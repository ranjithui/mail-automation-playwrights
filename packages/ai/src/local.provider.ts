/**
 * Local provider - the default.
 *
 * A deterministic, rule-based implementation of the AIProvider contract that
 * needs no API key and sends nothing to a third party. It is genuinely useful
 * (intent detection, priority, thread summaries and template-grounded reply
 * drafts) and it means the AI surface of the product is fully operable on a
 * fresh install, offline, at zero cost. Switch to a hosted model in
 * Settings -> AI when you want generative quality.
 */
import { AI_INTENTS, truncate } from '@mail/shared';
import type { AIIntent, AINextAction, AIPriority, AISentiment } from '@mail/shared';
import {
  MISSING_INFO_RESPONSE,
  PROMPT_VERSIONS,
} from './prompt.service.js';
import type {
  AIProvider,
  EmailContext,
  IntentResult,
  ReplyContext,
  ReplySuggestion,
} from './types.js';

interface Rule {
  intent: AIIntent;
  patterns: RegExp[];
  priority: AIPriority;
  sentiment: AISentiment;
  nextAction: AINextAction;
  weight: number;
}

const RULES: Rule[] = [
  {
    intent: 'UNSUBSCRIBE',
    patterns: [/\bunsubscribe\b/i, /\bremove me\b/i, /\bstop emailing\b/i, /\bdo not contact\b/i, /\btake me off\b/i],
    priority: 'HIGH',
    sentiment: 'NEGATIVE',
    nextAction: 'NO_ACTION',
    weight: 10,
  },
  {
    intent: 'BOUNCE',
    patterns: [/address not found/i, /delivery status notification/i, /mail delivery subsystem/i, /550[ -]?5\.\d\.\d/i],
    priority: 'MEDIUM',
    sentiment: 'NEUTRAL',
    nextAction: 'NO_ACTION',
    weight: 10,
  },
  {
    intent: 'OUT_OF_OFFICE',
    patterns: [/out of (the )?office/i, /automatic reply/i, /auto[- ]?reply/i, /on leave/i, /vacation (response|reply)/i],
    priority: 'LOW',
    sentiment: 'NEUTRAL',
    nextAction: 'FOLLOW_UP_LATER',
    weight: 9,
  },
  {
    intent: 'ASKING_PRICING',
    patterns: [/\bpricing\b/i, /\bprice\b/i, /\bhow much\b/i, /\bcost\b/i, /\bquote\b/i, /\brates?\b/i, /\bbudget\b/i],
    priority: 'HIGH',
    sentiment: 'POSITIVE',
    nextAction: 'SEND_PRICING',
    weight: 8,
  },
  {
    intent: 'MEETING_REQUEST',
    patterns: [/\bcall\b/i, /\bmeeting\b/i, /\bdemo\b/i, /\bcalendar\b/i, /\bschedule\b/i, /\bavailable\b/i, /\bcatch up\b/i],
    priority: 'HIGH',
    sentiment: 'POSITIVE',
    nextAction: 'SCHEDULE_MEETING',
    weight: 7,
  },
  {
    intent: 'REQUEST_CALLBACK',
    patterns: [/\bcall me\b/i, /\bring me\b/i, /\bphone me\b/i, /\bmy number is\b/i],
    priority: 'HIGH',
    sentiment: 'POSITIVE',
    nextAction: 'SCHEDULE_MEETING',
    weight: 7,
  },
  {
    intent: 'NOT_INTERESTED',
    patterns: [/not interested/i, /no thanks/i, /\bnot a (good )?fit\b/i, /\bnot a priority\b/i, /already (have|use|renewed)/i, /\bpass\b/i],
    priority: 'LOW',
    sentiment: 'NEGATIVE',
    nextAction: 'NO_ACTION',
    weight: 6,
  },
  {
    intent: 'ASKING_INFORMATION',
    patterns: [/\bcould you (clarify|explain|share|send)\b/i, /\bmore (info|information|detail)/i, /\bhow does\b/i, /\bwhat (is|are)\b/i, /\?$/m],
    priority: 'MEDIUM',
    sentiment: 'NEUTRAL',
    nextAction: 'SEND_INFORMATION',
    weight: 5,
  },
  {
    intent: 'INTERESTED',
    patterns: [/\binterested\b/i, /\bsounds good\b/i, /\blooks (good|interesting)\b/i, /\bkeen\b/i, /\bhappy to\b/i, /\blet'?s (talk|discuss)\b/i],
    priority: 'HIGH',
    sentiment: 'POSITIVE',
    nextAction: 'SCHEDULE_MEETING',
    weight: 5,
  },
  {
    intent: 'NEEDS_FOLLOWUP',
    patterns: [/\bnext (quarter|month|year)\b/i, /\bcircle back\b/i, /\breach out (later|again)\b/i, /\bnot right now\b/i, /\brevisit\b/i],
    priority: 'MEDIUM',
    sentiment: 'NEUTRAL',
    nextAction: 'FOLLOW_UP_LATER',
    weight: 4,
  },
];

const POSITIVE_WORDS = /\b(thanks|thank you|great|excellent|helpful|appreciate|glad|perfect|yes)\b/gi;
const NEGATIVE_WORDS = /\b(no|not|never|unfortunately|disappointed|stop|remove|wrong|poor)\b/gi;

function scoreSentiment(text: string, fallback: AISentiment): AISentiment {
  const positive = (text.match(POSITIVE_WORDS) ?? []).length;
  const negative = (text.match(NEGATIVE_WORDS) ?? []).length;
  if (positive === 0 && negative === 0) return fallback;
  if (positive > negative + 1) return 'POSITIVE';
  if (negative > positive + 1) return 'NEGATIVE';
  return fallback;
}

function firstName(name: string): string {
  const clean = (name ?? '').trim();
  if (!clean || clean.includes('@')) return 'there';
  return clean.split(/\s+/)[0];
}

/** Reply scaffolds. Each one is grounded: it never asserts an unsupplied fact. */
const REPLY_BUILDERS: Partial<Record<AIIntent, (c: ReplyContext) => string[]>> = {
  ASKING_PRICING: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Thanks for coming back to me, and good question.',
    '',
    `Pricing depends on how many seats${c.contact.company ? ` ${c.contact.company}` : ' your team'} would need and which modules you want switched on, so rather than send a number that turns out not to apply, I would rather put an accurate figure in front of you.`,
    '',
    'If you can tell me the rough team size and what you would want it doing on day one, I will come back with exact numbers and what a rollout usually looks like.',
  ],
  MEETING_REQUEST: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Happy to set something up.',
    '',
    'A 30-minute call works well for this - I will walk through the parts most relevant to you and leave time for questions. Let me know a couple of windows that suit you and I will send an invite.',
  ],
  INTERESTED: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Glad it landed at a useful moment.',
    '',
    `The most efficient next step is usually a short call so I can focus on what actually matters to ${c.contact.company ?? 'your team'} rather than send a generic overview.`,
    '',
    'Would a 30-minute conversation later this week or early next work?',
  ],
  ASKING_INFORMATION: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Thanks for the question - happy to go through it properly.',
    '',
    'Rather than answer at a high level, tell me a little about how your team works today and I will respond specifically against that. If it is easier, a short call would cover it faster than email.',
  ],
  NOT_INTERESTED: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Understood, and thanks for letting me know rather than leaving it open.',
    '',
    'I will close this off. If your setup changes and it becomes relevant again, I am easy to find.',
    '',
    'All the best.',
  ],
  UNSUBSCRIBE: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'Removed - you will not hear from me again.',
    '',
    'Apologies for the intrusion.',
  ],
  OUT_OF_OFFICE: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'No problem at all - I will follow up once you are back at your desk.',
  ],
  NEEDS_FOLLOWUP: (c) => [
    `Hi ${firstName(c.contact.name)},`,
    '',
    'That makes sense, and thanks for the steer on timing.',
    '',
    'I will make a note to come back to you then. If anything moves sooner, just reply here.',
  ],
};

const GENERIC_REPLY = (c: ReplyContext) => [
  `Hi ${firstName(c.contact.name)},`,
  '',
  'Thanks for getting back to me.',
  '',
  'So I can be useful rather than generic, could you tell me a little more about what you are trying to solve and the timeline you are working to? I will respond specifically against that.',
];

function applyLength(lines: string[], length: string): string {
  if (length === 'SHORT') {
    const head = lines.slice(0, 3);
    const tail = lines.slice(3).filter(Boolean).slice(0, 1);
    return [...head, ...(tail.length ? ['', ...tail] : [])].join('\n');
  }
  if (length === 'DETAILED') {
    return [...lines, '', 'If it helps, I can also send a short written summary you can forward internally.'].join('\n');
  }
  return lines.join('\n');
}

function applyStyle(text: string, style: string): string {
  switch (style) {
    case 'CONCISE':
      return text
        .split('\n')
        .filter((l, i, arr) => l.trim() !== '' || arr[i - 1]?.trim() !== '')
        .join('\n')
        .replace(/\b(really|actually|just|simply|of course)\s/gi, '');
    case 'FRIENDLY':
      return text.replace(/^Hi /, 'Hi ').replace(/Thanks for/i, 'Thanks so much for');
    case 'EXECUTIVE':
      return text.replace(/\n\n+/g, '\n\n').replace(/I would rather/gi, 'I prefer to');
    case 'TECHNICAL':
      return text.replace(/walk through/gi, 'go through the architecture and');
    default:
      return text;
  }
}

export class LocalAIProvider implements AIProvider {
  readonly name = 'local' as const;

  async classifyIntent(context: EmailContext): Promise<IntentResult> {
    const text = `${context.subject}\n${context.latestMessage}`;
    let best: Rule | null = null;
    let bestScore = 0;
    const reasons: string[] = [];

    for (const rule of RULES) {
      const hits = rule.patterns.filter((p) => p.test(text));
      if (!hits.length) continue;
      const score = rule.weight + hits.length;
      if (score > bestScore) {
        bestScore = score;
        best = rule;
      }
      for (const hit of hits.slice(0, 2)) {
        const match = hit.exec(text);
        if (match?.[0]) reasons.push(match[0].trim().slice(0, 40));
      }
    }

    const intent = best?.intent ?? 'OTHER';
    const confidence = best ? Math.min(0.95, 0.45 + bestScore / 25) : 0.3;

    return {
      intent: AI_INTENTS.includes(intent) ? intent : 'OTHER',
      sentiment: scoreSentiment(text, best?.sentiment ?? 'NEUTRAL'),
      priority: best?.priority ?? 'MEDIUM',
      nextAction: best?.nextAction ?? 'FOLLOW_UP_LATER',
      confidence: Math.round(confidence * 100) / 100,
      reasons: [...new Set(reasons)].slice(0, 4),
      provider: 'local',
      model: 'rules-v1',
      promptVersion: PROMPT_VERSIONS.intent,
    };
  }

  async summarizeThread(context: EmailContext): Promise<string> {
    const classification = await this.classifyIntent(context);
    const who = context.contact?.name ?? 'The sender';
    const inbound = context.conversation.filter((t) => t.direction === 'INBOUND').length;
    const outbound = context.conversation.filter((t) => t.direction === 'OUTBOUND').length;

    const intentLine: Record<string, string> = {
      ASKING_PRICING: `${who} asked about pricing.`,
      MEETING_REQUEST: `${who} wants to arrange a call.`,
      INTERESTED: `${who} expressed interest.`,
      ASKING_INFORMATION: `${who} asked a question that needs a specific answer.`,
      NOT_INTERESTED: `${who} declined for now.`,
      UNSUBSCRIBE: `${who} asked to be removed from further contact.`,
      OUT_OF_OFFICE: `${who} is out of the office; this is an auto-reply.`,
      BOUNCE: 'The message could not be delivered.',
      NEEDS_FOLLOWUP: `${who} asked to be contacted again later.`,
    };

    const action: Record<string, string> = {
      SEND_PRICING: 'Recommended next action: send pricing and offer a call.',
      SCHEDULE_MEETING: 'Recommended next action: propose two specific times.',
      SEND_INFORMATION: 'Recommended next action: answer the question directly.',
      FOLLOW_UP_LATER: 'Recommended next action: schedule a follow-up for later.',
      NO_ACTION: 'Recommended next action: none - close this thread out.',
    };

    return [
      intentLine[classification.intent] ?? `${who} replied to the thread.`,
      `${outbound} message${outbound === 1 ? '' : 's'} sent, ${inbound} received.`,
      action[classification.nextAction] ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  async generateReply(context: ReplyContext): Promise<ReplySuggestion> {
    if (!context.latestMessage?.trim()) {
      return {
        text: MISSING_INFO_RESPONSE,
        subject: context.subject,
        provider: 'local',
        model: 'rules-v1',
        promptVersion: PROMPT_VERSIONS.reply,
      };
    }

    const classification = await this.classifyIntent({
      contact: context.contact,
      subject: context.subject,
      latestMessage: context.latestMessage,
      conversation: context.conversation,
    });

    const builder = REPLY_BUILDERS[classification.intent] ?? GENERIC_REPLY;
    let body = applyLength(builder(context), context.length);
    body = applyStyle(body, context.style);

    if (context.customInstructions?.trim()) {
      body += `\n\n${this.applyInstruction(context.customInstructions)}`;
    }
    body += `\n\nBest regards,\n${context.sender.name}`;

    return {
      text: body,
      subject: context.subject,
      provider: 'local',
      model: 'rules-v1',
      promptVersion: PROMPT_VERSIONS.reply,
    };
  }

  private applyInstruction(instruction: string): string {
    if (/meeting|call|next week/i.test(instruction)) {
      return 'Would a short call next week suit you? Send me two windows and I will work around them.';
    }
    if (/pricing|price|quote/i.test(instruction)) {
      return 'I can put exact numbers together once I know the team size you are planning for.';
    }
    return `On your specific point: ${truncate(instruction, 180)}`;
  }

  async editDraft(draft: string, action: string, context: ReplyContext): Promise<ReplySuggestion> {
    let text = draft;
    switch (action) {
      case 'SHORTEN': {
        const paragraphs = draft.split(/\n\s*\n/).filter(Boolean);
        text = [paragraphs[0], paragraphs[1], paragraphs[paragraphs.length - 1]].filter(Boolean).join('\n\n');
        break;
      }
      case 'EXPAND':
        text = `${draft}\n\nHappy to put this in writing in more detail if that is useful for sharing internally.`;
        break;
      case 'MAKE_PROFESSIONAL':
        text = draft.replace(/!+/g, '.').replace(/\b(hey|hiya)\b/gi, 'Hello');
        break;
      case 'MAKE_FRIENDLY':
        text = draft.replace(/^Dear /m, 'Hi ').replace(/Kind regards/gi, 'Thanks');
        break;
      case 'IMPROVE_GRAMMAR':
        text = draft
          .replace(/\s+([,.;:])/g, '$1')
          .replace(/\s{2,}/g, ' ')
          .replace(/(^|\.\s+)([a-z])/g, (_m, p1, p2) => `${p1}${p2.toUpperCase()}`);
        break;
      case 'MAKE_PERSUASIVE':
        text = `${draft}\n\nThe teams that get the most out of this usually start small and expand once the first workflow is proven.`;
        break;
      case 'REMOVE_SALES_LANGUAGE':
        text = draft.replace(
          /\b(revolutionary|game[- ]changing|world[- ]class|cutting[- ]edge|best[- ]in[- ]class|synerg\w+|leverage)\b/gi,
          '',
        );
        break;
      case 'ADD_MEETING_CTA':
        text = `${draft}\n\nWould a 30-minute call later this week work? Send two windows and I will send an invite.`;
        break;
      case 'REGENERATE':
      default:
        return this.generateReply(context);
    }

    return {
      text: text.replace(/\n{3,}/g, '\n\n').trim(),
      subject: context.subject,
      provider: 'local',
      model: 'rules-v1',
      promptVersion: PROMPT_VERSIONS.edit,
    };
  }
}
