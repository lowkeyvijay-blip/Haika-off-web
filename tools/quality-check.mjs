/* Functional smoke test across the three quality tiers.
   Usage: node tools/quality-check.mjs */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = 4178;
const CDP_PORT = 9338;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = join(process.env.TEMP || process.env.TMP || ROOT, 'opencode', 'quality-profile-' + process.pid);

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

function chromeLaunch(port) {
  return spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
}

async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

class CDP {
  constructor(u) { this.id = 0; this.p = new Map(); this.ws = new WebSocket(u); }
  async open() {
    await new Promise((a, b) => { this.ws.onopen = a; this.ws.onerror = b; setTimeout(() => b(new Error('timeout')), 15000); });
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); bad(new Error('timeout ' + method)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
}

async function main() {
  const server = await serve();
  const chrome = chromeLaunch(CDP_PORT);
  const cdp = new CDP(await target(CDP_PORT));
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push(String(e.message)));addEventListener('unhandledrejection',e=>window.__errs.push(String(e.reason)));`
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900
  });

  const ev = async (e, aw = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const go = async (url, wait = 2600) => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}${url}` });
    await sleep(wait);
  };

  for (const tier of ['low', 'mid', 'high']) {
    console.log(`\n--- ${tier.toUpperCase()} ---`);
    await go(`/index.html?quality=${tier}`);

    const home = await ev(`(() => {
      const s = document.getElementById('stage');
      const g = document.querySelector('.grain');
      const v = document.getElementById('clip');
      const nav = document.querySelector('.nav');
      const ch = document.getElementById('chapters');
      return {
        quality: document.documentElement.getAttribute('data-quality'),
        video: !!v, src: !!(v && v.src), ready: v ? v.readyState : null,
        state: s && s.getAttribute('data-state'), live: !!(s && s.classList.contains('is-live')),
        grain: g ? getComputedStyle(g).display : 'missing',
        grainOp: g ? getComputedStyle(g).opacity : null,
        chapters: ch ? getComputedStyle(ch).display : 'missing',
        chapterOn: ch ? ch.querySelectorAll('.is-active').length : 0,
        railRight: ch ? ch.getBoundingClientRect().right : 0,
        headLeft: (() => {
          const h = document.querySelector('[data-panel] h1');
          return h ? h.getBoundingClientRect().left : 0;
        })(),
        navBlur: getComputedStyle(nav).backdropFilter,
        errs: (window.__errs || []).slice()
      };
    })()`);
    check(`${tier}: home boots clean`, home.errs.length === 0, home.errs);
    check(`${tier}: quality attribute`, home.quality === tier, home.quality);
    if (tier === 'low') {
      check('low: hero video is not loaded', !home.video && !home.src, { video: home.video, src: home.src });
      check('low: stage stays on the poster', home.state === 'poster' && !home.live, { state: home.state, live: home.live });
      check('low: grain layer is dropped', home.grain === 'none', home.grain);
    } else if (tier === 'mid') {
      check('mid: hero video is not loaded', !home.video && !home.src, { video: home.video, src: home.src });
      check('mid: stage stays on the poster', home.state === 'poster' && !home.live, { state: home.state, live: home.live });
      check('mid: grain layer is painted', home.grain !== 'none', { display: home.grain, opacity: home.grainOp });
    } else {
      check('high: hero video is wired', home.video && home.src, { video: home.video, src: home.src, ready: home.ready });
      check('high: grain layer is painted', home.grain !== 'none', { display: home.grain, opacity: home.grainOp });
    }
    check(`${tier}: chapter rail visibility`, tier === 'high' ? home.chapters === 'block' : home.chapters === 'none', home.chapters);
    if (tier === 'high') {
      check('high: chapter rail has an active step', home.chapterOn === 1, home.chapterOn);
      check('high: chapter rail clears the copy', home.railRight < home.headLeft - 8, { railRight: Math.round(home.railRight), headLeft: Math.round(home.headLeft) });
    }

    await ev(`(() => {
      const t = document.getElementById('track');
      const span = t ? Math.max(1, t.offsetHeight - innerHeight) : 0;
      scrollTo({ top: span * 0.5, behavior: 'instant' });
    })()`);
    await sleep(400);
    const scrub = await ev(`(() => {
      const p = document.getElementById('heroPoster');
      const s = document.getElementById('stage');
      const ch = document.getElementById('chapters');
      const items = ch ? Array.from(ch.querySelectorAll('li')) : [];
      return {
        transform: p ? getComputedStyle(p).transform : 'missing',
        live: !!(s && s.classList.contains('is-live')),
        chapter: items.findIndex(li => li.classList.contains('is-active'))
      };
    })()`);
    if (tier === 'mid') {
      check('mid: poster carries the hero motion', scrub.transform !== 'none' && scrub.transform !== 'matrix(1.03, 0, 0, 1.03, 0, 0)', scrub.transform);
    }
    if (tier === 'high') {
      check('high: video replaces the poster', scrub.live, scrub.live);
      check('high: chapter rail tracks scroll', scrub.chapter === 2, scrub.chapter);
    }

    await ev(`document.querySelector('#about').scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(500);
    const brains = await ev(`(() => {
      const b = document.querySelector('.brains');
      const p = getComputedStyle(b).getPropertyValue('--p').trim();
      const nav = document.querySelector('.nav');
      return {
        p,
        stuck: nav.classList.contains('is-stuck'),
        scrolling: nav.classList.contains('is-scrolling'),
        blur: getComputedStyle(nav).backdropFilter
      };
    })()`);
    if (tier === 'low') check('low: portrait parallax stays off', brains.p === '0', brains.p);
    else check(`${tier}: portrait progress is live`, brains.p !== '' && brains.p !== '0', brains.p);
    check(`${tier}: nav reaches its stuck state`, brains.stuck, brains.stuck);
    if (tier === 'high') check('high: nav gets a real blur', brains.blur !== 'none', brains.blur);
    else check(`${tier}: nav avoids the expensive blur`, brains.blur === 'none', brains.blur);

    await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(900);
    const end = await ev(`(() => {
      const s = document.getElementById('stage');
      return {
        parked: !!(s && s.classList.contains('is-parked')),
        navStuck: document.querySelector('.nav').classList.contains('is-stuck'),
        errs: (window.__errs || []).slice()
      };
    })()`);
    check(`${tier}: home runs to the footer clean`, end.errs.length === 0, end.errs);
    check(`${tier}: stage parks at the bottom`, end.parked, end.parked);
    check(`${tier}: nav gains its stuck state`, end.navStuck, end.navStuck);

    await go(`/start/?quality=${tier}`, 3000);
    const start = await ev(`(() => {
      const svg = document.querySelector('[data-model-svg] svg');
      const gl = document.querySelector('[data-model-gl]');
      const model = document.getElementById('model');
      const step = document.querySelector('[data-step]:not([hidden])');
      return {
        quality: document.documentElement.getAttribute('data-quality'),
        svg: !!svg, gl: !!gl,
        modelGl: !!(model && model.classList.contains('is-gl')),
        step: step && step.getAttribute('data-step'),
        errs: (window.__errs || []).slice()
      };
    })()`);
    check(`${tier}: /start boots clean`, start.errs.length === 0, start.errs);
    check(`${tier}: /start quality attribute`, start.quality === tier, start.quality);
    check(`${tier}: /start starts on step 1`, start.step === '1', start.step);
    if (tier === 'low') check('low: /start stays SVG-only', start.svg && !start.modelGl, { svg: start.svg, gl: start.modelGl });
    else check(`${tier}: /start uses WebGL`, start.modelGl && start.gl, { gl: start.modelGl, canvas: start.gl });

    const walked = await ev(`(async () => {
      const next = document.querySelector('[data-next]');
      [['#f-name', 'Quality Check'], ['#f-email', 'qa@example.com']].forEach(([sel, value]) => {
        const el = document.querySelector(sel);
        if (el) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      if (next) next.click();
      await new Promise(r => setTimeout(r, 350));
      const step = document.querySelector('[data-step]:not([hidden])');
      return {
        step: step && step.getAttribute('data-step'),
        errs: (window.__errs || []).slice()
      };
    })()`, true);
    check(`${tier}: /start advances`, walked.step === '2', walked.step);
    check(`${tier}: /start stays clean after advancing`, walked.errs.length === 0, walked.errs);
  }

  console.log(`\n=== ${results.every(r => r.pass) ? 'PASS' : 'FAIL'} (${results.filter(r => r.pass).length}/${results.length}) ===`);

  cdp.close();
  chrome.kill();
  server.close();
  if (!results.every(r => r.pass)) process.exitCode = 1;
}

main().catch(e => { console.error('quality check crashed:', e); process.exit(2); });
