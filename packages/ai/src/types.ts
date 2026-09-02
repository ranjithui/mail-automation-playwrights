import type {
  AIIntent,
  AINextAction,
  AIPriority,
  AIProviderName,
  AIReplyLength,
  AIReplyStyle,
  AISentiment,
} from '@mail/shared';

export interface ContactContext {
  name: string;
  email: string;
  company: string | null;
  title: string | null;
  industry: string | null;
  city?: string | null;
  country?: string | null;
}

export interface CampaignContext {
  name: string;
  sequenceStep: number;
  stepName: string | null;
}

export interface ConversationTurn {
  direction: 'INBOUND' | 'OUTBOUND';
  from: string;
  at: string;
  text: string;
}

/** Everything the prompt builder is allowed to see. Nothing else leaves the backend. */
export interface ReplyContext {
  contact: ContactContext;
  campaign: CampaignContext | null;
  conversation: ConversationTurn[];
  latestMessage: string;
  originalMessage: string;
  sender: { name: string; email: string; signature?: string | null };
  style: AIReplyStyle;
  length: AIReplyLength;
  customInstructions?: string | null;
  subject: string;
}

export interface EmailContext {
  contact: ContactContext | null;
  subject: string;
  latestMessage: string;
  conversation: ConversationTurn[];
}

export interface ReplySuggestion {
  text: string;
  subject: string | null;
  provider: AIProviderName;
  model: string | null;
  promptVersion: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface IntentResult {
  intent: AIIntent;
  sentiment: AISentiment;
  priority: AIPriority;
  nextAction: AINextAction;
  confidence: number;
  reasons: string[];
  provider: AIProviderName;
  model: string | null;
  promptVersion: string;
}

export interface AIProviderConfig {
  provider: AIProviderName;
  apiKey?: string | null;
  model?: string | null;
  temperature: number;
  maxTokens: number;
}

/** The contract each provider implements (spec section 60). */
export interface AIProvider {
  readonly name: AIProviderName;
  generateReply(context: ReplyContext): Promise<ReplySuggestion>;
  classifyIntent(context: EmailContext): Promise<IntentResult>;
  summarizeThread(context: EmailContext): Promise<string>;
  editDraft(draft: string, action: string, context: ReplyContext): Promise<ReplySuggestion>;
}
