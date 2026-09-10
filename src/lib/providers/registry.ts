import { anthropicAdapter } from './anthropic';
import { deepgramAdapter } from './deepgram';
import { elevenlabsAdapter } from './elevenlabs';
import { geminiAdapter } from './gemini';
import { groqAdapter } from './groq';
import { openaiAdapter } from './openai';
import { qwenAdapter } from './qwen';
import type { AIProviderAdapter, AiProviderType } from './types';

/**
 * The adapter registry.
 *
 * This is the single source of truth for which providers exist. The
 * `ai_providers` catalogue table is seeded *from here* (see
 * `scripts/seed-providers.ts`) rather than from a hand-written SQL migration,
 * so the database can never list a provider that has no adapter, or omit one
 * that does.
 *
 * That also sidesteps a real constraint: a Postgres enum value cannot be used
 * in the same transaction that adds it, and Drizzle's migrator runs all pending
 * migrations in one transaction -- so a migration that adds an enum value and
 * another that inserts a row using it can never be applied together.
 */

const ADAPTERS = [
  openaiAdapter,
  anthropicAdapter,
  geminiAdapter,
  groqAdapter,
  qwenAdapter,
  elevenlabsAdapter,
  deepgramAdapter,
] as const;

/**
 * Typed as a total record over `AiProviderType`, so adding a value to the
 * database enum fails to compile until an adapter exists for it. A provider
 * that can be registered but never collected from would otherwise sit in the
 * UI looking functional.
 */
export const PROVIDER_ADAPTERS: Record<AiProviderType, AIProviderAdapter> = Object.fromEntries(
  ADAPTERS.map((adapter) => [adapter.type, adapter])
) as Record<AiProviderType, AIProviderAdapter>;

export function getAdapter(type: AiProviderType): AIProviderAdapter {
  return PROVIDER_ADAPTERS[type];
}

/** All adapters, ordered for display: LLMs first, then speech, alphabetically. */
export function listAdapters(): readonly AIProviderAdapter[] {
  return [...ADAPTERS].sort((a, b) => {
    if (a.category !== b.category) return a.category === 'llm' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

/** The catalogue rows the database should hold, derived from the adapters. */
export function catalogueEntries(): readonly { type: AiProviderType; name: string }[] {
  return ADAPTERS.map((adapter) => ({ type: adapter.type, name: adapter.displayName }));
}
