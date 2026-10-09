import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const PORT = Number(process.env.PORT || 4173);
const CHROME = process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + join(ROOT, '.chrome-profile'),
    '--window-size=1440,900', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ];
  return spawn(CHROME, args, { stdio: 'ignore' });
}

async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no chrome target');
}

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ws = new WebSocket(url);
  }
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
      } else if (m.method) {
        this.handlers.forEach(h => h(m));
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
          bad(new Error('timeout ' + method + (params.expression ? ' :: ' + String(params.expression).slice(0, 220) : '')));
        }
      }, 9000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

const report = { pass: [], fail: [] };
const ok = (name, detail = '') => report.pass.push(name + (detail ? ' — ' + detail : ''));
const bad = (name, detail = '') => report.fail.push(name + (detail ? ' — ' + detail : ''));
function check(name, cond, detail = '') { cond ? ok(name, detail) : bad(name, detail); }

const WIDTHS = [
  ['desktop-1440', 1440, 900],
  ['desktop-1280', 1280, 800],
  ['tablet-1024', 1024, 768],
  ['mobile-390', 390, 844],
  ['mobile-375', 375, 667],
  ['mobile-360', 360, 740]
];

async function main() {
  const server = await serve();
  const chrome = chromeLaunch(9333);
  const wsUrl = await target(9333);
  const cdp = new CDP(wsUrl);
  await cdp.open();

  const consoleErrors = [];
  const failedRequests = [];
  const reqUrls = new Map();
  const transfer = [];
  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleErrors.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Network.loadingFailed') {
      failedRequests.push(m.params.errorText + ' ' + (m.params.type || ''));
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      reqUrls.set(m.params.requestId, r.url);
      if (r.status >= 400) failedRequests.push(r.status + ' ' + r.url);
    }
    if (m.method === 'Network.loadingFinished') {
      transfer.push({ url: reqUrls.get(m.params.requestId) || '', bytes: m.params.encodedDataLength || 0 });
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const evalJS = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const setViewport = async (w, h) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 700, screenWidth: w, screenHeight: h
    });
  };

  await setViewport(1440, 900);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(4200);

  // ---------- console ----------
  const errs = consoleErrors.filter(e => !/fonts\.googleapis|net::ERR_/.test(e) || e.startsWith('EXCEPTION'));
  check('no console exceptions', !errs.some(e => e.startsWith('EXCEPTION')), errs.filter(e => e.startsWith('EXCEPTION')).slice(0, 3).join(' | '));
  check('no console errors', !errs.length, errs.slice(0, 4).join(' | '));

  // ---------- structure ----------
  const navTop = await evalJS(`(() => {
    const el = document.elementFromPoint(innerWidth/2, 16);
    return el ? (el.closest('.nav') ? 'nav' : (el.closest('.navmenu') ? 'navmenu' : el.className || el.tagName)) : 'none';
  })()`);
  check('nav is topmost at top of page', navTop === 'nav', navTop);

  const panel0 = await evalJS(`getComputedStyle(document.querySelector('[data-panel]')).opacity`);
  check('panel 0 visible at scroll 0', parseFloat(panel0) > 0.95, 'opacity=' + panel0);

  const deadLinks = await evalJS(`(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const h = a.getAttribute('href');
      if (!h || h === '#' || h === '' || /^(javascript|todo|example\.com)/i.test(h)) out.push(a.textContent.trim().slice(0,30) + ' -> ' + h);
      if (h.startsWith('#') && h.length > 1 && !document.querySelector(h)) out.push('missing target: ' + h);
    });
    return out;
  })()`);
  check('no dead / placeholder hrefs', deadLinks.length === 0, deadLinks.join(' | '));

  const ctas = await evalJS(`(() => {
    const a = [...document.querySelectorAll('.cta, .panel .btn, .nav__links .pill, .final .btn')];
    return a.map(x => x.tagName + ':' + x.getAttribute('href')).join(', ');
  })()`);
  check('every hero/final CTA has a real href', /start\/?/.test(ctas) && !/href="#"/.test(ctas), ctas);

  const vijay = await evalJS(`(async () => {
    const i = document.querySelector('.portrait--vijay img');
    if (!i) return false;
    i.scrollIntoView({block:'center'});
    await new Promise(r => setTimeout(r, 1200));
    return i.complete && i.naturalWidth > 0;
  })()`, true);
  check('Vijay portrait wired and loads', !!vijay);

  // ---------- scroll choreography ----------
  const trackInfo = await evalJS(`(() => {
    const t = document.getElementById('track');
    return { top: t.offsetTop, h: t.offsetHeight, doc: document.documentElement.scrollHeight, vh: innerHeight };
  })()`);

  const trackSamples = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    await evalJS(`scrollTo(0, ${trackInfo.top + trackInfo.h * f})`);
    await sleep(550);
    trackSamples.push(await evalJS(`[...document.querySelectorAll('[data-panel]')].map(x => +getComputedStyle(x).opacity)`));
  }
  const trackPeak = trackSamples.map(p => Math.max.apply(null, p));
  let run = 0, maxBlankRun = 0;
  for (const m of trackPeak) { if (m < 0.30) { run++; maxBlankRun = Math.max(maxBlankRun, run); } else run = 0; }
  const solidBeats = trackPeak.filter(o => o >= 0.90).length;
  const peaks = trackPeak.map(x => x.toFixed(2)).join(',');
  check('hero track never blanks for long', maxBlankRun <= 1,
    'longest blank run=' + maxBlankRun + ' consecutive samples; peaks=' + peaks);
  check('hero track keeps long reading windows', solidBeats >= 11,
    solidBeats + '/21 samples at >=0.9; peaks=' + peaks);

  const navMid = await evalJS(`(() => { const el = document.elementFromPoint(innerWidth/2, 16); return el && el.closest('.nav') ? 'nav' : (el && el.className) || 'none'; })()`);
  check('nav still topmost mid-track', navMid === 'nav', navMid);

  await evalJS(`scrollTo(0, document.documentElement.scrollHeight - innerHeight)`);
  await sleep(900);
  const atBottom = await evalJS(`(() => {
    const el = document.elementFromPoint(innerWidth/2, innerHeight/2);
    return el ? (el.closest('.content') ? 'content' : (el.closest('.sitefoot') ? 'footer' : (el.closest('.nav') ? 'nav' : (el.className||el.tagName)))) : 'none';
  })()`);
  check('content readable at page bottom', ['content','footer'].includes(atBottom), atBottom);

  const stageParked = await evalJS(`document.getElementById('stage').classList.contains('is-parked')`);
  check('stage parked once covered (perf)', !!stageParked);

  const navBottom = await evalJS(`(() => { const el = document.elementFromPoint(innerWidth/2, 16); return el && el.closest('.nav') ? 'nav' : (el && el.className) || 'none'; })()`);
  check('nav topmost at page bottom', navBottom === 'nav', navBottom);

  const stuck = await evalJS(`document.getElementById('nav').classList.contains('is-stuck')`);
  check('nav gains backdrop over content', !!stuck);

  // ---------- responsive overflow ----------
  for (const [name, w, h] of WIDTHS) {
    await setViewport(w, h);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(3200);
    const overflow = await evalJS(`(() => {
      const de = document.documentElement;
      const docOver = Math.max(de.scrollWidth - de.clientWidth, document.body.scrollWidth - document.body.clientWidth);
      if (docOver <= 1) return { doc: docOver, over: 0, el: '' };
      let worst = { over: 0, el: '' };
      const clipped = el => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const s = getComputedStyle(p);
          if (s.overflowX !== 'visible' || s.overflow !== 'visible') return true;
          p = p.parentElement;
        }
        return false;
      };
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > de.clientWidth + 1.5 && !clipped(el)) {
          const over = r.right - de.clientWidth;
          if (over > worst.over) worst = { over: Math.round(over), el: (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 40) };
        }
      });
      return { doc: docOver, ...worst };
    })()`);
    check(`${name}: no horizontal overflow`, overflow.doc <= 1 && overflow.over <= 1, JSON.stringify(overflow));

    if (w <= 860) {
      const toggleVisible = await evalJS(`getComputedStyle(document.getElementById('navToggle')).display !== 'none'`);
      check(`${name}: menu button shown`, !!toggleVisible);
      await evalJS(`document.getElementById('navToggle').click()`);
      await sleep(600);
      const menuOpen = await evalJS(`(() => {
        const m = document.getElementById('navmenu');
        const el = document.elementFromPoint(innerWidth/2, innerHeight/2);
        return { open: m.dataset.open, hits: el && !!el.closest('.navmenu') };
      })()`);
      check(`${name}: mobile menu opens and covers`, menuOpen.open === 'true' && menuOpen.hits, JSON.stringify(menuOpen));
      await evalJS(`document.getElementById('navToggle').click()`);
      await sleep(500);
    }
    await cdp.send('Page.captureScreenshot', { format: 'png' });
  }

  // ---------- /start ----------
  await setViewport(1440, 900);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/start/` });
  await sleep(3000);
  const startState = await evalJS(`(() => ({
    steps: document.querySelectorAll('[data-step]').length,
    visible: [...document.querySelectorAll('[data-step]')].filter(s => !s.hidden).map(s => s.dataset.step).join(','),
    parts: document.querySelectorAll('#model [data-part]').length,
    svg: !!document.querySelector('#model svg'),
    gl: document.getElementById('model').classList.contains('is-gl'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))()`);
  check('/start renders iso model', startState.svg && startState.parts >= 26, 'parts=' + startState.parts + ' gl=' + startState.gl);
  check('/start has intake steps', startState.steps === 7, JSON.stringify(startState));
  check('/start starts on step 1', startState.visible === '1', 'visible=' + startState.visible);
  check('/start no horizontal overflow', startState.overflow <= 1, 'over=' + startState.overflow);

  const blocked = await evalJS(`(async () => {
    document.getElementById('intake').requestSubmit();
    await new Promise(r => setTimeout(r, 350));
    return {
      step: document.querySelector('[data-step]:not([hidden])').dataset.step,
      err: document.getElementById('e-name').textContent
    };
  })()`, true);
  check('/start refuses an empty step 1', blocked.step === '1' && !!blocked.err, JSON.stringify(blocked));

  const baseOn = await evalJS(`document.querySelector('#model [data-part="base"]').classList.contains('is-on')`);
  check('/start model base is present', !!baseOn);

  const adv = await evalJS(`(async () => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const submit = async () => { document.getElementById('intake').requestSubmit(); await new Promise(r => setTimeout(r, 350)); };
    const now = () => document.querySelector('[data-step]:not([hidden])').dataset.step;
    const on = k => { const g = document.querySelector('#model [data-part="' + k + '"]'); return g ? g.classList.contains('is-on') : false; };
    const log = { steps: [], parts: {} };

    set('f-name', 'QA Tester'); set('f-email', 'qa@example.com'); set('f-phone', '+91 12345 67890');
    await submit(); log.steps.push(now());

    set('f-company', 'Test Bakery'); set('f-site', 'testbakery.com');
    await submit(); log.steps.push(now());
    log.parts.biz = on('biz');

    document.querySelector('input[name="parts"][value="Website"]').click();
    await new Promise(r => setTimeout(r, 120));
    log.parts['comp-website'] = on('comp-website');
    await submit(); log.steps.push(now());

    document.querySelector('input[name="bottleneck"][value="Getting more leads"]').click();
    await new Promise(r => setTimeout(r, 120));
    log.parts.stress = on('stress');
    await submit(); log.steps.push(now());

    document.querySelector('input[name="current"][value="None yet"]').click();
    await new Promise(r => setTimeout(r, 120));
    log.parts.none = on('none');
    await submit(); log.steps.push(now());

    await submit(); log.steps.push(now());
    log.rows = document.querySelectorAll('.review__row').length;
    log.keyline = on('keyline');
    return log;
  })()`, true);
  check('/start walks all seven steps', adv.steps.join(',') === '2,3,4,5,6,7', adv.steps.join(','));
  check('/start model reacts to answers', adv.parts.biz && adv.parts['comp-website'] && adv.parts.stress && adv.parts.none, JSON.stringify(adv.parts));
  check('/start review summarises the brief', adv.rows === 6, 'rows=' + adv.rows);
  check('/start keyline appears at review', !!adv.keyline);

  const receipt = await evalJS(`(async () => {
    document.getElementById('f-consent').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('intake').requestSubmit();
    await new Promise(r => setTimeout(r, 700));
    const r = document.querySelector('[data-receipt]');
    const a = document.getElementById('mailBrief');
    return {
      shown: !r.hidden,
      ref: document.querySelector('[data-receipt-ref]').textContent,
      mail: a ? a.getAttribute('href') : '',
      formHidden: document.getElementById('intake').hidden
    };
  })()`, true);
  check('/start issues a draft reference', receipt.shown && /^HK-[A-Z0-9]{6}$/.test(receipt.ref), JSON.stringify(receipt).slice(0, 200));
  check('/start hands off a prepared email', /^mailto:[^?]+\?subject=/.test(receipt.mail) && /Lowkey\.vijay@gmail\.com/.test(receipt.mail), receipt.mail.slice(0, 80));
  check('/start hides the form once sent', !!receipt.formHidden);

  await setViewport(390, 844);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/start/` });
  await sleep(2200);
  const startMobile = await evalJS(`(() => ({
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    model: document.getElementById('model').getBoundingClientRect().height
  }))()`);
  check('/start mobile: no horizontal overflow', startMobile.over <= 1, 'over=' + startMobile.over);
  check('/start mobile: model panel visible', startMobile.model > 180, 'h=' + Math.round(startMobile.model));

  const startErrs = consoleErrors.filter(e => e.startsWith('EXCEPTION') || /^error:/i.test(e));
  check('/start console clean', !startErrs.length, startErrs.slice(0, 4).join(' | '));

  // ---------- reduced motion ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await setViewport(1440, 900);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(3200);
  const rmHome = await evalJS(`(() => {
    const v = document.querySelector('video');
    const stage = document.getElementById('stage');
    return { href: location.pathname, hasVideo: !!v, state: stage && stage.getAttribute('data-state') };
  })()`);
  check('reduced motion: home drops the video and shows the poster',
    rmHome.hasVideo === false && rmHome.state === 'poster', JSON.stringify(rmHome));

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/start/` });
  await sleep(3000);
  const rmStart = await evalJS(`({
    svg: !!document.querySelector('#model svg'),
    parts: document.querySelectorAll('#model [data-part]').length,
    gl: document.getElementById('model').classList.contains('is-gl')
  })`);
  check('reduced motion: /start falls back to the SVG renderer',
    rmStart.svg && rmStart.parts >= 26 && !rmStart.gl, JSON.stringify(rmStart));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  // ---------- document structure ----------
  for (const page of ['index.html', 'start/']) {
    await setViewport(1440, 900);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });
    await sleep(2200);
    const doc = await evalJS(`(() => {
      const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
      const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
      return {
        h1: document.querySelectorAll('h1').length,
        dupes: [...new Set(dupes)],
        three: performance.getEntriesByType('resource').some(r => r.name.includes('three')),
        title: document.title
      };
    })()`);
    check(page + ': exactly one h1', doc.h1 === 1, 'h1=' + doc.h1);
    check(page + ': no duplicate ids', doc.dupes.length === 0, doc.dupes.join(','));
    check(page + ': has a descriptive title', doc.title.length > 10 && /Haika/.test(doc.title), doc.title);
    check(page + ': three.js stays off the home page', page !== 'index.html' || !doc.three, 'three=' + doc.three);
  }


  // ---------- text contrast ----------
  const AUDIT = `(() => {
    const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = el => {
      const layers = [];
      let n = el;
      while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) layers.push(c); n = n.parentElement; }
      layers.push({ r: 255, g: 255, b: 255, a: 1 });
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = over(layers[i], out);
      return out;
    };
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
      if (!txt) return;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.5) return;
      if (el.closest('[aria-hidden="true"]') || el.closest('.vh') || el.closest('.boot')) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const isSvgText = el.tagName.toLowerCase() === 'text';
      const shown = isSvgText ? s.fill : s.color;
      const fg = parse(shown); if (!fg) return;
      const bg = bgOf(el);
      const f = fg.a < 1 ? over(fg, bg) : fg;
      const L1 = lum(f), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px0 = parseFloat(s.fontSize);
      // SVG text is sized in user units — resolve to the on-screen size so the
      // 24px large-text threshold is judged the way a reader actually sees it
      const ctm = (isSvgText && el.getScreenCTM) ? el.getScreenCTM() : null;
      const px = ctm ? px0 * Math.abs(ctm.a) : px0;
      const need = (px >= 24 || (px >= 18.66 && parseInt(s.fontWeight, 10) >= 700)) ? 3 : 4.5;
      if (ratio + 0.01 < need) {
        bad.push({
          t: txt.slice(0, 34), ratio: +ratio.toFixed(2), need,
          px: Math.round(px), color: shown,
          bg: 'rgb(' + [bg.r, bg.g, bg.b].map(x => Math.round(x)).join(',') + ')',
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 34)
        });
      }
    });
    return bad;
  })()`;

  const lowContrast = [];
  for (const page of ['index.html', 'start/']) {
    await setViewport(1440, 900);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });
    await sleep(2000);
    await evalJS(`(async () => { window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(r => setTimeout(r, 1400)); window.scrollTo(0,0); await new Promise(r => setTimeout(r, 800)); })()`, true);
    (await evalJS(AUDIT)).forEach(x => lowContrast.push(page + ' ' + JSON.stringify(x)));
  }
  check('text meets WCAG AA contrast', lowContrast.length === 0,
    '[' + lowContrast.length + '] ' + lowContrast.slice(0, 80).join(' | '));

  // ---------- external link liveness ----------
  const hrefs = new Set();
  for (const page of ['index.html', 'start/']) {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });
    await sleep(1500);
    (await evalJS(`[...document.querySelectorAll('a[href^="http"]')].map(a => a.href)`)).forEach(u => hrefs.add(u));
  }
  for (const u of hrefs) {
    try {
      const r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      check('external link live: ' + u.replace(/^https?:\/\//, '').slice(0, 52), r.status < 400, 'HTTP ' + r.status);
    } catch (e) {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch(() => null);
      check('external link live: ' + u.replace(/^https?:\/\//, '').slice(0, 52), !!r && r.status < 400, r ? 'HTTP ' + r.status : 'unreachable');
    }
  }

  // ---------- performance budget (cache disabled, cold load) ----------
  const budgets = { 'index.html': 220, 'start/': 1100 };
  for (const page of ['index.html', 'start/']) {
    await setViewport(1440, 900);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    transfer.length = 0;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });
    await sleep(4500);
    const t = await evalJS(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, Math.round(p.startTime)]));
      return { fcp: paints['first-contentful-paint'] ?? -1, dcl: Math.round(nav.domContentLoadedEventEnd) };
    })()`);
    const local = transfer.filter(x => x.url.startsWith(`http://127.0.0.1:${PORT}`));
    const localKb = Math.round(local.reduce((s, x) => s + x.bytes, 0) / 1024);
    check(page + ': first contentful paint under 1800 ms', t.fcp >= 0 && t.fcp < 1800, t.fcp + ' ms');
    check(page + ': DOMContentLoaded under 2500 ms', t.dcl > 0 && t.dcl < 2500, t.dcl + ' ms');
    check(page + ': local payload under ' + budgets[page] + ' KB',
      localKb <= budgets[page], localKb + ' KB over ' + local.length + ' requests');
    console.log('  perf ' + page + ': fcp=' + t.fcp + 'ms dcl=' + t.dcl + 'ms local=' + localKb + 'KB');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  }

  cdp.close();
  chrome.kill();
  server.close();

  console.log('\n=== PASS (' + report.pass.length + ') ===');
  report.pass.forEach(p => console.log('  ok  ' + p));
  console.log('\n=== FAIL (' + report.fail.length + ') ===');
  report.fail.forEach(f => console.log('  XX  ' + f));
  console.log('\nfailed requests: ' + [...new Set(failedRequests)].slice(0, 12).join(' | '));
  process.exit(report.fail.length ? 1 : 0);
}

main().catch(e => { console.error('QA crashed:', e); process.exit(2); });
