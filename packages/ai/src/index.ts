/**
 * AI facade: resolves the workspace's configured provider, applies the cost and
 * privacy controls, and exposes the three operations the product needs.
 */
import { createLogger, env } from '@mail/config';
import { tryDecrypt } from '@mail/config/crypto';
import { prisma } from '@mail/database';
import { parseJson, stringifyJson } from '@mail/shared';
import type { AIProviderName, AIReplyLength, AIReplyStyle } from '@mail/shared';
import { LocalAIProvider } from './local.provider.js';
import { RemoteAIProvider } from './remote.provider.js';
import type { AIProvider, AIProviderConfig } from './types.js';

export * from './types.js';
export * from './prompt.service.js';
export { LocalAIProvider } from './local.provider.js';
export { RemoteAIProvider } from './remote.provider.js';

const log = createLogger('ai');

export const AI_SETTINGS_KEY = 'ai';

export interface WorkspaceAISettings {
  provider: AIProviderName;
  apiKeyEncrypted: string | null;
  model: string | null;
  temperature: number;
  maxTokens: number;
  defaultStyle: AIReplyStyle;
  defaultLength: AIReplyLength;
  enableIntentDetection: boolean;
  enableThreadSummary: boolean;
  enableAIReply: boolean;
  autoGenerateReplies: boolean;
  analyzeScope: 'ALL' | 'CAMPAIGN_REPLIES' | 'UNREAD' | 'HIGH_PRIORITY';
  externalAIEnabled: boolean;
}

export const DEFAULT_AI_SETTINGS: WorkspaceAISettings = {
  provider: env.AI_PROVIDER,
  apiKeyEncrypted: null,
  model: env.AI_MODEL || null,
  temperature: env.AI_TEMPERATURE,
  maxTokens: env.AI_MAX_TOKENS,
  defaultStyle: 'PROFESSIONAL',
  defaultLength: 'MEDIUM',
  enableIntentDetection: true,
  enableThreadSummary: true,
  enableAIReply: true,
  autoGenerateReplies: false,
  analyzeScope: 'CAMPAIGN_REPLIES',
  externalAIEnabled: true,
};

export async function getAISettings(workspaceId: string): Promise<WorkspaceAISettings> {
  const row = await prisma.systemSetting.findUnique({
    where: { workspaceId_key: { workspaceId, key: AI_SETTINGS_KEY } },
  });
  const stored = parseJson<Partial<WorkspaceAISettings>>(row?.valueJson, {});
  return { ...DEFAULT_AI_SETTINGS, ...stored };
}

export async function saveAISettings(workspaceId: string, settings: WorkspaceAISettings) {
  return prisma.systemSetting.upsert({
    where: { workspaceId_key: { workspaceId, key: AI_SETTINGS_KEY } },
    create: { workspaceId, key: AI_SETTINGS_KEY, valueJson: stringifyJson(settings), isSecret: true },
    update: { valueJson: stringifyJson(settings) },
  });
}

/**
 * Returns the provider a workspace should use right now.
 *
 * Falls back to the local provider - never to an error - when external AI is
 * switched off, when no key is configured, or when the stored key cannot be
 * decrypted. Silent degradation is deliberate: an AI outage must not stop the
 * inbox from syncing.
 */
export async function getProvider(workspaceId: string): Promise<{ provider: AIProvider; settings: WorkspaceAISettings }> {
  const settings = await getAISettings(workspaceId);

  if (settings.provider === 'local' || !settings.externalAIEnabled) {
    return { provider: new LocalAIProvider(), settings };
  }

  const apiKey = tryDecrypt(settings.apiKeyEncrypted) ?? env.AI_API_KEY;
  if (!apiKey) {
    log.warn(`workspace ${workspaceId} selected ${settings.provider} but has no API key - using local provider`);
    return { provider: new LocalAIProvider(), settings };
  }

  const config: AIProviderConfig = {
    provider: settings.provider,
    apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  };

  try {
    return { provider: new RemoteAIProvider(config), settings };
  } catch (error) {
    log.error('failed to construct remote provider, falling back to local', error);
    return { provider: new LocalAIProvider(), settings };
  }
}

/** Cost control (spec section 71): decides whether a message is worth analysing. */
export function shouldAnalyze(
  settings: WorkspaceAISettings,
  message: { isRead: boolean; hasCampaign: boolean },
): boolean {
  if (!settings.enableIntentDetection) return false;
  switch (settings.analyzeScope) {
    case 'ALL':
      return true;
    case 'UNREAD':
      return !message.isRead;
    case 'CAMPAIGN_REPLIES':
      return message.hasCampaign;
    case 'HIGH_PRIORITY':
      return message.hasCampaign && !message.isRead;
    default:
      return true;
  }
}
