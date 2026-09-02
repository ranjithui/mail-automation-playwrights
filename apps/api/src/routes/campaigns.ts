import { Router } from 'express';
import { prisma } from '@mail/database';
import { enqueue } from '@mail/queue';
import {
  computeProgress,
  dispatchDueSteps,
  getHoldReason,
  logActivity,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
  stopCampaign,
} from '@mail/core';
import {
  campaignContactsSchema,
  campaignLabelName,
  campaignLaunchSchema,
  campaignSchema,
  campaignStepSchema,
  campaignTestSchema,
  campaignUpdateSchema,
  percent,
  parseJson,
  stringifyJson,
} from '@mail/shared';
import { z } from 'zod';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireManage, requireWrite, withWorkspace } from '../middleware/context.js';

export const campaignRouter = Router();
campaignRouter.use(authenticate, withWorkspace);

async function findCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
  if (!campaign) throw AppError.notFound('Campaign');
  return campaign;
}

/**
 * A campaign's name is the Gmail label its mail is filed under, so it has to
 * name exactly one campaign in the workspace.
 *
 * The database constraint is the backstop; this check exists to fail with a
 * sentence the wizard can show, and to catch the two cases the constraint
 * cannot: SQLite compares names case-sensitively while Gmail does not, and two
 * different names can still reduce to the same label ("Q3 / EU" and "Q3 EU").
 */
async function assertCampaignNameFree(workspaceId: string, name: string, excludeId?: string) {
  const wantedName = name.trim().toLowerCase();
  const wantedLabel = campaignLabelName(name).toLowerCase();

  const existing = await prisma.campaign.findMany({
    where: { workspaceId, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true, gmailLabel: true },
  });

  const clash = existing.find(
    (c) =>
      c.name.trim().toLowerCase() === wantedName ||
      (c.gmailLabel ?? '').toLowerCase() === wantedLabel,
  );
  if (clash) {
    throw AppError.conflict(
      `A campaign named "${clash.name}" already exists in this workspace. ` +
        'The campaign name is its Gmail label, so it has to be unique.',
    );
  }
}

campaignRouter.get(
  '/',
  handler(async (req, res) => {
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      include: {
        emailAccount: { select: { id: true, email: true, connection: true } },
        contactList: { select: { id: true, name: true } },
        _count: { select: { campaignContacts: true, steps: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const stats = await prisma.campaignContact.groupBy({
      by: ['campaignId', 'status'],
      where: { campaign: { workspaceId: req.ctx.workspaceId } },
      _count: { _all: true },
    });

    return ok(
      res,
      campaigns.map((c) => {
        const rows = stats.filter((s) => s.campaignId === c.id);
        const count = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
        const total = c._count.campaignContacts;
        const done = ['COMPLETED', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'FAILED'].reduce(
          (sum, s) => sum + count(s),
          0,
        );
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          status: c.status,
          mode: c.mode,
          timezone: c.timezone,
          sendWindowStart: c.sendWindowStart,
          sendWindowEnd: c.sendWindowEnd,
          dailyLimit: c.dailyLimit,
          emailAccount: c.emailAccount,
          contactList: c.contactList,
          contactCount: total,
          stepCount: c._count.steps,
          replies: count('REPLIED'),
          bounces: count('BOUNCED'),
          progress: percent(done, total),
          lastRunAt: c.lastRunAt,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      }),
    );
  }),
);

campaignRouter.post(
  '/',
  requireWrite,
  handler(async (req, res) => {
    const input = campaignSchema.parse(req.body);
    const { sendDays, startDate, ...rest } = input;
    const name = input.name.trim();
    await assertCampaignNameFree(req.ctx.workspaceId, name);

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        createdById: req.ctx.userId,
        ...rest,
        name,
        startDate: startDate ? new Date(startDate) : null,
        sendDaysJson: stringifyJson(sendDays),
        // The label is the campaign name. It is stored rather than rederived
        // on every read, so renaming a campaign that has already sent cannot
        // orphan the mail filed under the name it had at the time.
        gmailLabel: campaignLabelName(name),
      },
    });

    // Every campaign starts with one initial step so the wizard always has
    // something to edit rather than an empty sequence.
    await prisma.campaignStep.create({
      data: {
        campaignId: campaign.id,
        stepOrder: 1,
        name: 'Initial email',
        type: 'INITIAL',
        delayDays: 0,
        delayHours: 0,
        replyInThread: false,
      },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      campaignId: campaign.id,
      action: 'campaign.created',
      message: `Campaign "${campaign.name}" created`,
    });

    return ok(res, campaign, undefined, 201);
  }),
);

campaignRouter.get(
  '/:id',
  handler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: {
        emailAccount: { select: { id: true, email: true, displayName: true, connection: true, dailyLimit: true, sentToday: true } },
        contactList: { select: { id: true, name: true } },
        createdBy: { select: { firstName: true, lastName: true, email: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: {
            template: { select: { id: true, name: true, subject: true } },
            attachments: { include: { attachment: { select: { id: true, originalName: true, size: true } } } },
            _count: { select: { progress: true } },
          },
        },
      },
    });
    if (!campaign) throw AppError.notFound('Campaign');

    const progress = await computeProgress(campaign.id);
    const hold = await getHoldReason(campaign.id);

    return ok(res, {
      ...campaign,
      hold,
      sendDays: parseJson<number[]>(campaign.sendDaysJson, [1, 2, 3, 4, 5]),
      steps: campaign.steps.map((s) => ({
        ...s,
        attachmentIds: s.attachments.map((a) => a.attachmentId),
        attachments: s.attachments.map((a) => ({
          id: a.attachment.id,
          filename: a.attachment.originalName,
          size: a.attachment.size,
        })),
        processed: s._count.progress,
      })),
      progress,
    });
  }),
);

campaignRouter.patch(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const input = campaignUpdateSchema.parse(req.body);
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    const { sendDays, startDate, ...rest } = input;

    const name = input.name?.trim();
    const renamed = name !== undefined && name !== campaign.name;
    if (renamed) await assertCampaignNameFree(req.ctx.workspaceId, name!, campaign.id);

    // A campaign that has never run has filed nothing, so its label can follow
    // the new name. Once it has run, the old label is where its mail already
    // lives and renaming must not point later sends somewhere else.
    const relabel = renamed && !campaign.lastRunAt;

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        ...rest,
        ...(name !== undefined ? { name } : {}),
        ...(relabel ? { gmailLabel: campaignLabelName(name!) } : {}),
        ...(startDate !== undefined ? { startDate: startDate ? new Date(startDate) : null } : {}),
        ...(sendDays ? { sendDaysJson: stringifyJson(sendDays) } : {}),
      },
    });
    return ok(res, updated);
  }),
);

campaignRouter.delete(
  '/:id',
  requireManage,
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    if (campaign.status === 'RUNNING') throw AppError.badRequest('Stop the campaign before deleting it');
    await prisma.campaign.delete({ where: { id: campaign.id } });
    return ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------- steps

campaignRouter.put(
  '/:id/steps',
  requireWrite,
  handler(async (req, res) => {
    const steps = z.array(campaignStepSchema).min(1).parse(req.body?.steps);
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);

    const keptIds = steps.map((s) => s.id).filter(Boolean) as string[];
    await prisma.campaignStep.deleteMany({
      where: { campaignId: campaign.id, ...(keptIds.length ? { id: { notIn: keptIds } } : {}) },
    });

    const saved = [];
    for (const [index, step] of steps.entries()) {
      const data = {
        campaignId: campaign.id,
        stepOrder: index + 1,
        name: step.name,
        type: index === 0 ? ('INITIAL' as const) : ('FOLLOWUP' as const),
        templateId: step.templateId ?? null,
        subjectOverride: step.subjectOverride ?? null,
        bodyOverride: step.bodyOverride ?? null,
        delayDays: index === 0 ? 0 : step.delayDays,
        delayHours: index === 0 ? 0 : step.delayHours,
        replyInThread: index === 0 ? false : step.replyInThread,
        enabled: step.enabled,
      };

      const row = step.id
        ? await prisma.campaignStep.update({ where: { id: step.id }, data })
        : await prisma.campaignStep.create({ data });

      await prisma.stepAttachment.deleteMany({ where: { stepId: row.id } });
      for (const attachmentId of step.attachmentIds ?? []) {
        await prisma.stepAttachment.create({ data: { stepId: row.id, attachmentId } });
      }
      saved.push(row);
    }

    return ok(res, saved);
  }),
);

// ---------------------------------------------------------------- contacts

campaignRouter.get(
  '/:id/contacts',
  handler(async (req, res) => {
    await findCampaign(req.ctx.workspaceId, req.params.id);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 25));

    const where = {
      campaignId: req.params.id,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.campaignContact.findMany({
        where,
        include: {
          contact: { select: { id: true, email: true, firstName: true, lastName: true, companyName: true, title: true } },
          steps: { include: { step: { select: { name: true, stepOrder: true } } }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.campaignContact.count({ where }),
    ]);

    return ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        contact: r.contact,
        status: r.status,
        currentStep: r.currentStep,
        nextStepAt: r.nextStepAt,
        sentCount: r.sentCount,
        repliedAt: r.repliedAt,
        failedReason: r.failedReason,
        steps: r.steps.map((s) => ({
          stepName: s.step.name,
          stepOrder: s.step.stepOrder,
          status: s.status,
          completedAt: s.completedAt,
          error: s.error,
        })),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  }),
);

campaignRouter.post(
  '/:id/contacts',
  requireWrite,
  handler(async (req, res) => {
    const input = campaignContactsSchema.parse(req.body);
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);

    let contactIds = input.contactIds ?? [];
    if (input.listId) {
      const members = await prisma.contactListMember.findMany({
        where: { listId: input.listId, list: { workspaceId: req.ctx.workspaceId } },
        select: { contactId: true },
      });
      contactIds = [...new Set([...contactIds, ...members.map((m) => m.contactId)])];
      await prisma.campaign.update({ where: { id: campaign.id }, data: { contactListId: input.listId } });
    }
    if (!contactIds.length) throw AppError.badRequest('Select at least one contact or a contact list');

    if (input.replaceExisting) {
      await prisma.campaignContact.deleteMany({ where: { campaignId: campaign.id, status: 'NEW' } });
    }

    // Suppressed addresses never enter a campaign in the first place.
    const suppressed = await prisma.suppressionList.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      select: { value: true },
    });
    const blocked = new Set(suppressed.map((s) => s.value));

    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, workspaceId: req.ctx.workspaceId },
      select: { id: true, email: true },
    });

    let added = 0;
    let skipped = 0;
    for (const contact of contacts) {
      if (blocked.has(contact.email) || blocked.has(contact.email.split('@')[1] ?? '')) {
        skipped += 1;
        continue;
      }
      const created = await prisma.campaignContact
        .create({ data: { campaignId: campaign.id, contactId: contact.id, status: 'NEW' } })
        .catch(() => null);
      if (created) added += 1;
      else skipped += 1;
    }

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      campaignId: campaign.id,
      action: 'campaign.contacts_added',
      message: `${added} contact(s) added, ${skipped} skipped`,
    });

    return ok(res, { added, skipped });
  }),
);

campaignRouter.delete(
  '/:id/contacts/:campaignContactId',
  requireWrite,
  handler(async (req, res) => {
    await findCampaign(req.ctx.workspaceId, req.params.id);
    await prisma.campaignContact.deleteMany({
      where: { id: req.params.campaignContactId, campaignId: req.params.id },
    });
    return ok(res, { removed: true });
  }),
);

// ----------------------------------------------------------------- control

campaignRouter.post(
  '/:id/start',
  requireManage,
  handler(async (req, res) => {
    const input = campaignLaunchSchema.parse(req.body ?? {});
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);

    if (input.mode || input.startAt) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.startAt ? { startDate: new Date(input.startAt) } : {}),
        },
      });
    }

    return ok(res, await startCampaign(campaign.id, req.ctx.userId));
  }),
);

/**
 * Run now: dispatch this campaign's due work immediately, ignoring the sending
 * window for this one pass. Suppression, daily limit and reply checks all still
 * apply - the window is a scheduling preference, those are safety rules.
 */
campaignRouter.post(
  '/:id/run-now',
  requireManage,
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);

    if (campaign.status !== 'RUNNING') {
      await startCampaign(campaign.id, req.ctx.userId);
    }

    const result = await dispatchDueSteps(campaign.id, true);

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      campaignId: campaign.id,
      action: 'campaign.run_now',
      message: `Run now queued ${result.queued} message(s)`,
      status: result.queued ? 'SUCCESS' : 'WARNING',
    });

    return ok(res, result);
  }),
);

campaignRouter.post(
  '/:id/pause',
  requireManage,
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    return ok(res, await pauseCampaign(campaign.id, req.ctx.userId));
  }),
);

campaignRouter.post(
  '/:id/resume',
  requireManage,
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    return ok(res, await resumeCampaign(campaign.id, req.ctx.userId));
  }),
);

campaignRouter.post(
  '/:id/stop',
  requireManage,
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    return ok(res, await stopCampaign(campaign.id, req.ctx.userId));
  }),
);

/**
 * Draft mode (spec section 22): test the first contact, a selection, or the
 * whole campaign. Drafts are created in the mailbox and never sent.
 */
campaignRouter.post(
  '/:id/test',
  requireWrite,
  handler(async (req, res) => {
    const input = campaignTestSchema.parse(req.body ?? {});
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);
    if (!campaign.emailAccountId) throw AppError.badRequest('Attach a mailbox first');

    const step =
      (input.stepId
        ? await prisma.campaignStep.findFirst({ where: { id: input.stepId, campaignId: campaign.id } })
        : null) ??
      (await prisma.campaignStep.findFirst({
        where: { campaignId: campaign.id, enabled: true },
        orderBy: { stepOrder: 'asc' },
      }));
    if (!step) throw AppError.badRequest('Add a sequence step first');

    let targets: string[] = [];
    if (input.target === 'FIRST_CONTACT') {
      const first = await prisma.campaignContact.findFirst({
        where: { campaignId: campaign.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      targets = first ? [first.id] : [];
    } else if (input.target === 'SELECTED') {
      const rows = await prisma.campaignContact.findMany({
        where: { campaignId: campaign.id, contactId: { in: input.contactIds ?? [] } },
        select: { id: true },
      });
      targets = rows.map((r) => r.id);
    } else {
      const rows = await prisma.campaignContact.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
        take: 500,
      });
      targets = rows.map((r) => r.id);
    }

    if (!targets.length) throw AppError.badRequest('No contacts matched this test');

    for (const [index, campaignContactId] of targets.entries()) {
      await enqueue({
        workspaceId: req.ctx.workspaceId,
        queue: 'email-send',
        name: `draft-test:${campaign.name}`,
        payload: {
          campaignId: campaign.id,
          campaignContactId,
          stepId: step.id,
          stepOrder: step.stepOrder,
          emailAccountId: campaign.emailAccountId,
          mode: 'DRAFT_ONLY',
          isTest: true,
        },
        runAt: new Date(Date.now() + index * 2000),
        dedupeKey: `test:${campaign.id}:${campaignContactId}:${step.id}:${Date.now()}`,
        campaignId: campaign.id,
        stepId: step.id,
        maxAttempts: 1,
      });
    }

    return ok(res, { queued: targets.length, mode: 'DRAFT_ONLY' });
  }),
);

// --------------------------------------------------------------- analytics

campaignRouter.get(
  '/:id/analytics',
  handler(async (req, res) => {
    const campaign = await findCampaign(req.ctx.workspaceId, req.params.id);

    const [progress, events, stepStats, replies] = await Promise.all([
      computeProgress(campaign.id),
      prisma.emailEvent.groupBy({
        by: ['type'],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      }),
      prisma.campaignContactStep.groupBy({
        by: ['stepId', 'status'],
        where: { campaignContact: { campaignId: campaign.id } },
        _count: { _all: true },
      }),
      prisma.emailThread.findMany({
        where: { campaignId: campaign.id, lastMessageDirection: 'INBOUND' },
        select: {
          id: true,
          subject: true,
          snippet: true,
          lastMessageAt: true,
          contact: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 20,
      }),
    ]);

    const steps = await prisma.campaignStep.findMany({
      where: { campaignId: campaign.id },
      orderBy: { stepOrder: 'asc' },
      select: { id: true, name: true, stepOrder: true },
    });

    const daily = await prisma.emailEvent.findMany({
      where: { campaignId: campaign.id },
      select: { type: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });

    const byDay = new Map<string, { date: string; sent: number; replies: number; bounces: number }>();
    for (const event of daily) {
      const date = event.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(date) ?? { date, sent: 0, replies: 0, bounces: 0 };
      if (event.type === 'SENT') bucket.sent += 1;
      if (event.type === 'REPLY_RECEIVED') bucket.replies += 1;
      if (event.type === 'BOUNCED') bucket.bounces += 1;
      byDay.set(date, bucket);
    }

    return ok(res, {
      progress,
      events: Object.fromEntries(events.map((e) => [e.type, e._count._all])),
      stepPerformance: steps.map((step) => {
        const rows = stepStats.filter((s) => s.stepId === step.id);
        const count = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
        return {
          id: step.id,
          name: step.name,
          stepOrder: step.stepOrder,
          sent: count('SENT'),
          drafted: count('DRAFTED'),
          failed: count('FAILED'),
          skipped: count('SKIPPED'),
          cancelled: count('CANCELLED'),
          pending: count('PENDING') + count('QUEUED'),
        };
      }),
      timeline: [...byDay.values()],
      replies,
    });
  }),
);

campaignRouter.get(
  '/:id/activity',
  handler(async (req, res) => {
    await findCampaign(req.ctx.workspaceId, req.params.id);
    const logs = await prisma.activityLog.findMany({
      where: { campaignId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return ok(res, logs);
  }),
);
