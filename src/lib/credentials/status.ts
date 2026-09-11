import type { HealthStatus } from '@/lib/health';

/**
 * How a stored credential's state is presented.
 *
 * Client-safe. Until Phase 9 collects real health, the honest signal is the
 * result of the last validation, so every label says "at the last check"
 * rather than implying ongoing monitoring that does not exist yet.
 */

export type ApiKeyStatus = 'active' | 'disabled' | 'revoked';
export type ValidationOutcomeValue = 'valid' | 'invalid' | 'unverified';

export interface CredentialStatusView {
  tone: HealthStatus;
  label: string;
  description: string;
}

export function describeCredentialStatus(
  status: ApiKeyStatus,
  outcome: ValidationOutcomeValue | null
): CredentialStatusView {
  // Lifecycle state outranks validation: a revoked key's last check is history.
  if (status === 'revoked') {
    return {
      tone: 'unknown',
      label: 'Revoked',
      description: 'Permanently retired. Kept so its usage history stays attributed.',
    };
  }

  if (status === 'disabled') {
    return {
      tone: 'unknown',
      label: 'Disabled',
      description: 'Paused. Nothing is collected with it until it is enabled again.',
    };
  }

  switch (outcome) {
    case 'valid':
      return {
        tone: 'healthy',
        label: 'Validated',
        description: 'The provider accepted this key at the last check.',
      };
    case 'unverified':
      return {
        tone: 'degraded',
        label: 'Not verified',
        description:
          'The provider could not confirm this key at the last check. It may have been unavailable or rate limiting, or the key may be restricted.',
      };
    case 'invalid':
      return {
        tone: 'unhealthy',
        label: 'Rejected',
        description: 'The provider rejected this key at the last check.',
      };
    default:
      return {
        tone: 'unknown',
        label: 'Never checked',
        description: 'This key has not been checked against its provider yet.',
      };
  }
}
