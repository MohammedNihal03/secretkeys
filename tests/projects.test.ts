import { describe, expect, it } from 'vitest';

import { ENVIRONMENTS, PROJECT_NAME_MAX, parseProjectForm } from '@/lib/projects/schema';

/**
 * Project input validation.
 *
 * Exercised through `parseProjectForm`, which is the entry point every caller
 * uses, rather than the Zod schema directly -- that way the FormData coercion
 * is covered too.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = { name: 'FYIND', description: 'Customer app', environment: 'production' };

describe('valid input', () => {
  it('accepts a complete project', () => {
    const result = parseProjectForm(form(VALID));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual({
        name: 'FYIND',
        description: 'Customer app',
        environment: 'production',
      });
    }
  });

  it.each(ENVIRONMENTS)('accepts the %s environment', (environment) => {
    const result = parseProjectForm(form({ ...VALID, environment }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.environment).toBe(environment);
  });

  it('trims surrounding whitespace', () => {
    const result = parseProjectForm(form({ ...VALID, name: '   Lunad   ' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.name).toBe('Lunad');
  });

  it('stores an empty description as null rather than an empty string', () => {
    const result = parseProjectForm(form({ ...VALID, description: '   ' }));

    // Otherwise "no description" and "a blank description" become different states.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.description).toBeNull();
  });
});

describe('invalid input', () => {
  it('rejects an empty name', () => {
    const result = parseProjectForm(form({ ...VALID, name: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toMatch(/required/i);
  });

  it('rejects a whitespace-only name', () => {
    const result = parseProjectForm(form({ ...VALID, name: '      ' }));

    expect(result.ok).toBe(false);
  });

  it('rejects a name over the length limit', () => {
    const result = parseProjectForm(form({ ...VALID, name: 'a'.repeat(PROJECT_NAME_MAX + 1) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toMatch(/characters or fewer/);
  });

  it('accepts a name exactly at the limit', () => {
    expect(parseProjectForm(form({ ...VALID, name: 'a'.repeat(PROJECT_NAME_MAX) })).ok).toBe(true);
  });

  it('rejects an unknown environment', () => {
    const result = parseProjectForm(form({ ...VALID, environment: 'preprod' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.environment).toBeDefined();
  });

  it('rejects a missing environment', () => {
    const data = new FormData();
    data.append('name', 'X');
    data.append('description', '');

    expect(parseProjectForm(data).ok).toBe(false);
  });

  // Two projects that look identical in the UI but are distinct rows is a way
  // to make attribution ambiguous on purpose.
  it.each([
    ['newline', 'FY\nIND'],
    ['tab', 'FY\tIND'],
    ['zero-width space', 'FY​IND'],
    ['right-to-left override', 'FY‮IND'],
  ])('rejects a name containing a %s', (_label, name) => {
    const result = parseProjectForm(form({ ...VALID, name }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toMatch(/control or formatting/i);
  });

  it('allows ordinary punctuation and non-Latin scripts', () => {
    for (const name of ['Acme (EU) — Prod', 'プロジェクト', 'Проект-1', 'مشروع']) {
      expect(parseProjectForm(form({ ...VALID, name })).ok, name).toBe(true);
    }
  });

  it('reports one error per field', () => {
    const result = parseProjectForm(form({ name: '', description: '', environment: 'nope' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['environment', 'name']);
    }
  });
});
