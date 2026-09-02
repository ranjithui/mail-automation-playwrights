/**
 * Domain enumerations.
 *
 * These are plain TS unions + const arrays rather than Prisma native enums so
 * the same schema runs on SQLite and PostgreSQL (see DATABASE.md). Validation
 * happens at the Zod layer on both the API and the client.
 */

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'USER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

/** Higher number == more authority. Used by requireRole(). */
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 50,
  ADMIN: 40,
  MANAGER: 30,
  USER: 20,
  VIEWER: 10,
};

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_MODES = ['SEND', 'DRAFT_ONLY'] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

export const CONTACT_STATUSES = [
  'NEW',
  'QUEUED',
  'SENT',
  'REPLIED',
  'FOLLOWUP_PENDING',
  'COMPLETED',
  'BOUNCED',
  'UNSUBSCRIBED',
  'FAILED',
  'PAUSED',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const STEP_TYPES = ['INITIAL', 'FOLLOWUP'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_PROGRESS_STATUSES = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'SENT',
  'DRAFTED',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
] as const;
export type StepProgressStatus = (typeof STEP_PROGRESS_STATUSES)[number];

export const EMAIL_ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const;
export type EmailAccountStatus = (typeof EMAIL_ACCOUNT_STATUSES)[number];

export const CONNECTION_STATUSES = ['CONNECTED', 'CONNECTING', 'DISCONNECTED', 'ERROR'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const BROWSER_STATUSES = ['STOPPED', 'STARTING', 'RUNNING', 'ERROR'] as const;
export type BrowserStatus = (typeof BROWSER_STATUSES)[number];

export const SESSION_STATUSES = ['NONE', 'VALID', 'EXPIRED', 'ERROR'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const THREAD_STATUSES = ['OPEN', 'WAITING', 'REPLIED', 'ARCHIVED', 'CLOSED'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const JOB_STATUSES = [
  'PENDING',
  'DELAYED',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const QUEUES = [
  'email-send',
  'email-followup',
  'campaign-scheduler',
  'browser-worker',
  'inbox-sync',
  'bounce-check',
  'ai-analysis',
  'ai-reply',
  'notification',
  'analytics',
] as const;
export type QueueName = (typeof QUEUES)[number];

export const EVENT_TYPES = [
  'SENT',
  'DRAFT_CREATED',
  'REPLY_RECEIVED',
  'BOUNCED',
  'UNSUBSCRIBED',
  'FAILED',
  'SKIPPED',
  'OPENED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SUPPRESSION_TYPES = [
  'BOUNCE',
  'UNSUBSCRIBE',
  'MANUAL_BLOCK',
  'DOMAIN_BLOCK',
  'COMPLAINT',
] as const;
export type SuppressionType = (typeof SUPPRESSION_TYPES)[number];

export const ERROR_CODES = [
  'AUTH_ERROR',
  'SESSION_EXPIRED',
  'PROFILE_IN_USE',
  'GMAIL_NOT_AVAILABLE',
  'SELECTOR_NOT_FOUND',
  'ATTACHMENT_ERROR',
  'THREAD_NOT_FOUND',
  'SEND_FAILED',
  'BOUNCE',
  'RATE_LIMIT',
  'TIMEOUT',
  'NETWORK_ERROR',
  'SUPPRESSED',
  'DAILY_LIMIT_REACHED',
  'OUTSIDE_SENDING_WINDOW',
  'UNKNOWN_ERROR',
] as const;
export type AutomationErrorCode = (typeof ERROR_CODES)[number];

export const AI_INTENTS = [
  'INTERESTED',
  'NOT_INTERESTED',
  'ASKING_PRICING',
  'ASKING_INFORMATION',
  'MEETING_REQUEST',
  'REQUEST_CALLBACK',
  'NEEDS_FOLLOWUP',
  'POSITIVE',
  'NEGATIVE',
  'OUT_OF_OFFICE',
  'UNSUBSCRIBE',
  'BOUNCE',
  'OTHER',
] as const;
export type AIIntent = (typeof AI_INTENTS)[number];

export const AI_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
export type AISentiment = (typeof AI_SENTIMENTS)[number];

export const AI_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type AIPriority = (typeof AI_PRIORITIES)[number];

export const AI_REPLY_STYLES = [
  'PROFESSIONAL',
  'FRIENDLY',
  'CONCISE',
  'PERSUASIVE',
  'EXECUTIVE',
  'TECHNICAL',
  'FOLLOW_UP',
  'THANK_YOU',
  'MEETING_REQUEST',
  'PRICING_RESPONSE',
  'INFORMATION_REQUEST',
] as const;
export type AIReplyStyle = (typeof AI_REPLY_STYLES)[number];

export const AI_REPLY_LENGTHS = ['SHORT', 'MEDIUM', 'DETAILED'] as const;
export type AIReplyLength = (typeof AI_REPLY_LENGTHS)[number];

export const AI_EDIT_ACTIONS = [
  'REGENERATE',
  'SHORTEN',
  'EXPAND',
  'MAKE_PROFESSIONAL',
  'MAKE_FRIENDLY',
  'IMPROVE_GRAMMAR',
  'MAKE_PERSUASIVE',
  'REMOVE_SALES_LANGUAGE',
  'ADD_MEETING_CTA',
] as const;
export type AIEditAction = (typeof AI_EDIT_ACTIONS)[number];

export const AI_NEXT_ACTIONS = [
  'SCHEDULE_MEETING',
  'SEND_PRICING',
  'SEND_INFORMATION',
  'FOLLOW_UP_LATER',
  'NO_ACTION',
] as const;
export type AINextAction = (typeof AI_NEXT_ACTIONS)[number];

export const AI_PROVIDERS = ['local', 'openai', 'anthropic', 'gemini', 'groq'] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];

export const NOTIFICATION_TYPES = [
  'CAMPAIGN_COMPLETED',
  'CAMPAIGN_FAILED',
  'AUTH_EXPIRED',
  'WORKER_ERROR',
  'HIGH_BOUNCE_RATE',
  'NEW_IMPORTANT_REPLY',
  'AI_REPLY_AVAILABLE',
  'DAILY_DIGEST',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Intents that must never receive another automated follow-up. */
export const STOP_INTENTS: AIIntent[] = ['NOT_INTERESTED', 'UNSUBSCRIBE', 'BOUNCE'];
