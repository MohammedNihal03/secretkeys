'use server';

import { revalidatePath } from 'next/cache';

import { requirePermission } from '@/lib/auth/guards';
import { filterKnownProviderIds, setAllProvidersEnabled, setProviderEnabled } from './selection';

/**
 * Provider selection mutations.
 *
 * Each re-checks permission server-side. A Server Action is a public endpoint,
 * so a toggle being hidden from a developer's UI is not access control.
 */

export interface ToggleResult {
  ok: boolean;
  error?: string;
}

export async function toggleProviderAction(
  organizationId: string,
  providerId: string,
  enabled: boolean
): Promise<ToggleResult> {
  await requirePermission(organizationId, 'providers:manage');

  /**
   * The provider id arrives from the client, so it is checked against the
   * catalogue rather than trusted. Without this, a crafted id would insert a
   * selection row pointing at nothing -- or fail on the foreign key with an
   * unhelpful error.
   */
  const [known] = await filterKnownProviderIds([providerId]);

  if (!known) {
    return { ok: false, error: 'Unknown provider.' };
  }

  await setProviderEnabled(organizationId, known, enabled);
  revalidatePath(`/organizations/${organizationId}/providers`);

  return { ok: true };
}

export async function setAllProvidersAction(
  organizationId: string,
  enabled: boolean
): Promise<ToggleResult> {
  await requirePermission(organizationId, 'providers:manage');

  await setAllProvidersEnabled(organizationId, enabled);
  revalidatePath(`/organizations/${organizationId}/providers`);

  return { ok: true };
}
