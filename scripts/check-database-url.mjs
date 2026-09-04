#!/usr/bin/env node
/**
 * Checks DATABASE_URL before anything tries to connect with it.
 *
 * Prisma's own errors are accurate but arrive late and say little. A missing
 * variable is reported as a schema validation failure pointing at line 21 of a
 * generated file; an unsubstituted placeholder in the hostname is reported as
 * P1001 "Can't reach database server", which reads like the database is down.
 * Both cost a full build to interpret, and both are obvious here.
 *
 * Runs before `prisma db push` in the Render build, and is worth running by
 * hand any time a connection string changes:
 *
 *   npm run check:db
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Same minimal .env reader as prepare-prisma.mjs, and for the same reason:
// this has to work before dependencies are installed.
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const problems = [];
const warnings = [];
const fail = (what, why) => problems.push({ what, why });
const warn = (what, why) => warnings.push({ what, why });

const provider = (process.env.DATABASE_PROVIDER || 'sqlite').toLowerCase();
const raw = process.env.DATABASE_URL;

// SQLite needs none of this: the URL is a file path and there is nothing to
// resolve or authenticate against.
if (provider === 'sqlite') {
  console.log('[check:db] provider is sqlite - nothing to check');
  process.exit(0);
}

if (!raw || !raw.trim()) {
  console.error(
    '\n[check:db] DATABASE_URL is not set.\n\n' +
      '  On Render this is a `sync: false` variable, which means the blueprint\n' +
      '  deliberately does not carry a value - somebody has to type it in.\n' +
      '  Service -> Environment -> add DATABASE_URL, then Save Changes.\n',
  );
  process.exit(1);
}

// Quotes are a copy/paste artefact of .env syntax. Render (and any other
// dashboard) stores the box verbatim, so they end up inside the value.
const trimmed = raw.trim();
if (/^["'].*["']$/.test(trimmed)) {
  fail('it is wrapped in quotes', 'Supabase shows the string in .env form. Paste the value without the surrounding " or \'.');
}
const value = trimmed.replace(/^["']|["']$/g, '');

if (value !== raw) {
  warn('it has surrounding whitespace or quotes', 'harmless here, but a stray newline breaks some clients.');
}

// The failure this file exists for: a template pasted without substitution.
const placeholders = value.match(/\[[^\]]*\]|YOUR[-_]?PASSWORD|YOURPASSWORD|REGION|<[^>]+>/gi);
if (placeholders) {
  fail(
    `it still contains a placeholder: ${[...new Set(placeholders)].join(', ')}`,
    'Replace it with the real value from Supabase -> Connect -> ORMs -> Prisma.',
  );
}

let parsed;
try {
  parsed = new URL(value);
} catch (error) {
  fail('it is not a valid URL', error instanceof Error ? error.message : String(error));
}

if (parsed) {
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail(`the scheme is "${parsed.protocol}"`, 'PostgreSQL URLs start with postgresql:// or postgres://.');
  }

  if (!parsed.password) {
    fail('there is no password in it', 'Expected postgresql://user:PASSWORD@host:port/database.');
  }

  // The direct connection is IPv6-only on new Supabase projects, and most
  // hosts - Render included - dial IPv4. It resolves, so DNS will not catch
  // this; the connection simply times out.
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(parsed.hostname)) {
    fail(
      'it uses the Supabase DIRECT connection',
      'That host is IPv6-only on new projects and most platforms cannot reach it. ' +
        'Use the session pooler instead: <prefix>-<region>.pooler.supabase.com on port 5432.',
    );
  }

  // The transaction pooler is built for functions that open a connection per
  // request. Prisma needs to be told, or it will try to use prepared
  // statements that pgbouncer does not keep.
  if (parsed.port === '6543' && !/pgbouncer=true/i.test(parsed.search)) {
    warn(
      'it uses the transaction pooler (6543) without ?pgbouncer=true',
      'Either append ?pgbouncer=true or use the session pooler on 5432, which suits long-running processes better.',
    );
  }
}

// Left until last: it is the slowest check, and pointless if the URL is
// already malformed.
if (parsed && problems.length === 0) {
  try {
    const { address } = await dns.lookup(parsed.hostname);
    console.log(`[check:db] ${parsed.hostname} resolves to ${address}`);
  } catch (error) {
    fail(
      `the hostname "${parsed.hostname}" does not resolve`,
      `DNS says ${error instanceof Error ? error.code ?? error.message : error}. ` +
        'This is what Prisma reports as P1001 "Can\'t reach database server" - the host does not exist, ' +
        'rather than the database being down. Check the region part of the hostname.',
    );
  }
}

for (const { what, why } of warnings) console.warn(`[check:db] warning: ${what}\n            ${why}`);

if (problems.length) {
  console.error(`\n[check:db] DATABASE_URL will not work:\n`);
  for (const { what, why } of problems) console.error(`  * ${what}\n    ${why}\n`);
  console.error(
    '  Expected shape (Supabase session pooler):\n' +
      '    postgresql://postgres.<project-ref>:<password>@<prefix>-<region>.pooler.supabase.com:5432/postgres\n\n' +
      '  A password containing @ : / ? # & or % must be percent-encoded.\n',
  );
  process.exit(1);
}

console.log('[check:db] DATABASE_URL looks usable');
