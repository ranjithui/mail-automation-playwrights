/** Audit trail, domain events and notifications. */
import { prisma } from '@mail/database';
import { stringifyJson } from '@mail/shared';
import type { EventType, NotificationType } from '@mail/shared';
import { publish } from './realtime.js';

export interface ActivityInput {
  workspaceId: string;
  action: string;
  status?: 'SUCCESS' | 'FAILURE' | 'INFO' | 'WARNING';
  message?: string | null;
  userId?: string | null;
  campaignId?: string | null;
  contactId?: string | null;
  emailAccountId?: string | null;
  jobId?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
  retryCount?: number;
  workerId?: string | null;
  meta?: Record<string, unknown>;
}

export async function logActivity(input: ActivityInput) {
  const row = await prisma.activityLog.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      campaignId: input.campaignId ?? null,
      contactId: input.contactId ?? null,
      emailAccountId: input.emailAccountId ?? null,
      jobId: input.jobId ?? null,
      action: input.action,
      status: input.status ?? 'SUCCESS',
      message: input.message ?? null,
      durationMs: input.durationMs ?? null,
      errorCode: input.errorCode ?? null,
      retryCount: input.retryCount ?? 0,
      workerId: input.workerId ?? null,
      metaJson: stringifyJson(input.meta ?? {}),
    },
  });

  await publish(input.workspaceId, 'activity', {
    id: row.id,
    action: row.action,
    status: row.status,
    message: row.message,
    errorCode: row.errorCode,
    campaignId: row.campaignId,
    contactId: row.contactId,
    createdAt: row.createdAt.toISOString(),
  });
  return row;
}

export interface EmailEventInput {
  workspaceId: string;
  type: EventType;
  campaignId?: string | null;
  contactId?: string | null;
  stepId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  meta?: Record<string, unknown>;
}

export async function recordEvent(input: EmailEventInput) {
  return prisma.emailEvent.create({
    data: {
      workspaceId: input.workspaceId,
      type: input.type,
      campaignId: input.campaignId ?? null,
      contactId: input.contactId ?? null,
      stepId: input.stepId ?? null,
      threadId: input.threadId ?? null,
      messageId: input.messageId ?? null,
      metaJson: stringifyJson(input.meta ?? {}),
    },
  });
}

export interface NotifyInput {
  workspaceId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  severity?: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  linkUrl?: string | null;
  userId?: string | null;
}

export async function notify(input: NotifyInput) {
  const row = await prisma.notification.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      type: input.type,
      severity: input.severity ?? 'INFO',
      title: input.title,
      body: input.body ?? null,
      linkUrl: input.linkUrl ?? null,
    },
  });

  await publish(input.workspaceId, 'notification', {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    linkUrl: row.linkUrl,
    isRead: false,
    createdAt: row.createdAt.toISOString(),
  });
  return row;
}
