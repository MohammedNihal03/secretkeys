import { z } from 'zod';

/**
 * Validation for project input.
 *
 * Kept separate from the database schema so the same rules apply to a form
 * submission, a Server Action and any future API route -- validation that lives
 * inside one handler is validation the next caller forgets.
 */

export const ENVIRONMENTS = ['production', 'staging', 'development'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
};

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTION_MAX = 500;

export const projectInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(PROJECT_NAME_MAX, `Name must be ${PROJECT_NAME_MAX} characters or fewer`)
    /**
     * Control characters are rejected rather than stripped. A name containing a
     * newline or a zero-width character looks identical to a legitimate one in
     * the UI, which is a way to make two projects visually indistinguishable.
     */
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: 'Name must not contain control or formatting characters',
    }),

  description: z
    .string()
    .trim()
    .max(
      PROJECT_DESCRIPTION_MAX,
      `Description must be ${PROJECT_DESCRIPTION_MAX} characters or fewer`
    )
    // An empty textarea should clear the field, not store "".
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null),

  environment: z.enum(ENVIRONMENTS),
});

export type ProjectInputValues = z.infer<typeof projectInputSchema>;

/** Field-level errors, keyed by form field name. */
export type FieldErrors = Partial<Record<keyof ProjectInputValues, string>>;

/**
 * Parses form data into project input.
 *
 * Returns errors keyed by field so a form can render them inline rather than
 * showing one combined message.
 */
export function parseProjectForm(
  formData: FormData
): { ok: true; values: ProjectInputValues } | { ok: false; errors: FieldErrors } {
  const parsed = projectInputSchema.safeParse({
    name: formData.get('name') ?? '',
    description: formData.get('description') ?? '',
    environment: formData.get('environment') ?? '',
  });

  if (parsed.success) return { ok: true, values: parsed.data };

  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    // Keep the first error per field; the rest are usually consequences.
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as keyof ProjectInputValues] = issue.message;
    }
  }

  return { ok: false, errors };
}
