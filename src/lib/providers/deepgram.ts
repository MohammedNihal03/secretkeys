import { providerFetch } from './http';
import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type UsageRequest,
  type UsageResult,
  type UsageWindow,
} from './types';

/**
 * Deepgram adapter.
 *
 * Docs: https://developers.deepgram.com/reference/manage/usage/breakdown/get
 *
 * The most complete usage API of the seven providers: the breakdown endpoint
 * returns requests, audio hours, token counts and TTS characters over a real
 * date range, and can group by `accessor` -- Deepgram's term for the API key
 * that made the calls. That gives genuine per-key attribution using the
 * project key itself, with no separate admin credential.
 *
 * Usage is scoped to a Deepgram *project*, so the project id is required. It is
 * discovered during credential validation and stored on the credential, which
 * avoids an extra round trip on every collection.
 */

const BASE_URL = 'https://api.deepgram.com/v1';
const PROJECTS_URL = `${BASE_URL}/projects`;

const SECONDS_PER_HOUR = 3600;

/** Deepgram uses a `Token` scheme rather than `Bearer`. */
function authHeaders(credential: ProviderCredential): Record<string, string> {
  return { Authorization: `Token ${credential.apiKey}` };
}

interface DeepgramProject {
  project_id?: string;
  name?: string;
}

interface DeepgramUsageGrouping {
  start?: string;
  end?: string;
  /** The API key that produced these calls. */
  accessor?: string | null;
  endpoint?: string | null;
  models?: string[];
  method?: string | null;
  deployment?: string | null;
}

interface DeepgramUsageRow {
  hours?: number;
  total_hours?: number;
  agent_hours?: number;
  tokens_in?: number;
  tokens_out?: number;
  tts_characters?: number;
  requests?: number;
  grouping?: DeepgramUsageGrouping;
}

interface DeepgramUsageResponse {
  start?: string;
  end?: string;
  resolution?: { units?: string; amount?: number };
  results?: DeepgramUsageRow[];
}

/** Deepgram's date parameters accept `YYYY-MM-DD` only. */
function toDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function firstProjectId(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;

  const projects = (json as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return undefined;

  const first = projects[0] as DeepgramProject | undefined;
  return first?.project_id;
}

const probe: ProbeConfig = {
  url: PROJECTS_URL,
  headers: authHeaders,
  /**
   * The project id is what makes the usage endpoint reachable, so it is
   * captured here for the caller to persist rather than rediscovered on every
   * collection.
   */
  discover: (json) => {
    const projectId = firstProjectId(json);
    return projectId ? { providerProjectId: projectId } : {};
  },
};

export const deepgramAdapter: AIProviderAdapter = {
  type: 'deepgram',
  displayName: 'Deepgram',
  category: 'speech',

  capabilities: {
    usage: 'per_key',
    // The usage endpoint reports consumption, never money.
    cost: 'none',
    limits: 'none',
    meters: ['requests', 'audio_seconds', 'characters', 'tokens'],
    notes:
      'Reports real windowed usage (requests, audio hours, tokens and TTS characters) via the project usage breakdown endpoint, groupable by API key. No cost endpoint; remaining credit is available separately via /balances but is a currency balance rather than a metered quota.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential) {
    return probeHealth(probe, credential);
  },

  async fetchLimits(): Promise<NormalizedLimits> {
    return noLimits(
      'unsupported',
      'Deepgram publishes no rate-limit or quota endpoint. Remaining credit is exposed as a currency balance via /balances, which is not a metered quota.'
    );
  },

  async fetchUsage(request: UsageRequest): Promise<UsageResult> {
    let projectId = request.credential.providerProjectId ?? undefined;

    if (!projectId) {
      // Fall back to discovery, so a credential registered before the project
      // id was recorded still works.
      const projects = await providerFetch({
        url: PROJECTS_URL,
        headers: authHeaders(request.credential),
      });

      if (!projects.ok) {
        return { supported: false, reason: 'provider_error', detail: projects.detail };
      }

      projectId = firstProjectId(projects.json);

      if (!projectId) {
        return {
          supported: false,
          reason: 'provider_error',
          detail: 'No Deepgram project is associated with this credential.',
        };
      }
    }

    const params = new URLSearchParams({
      start: toDateParam(request.window.start),
      end: toDateParam(request.window.end),
      // Attributes each row to the key that made the calls.
      grouping: 'accessor',
    });

    const usage = await providerFetch({
      url: `${BASE_URL}/projects/${encodeURIComponent(projectId)}/usage/breakdown?${params}`,
      headers: authHeaders(request.credential),
    });

    if (!usage.ok) {
      return { supported: false, reason: 'provider_error', detail: usage.detail };
    }

    return { supported: true, entries: this.normalizeMetrics(usage.json, request.window) };
  },

  normalizeMetrics(payload: unknown, window: UsageWindow): readonly NormalizedUsage[] {
    if (typeof payload !== 'object' || payload === null) return [];

    const response = payload as DeepgramUsageResponse;
    const responseStart = parseDate(response.start, window.start);
    const responseEnd = parseDate(response.end, window.end);

    return (response.results ?? []).map((row) => {
      const requests = row.requests ?? 0;
      const tokensIn = row.tokens_in ?? 0;
      const tokensOut = row.tokens_out ?? 0;

      /**
       * `total_hours` is the billable figure; `hours` excludes some request
       * types. Preferring `total_hours` matches what the provider bills for,
       * with `hours` kept below for comparison.
       */
      const billableHours = row.total_hours ?? row.hours;

      return {
        windowStart: parseDate(row.grouping?.start, responseStart),
        windowEnd: parseDate(row.grouping?.end, responseEnd),
        requests: available(requests),
        // The breakdown counts requests without splitting by outcome.
        successfulRequests: unsupported('Deepgram usage does not split requests by outcome'),
        failedRequests: unsupported('Deepgram usage does not split requests by outcome'),
        inputTokens: available(tokensIn),
        outputTokens: available(tokensOut),
        totalTokens: available(tokensIn + tokensOut),
        characters:
          typeof row.tts_characters === 'number'
            ? available(row.tts_characters)
            : unsupported('Not returned for this grouping'),
        audioSeconds:
          typeof billableHours === 'number'
            ? available(Math.round(billableHours * SECONDS_PER_HOUR))
            : unsupported('Not returned for this grouping'),
        estimatedCostUsd: unsupported('Deepgram reports consumption, not cost'),
        ...(row.grouping?.accessor ? { providerKeyId: row.grouping.accessor } : {}),
        providerRaw: {
          hours: row.hours ?? null,
          totalHours: row.total_hours ?? null,
          agentHours: row.agent_hours ?? null,
          ttsCharacters: row.tts_characters ?? null,
          endpoint: row.grouping?.endpoint ?? null,
          models: row.grouping?.models ?? null,
          method: row.grouping?.method ?? null,
          deployment: row.grouping?.deployment ?? null,
          resolution: response.resolution ?? null,
        },
      };
    });
  },
};
