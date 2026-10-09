import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4175;
const CDP_PORT = 9335;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

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
function chromeLaunch(port) {
  return spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + join(ROOT, '.chrome-profile'), '--window-size=1440,900', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
}
async function target(port) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const p = (await r.json()).find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(250); }
  throw new Error('no target');
}
class CDP {
  constructor(u) { this.id = 0; this.p = new Map(); this.ws = new WebSocket(u); }
  async open() { await new Promise((a, b) => { this.ws.onopen = a; this.ws.onerror = b; setTimeout(() => b(new Error('t')), 15000); }); this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { ok, bad } = this.p.get(m.id); this.p.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((ok, bad) => { this.p.set(id, { ok, bad }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); bad(new Error('timeout ' + method)); } }, 15000); }); }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const server = await serve();
  const chrome = chromeLaunch(CDP_PORT);
  const cdp = new CDP(await target(CDP_PORT));
  await cdp.open();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const ev = async (e, aw = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(5200);

  console.log('--- page geometry ---');
  console.log(JSON.stringify(await ev(`(() => {
    const doc = document.documentElement;
    const sel = ['#work','#systems','.philosophy','#about','.final','.sitefoot','.brains','.brains__head','.brains__grid','.brains__foot'];
    const out = { scrollH: doc.scrollHeight, vh: innerHeight, sections: {} };
    sel.forEach(s => { const e = document.querySelector(s); if (!e) { out.sections[s] = 'MISSING'; return; }
      const r = e.getBoundingClientRect();
      out.sections[s] = { top: Math.round(r.top + scrollY), h: Math.round(r.height), op: getComputedStyle(e).opacity, cls: e.className };
    });
    return out;
  })()`), null, 1));

  console.log('--- scroll to #about center ---');
  await ev(`document.querySelector('#about').scrollIntoView({block:'center', behavior:'instant'})`);
  await sleep(2000);
  console.log(JSON.stringify(await ev(`(() => {
    const e = document.querySelector('#about');
    const kids = [...e.children].map(c => { const r = c.getBoundingClientRect(); const s = getComputedStyle(c);
      return { cls: String(c.className).slice(0,40), top: Math.round(r.top), h: Math.round(r.height), op: s.opacity, tf: s.transform.slice(0,40), tr: s.transform !== 'none' }; });
    const all = [...e.querySelectorAll('*')].filter(n => n.nodeType===1 && getComputedStyle(n).opacity !== '1').slice(0,12)
      .map(n => ({ cls: String(n.className).slice(0,40), op: getComputedStyle(n).opacity }));
    return { scrollY: Math.round(scrollY), isIn: e.classList.contains('is-in'), cls: e.className, kids, notFullOpacity: all };
  })()`), null, 1));

  console.log('--- panel opacities across TRUE progress (0..1 by 0.05) ---');
  const geom = await ev(`(() => { const t = document.getElementById('track');
    return { top: t.getBoundingClientRect().top + scrollY, span: Math.max(1, t.offsetHeight - innerHeight), h: t.offsetHeight }; })()`);
  console.log('track', JSON.stringify(geom));
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    await ev(`scrollTo(0, ${geom.top} + ${geom.span} * ${p})`);
    await sleep(520);
    const ops = await ev(`[...document.querySelectorAll('[data-panel]')].map(x => +(+getComputedStyle(x).opacity).toFixed(2))`);
    const max = Math.max.apply(null, ops);
    console.log(String(p.toFixed(2)).padEnd(5), JSON.stringify(ops), max < 0.35 ? '  <-- DEAD' : '');
  }

  console.log('--- systems legend / board overflow ---');
  await ev(`document.querySelector('#systems').scrollIntoView({block:'center', behavior:'instant'})`);
  await sleep(2200);
  console.log(JSON.stringify(await ev(`(() => {
    const board = document.querySelector('.sys__board');
    const b = board.getBoundingClientRect();
    const out = { board: { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }, over: [] };
    [...board.querySelectorAll('*')].forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const clips = [];
      let p = el.parentElement;
      while (p && p !== document.body) { const s = getComputedStyle(p); if (s.overflow !== 'visible' || s.overflowX !== 'visible') { clips.push(p.className); break; } p = p.parentElement; }
      if (clips.length && (r.left < b.left - 0.5 || r.right > b.right + 0.5)) {
        out.over.push({ cls: String(el.className).slice(0, 34), tag: el.tagName, txt: (el.textContent||'').trim().slice(0, 24),
          l: Math.round(r.left), r: Math.round(r.right), over: Math.round(r.left < b.left ? b.left - r.left : r.right - b.right) });
      }
    });
    const lg = document.querySelector('.sys__legend');
    if (lg) { const lr = lg.getBoundingClientRect(); out.legend = { l: Math.round(lr.left), r: Math.round(lr.right), w: Math.round(lr.width) }; }
    return out;
  })()`), null, 1));

  console.log('--- gold samples (computed) ---');
  console.log(JSON.stringify(await ev(`(() => {
    const pick = s => { const e = document.querySelector(s); if (!e) return s + ': MISSING';
      const st = getComputedStyle(e); return s + ' => color:' + st.color + ' size:' + st.fontSize + ' txt:"' + e.textContent.trim().slice(0,26) + '"'; };
    return ['.eyebrow','.label','.case__idx','.chain dt','.case__badges li[data-kind="status"]','.sys__legend .n','.sys__flow i','.brains__label','.work-plate__bar .kind','.demo a .host'].map(pick);
  })()`), null, 1));

  cdp.close(); chrome.kill(); server.close();
}
main().catch(e => { console.error('probe crashed:', e); process.exit(1); });
