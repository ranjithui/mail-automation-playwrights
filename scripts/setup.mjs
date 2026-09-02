#!/usr/bin/env node
/**
 * One-shot bootstrap:
 *   1. create .env from .env.example (generating real secrets)
 *   2. generate prisma/schema.prisma for the configured provider
 *   3. prisma generate + db push
 *   4. seed the demo workspace
 *
 * Safe to re-run: an existing .env is never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n[setup] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

console.log('MailFlow setup\n==============');

if (!fs.existsSync(envPath)) {
  const example = fs.readFileSync(examplePath, 'utf8');
  const env = example
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`)
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`)
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envPath, env, 'utf8');
  console.log('[setup] .env created with freshly generated secrets');
} else {
  console.log('[setup] .env already exists - left untouched');
}

for (const dir of ['storage/attachments', 'storage/screenshots', 'storage/sessions', 'prisma/data']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}

run('node', ['scripts/prepare-prisma.mjs']);
run('npx', ['prisma', 'generate']);
run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss']);
run('npx', ['tsx', 'prisma/seed.ts']);

console.log(`
=====================================================================
 Setup complete.

   Start everything with:   npm run dev

   Web app  ->  http://localhost:5173
   API      ->  http://localhost:4000/api/health

   Demo login is printed above by the seeder and is also written to
   "how to run.txt" in the project root.
=====================================================================
`);
