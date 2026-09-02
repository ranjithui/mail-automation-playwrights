/**
 * Migration from the legacy Google Apps Script / Sheets system.
 *
 * The old workbook is a set of sheets (Main1..Main10, Process, AutoProcess,
 * Dashboard) where every row is one prospect and the follow-up state lives in
 * fixed columns. This endpoint maps that shape onto the new model:
 *
 *   Main<N> sheet   -> ContactList + Campaign
 *   row             -> Contact + CampaignContact
 *   TemplateID      -> EmailTemplate reference on a CampaignStep
 *   Status          -> CampaignContact.status
 *   ThreadId        -> EmailThread.gmailThreadId
 *   RfcMessageId    -> EmailMessage.messageId
 *   LastMessageHtml -> EmailMessage.bodyHtml
 *   FollowUp1..3    -> CampaignStep 2..4 + CampaignContactStep ledger rows
 */
import { Router } from 'express';
import { prisma } from '@mail/database';
import { logActivity } from '@mail/core';
import { isEmail, migrationSchema, normalizeEmail, stringifyJson } from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireManage, withWorkspace } from '../middleware/context.js';

export const migrationRouter = Router();
migrationRouter.use(authenticate, withWorkspace);

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads a value from a legacy row by any of several historical header spellings. */
function pick(row: Record<string, unknown>, ...names: string[]): string {
  const index = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const name of names) {
    const key = index.get(norm(name));
    const value = key ? row[key] : undefined;
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

const LEGACY_STATUS_MAP: Record<string, string> = {
  '': 'NEW',
  new: 'NEW',
  pending: 'NEW',
  queued: 'QUEUED',
  sent: 'SENT',
  draft: 'QUEUED',
  drafted: 'QUEUED',
  replied: 'REPLIED',
  reply: 'REPLIED',
  followup1: 'FOLLOWUP_PENDING',
  followup2: 'FOLLOWUP_PENDING',
  followup3: 'FOLLOWUP_PENDING',
  completed: 'COMPLETED',
  done: 'COMPLETED',
  bounced: 'BOUNCED',
  bounce: 'BOUNCED',
  unsubscribed: 'UNSUBSCRIBED',
  failed: 'FAILED',
  error: 'FAILED',
  paused: 'PAUSED',
};

migrationRouter.post(
  '/analyze',
  handler(async (req, res) => {
    const input = migrationSchema.parse(req.body);

    const report = input.sheets.map((sheet) => {
      const headers = sheet.rows.length ? Object.keys(sheet.rows[0]) : [];
      let withEmail = 0;
      let withThread = 0;
      const statuses = new Map<string, number>();

      for (const row of sheet.rows) {
        const record = row as Record<string, unknown>;
        if (isEmail(normalizeEmail(pick(record, 'email', 'emailaddress')))) withEmail += 1;
        if (pick(record, 'threadid', 'gmailthreadid')) withThread += 1;
        const status = (pick(record, 'status', 'campaignstatus') || 'NEW').toLowerCase();
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      }

      return {
        sheet: sheet.name,
        rows: sheet.rows.length,
        headers,
        withEmail,
        withThread,
        statuses: Object.fromEntries(statuses),
        willCreate: /^main\d*$/i.test(sheet.name.replace(/\s+/g, ''))
          ? ['ContactList', 'Campaign', 'Contacts', 'CampaignContacts']
          : ['Contacts'],
      };
    });

    return ok(res, { sheets: report, mapping: LEGACY_MAPPING_DOC });
  }),
);

export const LEGACY_MAPPING_DOC = [
  { legacy: 'Main1..Main10 sheet', target: 'ContactList + Campaign' },
  { legacy: 'Row', target: 'Contact + CampaignContact' },
  { legacy: 'TemplateID', target: 'EmailTemplate on CampaignStep' },
  { legacy: 'Status', target: 'CampaignContact.status' },
  { legacy: 'ThreadId', target: 'EmailThread.gmailThreadId' },
  { legacy: 'RfcMessageId', target: 'EmailMessage.messageId' },
  { legacy: 'LastMessageHtml', target: 'EmailMessage.bodyHtml' },
  { legacy: 'FollowUp1Date / FollowUp2Date / FollowUp3Date', target: 'CampaignStep delay + CampaignContactStep' },
  { legacy: 'Process / AutoProcess triggers', target: 'ScheduledJob + campaign-scheduler queue' },
  { legacy: 'Dashboard sheet', target: 'Dashboard analytics (computed, not stored)' },
];

migrationRouter.post(
  '/import',
  requireManage,
  handler(async (req, res) => {
    const input = migrationSchema.parse(req.body);
    const workspaceId = req.ctx.workspaceId;

    const emailAccount =
      (input.emailAccountId
        ? await prisma.emailAccount.findFirst({ where: { id: input.emailAccountId, workspaceId } })
        : null) ?? (await prisma.emailAccount.findFirst({ where: { workspaceId } }));

    const summary = {
      contacts: { created: 0, updated: 0 },
      lists: 0,
      campaigns: 0,
      campaignContacts: 0,
      threads: 0,
      messages: 0,
      skipped: 0,
      notes: [] as string[],
    };

    for (const sheet of input.sheets) {
      const isCampaignSheet = /^main\s*\d*$/i.test(sheet.name.trim());

      let listId: string | null = null;
      let campaignId: string | null = null;
      const stepsByOrder = new Map<number, string>();

      if (isCampaignSheet && input.createCampaigns) {
        const list = await prisma.contactList.upsert({
          where: { workspaceId_name: { workspaceId, name: `${sheet.name} (migrated)` } },
          create: { workspaceId, name: `${sheet.name} (migrated)`, description: `Imported from Apps Script sheet ${sheet.name}` },
          update: {},
        });
        listId = list.id;
        summary.lists += 1;

        const campaign = await prisma.campaign.create({
          data: {
            workspaceId,
            name: `${sheet.name} (migrated)`,
            description: `Migrated from the Apps Script sheet "${sheet.name}"`,
            status: 'PAUSED',
            emailAccountId: emailAccount?.id ?? null,
            contactListId: list.id,
            createdById: req.ctx.userId,
          },
        });
        campaignId = campaign.id;
        summary.campaigns += 1;

        // The legacy fixed structure becomes four ordinary sequence steps -
        // which the sequence builder can then extend without limit.
        const stepDefs = [
          { order: 1, name: 'Initial email', type: 'INITIAL' as const, delayDays: 0 },
          { order: 2, name: 'Follow-up 1', type: 'FOLLOWUP' as const, delayDays: 3 },
          { order: 3, name: 'Follow-up 2', type: 'FOLLOWUP' as const, delayDays: 7 },
          { order: 4, name: 'Follow-up 3', type: 'FOLLOWUP' as const, delayDays: 14 },
        ];
        for (const def of stepDefs) {
          const step = await prisma.campaignStep.create({
            data: {
              campaignId: campaign.id,
              stepOrder: def.order,
              name: def.name,
              type: def.type,
              delayDays: def.delayDays,
              replyInThread: def.order > 1,
            },
          });
          stepsByOrder.set(def.order, step.id);
        }
      }

      for (const rawRow of sheet.rows) {
        const row = rawRow as Record<string, unknown>;
        const email = normalizeEmail(pick(row, 'email', 'emailaddress', 'workemail'));
        if (!isEmail(email)) {
          summary.skipped += 1;
          continue;
        }

        const data = {
          firstName: pick(row, 'firstname', 'first name') || null,
          lastName: pick(row, 'lastname', 'last name') || null,
          title: pick(row, 'title', 'jobtitle') || null,
          companyName: pick(row, 'companyname', 'company') || null,
          corporatePhone: pick(row, 'corporatephone', 'phone') || null,
          employees: pick(row, 'employees') || null,
          industry: pick(row, 'industry') || null,
          keywords: pick(row, 'keywords') || null,
          personLinkedinUrl: pick(row, 'personlinkedinurl', 'linkedin') || null,
          website: pick(row, 'website') || null,
          companyLinkedinUrl: pick(row, 'companylinkedinurl') || null,
          companyAddress: pick(row, 'companyaddress', 'address') || null,
          companyCity: pick(row, 'companycity', 'city') || null,
          companyState: pick(row, 'companystate', 'state') || null,
          companyCountry: pick(row, 'companycountry', 'country') || null,
          qualifyContact: pick(row, 'qualifycontact') || null,
        };

        const existing = await prisma.contact.findUnique({
          where: { workspaceId_email: { workspaceId, email } },
        });

        const contact = existing
          ? await prisma.contact.update({ where: { id: existing.id }, data })
          : await prisma.contact.create({ data: { workspaceId, email, ...data } });

        if (existing) summary.contacts.updated += 1;
        else summary.contacts.created += 1;

        if (listId) {
          await prisma.contactListMember
            .create({ data: { listId, contactId: contact.id } })
            .catch(() => undefined);
        }

        if (!campaignId) continue;

        const legacyStatus = pick(row, 'status', 'campaignstatus').toLowerCase().replace(/[^a-z0-9]/g, '');
        const status = LEGACY_STATUS_MAP[legacyStatus] ?? 'NEW';
        const sentCount = Number(pick(row, 'sentcount')) || (status === 'NEW' ? 0 : 1);

        const campaignContact = await prisma.campaignContact.upsert({
          where: { campaignId_contactId: { campaignId, contactId: contact.id } },
          create: {
            campaignId,
            contactId: contact.id,
            status,
            currentStep: Math.min(4, sentCount),
            sentCount,
            repliedAt: status === 'REPLIED' ? new Date() : null,
            bouncedAt: status === 'BOUNCED' ? new Date() : null,
            unsubscribedAt: status === 'UNSUBSCRIBED' ? new Date() : null,
          },
          update: { status },
        });
        summary.campaignContacts += 1;

        // Thread metadata: this is what makes migrated conversations continue
        // as real Gmail replies instead of starting a fresh thread.
        const gmailThreadId = pick(row, 'threadid', 'gmailthreadid');
        if (gmailThreadId && emailAccount) {
          const subject = pick(row, 'subject', 'lastsubject') || `${sheet.name} outreach`;
          const rfcMessageId = pick(row, 'rfcmessageid', 'messageid');
          const bodyHtml = pick(row, 'lastmessagehtml', 'lastmessage', 'messagehtml');

          const thread = await prisma.emailThread.upsert({
            where: { emailAccountId_gmailThreadId: { emailAccountId: emailAccount.id, gmailThreadId } },
            create: {
              workspaceId,
              emailAccountId: emailAccount.id,
              campaignId,
              contactId: contact.id,
              campaignContactId: campaignContact.id,
              gmailThreadId,
              subject,
              participantsJson: stringifyJson([emailAccount.email, email]),
              lastMessageId: rfcMessageId || null,
              lastMessageAt: new Date(),
              lastMessageDirection: status === 'REPLIED' ? 'INBOUND' : 'OUTBOUND',
              status: status === 'REPLIED' ? 'REPLIED' : 'OPEN',
            },
            update: { campaignId, contactId: contact.id, campaignContactId: campaignContact.id },
          });
          summary.threads += 1;

          if (bodyHtml) {
            const known = await prisma.emailMessage.findFirst({
              where: { threadId: thread.id, messageId: rfcMessageId || undefined },
              select: { id: true },
            });
            if (!known) {
              await prisma.emailMessage.create({
                data: {
                  threadId: thread.id,
                  messageId: rfcMessageId || null,
                  sender: emailAccount.email,
                  senderName: emailAccount.displayName,
                  recipientsJson: stringifyJson([email]),
                  subject,
                  bodyHtml,
                  direction: 'OUTBOUND',
                  sentAt: new Date(),
                },
              });
              summary.messages += 1;
            }
          }
        } else if (gmailThreadId && !emailAccount) {
          summary.notes.push('Thread metadata was skipped because no mailbox exists in this workspace yet.');
        }

        // Reconstruct the idempotency ledger so migrated contacts are never
        // re-sent a step the old system already completed.
        for (let order = 1; order <= Math.min(4, sentCount); order += 1) {
          const stepId = stepsByOrder.get(order);
          if (!stepId) continue;
          await prisma.campaignContactStep
            .create({
              data: {
                campaignContactId: campaignContact.id,
                stepId,
                status: 'SENT',
                idempotencyKey: `${campaignId}:${contact.id}:${stepId}`,
                completedAt: new Date(),
              },
            })
            .catch(() => undefined);
        }
      }
    }

    summary.notes = [...new Set(summary.notes)];
    summary.notes.push('Migrated campaigns are created PAUSED so you can review the sequence before anything sends.');

    await logActivity({
      workspaceId,
      userId: req.ctx.userId,
      action: 'migration.imported',
      message: `Migrated ${summary.contacts.created + summary.contacts.updated} contact(s) across ${summary.campaigns} campaign(s)`,
    });

    return ok(res, summary);
  }),
);

migrationRouter.get(
  '/mapping',
  handler(async (_req, res) => ok(res, LEGACY_MAPPING_DOC)),
);
