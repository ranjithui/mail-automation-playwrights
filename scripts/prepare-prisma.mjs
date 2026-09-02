#!/usr/bin/env node
/**
 * Generates prisma/schema.prisma from prisma/schema.template.prisma by
 * substituting the datasource provider selected in .env.
 *
 *   DATABASE_PROVIDER=sqlite      -> zero-install local development
 *   DATABASE_PROVIDER=postgresql  -> docker-compose / production
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

// Minimal .env reader so this script has zero dependencies.
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const provider = (process.env.DATABASE_PROVIDER || 'sqlite').toLowerCase();
const allowed = ['sqlite', 'postgresql'];
if (!allowed.includes(provider)) {
  console.error(`[prisma] DATABASE_PROVIDER must be one of ${allowed.join(' | ')} (got "${provider}")`);
  process.exit(1);
}

const templatePath = path.join(root, 'prisma', 'schema.template.prisma');
const outPath = path.join(root, 'prisma', 'schema.prisma');
const template = fs.readFileSync(templatePath, 'utf8');
const output =
  `// AUTO-GENERATED from schema.template.prisma - do not edit.\n` +
  `// Provider: ${provider}. Regenerate with: npm run prisma:prepare\n\n` +
  template.replace('__DATABASE_PROVIDER__', provider);

fs.writeFileSync(outPath, output, 'utf8');

if (provider === 'sqlite') {
  fs.mkdirSync(path.join(root, 'prisma', 'data'), { recursive: true });
}

console.log(`[prisma] schema.prisma generated for provider "${provider}"`);
