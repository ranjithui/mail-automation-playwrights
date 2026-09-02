import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string, sub = 'index.ts') => path.resolve(root, `packages/${name}/src/${sub}`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mail\/shared$/, replacement: pkg('shared') },
      { find: /^@mail\/config$/, replacement: pkg('config') },
      { find: /^@mail\/database$/, replacement: pkg('database') },
      { find: /^@mail\/queue$/, replacement: pkg('queue') },
      { find: /^@mail\/playwright$/, replacement: pkg('playwright') },
      { find: /^@mail\/ai$/, replacement: pkg('ai') },
      { find: /^@mail\/core$/, replacement: pkg('core') },
      { find: /^@mail\/(shared|config|database|queue|playwright|ai|core)\/(.*)$/, replacement: path.resolve(root, 'packages/$1/src/$2.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'basic',
  },
});
