import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security properties checked against the source itself.
 *
 * These are the rules that break silently: nobody notices a new Server Action
 * that forgot its permission check until someone calls it directly, and nobody
 * notices a new repository function that selects a ciphertext column until a
 * page renders it. A test that reads the code catches the next one at review
 * time, before it ships.
 */

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.(ts|tsx)$/.test(entry))
    .map((entry) => {
      const absolute = join(SRC, entry);
      return {
        path: relative(ROOT, absolute).split(sep).join('/'),
        text: readFileSync(absolute, 'utf8'),
      };
    });
}

/** Comments removed, so a rule is about code rather than prose that mentions it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const files = sourceFiles();

const GUARD = /\brequire(Permission|OrgAccess|User)\(/;

describe('server actions', () => {
  const actionModules = files.filter((file) => /^\s*['"]use server['"]/.test(file.text));

  it('exist, so this test is checking something', () => {
    expect(actionModules.length).toBeGreaterThan(3);
  });

  it('check permission in every exported action', () => {
    /**
     * A Server Action is a public endpoint. Hiding its button is not access
     * control; it can be invoked directly by anyone who can send a request.
     * Sign-in and sign-out are the only actions a signed-out user must reach.
     */
    const PUBLIC = new Set(['signIn', 'signOut']);
    const unguarded: string[] = [];

    for (const file of actionModules) {
      const body = code(file.text);
      const exports = [...body.matchAll(/export async function (\w+)/g)];

      exports.forEach((match, index) => {
        const name = match[1];
        const end = exports[index + 1]?.index ?? body.length;
        const block = body.slice(match.index, end);

        if (!PUBLIC.has(name) && !GUARD.test(block)) unguarded.push(`${file.path}: ${name}`);
      });
    }

    expect(unguarded).toEqual([]);
  });

  it('delegate to a guarded action when defined inline in a page', () => {
    const inline = files.filter(
      (file) => /['"]use server['"]/.test(file.text) && !/^\s*['"]use server['"]/.test(file.text)
    );

    for (const file of inline) {
      // An inline action may only forward to an action module, which is guarded.
      expect(code(file.text), file.path).toMatch(/return \w+Action\(/);
    }
  });
});

describe('ciphertext columns', () => {
  it('are referenced in code only by the schema and the two decryption services', () => {
    /**
     * Every other file reads through explicit column lists that leave these
     * out. A new reference anywhere else is either a leak in the making or a
     * decryption path that bypasses the one place decryption is audited.
     */
    const ALLOWED = new Set([
      'src/lib/db/schema/api-keys.ts',
      'src/lib/db/schema/monitored-databases.ts',
      'src/lib/credentials/service.ts',
      'src/lib/databases/service.ts',
    ]);

    const offenders = files
      .filter((file) =>
        /\b(encryptedKey|encryptedCredentials|keyFingerprint)\b/.test(code(file.text))
      )
      .map((file) => file.path)
      .filter((path) => !ALLOWED.has(path));

    expect(offenders).toEqual([]);
  });

  it('are never selected as a whole row from their tables', () => {
    // `select()` with no column list pulls ciphertext along with everything else.
    const offenders = files
      .filter((file) =>
        /\.select\(\)\s*\.from\((apiKeys|monitoredDatabases)\)/.test(code(file.text))
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe('rendering', () => {
  it('never injects raw HTML', () => {
    /**
     * `dangerouslySetInnerHTML` bypasses React's escaping, and it would also
     * need an inline script or style exception in the Content Security Policy.
     */
    const offenders = files
      .filter((file) => /dangerouslySetInnerHTML/.test(code(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe('logging', () => {
  it('happens only where it has been reviewed', () => {
    /**
     * Every log line is a place a secret could escape. There is exactly one in
     * the application, and it prints an error's message, never the object --
     * a driver error object can carry the connection configuration. A new log
     * call should be a deliberate change to this list.
     */
    const logging = files
      .filter((file) => /\bconsole\.(log|error|warn|info|debug)\(/.test(code(file.text)))
      .map((file) => file.path);

    expect(logging).toEqual(['src/lib/db/client.ts']);

    const client = files.find((file) => file.path === 'src/lib/db/client.ts');
    expect(code(client?.text ?? '')).toMatch(/console\.error\([^)]*error\.message\)/);
  });
});
