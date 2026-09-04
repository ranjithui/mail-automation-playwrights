/**
 * The agent's control panel.
 *
 * A window with a box to paste a pairing code into, and afterwards a page that
 * says whether this machine is doing anything. It is served over HTTP on
 * loopback and opened in the default browser rather than drawn with a GUI
 * toolkit: no native dependency to build per platform, nothing to bundle, and
 * the result is a real window that can be left open on a second monitor.
 *
 * Bound to 127.0.0.1 explicitly. On a machine that also runs a mail campaign
 * this must not become something the network can reach.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createLogger } from '@mail/config';

const log = createLogger('agent-ui');

export interface AgentStatus {
  enrolled: boolean;
  serverUrl: string;
  machineName: string;
  startedAt: string;
  waiting: boolean;
  mailboxes: Array<{ email: string; browserStatus: string }>;
  recent: Array<{ at: string; op: string; mailbox: string; ok: boolean; detail?: string }>;
}

export interface UiOptions {
  port: number;
  getStatus: () => AgentStatus;
  /** Resolves once the code is accepted, so the caller can start polling. */
  onEnrol: (serverUrl: string, code: string) => Promise<void>;
}

/** Opens the panel in whatever the machine treats as its browser. */
export function openInBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // Through cmd's `start`, which is what knows the default browser. The
      // empty pair of quotes is the window title `start` insists on when the
      // first argument is itself quoted.
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* headless machine, or no browser - the console prints the URL anyway */
  }
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MailFlow Agent</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #fff; --ink: #14171e; --muted: #5a6274;
    --line: #dde1e9; --accent: #2a4ba0; --ok: #1f7a4d; --bad: #a32d3d;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1015; --card:#151922; --ink:#e7eaf1; --muted:#98a1b4;
            --line:#262c39; --accent:#8aa9f2; --ok:#5fd39b; --bad:#ee8494; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
         display:flex; justify-content:center; padding:44px 20px; }
  main { width:100%; max-width:560px; display:flex; flex-direction:column; gap:20px; }
  h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:14px; margin:0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:22px; display:flex; flex-direction:column; gap:14px; }
  label { font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); }
  input { width:100%; padding:11px 12px; font:inherit; background:var(--bg); color:var(--ink);
          border:1px solid var(--line); border-radius:6px; }
  input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  #code { font:600 24px/1.2 ui-monospace,"Cascadia Mono",Consolas,monospace; letter-spacing:.18em; text-align:center; text-transform:uppercase; }
  button { padding:11px 16px; font:inherit; font-weight:600; color:#fff; background:var(--accent);
           border:0; border-radius:6px; cursor:pointer; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:7px; }
  .msg { font-size:14px; padding:10px 12px; border-radius:6px; border:1px solid var(--line); }
  .msg.bad { color:var(--bad); border-color:var(--bad); }
  .msg.ok { color:var(--ok); border-color:var(--ok); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:7px 0; border-top:1px solid var(--line); vertical-align:top; }
  td.t { color:var(--muted); white-space:nowrap; width:1%; padding-right:14px; font-variant-numeric:tabular-nums; }
  .mono { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; }
  .empty { color:var(--muted); font-size:14px; }
  footer { color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
<main>
  <div>
    <h1>MailFlow Agent</h1>
    <p class="sub" id="tagline">Checking this machine&rsquo;s enrolment&hellip;</p>
  </div>
  <div id="view"></div>
  <footer>This window can be closed. The agent keeps running in its own window.</footer>
</main>

<script>
const view = document.getElementById('view');
const tagline = document.getElementById('tagline');
let enrolling = false;

function enrolForm(message) {
  view.innerHTML = ''
    + '<form class="card" id="f">'
    + (message ? '<div class="msg bad">' + message + '</div>' : '')
    + '<div><label for="server">Server address</label>'
    + '<input id="server" name="server" placeholder="https://your-app.onrender.com" autocomplete="off" required></div>'
    + '<div><label for="code">Pairing code</label>'
    + '<input id="code" name="code" placeholder="XXXX-XXXX" autocomplete="off" required></div>'
    + '<button type="submit" id="go">Enrol this machine</button>'
    + '</form>';

  const saved = localStorage.getItem('serverUrl');
  if (saved) document.getElementById('server').value = saved;
  document.getElementById('code').focus();

  document.getElementById('f').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (enrolling) return;
    enrolling = true;
    const go = document.getElementById('go');
    go.disabled = true;
    go.textContent = 'Enrolling…';
    const serverUrl = document.getElementById('server').value.trim().replace(/\/+$/, '');
    const code = document.getElementById('code').value.trim();
    try {
      localStorage.setItem('serverUrl', serverUrl);
      const res = await fetch('/api/enrol', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl, code }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || 'that code was not accepted');
      refresh();
    } catch (error) {
      enrolling = false;
      enrolForm(error.message);
    }
  });
}

function statusView(s) {
  const rows = s.recent.length
    ? '<table>' + s.recent.map((r) =>
        '<tr><td class="t">' + r.at + '</td><td>'
        + '<span class="dot" style="background:' + (r.ok ? 'var(--ok)' : 'var(--bad)') + '"></span>'
        + '<span class="mono">' + r.op + '</span> &middot; ' + r.mailbox
        + (r.detail ? '<br><span class="empty">' + r.detail + '</span>' : '')
        + '</td></tr>').join('') + '</table>'
    : '<p class="empty">Nothing yet. Operations appear here as the server sends them.</p>';

  const boxes = s.mailboxes.length
    ? s.mailboxes.map((m) => '<div class="row"><span class="mono">' + m.email + '</span><span class="empty">'
        + m.browserStatus.toLowerCase() + '</span></div>').join('')
    : '<p class="empty">No mailbox open yet. Bind one to this device in the dashboard, then press Connect.</p>';

  view.innerHTML = ''
    + '<div class="card"><div class="row"><strong>'
    + '<span class="dot" style="background:' + (s.waiting ? 'var(--ok)' : 'var(--muted)') + '"></span>'
    + (s.waiting ? 'Connected and waiting for work' : 'Starting…') + '</strong>'
    + '<span class="empty mono">' + s.machineName + '</span></div>'
    + '<div class="empty mono">' + s.serverUrl + '</div></div>'
    + '<div class="card"><label>Mailboxes on this machine</label>' + boxes + '</div>'
    + '<div class="card"><label>Recent operations</label>' + rows + '</div>';
}

async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s.enrolled) {
      tagline.textContent = 'This machine is not enrolled yet. Paste a pairing code from the dashboard.';
      if (!enrolling && !document.getElementById('f')) enrolForm('');
      return;
    }
    tagline.textContent = 'Running. This machine holds the browser profiles for its mailboxes.';
    statusView(s);
  } catch {
    tagline.textContent = 'The agent is not responding — has its window been closed?';
  }
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

/** Binds the first free port at or after `from`, and says which it got. */
async function listen(server: http.Server, from: number): Promise<number> {
  for (let port = from; port < from + 10; port += 1) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        // Anything but "someone else has this port" is a real failure and
        // should not be walked past by trying the next number.
        if (error.code === 'EADDRINUSE') resolve(false);
        else throw error;
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (bound) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 9} for the control panel`);
}

/**
 * Serves the panel and returns its address once the machine is enrolled.
 *
 * The server keeps running afterwards, because the same page is what shows the
 * operator that anything is happening at all.
 */
export async function startUi(options: UiOptions): Promise<string> {
  // Definite assignment: the executor runs synchronously, but control-flow
  // analysis cannot see that and would keep narrowing this to null.
  let resolveEnrolled!: () => void;
  const enrolled = new Promise<void>((resolve) => {
    resolveEnrolled = resolve;
  });

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(payload);
    };

    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      return send(200, PAGE, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      return send(200, options.getStatus());
    }

    if (req.method === 'POST' && req.url === '/api/enrol') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        // A pairing form has no business sending kilobytes.
        if (raw.length > 4096) req.destroy();
      });
      req.on('end', () => {
        void (async () => {
          try {
            const { serverUrl, code } = JSON.parse(raw || '{}') as { serverUrl?: string; code?: string };
            if (!serverUrl || !/^https?:\/\//.test(serverUrl)) throw new Error('that does not look like a server address');
            if (!code) throw new Error('enter the pairing code');
            await options.onEnrol(serverUrl.replace(/\/+$/, ''), code.trim());
            send(200, { ok: true });
            resolveEnrolled();
          } catch (error) {
            send(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        })();
      });
      return;
    }

    return send(404, { error: 'not found' });
  });

  const port = await listen(server, options.port);
  const url = `http://127.0.0.1:${port}`;

  if (!options.getStatus().enrolled) {
    log.info(`opening ${url} to enrol this machine`);
    openInBrowser(url);
  } else {
    resolveEnrolled();
  }

  await enrolled;
  return url;
}
