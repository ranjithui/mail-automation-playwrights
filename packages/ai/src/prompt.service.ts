/**
 * ReplyPromptService.
 *
 * All prompt text lives here - never inside React components and never inside
 * a route handler. Prompts are versioned and the version is persisted with
 * every AI result so an output can always be traced back to the exact prompt
 * that produced it.
 */
import type { EmailContext, ReplyContext } from './types.js';

export const PROMPT_VERSIONS = {
  reply: 'reply-v1',
  intent: 'intent-v1',
  summary: 'summary-v1',
  edit: 'edit-v1',
} as const;

const LENGTH_GUIDANCE: Record<string, string> = {
  SHORT: 'Keep it under 70 words. Two short paragraphs at most.',
  MEDIUM: 'Aim for 90-140 words across two or three short paragraphs.',
  DETAILED: 'Up to 220 words. Use short paragraphs and, where it helps, a compact bullet list.',
};

const STYLE_GUIDANCE: Record<string, string> = {
  PROFESSIONAL: 'Measured, business-appropriate, courteous. No slang, no exclamation marks.',
  FRIENDLY: 'Warm and conversational while still professional. Contractions are fine.',
  CONCISE: 'Strip every unnecessary word. Lead with the answer.',
  PERSUASIVE: 'Lead with concrete value and end with one clear, low-friction ask.',
  EXECUTIVE: 'Brief and decisive, written the way a senior leader writes. No filler.',
  TECHNICAL: 'Precise and specific. Use correct terminology and avoid marketing language.',
  FOLLOW_UP: 'A polite nudge that adds one new piece of value rather than merely bumping the thread.',
  THANK_YOU: 'Appreciative and specific about what you are thanking them for.',
  MEETING_REQUEST: 'Propose a meeting with two concrete time options and a clear purpose.',
  PRICING_RESPONSE: 'Respond to the pricing question using only figures present in the context.',
  INFORMATION_REQUEST: 'Answer the question asked directly, then offer one relevant next step.',
};

/**
 * Guardrails (spec section 74). These are stated as hard constraints because
 * a fabricated price or invented availability in an outbound sales email is a
 * commercial and legal problem, not a cosmetic one.
 */
export const GUARDRAILS = [
  'Use ONLY facts present in the supplied context.',
  'Never invent pricing, discounts, contract terms or figures of any kind.',
  'Never invent product features, integrations, certifications or customers.',
  'Never promise a capability, timeline or delivery date that is not stated in the context.',
  'Never invent meeting availability; propose times only in relative terms unless specific times are given.',
  'If the recipient asked to be removed, acknowledge and confirm removal. Do not sell.',
  'Preserve the sender\'s intent; do not change what was previously committed to.',
  'Write only the body of the email. No subject line, no "Subject:" prefix, no markdown fences.',
  'Do not add a signature block; the platform appends the sender signature.',
  'If required information is missing, say exactly: "Additional information is required before generating a reliable response." and nothing else.',
].join('\n- ');

function conversationBlock(context: { conversation: ReplyContext['conversation'] }): string {
  if (!context.conversation.length) return '(no prior messages)';
  return context.conversation
    .slice(-8)
    .map((turn) => `[${turn.direction}] ${turn.from} (${turn.at}):\n${turn.text.slice(0, 1500)}`)
    .join('\n\n---\n\n');
}

export interface BuiltPrompt {
  system: string;
  user: string;
  version: string;
}

export function buildReplyPrompt(context: ReplyContext): BuiltPrompt {
  const system = [
    'You draft replies to business emails on behalf of a named sender.',
    'The draft is reviewed and edited by a human before it is ever sent, so accuracy matters more than polish.',
    '',
    'Hard constraints:',
    `- ${GUARDRAILS}`,
  ].join('\n');

  const user = [
    `SENDER: ${context.sender.name} <${context.sender.email}>`,
    '',
    'RECIPIENT:',
    JSON.stringify(
      {
        name: context.contact.name,
        company: context.contact.company,
        title: context.contact.title,
        industry: context.contact.industry,
      },
      null,
      2,
    ),
    '',
    context.campaign
      ? `CAMPAIGN: ${context.campaign.name} (sequence step ${context.campaign.sequenceStep}${
          context.campaign.stepName ? `: ${context.campaign.stepName}` : ''
        })`
      : 'CAMPAIGN: none',
    '',
    `SUBJECT: ${context.subject}`,
    '',
    'CONVERSATION SO FAR:',
    conversationBlock(context),
    '',
    'MESSAGE TO REPLY TO:',
    context.latestMessage.slice(0, 4000),
    '',
    `TONE: ${context.style} - ${STYLE_GUIDANCE[context.style] ?? ''}`,
    `LENGTH: ${context.length} - ${LENGTH_GUIDANCE[context.length] ?? ''}`,
    context.customInstructions ? `\nADDITIONAL INSTRUCTIONS FROM THE USER:\n${context.customInstructions}` : '',
    '',
    'Write the reply body now.',
  ].join('\n');

  return { system, user, version: PROMPT_VERSIONS.reply };
}

export function buildIntentPrompt(context: EmailContext): BuiltPrompt {
  const system = [
    'You classify inbound business email. Respond with a single JSON object and nothing else.',
    '',
    'Schema:',
    '{',
    '  "intent": "INTERESTED|NOT_INTERESTED|ASKING_PRICING|ASKING_INFORMATION|MEETING_REQUEST|REQUEST_CALLBACK|NEEDS_FOLLOWUP|POSITIVE|NEGATIVE|OUT_OF_OFFICE|UNSUBSCRIBE|BOUNCE|OTHER",',
    '  "sentiment": "POSITIVE|NEUTRAL|NEGATIVE",',
    '  "priority": "HIGH|MEDIUM|LOW",',
    '  "nextAction": "SCHEDULE_MEETING|SEND_PRICING|SEND_INFORMATION|FOLLOW_UP_LATER|NO_ACTION",',
    '  "confidence": 0.0-1.0,',
    '  "summary": "one or two sentences",',
    '  "reasons": ["short evidence phrases quoted from the email"]',
    '}',
    '',
    'Treat sentiment and priority as assistive signals, not facts. Prefer lower confidence when uncertain.',
  ].join('\n');

  const user = [
    context.contact ? `SENDER CONTEXT: ${JSON.stringify(context.contact)}` : 'SENDER CONTEXT: unknown contact',
    `SUBJECT: ${context.subject}`,
    '',
    'EMAIL:',
    context.latestMessage.slice(0, 4000),
  ].join('\n');

  return { system, user, version: PROMPT_VERSIONS.intent };
}

export function buildSummaryPrompt(context: EmailContext): BuiltPrompt {
  const system =
    'Summarise an email thread for a salesperson in at most three sentences: what the prospect wants, ' +
    'where the conversation stands, and the single most useful next action. Use only what is in the thread.';

  const user = ['THREAD:', conversationBlock(context), '', 'LATEST MESSAGE:', context.latestMessage.slice(0, 3000)].join('\n');
  return { system, user, version: PROMPT_VERSIONS.summary };
}

const EDIT_INSTRUCTIONS: Record<string, string> = {
  REGENERATE: 'Rewrite the draft from scratch with the same intent but different phrasing.',
  SHORTEN: 'Cut the draft to roughly half its length while keeping every commitment intact.',
  EXPAND: 'Add useful specificity. Do not add any fact that is not already in the context.',
  MAKE_PROFESSIONAL: 'Rewrite in a measured, business-appropriate register.',
  MAKE_FRIENDLY: 'Rewrite in a warmer, more conversational register.',
  IMPROVE_GRAMMAR: 'Fix grammar, spelling and punctuation. Change nothing else.',
  MAKE_PERSUASIVE: 'Sharpen the value proposition and end with one clear ask.',
  REMOVE_SALES_LANGUAGE: 'Strip marketing language, superlatives and hype. Keep it plain and factual.',
  ADD_MEETING_CTA: 'Keep the draft and add a short closing paragraph proposing a meeting.',
};

export function buildEditPrompt(draft: string, action: string, context: ReplyContext): BuiltPrompt {
  const system = [
    'You edit an email draft that a human will review before sending.',
    'Return only the edited body text.',
    '',
    'Hard constraints:',
    `- ${GUARDRAILS}`,
  ].join('\n');

  const user = [
    `EDIT ACTION: ${action} - ${EDIT_INSTRUCTIONS[action] ?? 'Improve the draft.'}`,
    '',
    'CONTEXT (for accuracy only, do not restate):',
    `Recipient: ${context.contact.name}${context.contact.company ? ` at ${context.contact.company}` : ''}`,
    `Their message: ${context.latestMessage.slice(0, 1500)}`,
    '',
    'CURRENT DRAFT:',
    draft,
  ].join('\n');

  return { system, user, version: PROMPT_VERSIONS.edit };
}

export const MISSING_INFO_RESPONSE =
  'Additional information is required before generating a reliable response.';
