import { describe, expect, it } from 'vitest';

import { redactSecret } from '@/lib/credentials/redact';
import { needsEndpoint } from '@/lib/credentials/requirements';
import { parseMetadataForm, parseRegisterForm } from '@/lib/credentials/schema';
import { describeCredentialStatus } from '@/lib/credentials/status';
import { classifyValidation } from '@/lib/credentials/validation-outcome';
import type { CredentialValidation } from '@/lib/providers/types';

/**
 * API key input handling, outcome classification and presentation. No
 * database or network: the integration suite covers the full flow.
 */

const PROJECT_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const PROVIDER_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwx';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = {
  projectId: PROJECT_ID,
  providerId: PROVIDER_ID,
  keyName: 'FYIND Production',
  environment: 'production',
  secret: SECRET,
  providerKeyId: '',
  baseUrl: '',
};

describe('parseRegisterForm', () => {
  it('accepts a complete registration', () => {
    const result = parseRegisterForm(form(VALID));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toMatchObject({
        keyName: 'FYIND Production',
        secret: SECRET,
        providerKeyId: null,
        baseUrl: null,
      });
    }
  });

  it('trims a trailing newline from a pasted key', () => {
    const result = parseRegisterForm(form({ ...VALID, secret: `${SECRET}\n` }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.secret).toBe(SECRET);
  });

  it('rejects whitespace inside the key rather than silently stripping it', () => {
    const result = parseRegisterForm(form({ ...VALID, secret: 'sk-proj-abcd efghijklmnopqrstu' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.secret).toMatch(/spaces or line breaks/);
  });

  it('asks for the key when it is missing', () => {
    const result = parseRegisterForm(form({ ...VALID, secret: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.secret).toBe('Paste the API key');
  });

  it('rejects a key too short to be real', () => {
    // Storing the last four characters of a short secret would reveal most of it.
    const result = parseRegisterForm(form({ ...VALID, secret: 'short-key' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.secret).toMatch(/too short/);
  });

  it('rejects malformed ids', () => {
    const result = parseRegisterForm(form({ ...VALID, projectId: 'not-an-id', providerId: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.projectId).toBe('Choose a project');
      expect(result.errors.providerId).toBe('Choose a provider');
    }
  });

  it('validates the provider key id format', () => {
    expect(parseRegisterForm(form({ ...VALID, providerKeyId: 'key_abc-123.x:y' })).ok).toBe(true);

    const bad = parseRegisterForm(form({ ...VALID, providerKeyId: 'key abc' }));
    expect(bad.ok).toBe(false);
  });

  it('echoes non-secret input so a failed submission does not wipe the form', () => {
    const result = parseRegisterForm(form({ ...VALID, keyName: '' }));

    expect(result.echo).toMatchObject({ projectId: PROJECT_ID, environment: 'production' });
  });

  it('never echoes the secret back', () => {
    const result = parseRegisterForm(form({ ...VALID, keyName: '' }));

    expect(result.echo).not.toHaveProperty('secret');
    expect(JSON.stringify(result.echo)).not.toContain(SECRET);
  });
});

describe('parseMetadataForm', () => {
  it('accepts edits without a secret', () => {
    const result = parseMetadataForm(
      form({ keyName: 'Renamed', environment: 'staging', providerKeyId: 'key_1' })
    );

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.values).toEqual({
        keyName: 'Renamed',
        environment: 'staging',
        providerKeyId: 'key_1',
      });
  });

  it('ignores a secret smuggled into the submission', () => {
    const result = parseMetadataForm(
      form({ keyName: 'X', environment: 'production', providerKeyId: '', secret: SECRET })
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).not.toHaveProperty('secret');
  });
});

describe('classifyValidation', () => {
  const failed = (failure: CredentialValidation['failure']): CredentialValidation => ({
    valid: false,
    failure,
    latencyMs: 1,
  });

  it('accepts a valid key', () => {
    expect(classifyValidation({ valid: true, latencyMs: 1 })).toEqual({ outcome: 'valid' });
  });

  it('rejects a key the provider says is wrong', () => {
    expect(classifyValidation(failed('unauthorized'))).toEqual({
      outcome: 'invalid',
      field: 'secret',
    });
  });

  it('attributes a configuration problem to the endpoint field', () => {
    expect(classifyValidation(failed('misconfigured'))).toEqual({
      outcome: 'invalid',
      field: 'baseUrl',
    });
  });

  it('does not reject a forbidden response, which restricted keys produce', () => {
    // A restricted key can be refused /models yet work for inference.
    expect(classifyValidation(failed('forbidden'))).toEqual({ outcome: 'unverified' });
  });

  it.each(['rate_limited', 'network_error', 'timeout', 'unexpected_status'] as const)(
    'leaves a key unverified on %s rather than rejecting it',
    (failure) => {
      // A provider outage must not block registering a good key.
      expect(classifyValidation(failed(failure))).toEqual({ outcome: 'unverified' });
    }
  );
});

describe('redactSecret', () => {
  const RAW = 'xk7Q2mP9vL4nR8sT1wY6zB3cD5fG0hJ';

  it('removes an echoed key that has no recognisable prefix', () => {
    const redacted = redactSecret(`Invalid key provided: ${RAW}`, RAW);

    expect(redacted).not.toContain(RAW);
    expect(redacted).toContain('***');
  });

  it('removes a truncated form of the key', () => {
    const redacted = redactSecret(`Key ending ${RAW.slice(-8)} was revoked`, RAW);

    expect(redacted).not.toContain(RAW.slice(-8));
  });

  it('leaves ordinary text intact', () => {
    expect(redactSecret('Rate limit exceeded for model gpt-5', RAW)).toBe(
      'Rate limit exceeded for model gpt-5'
    );
  });

  it('passes through empty input', () => {
    expect(redactSecret(undefined, RAW)).toBeUndefined();
    expect(redactSecret('', RAW)).toBe('');
  });
});

describe('describeCredentialStatus', () => {
  it.each([
    ['active', 'valid', 'healthy', 'Validated'],
    ['active', 'unverified', 'degraded', 'Not verified'],
    ['active', 'invalid', 'unhealthy', 'Rejected'],
    ['active', null, 'unknown', 'Never checked'],
    ['disabled', 'valid', 'unknown', 'Disabled'],
    ['revoked', 'valid', 'unknown', 'Revoked'],
  ] as const)('%s + %s -> %s (%s)', (status, outcome, tone, label) => {
    expect(describeCredentialStatus(status, outcome)).toMatchObject({ tone, label });
  });

  it('never claims ongoing health, only the last check', () => {
    const { description } = describeCredentialStatus('active', 'valid');

    expect(description).toMatch(/last check/);
    expect(description).not.toMatch(/healthy/i);
  });
});

describe('needsEndpoint', () => {
  it('requires an endpoint only for Azure OpenAI', () => {
    expect(needsEndpoint('azure_openai')).toBe(true);
    expect(needsEndpoint('openai')).toBe(false);
    expect(needsEndpoint('anthropic')).toBe(false);
  });
});
