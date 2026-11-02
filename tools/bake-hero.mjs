/* One-off asset baker: applies the hero colour treatment once, off the main thread,
   so the running page never pays for a full-screen CSS filter chain.
   Also emits a tiny tiling grain JPEG.
   Usage: node tools/bake-hero.mjs */
import http from 'node:http';
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4181;
const CDP_PORT = 9341;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = join(process.env.TEMP || process.env.TMP || ROOT, 'opencode', 'bake-profile-' + process.pid);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/__bake') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>bake</title>');
    }
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream' });
    createReadStream(f).pipe(res);
  });
  return new Promise(ok => s.listen(PORT, () => ok(s)));
}
function launch(port) {
  return spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE,
    '--window-size=1200,800', '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });
}
async function target(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('no chrome target');
}
class CDP {
  constructor(u) { this.id = 0; this.p = new Map(); this.ws = new WebSocket(u); }
  async open() {
    await new Promise((a, b) => { this.ws.onopen = a; this.ws.onerror = b; setTimeout(() => b(new Error('ws timeout')), 15000); });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const { ok, bad } = this.p.get(m.id); this.p.delete(m.id);
        m.error ? bad(new Error(m.error.message)) : ok(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); bad(new Error('timeout ' + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

function saveDataUrl(file, dataUrl) {
  const b64 = String(dataUrl).split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, buf);
  return buf.length;
}

async function main() {
  const server = await serve();
  const chrome = launch(CDP_PORT);
  const cdp = new CDP(await target(CDP_PORT));
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__bake` });
  await sleep(800);

  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const FULL = 'invert(1) brightness(2.1) contrast(1.28) sepia(.26) saturate(1.22)';
      const CANDIDATES = {
        'invert+brightness': 'invert(1) brightness(2.06)',
        'invert+brightness+sepia': 'invert(1) brightness(2.06) sepia(.20) saturate(1.12)',
        'invert+brightness+contrast': 'invert(1) brightness(2.08) contrast(1.20)',
        'invert+brightness+sepia+sat': 'invert(1) brightness(2.08) sepia(.20) saturate(1.14)'
      };
      const img = new Image();
      img.src = '/assets/hero-poster.jpg';
      await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.filter = FULL;
      ctx.drawImage(img, 0, 0);
      const dataURL = canvas.toDataURL('image/jpeg', 0.80);

      const lq = document.createElement('canvas');
      lq.width = 32; lq.height = 18;
      const lctx = lq.getContext('2d');
      lctx.filter = FULL;
      lctx.drawImage(img, 0, 0, 32, 18);
      const lqip = lq.toDataURL('image/jpeg', 0.55);

      function sample(filter) {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        const x = c.getContext('2d');
        x.filter = filter;
        x.drawImage(img, 0, 0, 160, 90);
        return x.getImageData(0, 0, 160, 90).data;
      }
      const ref = sample(FULL);
      const stats = {};
      for (const k of Object.keys(CANDIDATES)) {
        const d = sample(CANDIDATES[k]);
        let sum = 0, max = 0;
        for (let i = 0; i < ref.length; i += 4) {
          const dr = Math.abs(d[i] - ref[i]);
          const dg = Math.abs(d[i + 1] - ref[i + 1]);
          const db = Math.abs(d[i + 2] - ref[i + 2]);
          const e = (dr + dg + db) / 3;
          sum += e; if (e > max) max = e;
        }
        stats[k] = { meanDelta: +(sum / (ref.length / 4)).toFixed(2), maxDelta: max };
      }

      const g = document.createElement('canvas');
      g.width = 80; g.height = 80;
      const gx = g.getContext('2d');
      const id = gx.createImageData(80, 80);
      for (let i = 0; i < id.data.length; i += 4) {
        const base = 118 + Math.random() * 44 + (Math.random() - 0.5) * 26;
        const v = Math.max(0, Math.min(255, base)) | 0;
        id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v; id.data[i + 3] = 255;
      }
      gx.putImageData(id, 0, 0);
      const grain = g.toDataURL('image/jpeg', 0.55);

      return { dataURL, lqip, grain, stats, w, h };
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);

  const v = r.result.value;
  const heroBytes = saveDataUrl(join(ROOT, 'assets', 'hero-poster-obsidian.jpg'), v.dataURL);
  const grainBytes = saveDataUrl(join(ROOT, 'assets', 'grain.jpg'), v.grain);
  console.log(JSON.stringify({
    hero: { file: 'assets/hero-poster-obsidian.jpg', bytes: heroBytes, size: [v.w, v.h] },
    grain: { file: 'assets/grain.jpg', bytes: grainBytes },
    filterStats: v.stats,
    lqip: v.lqip
  }, null, 2));

  cdp.close();
  chrome.kill();
  server.close();
}
main().catch(e => { console.error('bake crashed:', e); process.exit(2); });
