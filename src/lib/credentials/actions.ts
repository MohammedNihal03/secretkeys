'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { resolveAllFor } from '@/lib/alerts/repository';
import { requirePermission } from '@/lib/auth/guards';
import {
  parseMetadataForm,
  parseRegisterForm,
  type MetadataFieldErrors,
  type MetadataFormEcho,
  type RegisterFieldErrors,
  type RegisterFormEcho,
} from './schema';
import { registerApiKey, revalidateApiKey, setApiKeyStatus, updateApiKeyMetadata } from './service';
import type { ApiKeyStatus } from './status';

/**
 * API key mutations.
 *
 * Every action re-checks `api_keys:manage` server-side. A Server Action is a
 * public endpoint, so a button being hidden from a developer is not access
 * control. The organization and key ids are bound on the server, never read
 * from the submitted form.
 *
 * No action returns the secret, or anything derived from it beyond the
 * validation outcome.
 */

export interface RegisterFormState {
  errors?: RegisterFieldErrors;
  error?: string;
  /** Non-secret input echoed back so a failed submission does not wipe the form. */
  values?: RegisterFormEcho;
}

export async function registerApiKeyAction(
  organizationId: string,
  _previous: RegisterFormState,
  formData: FormData
): Promise<RegisterFormState> {
  await requirePermission(organizationId, 'api_keys:manage');

  const parsed = parseRegisterForm(formData);
  if (!parsed.ok) return { errors: parsed.errors, values: parsed.echo };

  const result = await registerApiKey(organizationId, parsed.values);

  if (!result.ok) {
    return 'errors' in result
      ? { errors: result.errors, values: parsed.echo }
      : { error: result.error, values: parsed.echo };
  }

  revalidatePath(`/organizations/${organizationId}/keys`);
  redirect(`/organizations/${organizationId}/keys/${result.apiKeyId}?registered=${result.outcome}`);
}

export interface KeyActionResult {
  ok: boolean;
  message: string;
}

const OUTCOME_MESSAGE = {
  valid: 'The provider accepted this key.',
  unverified: 'The provider could not confirm this key.',
  invalid: 'The provider rejected this key.',
} as const;

export async function revalidateApiKeyAction(
  organizationId: string,
  apiKeyId: string
): Promise<KeyActionResult> {
  await requirePermission(organizationId, 'api_keys:manage');

  const result = await revalidateApiKey(organizationId, apiKeyId);
  revalidatePath(`/organizations/${organizationId}/keys/${apiKeyId}`);

  if (!result.ok) return { ok: false, message: result.error };

  return {
    ok: result.outcome !== 'invalid',
    message: result.detail
      ? `${OUTCOME_MESSAGE[result.outcome]} ${result.detail}`
      : OUTCOME_MESSAGE[result.outcome],
  };
}

export async function setApiKeyStatusAction(
  organizationId: string,
  apiKeyId: string,
  status: ApiKeyStatus
): Promise<KeyActionResult> {
  await requirePermission(organizationId, 'api_keys:manage');

  // The status arrives from the client, so it is checked rather than trusted.
  if (status !== 'active' && status !== 'disabled' && status !== 'revoked') {
    return { ok: false, message: 'Unknown status.' };
  }

  const result = await setApiKeyStatus(organizationId, apiKeyId, status);

  /**
   * A credential nobody collects from can never clear its own alerts, and an
   * alert that cannot be cleared is what teaches people to ignore the list.
   */
  if (result.ok && status !== 'active') {
    await resolveAllFor(organizationId, apiKeyId);
  }

  revalidatePath(`/organizations/${organizationId}/keys`);
  revalidatePath(`/organizations/${organizationId}/keys/${apiKeyId}`);

  if (!result.ok) return { ok: false, message: result.error };

  const labels = { active: 'Enabled.', disabled: 'Disabled.', revoked: 'Revoked.' } as const;
  return { ok: true, message: labels[status] };
}

export interface MetadataFormState {
  errors?: MetadataFieldErrors;
  error?: string;
  saved?: boolean;
  values?: MetadataFormEcho;
}

export async function updateApiKeyMetadataAction(
  organizationId: string,
  apiKeyId: string,
  _previous: MetadataFormState,
  formData: FormData
): Promise<MetadataFormState> {
  await requirePermission(organizationId, 'api_keys:manage');

  const parsed = parseMetadataForm(formData);
  if (!parsed.ok) return { errors: parsed.errors, values: parsed.echo };

  const result = await updateApiKeyMetadata(organizationId, apiKeyId, parsed.values);

  if (!result.ok) {
    return 'errors' in result
      ? { errors: result.errors, values: parsed.echo }
      : { error: result.error, values: parsed.echo };
  }

  revalidatePath(`/organizations/${organizationId}/keys`);
  revalidatePath(`/organizations/${organizationId}/keys/${apiKeyId}`);

  return { saved: true, values: parsed.echo };
}
