#!/usr/bin/env node
/** Drops the local dev database and rebuilds it from scratch, then re-seeds. */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const dataDir = path.join(root, 'prisma', 'data');
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('[reset] removed prisma/data');
}

run('node', ['scripts/prepare-prisma.mjs']);
run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss', '--force-reset']);
run('npx', ['tsx', 'prisma/seed.ts']);
console.log('[reset] database rebuilt and seeded');
