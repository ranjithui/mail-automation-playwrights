/**
 * Send / follow-up processor.
 *
 * Handles both the `email-send` and `email-followup` queues because the only
 * difference is whether the step replies inside the existing Gmail thread.
 *
 * Ordering of the safety checks matters and is deliberate:
 *   1. idempotency ledger  - has this exact (contact, step) already been done?
 *   2. preflight           - replied / bounced / unsubscribed / paused / suppressed
 *   3. sending window      - re-checked at execution time, not just at queueing
 *   4. daily quota         - per mailbox, reserved atomically
 * Only then does a browser action happen.
 */
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { JobError, type JobRecord } from '@mail/queue';
import {
  advanceAfterSend,
  broadcastProgress,
  classifyInbound,
  dispatchDueSteps,
  handleReply,
  isSuppressed,
  logActivity,
  markMailboxBusy,
  recordEvent,
  releaseMailbox,
  reserveDailyQuota,
  preflight,
  withMailbox,
  sendWindowOf,
  storage,
} from '@mail/core';
import { AutomationError } from '@mail/playwright';
import type { AttachmentRef } from '@mail/playwright';
import {
  buildReplyChain,
  contactToContext,
  displayName,
  htmlToText,
  isWithinSendWindow,
  nextSendWindowSlot,
  renderTemplate,
  replySubject,
  stringifyJson,
  truncate,
} from '@mail/shared';

const log = createLogger('send');

/**
 * How long after a step started we assume its browser work could still be
 * running. act()'s timeout reports a failure but cannot abort the compose it
 * raced, so the page may keep going for a while after the job gives up.
 */
const IN_FLIGHT_MS = 3 * 60_000;

interface SendPayload {
  campaignId: string;
  campaignContactId: string;
  stepId: string;
  stepOrder: number;
  emailAccountId: string;
  mode?: 'SEND' | 'DRAFT_ONLY';
  isTest?: boolean;
}

export async function processSend(job: JobRecord) {
  const started = Date.now();
  const payload = job.payload as unknown as SendPayload;

  const campaignContact = await prisma.campaignContact.findUnique({
    where: { id: payload.campaignContactId },
    include: { contact: true, campaign: true },
  });
  if (!campaignContact) throw new JobError('Campaign contact no longer exists', 'THREAD_NOT_FOUND', false);

  const { contact, campaign } = campaignContact;

  const step = await prisma.campaignStep.findUnique({
    where: { id: payload.stepId },
    include: {
      template: { include: { templateAttachments: { include: { attachment: true } } } },
      attachments: { include: { attachment: true } },
    },
  });
  if (!step) throw new JobError('Sequence step no longer exists', 'THREAD_NOT_FOUND', false);

  // ---------------------------------------------------------- 1. idempotency
  const ledger = await prisma.campaignContactStep.findUnique({
    where: { campaignContactId_stepId: { campaignContactId: campaignContact.id, stepId: step.id } },
  });

  if (ledger && ['SENT', 'DRAFTED', 'CANCELLED', 'SKIPPED'].includes(ledger.status)) {
    log.info(`skipping ${contact.email} / ${step.name}: ledger says ${ledger.status}`);
    return { skipped: true, reason: `already ${ledger.status}` };
  }

  // PROCESSING means a previous attempt still had the browser open for this
  // exact step - a job that timed out leaves its compose running for a while
  // after the timeout is reported. Starting a second compose on top of it is
  // precisely how one contact receives two copies, so back off and let the
  // queue retry once the first attempt can no longer be in flight.
  if (ledger?.status === 'PROCESSING' && ledger.startedAt && Date.now() - ledger.startedAt.getTime() < IN_FLIGHT_MS) {
    log.warn(`deferring ${contact.email} / ${step.name}: a previous attempt started ${ledger.startedAt.toISOString()} may still be sending`);
    throw new JobError('A previous attempt for this step may still be in flight', 'ALREADY_IN_PROGRESS', true);
  }

  const progress =
    ledger ??
    (await prisma.campaignContactStep.create({
      data: {
        campaignContactId: campaignContact.id,
        stepId: step.id,
        idempotencyKey: `${campaign.id}:${contact.id}:${step.id}`,
        status: 'PROCESSING',
      },
    }));

  await prisma.campaignContactStep.update({
    where: { id: progress.id },
    data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
  });

  const skip = async (reason: string, code: string) => {
    await prisma.campaignContactStep.update({
      where: { id: progress.id },
      data: { status: 'SKIPPED', error: reason, errorCode: code, completedAt: new Date() },
    });
    await recordEvent({
      workspaceId: job.workspaceId,
      type: 'SKIPPED',
      campaignId: campaign.id,
      contactId: contact.id,
      stepId: step.id,
      meta: { reason, code },
    });
    await logActivity({
      workspaceId: job.workspaceId,
      campaignId: campaign.id,
      contactId: contact.id,
      emailAccountId: payload.emailAccountId,
      jobId: job.id,
      action: 'send.skipped',
      status: 'WARNING',
      message: `${contact.email}: ${reason}`,
      errorCode: code,
      durationMs: Date.now() - started,
    });
    await broadcastProgress(campaign.id);
    return { skipped: true, reason };
  };

  // ------------------------------------------------------------ 2. preflight
  if (!payload.isTest) {
    const check = await preflight(campaignContact.id);
    if (!check.ok) return skip(check.reason ?? 'Preflight failed', check.code ?? 'SUPPRESSED');
  }

  const suppression = await isSuppressed(job.workspaceId, contact.email);
  if (suppression.suppressed) return skip(`Suppressed (${suppression.type})`, 'SUPPRESSED');

  // ------------------------------------------------------- 3. sending window
  if (!payload.isTest && !campaign.sendImmediately && !isWithinSendWindow(new Date(), sendWindowOf(campaign))) {
    // Not a failure: put the work back so the scheduler re-queues it in-window.
    await prisma.campaignContactStep.update({
      where: { id: progress.id },
      data: { status: 'PENDING', errorCode: 'OUTSIDE_SENDING_WINDOW' },
    });
    const window = sendWindowOf(campaign);
    const runAt = nextSendWindowSlot(new Date(), window);
    log.info(`deferring ${contact.email} to ${runAt.toISOString()}: outside sending window`);
    // deferUntil, not a plain return: completing this job would retire the only
    // row that can ever send this step, and the contact would never be mailed.
    return { deferred: true, reason: 'outside sending window', deferUntil: runAt };
  }

  const isDraftMode = (payload.mode ?? campaign.mode) === 'DRAFT_ONLY';

  // ---------------------------------------------------------- 4. daily quota
  if (!isDraftMode) {
    const quota = await reserveDailyQuota(payload.emailAccountId);
    if (!quota.allowed) {
      await prisma.campaignContactStep.update({
        where: { id: progress.id },
        data: { status: 'PENDING', errorCode: 'DAILY_LIMIT_REACHED' },
      });
      // Half an hour: long enough not to spin, short enough to pick up a raised
      // limit or the day rolling over without waiting for the next campaign tick.
      return {
        deferred: true,
        reason: `daily limit ${quota.dailyLimit} reached`,
        deferUntil: new Date(Date.now() + 30 * 60_000),
      };
    }
  }

  // ------------------------------------------------------------- 5. content
  const context = contactToContext(contact as unknown as Record<string, unknown>);
  const subjectSource = step.subjectOverride || step.template?.subject || `Hello {{First Name | there}}`;
  const bodySource =
    step.bodyOverride ||
    step.template?.bodyHtml ||
    `<p>Hi {{First Name | there}},</p><p>I wanted to reach out about {{Company Name | your company}}.</p>`;

  const renderedSubject = renderTemplate(subjectSource, context);
  const renderedBody = renderTemplate(bodySource, context);

  const account = await prisma.emailAccount.findUniqueOrThrow({ where: { id: payload.emailAccountId } });
  const signature = account.signatureHtml ? `<br><br>${account.signatureHtml}` : '';

  const attachments: AttachmentRef[] = [
    ...(step.attachments ?? []).map((a) => a.attachment),
    ...(step.template?.templateAttachments ?? []).map((a) => a.attachment),
  ]
    .filter((a, index, all) => all.findIndex((x) => x.id === a.id) === index)
    .filter((a) => storage.exists(a.storagePath))
    .map((a) => ({
      filename: a.originalName,
      path: storage.resolve(a.storagePath),
      mimeType: a.mimeType,
      size: a.size,
    }));

  // ------------------------------------------------- 6. existing thread, if any
  const existingThread = step.replyInThread
    ? await prisma.emailThread.findFirst({
        where: { campaignContactId: campaignContact.id, emailAccountId: account.id },
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      })
    : null;

  await markMailboxBusy(account.id, job.id, campaign.id);

  try {
    // Serialised per mailbox: one browser action at a time, always.
    const outcome = await withMailbox(account.id, async (driver) => {
    let result;
    let threadSubject = renderedSubject.output;

    if (existingThread) {
      // Ask the mailbox itself before nudging someone.
      //
      // Everything else that stops a follow-up reads our synced copy, which is
      // up to one sync interval behind: a reply that arrived in the last minute
      // has not cancelled this job yet, and the contact would be chased for an
      // answer they already gave. The conversation is about to be opened to
      // reply into anyway, so asking who spoke last is the cheapest check there
      // is at the only moment it cannot be stale.
      // Only a real reply counts, judged by the same classifier the inbox sync
      // uses. An out-of-office is inbound too, and treating "back on Monday" as
      // an answer would end the sequence and drop the contact from every list.
      const latest = await driver.getLatestMessage(existingThread.gmailThreadId).catch(() => null);
      if (latest?.direction === 'INBOUND' && classifyInbound(latest).kind === 'REPLY') {
        return { repliedInMailbox: latest.sender || contact.email };
      }

      // True in-thread reply: subject is normalised to a single "Re:" and the
      // previous message is quoted as a trimmed Gmail-style chain.
      const previous = existingThread.messages[0];
      threadSubject = replySubject(existingThread.subject);
      const bodyWithChain = buildReplyChain(
        `${renderedBody.output}${signature}`,
        previous
          ? {
              fromName: previous.senderName,
              fromEmail: previous.sender,
              sentAt: previous.sentAt ?? previous.receivedAt ?? previous.createdAt,
              bodyHtml: previous.bodyHtml ?? '',
            }
          : null,
      );

      result = await driver.replyToConversation(
        {
          gmailThreadId: existingThread.gmailThreadId,
          to: contact.email,
          inReplyTo: previous?.messageId ?? existingThread.lastMessageId,
          subject: threadSubject,
          bodyHtml: bodyWithChain,
          attachments,
        },
        isDraftMode ? 'DRAFT' : 'SEND',
      );
    } else {
      const request = {
        to: contact.email,
        subject: threadSubject,
        bodyHtml: `${renderedBody.output}${signature}`,
        attachments,
      };
      result = isDraftMode ? await driver.saveDraft(request) : await driver.sendMessage(request);
    }

      // Filing is best-effort, and deliberately last. The message has already
      // gone; a labels menu that misbehaves must not turn a delivered email
      // into a failed job that gets retried and sent again.
      if (campaign.gmailLabel && !result.isDraft) {
        try {
          const subject = threadSubject.replace(/["\\]/g, '').trim();
          const filed = await driver.applyLabel(
            // `after:` in Unix seconds, not `newer_than:1d`. The same subject goes
            // to the same contact every time a campaign is re-run, so a day-wide
            // window matched yesterday's conversation as readily as the message
            // just sent - and Gmail, ranking by relevance, offered the older one
            // first. One send filed a day-old thread and left itself unlabelled
            // while the check, searching the same window, said it had worked.
            `in:sent to:${contact.email} subject:"${subject}" after:${Math.floor(
              (Date.now() - 10 * 60_000) / 1000,
            )}`,
            campaign.gmailLabel,
          );
          if (!filed) log.warn(`could not file ${contact.email} under ${campaign.gmailLabel}`);
        } catch (error) {
          log.warn(
            `labelling ${contact.email} as ${campaign.gmailLabel} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return { result, threadSubject };
    });

    if ('repliedInMailbox' in outcome) {
      // Treated exactly like a reply found by the inbox sync: the sequence
      // stops, the queued follow-ups go, and the contact comes off the lists.
      await handleReply(campaignContact.id);
      await markMailboxBusy(account.id, null, null);
      return skip(`${outcome.repliedInMailbox} replied in the mailbox`, 'REPLIED');
    }
    const { result, threadSubject } = outcome;

    // ---------------------------------------------------------- 7. persistence
    const thread =
      existingThread ??
      (await prisma.emailThread.upsert({
        where: { emailAccountId_gmailThreadId: { emailAccountId: account.id, gmailThreadId: result.gmailThreadId } },
        create: {
          workspaceId: job.workspaceId,
          emailAccountId: account.id,
          campaignId: campaign.id,
          contactId: contact.id,
          campaignContactId: campaignContact.id,
          gmailThreadId: result.gmailThreadId,
          subject: threadSubject,
          participantsJson: stringifyJson([account.email, contact.email]),
          snippet: truncate(htmlToText(renderedBody.output), 200),
          lastMessageId: result.rfcMessageId,
          lastMessageAt: result.sentAt,
          lastMessageDirection: 'OUTBOUND',
          status: 'WAITING',
        },
        update: {
          lastMessageId: result.rfcMessageId,
          lastMessageAt: result.sentAt,
          lastMessageDirection: 'OUTBOUND',
        },
      }));

    await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        gmailMessageId: result.gmailMessageId,
        messageId: result.rfcMessageId,
        inReplyTo: existingThread?.lastMessageId ?? null,
        sender: account.email,
        senderName: account.displayName,
        recipientsJson: stringifyJson([contact.email]),
        subject: threadSubject,
        bodyHtml: `${renderedBody.output}${signature}`,
        bodyText: htmlToText(renderedBody.output),
        snippet: truncate(htmlToText(renderedBody.output), 300),
        direction: 'OUTBOUND',
        isDraft: result.isDraft,
        hasAttachments: attachments.length > 0,
        stepId: step.id,
        sentAt: result.sentAt,
      },
    });

    if (existingThread) {
      await prisma.emailThread.update({
        where: { id: thread.id },
        data: {
          lastMessageId: result.rfcMessageId,
          lastMessageAt: result.sentAt,
          lastMessageDirection: 'OUTBOUND',
          status: 'WAITING',
        },
      });
    }

    await prisma.campaignContactStep.update({
      where: { id: progress.id },
      data: {
        status: result.isDraft ? 'DRAFTED' : 'SENT',
        completedAt: new Date(),
        messageId: result.rfcMessageId,
        error: null,
        errorCode: null,
      },
    });

    if (!payload.isTest) {
      await advanceAfterSend(campaignContact.id, step.stepOrder);
      await prisma.contact.update({
        where: { id: contact.id },
        data: { status: result.isDraft ? 'QUEUED' : 'SENT', lastContactedAt: new Date() },
      });

      // A campaign that sends immediately should not sit for up to a minute
      // waiting for the next scheduler tick to notice that the step it just
      // advanced to is already due. Dispatching here is what makes a zero-delay
      // follow-up behave like the initial send rather than like a scheduled
      // one. It queues work; it never sends, so the mailbox is not touched
      // twice, and a failure only costs the latency it was saving.
      if (campaign.sendImmediately) {
        await dispatchDueSteps(campaign.id).catch((error) =>
          log.warn(
            `could not dispatch the next step for "${campaign.name}" straight away: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }

    await recordEvent({
      workspaceId: job.workspaceId,
      type: result.isDraft ? 'DRAFT_CREATED' : 'SENT',
      campaignId: campaign.id,
      contactId: contact.id,
      stepId: step.id,
      threadId: thread.id,
      messageId: result.rfcMessageId,
      meta: { subject: threadSubject, replyInThread: Boolean(existingThread) },
    });

    await logActivity({
      workspaceId: job.workspaceId,
      campaignId: campaign.id,
      contactId: contact.id,
      emailAccountId: account.id,
      jobId: job.id,
      action: result.isDraft ? 'send.draft_created' : 'send.sent',
      status: 'SUCCESS',
      message: result.alreadySent
        ? `Recovered an earlier send to ${contact.email} (${step.name}) - no duplicate was sent`
        : `${result.isDraft ? 'Draft created for' : 'Sent to'} ${contact.email} (${step.name})`,
      durationMs: Date.now() - started,
      retryCount: job.attempts,
    });

    await broadcastProgress(campaign.id, {
      currentContact: displayName(contact),
      currentAction: result.isDraft ? 'Draft saved in Gmail' : 'Message sent',
    });

    await markMailboxBusy(account.id, null, null);
    return {
      sent: !result.isDraft,
      drafted: result.isDraft,
      alreadySent: Boolean(result.alreadySent),
      gmailThreadId: result.gmailThreadId,
      messageId: result.rfcMessageId,
    };
  } catch (error) {
    const code = error instanceof AutomationError ? error.code : 'SEND_FAILED';
    const retryable = error instanceof AutomationError ? error.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    const willRetry = retryable && job.attempts + 1 < job.maxAttempts;

    await prisma.campaignContactStep.update({
      where: { id: progress.id },
      data: {
        status: willRetry ? 'PENDING' : 'FAILED',
        errorCode: code,
        error: message.slice(0, 1000),
        ...(willRetry ? {} : { completedAt: new Date() }),
      },
    });

    if (!willRetry) {
      await prisma.campaignContact.update({
        where: { id: campaignContact.id },
        data: { status: 'FAILED', failedReason: truncate(message, 300) },
      });
      await recordEvent({
        workspaceId: job.workspaceId,
        type: 'FAILED',
        campaignId: campaign.id,
        contactId: contact.id,
        stepId: step.id,
        meta: { code, message: truncate(message, 300) },
      });
    }

    await logActivity({
      workspaceId: job.workspaceId,
      campaignId: campaign.id,
      contactId: contact.id,
      emailAccountId: account.id,
      jobId: job.id,
      action: 'send.failed',
      status: 'FAILURE',
      message: `${contact.email}: ${truncate(message, 300)}`,
      errorCode: code,
      durationMs: Date.now() - started,
      retryCount: job.attempts,
      meta: { screenshot: (error as AutomationError)?.options?.screenshotPath ?? null },
    });

    await markMailboxBusy(account.id, null, null);

    // A timeout means the browser was still working when we stopped waiting.
    // Tearing the context down guarantees that half-finished compose cannot
    // click Send behind the back of the retry that follows.
    if (code === 'TIMEOUT') {
      log.warn(`releasing mailbox ${account.email} after a timed-out send`);
      await releaseMailbox(account.id).catch(() => undefined);
    }

    await broadcastProgress(campaign.id);
    throw new JobError(message, code, retryable);
  }
}
