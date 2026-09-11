import type { CredentialValidation } from '@/lib/providers/types';

/**
 * Turns a provider's answer into what the dashboard records.
 *
 * Pure, so the decision -- which failures reject a key and which merely leave
 * it unverified -- is tested without a network or a database.
 */

export type ValidationOutcome = 'valid' | 'invalid' | 'unverified';

export interface ValidationVerdict {
  outcome: ValidationOutcome;
  /** The form field a rejection belongs to. */
  field?: 'secret' | 'baseUrl';
}

export function classifyValidation(validation: CredentialValidation): ValidationVerdict {
  if (validation.valid) return { outcome: 'valid' };

  switch (validation.failure) {
    // The provider says this key is wrong.
    case 'unauthorized':
      return { outcome: 'invalid', field: 'secret' };

    // No request could be made at all, e.g. a missing Azure endpoint.
    case 'misconfigured':
      return { outcome: 'invalid', field: 'baseUrl' };

    /**
     * 403 is deliberately NOT a rejection. It means the provider recognised the
     * key but denied this particular check -- which is exactly what happens with
     * restricted keys that lack permission to list models yet work fine for
     * inference. Rejecting them would block legitimate credentials.
     */
    case 'forbidden':
    // Nothing was learned about the key: the provider was down, slow, or throttling.
    case 'rate_limited':
    case 'network_error':
    case 'timeout':
    case 'unexpected_status':
    default:
      return { outcome: 'unverified' };
  }
}
