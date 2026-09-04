#!/usr/bin/env node
/**
 * Packages the agent as a double-clickable executable.
 *
 *   npm run build:agent
 *
 * Produces `dist/agent/` holding the executable, the Playwright packages it
 * needs beside it, and a readme. Zip that folder and it runs on a machine with
 * no Node, no repository and no npm.
 *
 * How it is built
 * ---------------
 * esbuild flattens the agent and everything it imports into one CommonJS file,
 * which Node's Single Executable Application support then injects into a copy
 * of node itself. Nothing is compiled; the executable *is* node, carrying the
 * bundle inside it.
 *
 * Playwright stays outside the bundle. It locates its driver and its browser
 * registry from paths relative to its own package directory, so folding it into
 * a single file breaks it in ways that only show up when a browser is launched.
 * It is copied next to the executable instead.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'agent');
const work = path.join(out, '.build');

const say = (message) => console.log(`[agent] ${message}`);

/** Packages copied whole, because bundling them breaks how they find files. */
const SHIPPED_ALONGSIDE = ['playwright', 'playwright-core'];

const exeName = process.platform === 'win32' ? 'mailflow-agent.exe' : 'mailflow-agent';

// Windows keeps a running executable locked, and rebuilding while the agent is
// open is the normal way to hit that. Retried briefly, then explained - the raw
// EPERM names a path and not the reason.
try {
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (error) {
  if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
  console.error(
    `[agent] cannot replace dist/agent - something is using it.${String.fromCharCode(10)}` +
      `        Close ${exeName} (and any Chrome it opened) and run this again.`,
  );
  process.exit(1);
}
fs.mkdirSync(work, { recursive: true });

// ------------------------------------------------------------------- bundle

say('bundling');
await build({
  entryPoints: [path.join(root, 'apps/agent/src/index.ts')],
  outfile: path.join(work, 'agent.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  // CommonJS, because that is what a single executable can hold today.
  format: 'cjs',
  external: [],
  define: {
    'import.meta.url': '__agentMetaUrl',
  },
  plugins: [
    {
      name: 'playwright-beside-the-executable',
      setup(build) {
        build.onResolve({ filter: /^playwright$/ }, () => ({
          path: 'playwright',
          namespace: 'from-exe',
        }));
        build.onLoad({ filter: /.*/, namespace: 'from-exe' }, () => ({
          contents: [
            "const { createRequire } = require('node:module');",
            "const { dirname, join } = require('node:path');",
            // A file path rather than a directory: createRequire resolves
            // relative to the file it is given, and a directory without a
            // trailing separator is read as one.
            "const near = createRequire(join(dirname(process.execPath), 'index.js'));",
            "module.exports = near('playwright');",
          ].join(String.fromCharCode(10)),
          loader: 'js',
        }));
      },
    },
  ],
  // Settings are injected here rather than shipped as a .env beside the
  // executable. @mail/config resolves its storage paths from its own module
  // location, which inside a single executable is the executable itself - so
  // left alone it would try to write sessions and screenshots next to the exe,
  // or three directories above it. These run before anything imports config.
  banner: {
    js: [
      "const __os = require('node:os');",
      "const __agentMetaUrl = require('node:url').pathToFileURL(__filename).href;",
      "const __path = require('node:path');",
      "const __base = process.platform === 'win32'",
      "  ? __path.join(process.env.APPDATA || __path.join(__os.homedir(), 'AppData', 'Roaming'), 'MailFlow Agent')",
      "  : __path.join(process.env.XDG_CONFIG_HOME || __path.join(__os.homedir(), '.config'), 'mailflow-agent');",
      "process.env.PLAYWRIGHT_STORAGE_DIR ||= __path.join(__base, 'sessions');",
      "process.env.SCREENSHOT_DIR ||= __path.join(__base, 'screenshots');",
      "process.env.STORAGE_DIR ||= __path.join(__base, 'files');",
      "process.env.PLAYWRIGHT_BROWSER_CHANNEL ||= 'chrome';",
      "process.env.PLAYWRIGHT_HEADLESS ||= 'false';",
    ].join(String.fromCharCode(10)),
  },
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

const bundleSize = (fs.statSync(path.join(work, 'agent.cjs')).size / 1024 / 1024).toFixed(1);
say(`bundle is ${bundleSize}MB`);

// ---------------------------------------------------------------------- sea

say('preparing the executable');
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(work, 'agent.cjs'),
      output: path.join(work, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      // The bundle is one file with no runtime `require` of anything local, so
      // there is nothing to snapshot or map back.
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exePath = path.join(out, exeName);
fs.copyFileSync(process.execPath, exePath);

say('injecting');
const { inject } = await import('postject');
await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(path.join(work, 'sea-prep.blob')), {
  // The value node itself looks for when deciding whether it is carrying an
  // application. Changing it produces an executable that runs as plain node.
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

// ------------------------------------------------------------- what goes with

/** Copies a package and its own dependencies that are not already there. */
function copyPackage(name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);

  const from = path.join(root, 'node_modules', name);
  if (!fs.existsSync(from)) throw new Error(`${name} is not installed - run npm install first`);

  const to = path.join(out, 'node_modules', name);
  fs.cpSync(from, to, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency, seen);
}

say('copying playwright');
for (const name of SHIPPED_ALONGSIDE) copyPackage(name);

fs.writeFileSync(
  path.join(out, 'README.txt'),
  `MailFlow Agent
==============

Double-click ${exeName}.

A window opens asking for the server address and a pairing code. Get the code
from the dashboard: Devices -> Add device. It is good for ten minutes and one
use.

After that the agent waits for work. Leave it running - it is what sends your
mail. The same window shows what it is doing, and closing the window does not
stop it; closing the console does.

Requirements
------------
Google Chrome. The agent drives the Chrome already installed on this machine,
so there is nothing else to download.

Where things are kept
---------------------
The device token lives in your user profile, not in this folder:
  Windows  %APPDATA%\\MailFlow Agent\\agent.json
  macOS    ~/.config/mailflow-agent/agent.json
  Linux    ~/.config/mailflow-agent/agent.json

Delete that file to un-enrol this machine.

Signing in
----------
The first time a mailbox connects, a Chrome window opens for the Google
sign-in. Complete it yourself; the session is remembered afterwards.
`,
);

fs.rmSync(work, { recursive: true, force: true });

// ---------------------------------------------------------------- publishable

/**
 * Zipped here rather than by hand, because the thing that gets uploaded should
 * be the thing that was just built. Windows ships bsdtar, which writes a zip
 * when the extension says so; everywhere else has `zip`.
 */
const archive = path.join(root, 'dist', `mailflow-agent-${process.platform}-${process.arch}.zip`);
fs.rmSync(archive, { force: true });

say('zipping');
try {
  const dist = path.join(root, 'dist');
  const name = path.basename(archive);

  if (process.platform === 'win32') {
    // Not `tar -a`, which Windows' bsdtar honours for gzip but not for zip: it
    // writes the entries stored, producing an archive fractionally LARGER than
    // the folder. That matters because the executable is mostly the node binary,
    // which deflates by about 60% - the difference between an upload that fits
    // inside a hosting tier's file size limit and one that does not.
    const quote = (value) => "'" + value.split("'").join("''") + "'";
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path ${quote(path.join(dist, 'agent'))} -DestinationPath ${quote(archive)} -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('zip', ['-9qr', name, 'agent'], { cwd: dist, stdio: 'inherit' });
  }
} catch (error) {
  say(`could not create the zip (${error.message}) - the folder itself is still complete`);
}

const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(0);
say(`done - dist/agent/${exeName} (${size}MB)`);
if (fs.existsSync(archive)) {
  const zipped = (fs.statSync(archive).size / 1024 / 1024).toFixed(0);
  say(`archive - ${path.relative(root, archive)} (${zipped}MB)`);
  say('publish it, then point AGENT_DOWNLOAD_URL at it so the Devices page can offer it:');
  say(`  gh release create agent-v${new Date().toISOString().slice(0, 10)} "${archive}" --notes "MailFlow agent"`);
}
