import http from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4174;
const CDP_PORT = 9334;
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
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 ' + p);
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
  throw new Error('no chrome target');
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          bad(new Error('timeout ' + method));
        }
      }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const chrome = chromeLaunch(CDP_PORT);
  const wsUrl = await target(CDP_PORT);
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const evalJS = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const viewport = async (w, h) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 700, screenWidth: w, screenHeight: h
    });
  };

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(OUT, name), Buffer.from(data, 'base64'));
    console.log('  saved ' + name);
  };

  const go = async (url, wait) => { await cdp.send('Page.navigate', { url }); await sleep(wait); };

  const scrollToSel = async (sel, block = 'center') => {
    await evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({block:'${block}', behavior:'instant'}); })()`);
    await sleep(1900);
  };

  const base = `http://127.0.0.1:${PORT}`;
  const log = [];

  /* ============ desktop ============ */
  await viewport(1440, 900);

  await go(`${base}/index.html`, 5200);
  log.push(await evalJS(`JSON.stringify({boot: !document.getElementById('boot'), live: document.getElementById('stage').classList.contains('is-live'), state: document.getElementById('stage').getAttribute('data-state')})`));
  await shot('01-home-hero-fold.png');

  await evalJS(`(() => { const t = document.getElementById('track'); scrollTo(0, t.offsetTop + t.offsetHeight * 0.18); })()`);
  await sleep(1600);
  await shot('02-home-panel-2.png');

  await scrollToSel('#systems');
  await shot('03-systems-presence-conversation-automation.png');

  await scrollToSel('#work', 'start');
  await sleep(1200);
  await shot('04-work-case-studies.png');

  await scrollToSel('.plates', 'start');
  await sleep(800);
  await shot('05-work-demo-plates.png');

  await scrollToSel('#about');
  await shot('06-brains-founders.png');

  await scrollToSel('#contact');
  await shot('07-final-cta.png');

  /* ============ /start desktop ============ */
  await go(`${base}/start/`, 5000);
  log.push(await evalJS(`JSON.stringify({parts: document.querySelectorAll('#model [data-part]').length, gl: document.getElementById('model').classList.contains('is-gl')})`));
  await shot('08-start-step1.png');

  const advance = async (to) => {
    await evalJS(`(async () => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const now = () => document.querySelector('[data-step]:not([hidden])').dataset.step;
      const submit = async () => { document.getElementById('intake').requestSubmit(); await new Promise(r => setTimeout(r, 420)); };
      let guard = 0;
      while (now() !== String(${to}) && guard++ < 16) {
        const s = now();
        if (s === '1') { set('f-name','Amrita Sharma'); set('f-email','hello@amrita.example'); set('f-phone','+91 98765 43210'); }
        if (s === '2') { set('f-company','Amrita Dental'); set('f-site','amrita.example'); }
        if (s === '3') { const c = document.querySelector('input[name="parts"][value="Website"]'); if (!c.checked) c.click(); }
        if (s === '4') { const c = document.querySelector('input[name="bottleneck"][value="Getting more leads"]'); if (!c.checked) c.click(); }
        if (s === '5') { const c = document.querySelector('input[name="current"][value="None yet"]'); if (!c.checked) c.click(); }
        if (s === '6') { set('f-vision', 'A calm, editorial site that books consultations without a phone call.'); }
        await new Promise(r => setTimeout(r, 200));
        await submit();
      }
      return now();
    })()`, true);
    await sleep(2400);
  };

  await advance(5);
  await shot('09-start-midflow-model-assembled.png');

  await advance(7);
  await shot('10-start-review.png');

  await evalJS(`(async () => { document.getElementById('f-consent').click(); await new Promise(r=>setTimeout(r,150)); document.getElementById('intake').requestSubmit(); await new Promise(r=>setTimeout(r,900)); })()`, true);
  await shot('11-start-receipt.png');

  /* ============ mobile ============ */
  await viewport(390, 844);
  await go(`${base}/index.html`, 5200);
  await shot('12-mobile-home-hero.png');

  await scrollToSel('#systems');
  await shot('13-mobile-systems.png');

  await scrollToSel('#work', 'start');
  await sleep(1000);
  await shot('14-mobile-work-cases.png');

  await go(`${base}/start/`, 4600);
  await shot('15-mobile-start-step1.png');

  await advance(5);
  await shot('16-mobile-start-midflow.png');

  console.log('\nstate: ' + log.join(' | '));
  console.log('shots -> ' + OUT);

  cdp.close();
  chrome.kill();
  server.close();
}

main().catch(e => { console.error('shots crashed:', e); process.exit(1); });
