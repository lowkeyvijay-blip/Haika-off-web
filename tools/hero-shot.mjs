import http from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4176;
const CDP_PORT = 9336;
const OUT = join(ROOT, 'tools', 'shots');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(PORT, () => ok(server)));
}

function chromeLaunch(port) {
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + join(ROOT, '.chrome-profile'),
    '--window-size=1440,900', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ], { stdio: 'ignore' });
}

async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await r.json()).find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

class CDP {
  constructor(url) { this.id = 0; this.pending = new Map(); this.ws = new WebSocket(url); }
  async open() {
    await new Promise((ok, bad) => {
      this.ws.onopen = ok; this.ws.onerror = bad;
      setTimeout(() => bad(new Error('ws timeout')), 15000);
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { ok, bad } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? bad(new Error(m.error.message)) : ok(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); bad(new Error('timeout ' + method)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const chrome = chromeLaunch(CDP_PORT);
  const cdp = new CDP(await target(CDP_PORT));
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evalJS = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const viewport = async (w, h) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700, screenWidth: w, screenHeight: h });
  };
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(OUT, name), Buffer.from(data, 'base64'));
    console.log('  saved ' + name);
  };
  const go = async (url, wait) => { await cdp.send('Page.navigate', { url }); await sleep(wait); };

  const base = `http://127.0.0.1:${PORT}`;
  const tag = process.env.TAG || 'before';

  /* desktop hero fold */
  await viewport(1440, 900);
  await go(`${base}/index.html`, 6000);
  const state = await evalJS(`JSON.stringify({state: document.getElementById('stage').getAttribute('data-state'), live: document.getElementById('stage').classList.contains('is-live')})`);
  console.log('hero state: ' + state);
  await shot(`${tag}-hero-desktop.png`);

  /* mid-track panel over donut */
  await evalJS(`(() => { const t = document.getElementById('track'); scrollTo(0, t.offsetTop + t.offsetHeight * 0.30); })()`);
  await sleep(1600);
  await shot(`${tag}-hero-midtrack.png`);

  /* mobile hero */
  await viewport(390, 844);
  await go(`${base}/index.html`, 5600);
  await shot(`${tag}-hero-mobile.png`);

  cdp.close(); chrome.kill(); server.close();
  console.log('done -> ' + OUT);
}

main().catch(e => { console.error('hero-shot crashed:', e); process.exit(1); });
