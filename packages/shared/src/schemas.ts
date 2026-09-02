/**
 * Zod contracts. The API validates every request body with these and the React
 * forms reuse the exact same objects through @hookform/resolvers, so the two
 * layers can never drift.
 */
import { z } from 'zod';
import {
  AI_EDIT_ACTIONS,
  AI_PROVIDERS,
  AI_REPLY_LENGTHS,
  AI_REPLY_STYLES,
  CAMPAIGN_MODES,
  CAMPAIGN_STATUSES,
  CONTACT_STATUSES,
  ROLES,
  STEP_TYPES,
  SUPPRESSION_TYPES,
} from './enums.js';

export const idSchema = z.string().min(1);
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const clockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:mm, e.g. 09:30');

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/\d/, 'Include a number');

// ---------------------------------------------------------------- auth

export const registerSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(60),
  lastName: z.string().trim().min(1, 'Last name is required').max(60),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(2, 'Organization name is required').max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  remember: z.boolean().optional().default(true),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  timezone: z.string().min(1).default('Asia/Kolkata'),
});

// ---------------------------------------------------------- workspace

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z.string().min(1).default('Asia/Kolkata'),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).default('USER'),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  password: passwordSchema,
});

export const updateMemberRoleSchema = z.object({ role: z.enum(ROLES) });

// ------------------------------------------------------- email account

export const createEmailAccountSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80),
  dailyLimit: z.coerce.number().int().min(1).max(2000).default(200),
  hourlyLimit: z.coerce.number().int().min(1).max(500).default(40),
  signatureHtml: z.string().max(5000).optional().nullable(),
});

export const updateEmailAccountSchema = createEmailAccountSchema.partial().extend({
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']).optional(),
});

// ------------------------------------------------------------ contacts

export const contactSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().max(80).optional().nullable(),
  lastName: z.string().trim().max(80).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  companyName: z.string().trim().max(160).optional().nullable(),
  corporatePhone: z.string().trim().max(60).optional().nullable(),
  employees: z.string().trim().max(40).optional().nullable(),
  industry: z.string().trim().max(120).optional().nullable(),
  keywords: z.string().trim().max(400).optional().nullable(),
  personLinkedinUrl: z.string().trim().max(300).optional().nullable(),
  website: z.string().trim().max(300).optional().nullable(),
  companyLinkedinUrl: z.string().trim().max(300).optional().nullable(),
  companyAddress: z.string().trim().max(300).optional().nullable(),
  companyCity: z.string().trim().max(120).optional().nullable(),
  companyState: z.string().trim().max(120).optional().nullable(),
  companyCountry: z.string().trim().max(120).optional().nullable(),
  qualifyContact: z.string().trim().max(120).optional().nullable(),
  status: z.enum(CONTACT_STATUSES).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  custom: z.record(z.string()).optional(),
  notes: z.string().max(4000).optional().nullable(),
});

export const contactQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  listId: z.string().optional(),
  tag: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['createdAt', 'email', 'companyName', 'lastName', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const bulkContactActionSchema = z.object({
  ids: z.array(idSchema).min(1, 'Select at least one contact'),
  action: z.enum(['DELETE', 'ADD_TO_LIST', 'REMOVE_FROM_LIST', 'SET_STATUS', 'ADD_TAG', 'SUPPRESS']),
  listId: idSchema.optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
});

export const contactListSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional().nullable(),
});

export const importCommitSchema = z.object({
  listId: idSchema.optional().nullable(),
  createList: z.string().trim().min(1).max(80).optional().nullable(),
  mapping: z.record(z.string()),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).min(1).max(20000),
  skipDuplicates: z.boolean().default(true),
  updateExisting: z.boolean().default(false),
});

// ----------------------------------------------------------- templates

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60).default('GENERAL'),
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  bodyHtml: z.string().min(1, 'Body is required'),
  bodyText: z.string().optional().nullable(),
  description: z.string().max(400).optional().nullable(),
  attachmentIds: z.array(idSchema).max(20).optional(),
});

export const templatePreviewSchema = z.object({
  subject: z.string().default(''),
  bodyHtml: z.string().default(''),
  contactId: idSchema.optional(),
  sample: z.record(z.string()).optional(),
});

// ----------------------------------------------------------- campaigns

export const campaignStepSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(STEP_TYPES).default('FOLLOWUP'),
  templateId: idSchema.optional().nullable(),
  subjectOverride: z.string().max(300).optional().nullable(),
  bodyOverride: z.string().optional().nullable(),
  delayDays: z.coerce.number().int().min(0).max(365).default(3),
  delayHours: z.coerce.number().int().min(0).max(23).default(0),
  replyInThread: z.boolean().default(true),
  enabled: z.boolean().default(true),
  attachmentIds: z.array(idSchema).max(20).optional(),
});

export const campaignSchema = z
  .object({
    name: z.string().trim().min(2, 'Campaign name is required').max(120),
    description: z.string().max(1000).optional().nullable(),
    emailAccountId: idSchema.optional().nullable(),
    contactListId: idSchema.optional().nullable(),
    mode: z.enum(CAMPAIGN_MODES).default('SEND'),
    timezone: z.string().min(1).default('Asia/Kolkata'),
    startDate: z.string().datetime().optional().nullable(),
    sendWindowStart: clockSchema.default('09:30'),
    sendWindowEnd: clockSchema.default('17:30'),
    sendDays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
    /** Ignore the sending window and dispatch as soon as the campaign starts. */
    sendImmediately: z.boolean().default(false),
    dailyLimit: z.coerce.number().int().min(1).max(2000).default(100),
    minDelaySec: z.coerce.number().int().min(0).max(3600).default(30),
    maxDelaySec: z.coerce.number().int().min(0).max(7200).default(60),
    randomDelay: z.boolean().default(true),
    trackOpens: z.boolean().default(false),
    stopOnReply: z.boolean().default(true),
  })
  .refine((v) => v.maxDelaySec >= v.minDelaySec, {
    message: 'Maximum delay must be greater than or equal to minimum delay',
    path: ['maxDelaySec'],
  });

export const campaignUpdateSchema = campaignSchema.innerType().partial().extend({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

export const campaignContactsSchema = z.object({
  contactIds: z.array(idSchema).optional(),
  listId: idSchema.optional(),
  replaceExisting: z.boolean().default(false),
});

export const campaignLaunchSchema = z.object({
  startAt: z.string().datetime().optional().nullable(),
  mode: z.enum(CAMPAIGN_MODES).optional(),
});

export const campaignTestSchema = z.object({
  contactId: idSchema.optional(),
  stepId: idSchema.optional(),
  target: z.enum(['FIRST_CONTACT', 'SELECTED', 'ENTIRE_CAMPAIGN']).default('FIRST_CONTACT'),
  contactIds: z.array(idSchema).optional(),
});

// --------------------------------------------------------------- inbox

export const inboxQuerySchema = z.object({
  folder: z
    .enum(['ALL', 'UNREAD', 'IMPORTANT', 'REPLIED', 'WAITING', 'AI_SUGGESTED', 'ARCHIVED'])
    .default('ALL'),
  q: z.string().trim().optional(),
  emailAccountId: idSchema.optional(),
  campaignId: idSchema.optional(),
  intent: z.string().optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  starred: z.coerce.boolean().optional(),
  hasAttachment: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const threadActionSchema = z.object({
  action: z.enum(['MARK_READ', 'MARK_UNREAD', 'STAR', 'UNSTAR', 'ARCHIVE', 'UNARCHIVE', 'IMPORTANT']),
});

export const composeReplySchema = z.object({
  bodyHtml: z.string().min(1, 'Write a message before sending'),
  subject: z.string().max(300).optional(),
  cc: z.array(emailSchema).max(20).optional(),
  bcc: z.array(emailSchema).max(20).optional(),
  attachmentIds: z.array(idSchema).max(20).optional(),
  mode: z.enum(['DRAFT', 'SEND']).default('DRAFT'),
  suggestionId: idSchema.optional(),
});

// ------------------------------------------------------------------ ai

export const aiGenerateSchema = z.object({
  threadId: idSchema,
  messageId: idSchema.optional(),
  style: z.enum(AI_REPLY_STYLES).default('PROFESSIONAL'),
  length: z.enum(AI_REPLY_LENGTHS).default('MEDIUM'),
  customInstructions: z.string().max(1000).optional(),
  variants: z.coerce.number().int().min(1).max(3).default(1),
});

export const aiEditSchema = z.object({
  suggestionId: idSchema.optional(),
  threadId: idSchema,
  draft: z.string().min(1),
  action: z.enum(AI_EDIT_ACTIONS),
});

export const aiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('local'),
  apiKey: z.string().max(300).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  temperature: z.coerce.number().min(0).max(2).default(0.4),
  maxTokens: z.coerce.number().int().min(64).max(8000).default(800),
  defaultStyle: z.enum(AI_REPLY_STYLES).default('PROFESSIONAL'),
  defaultLength: z.enum(AI_REPLY_LENGTHS).default('MEDIUM'),
  enableIntentDetection: z.boolean().default(true),
  enableThreadSummary: z.boolean().default(true),
  enableAIReply: z.boolean().default(true),
  autoGenerateReplies: z.boolean().default(false),
  analyzeScope: z.enum(['ALL', 'CAMPAIGN_REPLIES', 'UNREAD', 'HIGH_PRIORITY']).default('CAMPAIGN_REPLIES'),
  externalAIEnabled: z.boolean().default(true),
});

// ---------------------------------------------------- safety & settings

export const suppressionSchema = z.object({
  value: z.string().trim().min(3).max(200),
  scope: z.enum(['EMAIL', 'DOMAIN']).default('EMAIL'),
  type: z.enum(SUPPRESSION_TYPES).default('MANUAL_BLOCK'),
  reason: z.string().max(300).optional().nullable(),
});

export const workspaceSettingsSchema = z.object({
  timezone: z.string().min(1).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  sendWindowStart: clockSchema.optional(),
  sendWindowEnd: clockSchema.optional(),
  defaultDailyLimit: z.coerce.number().int().min(1).max(2000).optional(),
  skipWhenOutOfOffice: z.boolean().optional(),
  notifyOnReply: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
});

export const migrationSchema = z.object({
  sheets: z
    .array(
      z.object({
        name: z.string().min(1),
        rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
      }),
    )
    .min(1),
  createCampaigns: z.boolean().default(true),
  emailAccountId: idSchema.optional().nullable(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type CampaignInput = z.infer<typeof campaignSchema>;
export type CampaignStepInput = z.infer<typeof campaignStepSchema>;
export type TemplateInput = z.infer<typeof templateSchema>;
export type AIGenerateInput = z.infer<typeof aiGenerateSchema>;
export type AISettingsInput = z.infer<typeof aiSettingsSchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type ContactQuery = z.infer<typeof contactQuerySchema>;
