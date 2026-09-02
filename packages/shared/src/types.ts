/** Wire types shared between the API and the React client. */
import type {
  AIIntent,
  AIPriority,
  AIReplyLength,
  AIReplyStyle,
  AISentiment,
  AutomationErrorCode,
  BrowserStatus,
  CampaignStatus,
  ConnectionStatus,
  ContactStatus,
  Direction,
  JobStatus,
  QueueName,
  Role,
  SessionStatus,
  ThreadStatus,
} from './enums.js';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  timezone: string;
  organizationId: string | null;
  organizationName: string | null;
  workspaces: Array<{ id: string; name: string; slug: string; role: Role; timezone: string }>;
  activeWorkspaceId: string | null;
}

export interface DashboardKpis {
  totalContacts: number;
  emailsSent: number;
  draftsCreated: number;
  replies: number;
  followUps: number;
  bounces: number;
  unsubscribes: number;
  failed: number;
  replyRate: number;
  bounceRate: number;
}

export interface SeriesPoint {
  date: string;
  [key: string]: string | number;
}

export interface DashboardResponse {
  kpis: DashboardKpis;
  activity: SeriesPoint[];
  campaignPerformance: Array<{
    id: string;
    name: string;
    status: CampaignStatus;
    sent: number;
    replies: number;
    bounces: number;
    replyRate: number;
    progress: number;
  }>;
  mailboxPerformance: Array<{
    id: string;
    email: string;
    sent: number;
    replies: number;
    bounces: number;
    dailyLimit: number;
    sentToday: number;
    connection: ConnectionStatus;
  }>;
  aiInsights: {
    analyzed: number;
    suggestionsGenerated: number;
    suggestionsSent: number;
    byIntent: Array<{ intent: AIIntent; count: number }>;
  };
  inboxActivity: { unread: number; requiresAttention: number; awaitingReply: number; aiAvailable: number };
  recentActivity: ActivityLogItem[];
}

export interface ActivityLogItem {
  id: string;
  action: string;
  status: string;
  message: string | null;
  errorCode: string | null;
  durationMs: number | null;
  retryCount: number;
  workerId: string | null;
  campaignId: string | null;
  campaignName?: string | null;
  contactId: string | null;
  createdAt: string;
}

export interface CampaignProgress {
  campaignId: string;
  status: CampaignStatus;
  total: number;
  processed: number;
  sent: number;
  drafted: number;
  failed: number;
  skipped: number;
  replies: number;
  percent: number;
  currentContact?: string | null;
  currentAction?: string | null;
  updatedAt: string;
}

export interface JobSummary {
  id: string;
  queue: QueueName | string;
  name: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: AutomationErrorCode | string | null;
  error: string | null;
  campaignId: string | null;
  campaignName?: string | null;
  payload?: Record<string, unknown>;
}

export interface EmailAccountSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  connection: ConnectionStatus;
  browserStatus: BrowserStatus;
  sessionStatus: SessionStatus;
  dailyLimit: number;
  hourlyLimit: number;
  sentToday: number;
  activeCampaigns: number;
  lastConnectedAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  signatureHtml: string | null;
}

export interface ThreadListItem {
  id: string;
  subject: string;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  status: ThreadStatus;
  lastMessageAt: string | null;
  lastMessageDirection: Direction;
  hasAttachments: boolean;
  participants: string[];
  contact: { id: string; name: string; email: string; companyName: string | null } | null;
  campaign: { id: string; name: string } | null;
  sequenceStep: string | null;
  emailAccount: { id: string; email: string };
  ai: {
    intent: AIIntent | null;
    sentiment: AISentiment | null;
    priority: AIPriority | null;
    summary: string | null;
    hasSuggestion: boolean;
  } | null;
}

export interface ThreadMessage {
  id: string;
  direction: Direction;
  sender: string;
  senderName: string | null;
  recipients: string[];
  cc: string[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string | null;
  isDraft: boolean;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

export interface ThreadDetail extends ThreadListItem {
  messages: ThreadMessage[];
  suggestions: AISuggestion[];
}

export interface AISuggestion {
  id: string;
  style: AIReplyStyle;
  length: AIReplyLength;
  suggestion: string;
  subject: string | null;
  provider: string;
  model: string | null;
  promptVersion: string;
  selected: boolean;
  edited: boolean;
  sent: boolean;
  createdAt: string;
}

export interface ContactTimelineItem {
  id: string;
  type: string;
  label: string;
  detail?: string | null;
  campaignName?: string | null;
  createdAt: string;
}

export interface RealtimeEvent {
  type:
    | 'campaign.progress'
    | 'campaign.status'
    | 'inbox.message'
    | 'inbox.updated'
    | 'worker.status'
    | 'ai.status'
    | 'notification'
    | 'job.updated'
    | 'activity';
  workspaceId: string;
  payload: unknown;
  at: string;
}

export interface ContactRecord {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  companyName: string | null;
  corporatePhone: string | null;
  employees: string | null;
  industry: string | null;
  keywords: string | null;
  personLinkedinUrl: string | null;
  website: string | null;
  companyLinkedinUrl: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyCountry: string | null;
  qualifyContact: string | null;
  status: ContactStatus;
  tags: string[];
  custom: Record<string, string>;
  notes: string | null;
  lastContactedAt: string | null;
  lastRepliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
