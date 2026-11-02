/* Repeatable perf probe for the two Haika pages.
   Measures compositor/CPU work while scrolling the hero track and while idle.
   Usage: node tools/perf.mjs [label] [--mobile] [--quality=low|mid|high] */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4177;
const CDP_PORT = 9337;
const ARGS = process.argv.slice(2);
const LABEL = ARGS.find(a => a.indexOf('--') !== 0) || 'run';
const MOBILE = ARGS.includes('--mobile');
const START = ARGS.includes('--start');
const PAGE = START ? '/start/' : '/index.html';
const QARG = ARGS.find(a => a.indexOf('--quality=') === 0);
const QUALITY = QARG ? QARG.split('=')[1] : (MOBILE ? 'low' : 'high');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = join(process.env.TEMP || process.env.TMP || ROOT, 'opencode', 'perf-profile-' + process.pid);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon'
};

function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
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
    '--window-size=1440,900', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
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

async function main() {
  const server = await serve();
  const chrome = launch(CDP_PORT);
  const cdp = new CDP(await target(CDP_PORT));
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');

  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const metrics = async () => {
    const m = (await cdp.send('Performance.getMetrics')).metrics;
    const out = {};
    m.forEach(x => { out[x.name] = x.value; });
    return out;
  };
  const delta = (a, b) => {
    const keys = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize'];
    const o = {};
    keys.forEach(k => { o[k] = +(b[k] - a[k]).toFixed(4); });
    return o;
  };

  const W = MOBILE ? 390 : 1440, H = MOBILE ? 844 : 900;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: MOBILE,
    screenWidth: W, screenHeight: H
  });
  if (MOBILE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}${PAGE}?quality=${QUALITY}` });
  await sleep(START ? 6000 : 4500);

  const info = await ev(`(() => {
    const t = document.getElementById('track');
    const s = document.getElementById('stage');
    const model = document.getElementById('model');
    return {
      quality: document.documentElement.getAttribute('data-quality'),
      trackTop: t ? t.getBoundingClientRect().top + scrollY : null,
      trackSpan: t ? Math.max(1, t.offsetHeight - innerHeight) : null,
      hasVideo: !!document.getElementById('clip'),
      videoSrc: !!(document.getElementById('clip') || {}).src,
      state: s && s.getAttribute('data-state'),
      live: !!(s && s.classList.contains('is-live')),
      modelGl: !!(model && model.classList.contains('is-gl')),
      modelSvg: !!document.querySelector('[data-model-svg] svg'),
      frames: 0
    };
  })()`);

  await ev(`(() => {
    window.__p = { frames: 0, long: 0, longMax: 0, drops: 0, last: 0 };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          window.__p.long++;
          window.__p.longMax = Math.max(window.__p.longMax, e.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    (function loop(ts){
      const p = window.__p;
      if (p.last && ts - p.last > 24) p.drops++;
      p.last = ts;
      p.frames++;
      requestAnimationFrame(loop);
    })();
  })()`);

  // ---- idle window: page is settled, nothing should be painting ----
  const idleA = await metrics();
  await sleep(2200);
  const idleB = await metrics();
  const idleFrames = await ev(`(() => { const f = window.__p.frames; window.__p.frames = 0; return f; })()`);

  // ---- scripted 4s scroll across the hero track (or the whole brief) ----
  const scrollA = await metrics();
  await ev(`(async () => {
    const t = document.getElementById('track');
    const top = t ? t.getBoundingClientRect().top + scrollY : 0;
    const span = t ? Math.max(1, t.offsetHeight - innerHeight) : Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const dur = 4000;
    const start = performance.now();
    await new Promise(done => {
      function step(now) {
        const k = Math.min(1, (now - start) / dur);
        const eased = k * k * (3 - 2 * k);
        window.scrollTo(0, top + span * eased);
        if (k < 1) requestAnimationFrame(step); else done();
      }
      requestAnimationFrame(step);
    });
    await new Promise(r => setTimeout(r, 500));
  })()`, true);
  const scrollB = await metrics();
  const scrollStats = await ev(`(() => { const p = window.__p; const out = { frames: p.frames, drops: p.drops, long: p.long, longMax: +p.longMax.toFixed(1) }; p.frames = 0; p.drops = 0; p.long = 0; p.longMax = 0; return out; })()`);

  const video = await ev(`(() => {
    const v = document.getElementById('clip');
    if (!v) return { exists: false };
    return { exists: true, ready: v.readyState, duration: +(v.duration || 0).toFixed(2), src: v.currentSrc ? v.currentSrc.slice(0, 60) : '' };
  })()`);

  const timing = await ev(`(() => {
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find(p => p.name === 'first-contentful-paint');
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    return {
      fcp: fcp ? Math.round(fcp.startTime) : null,
      dcl: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      requests: res.length,
      transferredKB: Math.round(res.reduce((n, r) => n + (r.transferSize || 0), 0) / 1024)
    };
  })()`);

  console.log(JSON.stringify({
    label: LABEL,
    page: PAGE,
    profile: (MOBILE ? 'mobile-390-cpu4x' : 'desktop-1440') + '/' + QUALITY,
    info,
    timing,
    idle: { seconds: 2.2, frames: idleFrames, ...delta(idleA, idleB) },
    scroll: { seconds: 4.5, ...scrollStats, ...delta(scrollA, scrollB) },
    video
  }, null, 2));

  cdp.close();
  chrome.kill();
  server.close();
}
main().catch(e => { console.error('perf crashed:', e); process.exit(2); });
