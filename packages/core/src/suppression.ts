/**
 * Centralised suppression.
 *
 * Every outbound send passes through `assertSendable()`. Bounced and opted-out
 * contacts are preserved (never deleted) so their history stays auditable while
 * future sends are blocked.
 */
import { prisma } from '@mail/database';
import { emailDomain, normalizeEmail } from '@mail/shared';
import type { SuppressionType } from '@mail/shared';
import { recordEvent } from './activity.js';

export interface SuppressionHit {
  suppressed: boolean;
  type?: SuppressionType;
  reason?: string | null;
  scope?: 'EMAIL' | 'DOMAIN';
}

export async function isSuppressed(workspaceId: string, email: string): Promise<SuppressionHit> {
  const address = normalizeEmail(email);
  const domain = emailDomain(address);

  const hit = await prisma.suppressionList.findFirst({
    where: { workspaceId, value: { in: [address, domain].filter(Boolean) } },
  });
  if (!hit) return { suppressed: false };

  return {
    suppressed: true,
    type: hit.type as SuppressionType,
    reason: hit.reason,
    scope: hit.scope as 'EMAIL' | 'DOMAIN',
  };
}

export async function addSuppression(params: {
  workspaceId: string;
  value: string;
  type: SuppressionType;
  scope?: 'EMAIL' | 'DOMAIN';
  reason?: string | null;
}) {
  const value = normalizeEmail(params.value);
  return prisma.suppressionList.upsert({
    where: { workspaceId_value: { workspaceId: params.workspaceId, value } },
    create: {
      workspaceId: params.workspaceId,
      value,
      type: params.type,
      scope: params.scope ?? (value.includes('@') ? 'EMAIL' : 'DOMAIN'),
      reason: params.reason ?? null,
    },
    update: { type: params.type, reason: params.reason ?? null },
  });
}

export async function removeSuppression(workspaceId: string, value: string) {
  return prisma.suppressionList.deleteMany({ where: { workspaceId, value: normalizeEmail(value) } });
}

/**
 * Takes a contact out of every contact list they belong to.
 *
 * The contact row, its bounce reason and its message history all stay: this
 * removes list *membership*, which is what decides whether the address is ever
 * pulled into another campaign. Deleting the contact outright would take the
 * evidence with it and let a future import quietly re-add the same dead
 * address.
 */
export async function removeFromAllLists(contactId: string): Promise<number> {
  const { count } = await prisma.contactListMember.deleteMany({ where: { contactId } });
  return count;
}

/** Records a bounce, suppresses the address and stops the contact's sequence. */
export async function registerBounce(params: {
  workspaceId: string;
  email: string;
  contactId?: string | null;
  campaignId?: string | null;
  type: 'HARD' | 'SOFT';
  reason: string;
  rawSnippet?: string | null;
}) {
  await prisma.bounce.create({
    data: {
      workspaceId: params.workspaceId,
      contactId: params.contactId ?? null,
      campaignId: params.campaignId ?? null,
      email: normalizeEmail(params.email),
      type: params.type,
      reason: params.reason,
      rawSnippet: params.rawSnippet ?? null,
    },
  });

  // Only hard bounces are permanently suppressed; a soft bounce (full mailbox,
  // temporary deferral) stops the current sequence but does not block forever.
  if (params.type === 'HARD') {
    await addSuppression({
      workspaceId: params.workspaceId,
      value: params.email,
      type: 'BOUNCE',
      reason: params.reason,
    });
  }

  let removedFromLists = 0;
  if (params.contactId) {
    await prisma.contact.update({
      where: { id: params.contactId },
      data: { status: 'BOUNCED' },
    });
    await prisma.campaignContact.updateMany({
      where: { contactId: params.contactId, status: { notIn: ['BOUNCED', 'UNSUBSCRIBED'] } },
      data: { status: 'BOUNCED', bouncedAt: new Date(), nextStepAt: null },
    });

    // Both kinds come off the list. A soft bounce is only *probably*
    // temporary, and mailing a full or deferring mailbox again on the next
    // campaign costs sender reputation for no return.
    removedFromLists = await removeFromAllLists(params.contactId);
  }

  await recordEvent({
    workspaceId: params.workspaceId,
    type: 'BOUNCED',
    contactId: params.contactId ?? null,
    campaignId: params.campaignId ?? null,
    meta: { type: params.type, reason: params.reason, removedFromLists },
  });

  return { removedFromLists };
}

/** Records an opt-out, suppresses the address and stops all future sends. */
export async function registerUnsubscribe(params: {
  workspaceId: string;
  email: string;
  contactId?: string | null;
  campaignId?: string | null;
  source?: 'REPLY' | 'MANUAL' | 'LINK' | 'AI';
  reason?: string | null;
}) {
  const email = normalizeEmail(params.email);

  await prisma.unsubscribe.upsert({
    where: { workspaceId_email: { workspaceId: params.workspaceId, email } },
    create: {
      workspaceId: params.workspaceId,
      email,
      contactId: params.contactId ?? null,
      source: params.source ?? 'REPLY',
      reason: params.reason ?? null,
    },
    update: { reason: params.reason ?? null },
  });

  await addSuppression({
    workspaceId: params.workspaceId,
    value: email,
    type: 'UNSUBSCRIBE',
    reason: params.reason ?? 'Recipient requested removal',
  });

  if (params.contactId) {
    await prisma.contact.update({ where: { id: params.contactId }, data: { status: 'UNSUBSCRIBED' } });
    await prisma.campaignContact.updateMany({
      where: { contactId: params.contactId },
      data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date(), nextStepAt: null },
    });
    await prisma.campaignContactStep.updateMany({
      where: { campaignContact: { contactId: params.contactId }, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'CANCELLED' },
    });
  }

  await recordEvent({
    workspaceId: params.workspaceId,
    type: 'UNSUBSCRIBED',
    contactId: params.contactId ?? null,
    campaignId: params.campaignId ?? null,
    meta: { source: params.source ?? 'REPLY' },
  });
}
