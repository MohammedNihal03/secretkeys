import { z } from 'zod';

import { ENVIRONMENTS } from '@/lib/projects/schema';
import { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH } from './mask';

/**
 * Validation for registering and editing API keys.
 *
 * Client-safe, so the same rules drive the form and the Server Action. Only
 * shape is checked here -- whether the project belongs to the organization,
 * whether the provider is tracked, and whether the key actually works are
 * decided server-side in `service.ts`.
 */

export const KEY_NAME_MAX = 80;
export const PROVIDER_KEY_ID_MAX = 200;
export const ENDPOINT_MAX = 2048;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** Permissive UUID shape. Existence and ownership are checked against the database. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Provider key identifiers such as `key_abc123` or `apikey_01AB`. */
const PROVIDER_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const idSchema = (message: string) => z.string().trim().regex(ID_PATTERN, message);

const keyNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(KEY_NAME_MAX, `Name must be ${KEY_NAME_MAX} characters or fewer`)
  .refine((value) => !CONTROL_OR_FORMAT.test(value), {
    message: 'Name must not contain control or formatting characters',
  });

/**
 * The secret itself.
 *
 * Surrounding whitespace is trimmed, because a trailing newline from a copy is
 * the most common way a correct key gets rejected. Whitespace *inside* the
 * value is refused rather than stripped: no supported provider issues keys
 * containing it, so it means a mangled paste.
 */
const secretSchema = z
  .string()
  .trim()
  .min(1, 'Paste the API key')
  .min(
    MIN_SECRET_LENGTH,
    `That is too short to be an API key — expected at least ${MIN_SECRET_LENGTH} characters`
  )
  .max(MAX_SECRET_LENGTH, 'That is too long to be an API key')
  .refine((value) => !/\s/.test(value), {
    message: 'The key contains spaces or line breaks — check it was copied exactly',
  });

const providerKeyIdSchema = z
  .string()
  .trim()
  .max(PROVIDER_KEY_ID_MAX, `Must be ${PROVIDER_KEY_ID_MAX} characters or fewer`)
  .refine((value) => value === '' || PROVIDER_KEY_ID_PATTERN.test(value), {
    message: 'Use only letters, numbers and . _ : -',
  })
  .transform((value) => (value === '' ? null : value));

/** Shape only. Which hosts are allowed is the adapter's decision. */
const endpointSchema = z
  .string()
  .trim()
  .max(ENDPOINT_MAX, 'That URL is too long')
  .transform((value) => (value === '' ? null : value));

const environmentSchema = z.enum(ENVIRONMENTS, 'Choose an environment');

export const registerApiKeySchema = z.object({
  projectId: idSchema('Choose a project'),
  providerId: idSchema('Choose a provider'),
  keyName: keyNameSchema,
  environment: environmentSchema,
  secret: secretSchema,
  providerKeyId: providerKeyIdSchema,
  baseUrl: endpointSchema,
});

/** Editable after registration. The secret is deliberately not among these. */
export const apiKeyMetadataSchema = z.object({
  keyName: keyNameSchema,
  environment: environmentSchema,
  providerKeyId: providerKeyIdSchema,
});

export type RegisterApiKeyValues = z.infer<typeof registerApiKeySchema>;
export type ApiKeyMetadataValues = z.infer<typeof apiKeyMetadataSchema>;

export type RegisterFieldErrors = Partial<Record<keyof RegisterApiKeyValues, string>>;
export type MetadataFieldErrors = Partial<Record<keyof ApiKeyMetadataValues, string>>;

/**
 * Raw non-secret input, echoed back into the form after a failed submission.
 *
 * React 19 resets a form once its action completes, so without this a single
 * validation error would wipe everything the user typed. The secret is never
 * echoed: after a failure it must be pasted again, rather than round-tripping
 * through the response.
 */
export type RegisterFormEcho = Partial<
  Record<Exclude<keyof RegisterApiKeyValues, 'secret'>, string>
>;
export type MetadataFormEcho = Partial<Record<keyof ApiKeyMetadataValues, string>>;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function firstErrorPerField<K extends string>(
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
): Partial<Record<K, string>> {
  const errors: Partial<Record<K, string>> = {};

  for (const issue of issues) {
    const name = issue.path[0];
    // The first error per field is the actionable one; later ones are consequences.
    if (typeof name === 'string' && !(name in errors)) {
      errors[name as K] = issue.message;
    }
  }

  return errors;
}

export function parseRegisterForm(
  formData: FormData
):
  | { ok: true; values: RegisterApiKeyValues; echo: RegisterFormEcho }
  | { ok: false; errors: RegisterFieldErrors; echo: RegisterFormEcho } {
  const echo: RegisterFormEcho = {
    projectId: field(formData, 'projectId'),
    providerId: field(formData, 'providerId'),
    keyName: field(formData, 'keyName'),
    environment: field(formData, 'environment'),
    providerKeyId: field(formData, 'providerKeyId'),
    baseUrl: field(formData, 'baseUrl'),
  };

  const parsed = registerApiKeySchema.safeParse({ ...echo, secret: field(formData, 'secret') });

  return parsed.success
    ? { ok: true, values: parsed.data, echo }
    : { ok: false, errors: firstErrorPerField(parsed.error.issues), echo };
}

export function parseMetadataForm(
  formData: FormData
):
  | { ok: true; values: ApiKeyMetadataValues; echo: MetadataFormEcho }
  | { ok: false; errors: MetadataFieldErrors; echo: MetadataFormEcho } {
  const echo: MetadataFormEcho = {
    keyName: field(formData, 'keyName'),
    environment: field(formData, 'environment'),
    providerKeyId: field(formData, 'providerKeyId'),
  };

  const parsed = apiKeyMetadataSchema.safeParse(echo);

  return parsed.success
    ? { ok: true, values: parsed.data, echo }
    : { ok: false, errors: firstErrorPerField(parsed.error.issues), echo };
}
