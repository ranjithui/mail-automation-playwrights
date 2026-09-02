/**
 * Hosted model providers.
 *
 * One class covers OpenAI, Anthropic, Gemini and Groq because the only real
 * differences are the endpoint, the auth header and the request/response shape.
 * Adding a further provider (or a local server such as Ollama exposing an
 * OpenAI-compatible endpoint) means adding one entry to `ENDPOINTS`.
 *
 * Privacy: only the fields assembled by ReplyPromptService are transmitted.
 * Passwords, cookies, session tokens, browser state and unrelated mail are
 * never part of a prompt, and a workspace admin can disable external AI
 * entirely (Settings -> AI -> external AI), which pins the provider to `local`.
 */
import { createLogger } from '@mail/config';
import { AI_INTENTS, AI_PRIORITIES, AI_SENTIMENTS } from '@mail/shared';
import type { AIIntent, AINextAction, AIPriority, AIProviderName, AISentiment } from '@mail/shared';
import {
  buildEditPrompt,
  buildIntentPrompt,
  buildReplyPrompt,
  buildSummaryPrompt,
  PROMPT_VERSIONS,
} from './prompt.service.js';
import type {
  AIProvider,
  AIProviderConfig,
  EmailContext,
  IntentResult,
  ReplyContext,
  ReplySuggestion,
} from './types.js';

const log = createLogger('ai');

interface Endpoint {
  url: (model: string, apiKey: string) => string;
  defaultModel: string;
  headers: (apiKey: string) => Record<string, string>;
  body: (system: string, user: string, config: AIProviderConfig, model: string) => unknown;
  extract: (json: any) => { text: string; tokensIn?: number; tokensOut?: number };
}

const ENDPOINTS: Record<Exclude<AIProviderName, 'local'>, Endpoint> = {
  openai: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: (system, user, config, model) => ({
      model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    extract: (json) => ({
      text: json?.choices?.[0]?.message?.content ?? '',
      tokensIn: json?.usage?.prompt_tokens,
      tokensOut: json?.usage?.completion_tokens,
    }),
  },

  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5',
    headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    body: (system, user, config, model) => ({
      model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    extract: (json) => ({
      text: Array.isArray(json?.content) ? json.content.map((c: any) => c?.text ?? '').join('') : '',
      tokensIn: json?.usage?.input_tokens,
      tokensOut: json?.usage?.output_tokens,
    }),
  },

  gemini: {
    url: (model, key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    defaultModel: 'gemini-2.0-flash',
    headers: () => ({ 'content-type': 'application/json' }),
    body: (system, user, config) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: config.temperature, maxOutputTokens: config.maxTokens },
    }),
    extract: (json) => ({
      text: json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '',
      tokensIn: json?.usageMetadata?.promptTokenCount,
      tokensOut: json?.usageMetadata?.candidatesTokenCount,
    }),
  },

  groq: {
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: (system, user, config, model) => ({
      model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    extract: (json) => ({
      text: json?.choices?.[0]?.message?.content ?? '',
      tokensIn: json?.usage?.prompt_tokens,
      tokensOut: json?.usage?.completion_tokens,
    }),
  },
};

export class RemoteAIProvider implements AIProvider {
  readonly name: AIProviderName;
  private readonly endpoint: Endpoint;
  private readonly model: string;

  constructor(private readonly config: AIProviderConfig) {
    if (config.provider === 'local') throw new Error('RemoteAIProvider cannot wrap the local provider');
    this.name = config.provider;
    this.endpoint = ENDPOINTS[config.provider];
    this.model = config.model?.trim() || this.endpoint.defaultModel;
  }

  private async chat(system: string, user: string): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error(`No API key configured for provider "${this.name}"`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(this.endpoint.url(this.model, apiKey), {
        method: 'POST',
        headers: this.endpoint.headers(apiKey),
        body: JSON.stringify(this.endpoint.body(system, user, this.config, this.model)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${this.name} responded ${response.status}: ${detail.slice(0, 300)}`);
      }
      return this.endpoint.extract(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateReply(context: ReplyContext): Promise<ReplySuggestion> {
    const prompt = buildReplyPrompt(context);
    const result = await this.chat(prompt.system, prompt.user);
    return {
      text: cleanBody(result.text),
      subject: context.subject,
      provider: this.name,
      model: this.model,
      promptVersion: prompt.version,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };
  }

  async editDraft(draft: string, action: string, context: ReplyContext): Promise<ReplySuggestion> {
    const prompt = buildEditPrompt(draft, action, context);
    const result = await this.chat(prompt.system, prompt.user);
    return {
      text: cleanBody(result.text),
      subject: context.subject,
      provider: this.name,
      model: this.model,
      promptVersion: prompt.version,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };
  }

  async classifyIntent(context: EmailContext): Promise<IntentResult> {
    const prompt = buildIntentPrompt(context);
    const result = await this.chat(prompt.system, prompt.user);
    const parsed = extractJson(result.text);

    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
      typeof value === 'string' && (allowed as readonly string[]).includes(value.toUpperCase())
        ? (value.toUpperCase() as T)
        : fallback;

    return {
      intent: pick<AIIntent>(parsed?.intent, AI_INTENTS, 'OTHER'),
      sentiment: pick<AISentiment>(parsed?.sentiment, AI_SENTIMENTS, 'NEUTRAL'),
      priority: pick<AIPriority>(parsed?.priority, AI_PRIORITIES, 'MEDIUM'),
      nextAction: (parsed?.nextAction as AINextAction) ?? 'FOLLOW_UP_LATER',
      confidence: typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasons: Array.isArray(parsed?.reasons) ? parsed.reasons.slice(0, 4).map(String) : [],
      provider: this.name,
      model: this.model,
      promptVersion: prompt.version,
    };
  }

  async summarizeThread(context: EmailContext): Promise<string> {
    const prompt = buildSummaryPrompt(context);
    const result = await this.chat(prompt.system, prompt.user);
    return result.text.trim();
  }
}

function cleanBody(text: string): string {
  return (text ?? '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/, '')
    .replace(/^subject:.*\n+/i, '')
    .trim();
}

function extractJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    log.warn('AI returned unparsable JSON for classification');
    return null;
  }
}
