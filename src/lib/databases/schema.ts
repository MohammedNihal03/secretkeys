import { z } from 'zod';

import { ENVIRONMENTS } from '@/lib/projects/schema';

/**
 * Validating what an operator types when registering a database.
 *
 * Deliberately strict about the host: this application will open a TCP
 * connection to whatever is entered here, so the field is a hostname or an IP,
 * never a URL and never something with a scheme, credentials or a path hiding
 * in it.
 */

const trimmed = z.string().trim();

/** Hostname labels, or a bare IPv4/IPv6 address. No scheme, port, or path. */
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/;

export const hostSchema = trimmed
  .min(1, 'Enter the database host.')
  .max(253, 'That host name is too long.')
  .refine(
    (host) => HOSTNAME_PATTERN.test(host) || IPV6_PATTERN.test(host),
    'Enter a host name or IP address only — no scheme, port, user or path.'
  );

export const portSchema = z.coerce
  .number()
  .int('The port must be a whole number.')
  .min(1, 'The port must be between 1 and 65535.')
  .max(65_535, 'The port must be between 1 and 65535.');

export const registerDatabaseSchema = z.object({
  projectId: z.uuid('Choose a project.'),
  name: trimmed.min(1, 'Give this database a name.').max(100, 'That name is too long.'),
  host: hostSchema,
  port: portSchema,
  databaseName: trimmed
    .min(1, 'Enter the database name.')
    .max(63, 'PostgreSQL database names are at most 63 characters.'),
  username: trimmed
    .min(1, 'Enter the monitoring role.')
    .max(63, 'PostgreSQL role names are at most 63 characters.'),
  password: z.string().min(1, 'Enter the password for the monitoring role.'),
  /**
   * A private certificate authority, for a server whose certificate is not
   * signed by a public one. Optional, and only meaningful with TLS on.
   */
  ca: trimmed.max(20_000, 'That certificate is too long.').optional(),
  sslEnabled: z.boolean(),
  /**
   * Opting out of certificate verification. Separate from `sslEnabled` because
   * encrypted-but-unverified is a different decision from unencrypted, and both
   * deserve to be chosen deliberately.
   */
  allowUnverifiedCertificate: z.boolean(),
  environment: z.enum(ENVIRONMENTS, 'Choose an environment.'),
});

export type RegisterDatabaseValues = z.infer<typeof registerDatabaseSchema>;

export type RegisterDatabaseFieldErrors = Partial<
  Record<keyof RegisterDatabaseValues | 'form', string>
>;

/** Reads one field from a form, as a trimmed string or null. */
function field(formData: FormData, name: string): string | null {
  const raw = formData.get(name);
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  return value === '' ? null : value;
}

function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on' || formData.get(name) === 'true';
}

export function parseRegisterDatabase(formData: FormData) {
  return registerDatabaseSchema.safeParse({
    projectId: field(formData, 'projectId') ?? '',
    name: field(formData, 'name') ?? '',
    host: field(formData, 'host') ?? '',
    port: field(formData, 'port') ?? '5432',
    databaseName: field(formData, 'databaseName') ?? '',
    username: field(formData, 'username') ?? '',
    password: formData.get('password') ?? '',
    ca: field(formData, 'ca') ?? undefined,
    sslEnabled: checkbox(formData, 'sslEnabled'),
    allowUnverifiedCertificate: checkbox(formData, 'allowUnverifiedCertificate'),
    environment: field(formData, 'environment') ?? '',
  });
}

/** Turns a Zod failure into one message per field, for the form to render. */
export function fieldErrors(error: z.ZodError): RegisterDatabaseFieldErrors {
  const errors: RegisterDatabaseFieldErrors = {};

  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in errors)) {
      errors[key as keyof RegisterDatabaseFieldErrors] = issue.message;
    }
  }

  return errors;
}
