/* =========================================================================
   Haika — /start intake
   Seven-step brief plus a model that assembles as the brief is answered.

   Two renderers share one part table:
     · SVG  — always available (mobile, reduced motion, WebGL failure)
     · WebGL (three.js) — progressive upgrade on capable desktops

   Submission is honest: a real POST when an endpoint is configured, and a
   prepared email handoff when it is not. Nothing is ever faked as stored.
   ========================================================================= */

(function () {
  'use strict';

  var doc = document;
  var CFG = (window.HAIKA && window.HAIKA.config) || {};
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var modelEl = doc.getElementById('model');

  /* ---------------------------------------------------------------- helpers */
  function named(id) { try { return document.getElementById('intake').elements.namedItem(id); } catch (e) { return null; } }
  function text(id) { var el = named(id); return el && typeof el.value === 'string' ? el.value : ''; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v).trim()); }
  function mailto(addr, subject, body) {
    return 'mailto:' + String(addr || '').trim().replace(/[\s]+/g, '') +
      '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  /* contact destination comes from config, never from markup */
  (function contactLinks() {
    var email = CFG.contact && CFG.contact.email;
    if (!email) return;
    var nodes = doc.querySelectorAll('[data-contact-link]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('href', 'mailto:' + email);
      if (nodes[i].getAttribute('data-contact-link') === 'text') nodes[i].textContent = email;
    }
  })();

  /* =======================================================================
     PART TABLE — shared by both renderers
     box = [x0, x1, y0, y1, z0, z1]   (z is up)
     ======================================================================= */
  var SLOTS = ['cur-website', 'cur-whatsapp', 'cur-crm', 'cur-forms', 'cur-sheets', 'none'];
  var slotY = function (i) { return -20 + i * 7.2; };

  var PARTS = [
    { id: 'base', key: 'base', box: [-34, 34, -22, 22, 0, 7], tone: 'light' },

    { id: 'r1', key: 'biz', box: [-26, -22, -14, -10, 7, 16], tone: 'dark' },
    { id: 'r2', key: 'biz', box: [22, 26, -14, -10, 7, 16], tone: 'dark' },
    { id: 'r3', key: 'biz', box: [-26, -22, 6, 10, 7, 16], tone: 'dark' },
    { id: 'r4', key: 'biz', box: [22, 26, 6, 10, 7, 16], tone: 'dark' },
    { id: 'biz', key: 'biz', box: [-30, 30, -19, 19, 16, 21], tone: 'light' },

    { id: 'cw', key: 'comp-website', box: [-26, -10, -15, -4, 21, 44], tone: 'light' },
    { id: 'cc', key: 'comp-chatbot', box: [-6, 6, -15, -4, 21, 31], tone: 'light' },
    { id: 'cv', key: 'comp-voice', box: [10, 24, -15, -4, 21, 34], tone: 'light' },
    { id: 'ca', key: 'comp-automation', box: [-20, -4, 2, 15, 21, 30], tone: 'light' },
    { id: 'ck', key: 'comp-custom', box: [2, 24, 2, 15, 21, 33], tone: 'light' },

    { id: 'stress', key: 'stress', box: [36, 41, -5, 5, 0, 46], tone: 'gold' },
    { id: 'stresscap', key: 'stress', box: [34, 43, -7, 7, 46, 49], tone: 'gold' },

    { id: 'notes', key: 'notes', box: [-30, 30, -19, 19, 53.4, 54.2], tone: 'datum' },
    { id: 'keyline', key: 'keyline', box: [-36, 36, -24, 24, 7.1, 7.7], tone: 'datum' }
  ];

  SLOTS.forEach(function (key, i) {
    var y = slotY(i);
    PARTS.push({ id: 's' + i, key: key, box: [-52, -44, y, y + 6, 0, 8], tone: 'dark' });
    PARTS.push({ id: 'l' + i, key: key, link: [-44, y + 3, 4, -34, y + 3, 4] });
  });

  /* =======================================================================
     STATE
     ======================================================================= */
  var state = {
    step: 1, max: 1, sending: false, done: false,
    values: { name: '', email: '', phone: '', company: '', site: '', vision: '', parts: [], bottleneck: [], current: [], consent: false }
  };

  function partOn(key) {
    var v = state.values;
    if (key === 'base') return true;
    if (key === 'biz') return state.max >= 2 && v.company.trim().length > 0;
    if (key.indexOf('comp-') === 0) return v.parts.some(function (p) { return p.model === key; });
    if (key === 'stress') return v.bottleneck.length > 0;
    if (key === 'none') return v.current.some(function (c) { return c.model === 'none'; });
    if (key.indexOf('cur-') === 0) return v.current.some(function (c) { return c.model === key; });
    if (key === 'notes') return state.max >= 6;
    if (key === 'keyline') return state.step >= 7;
    return false;
  }

  /* =======================================================================
     SVG RENDERER
     ======================================================================= */
  var K = 0.8660254;
  function px(x, y, z) { return ((x - y) * K).toFixed(2) + ',' + ((x + y) * 0.5 - z).toFixed(2); }
  function poly(pts, cls) {
    return '<polygon class="' + cls + '" points="' + pts.map(function (p) { return px(p[0], p[1], p[2]); }).join(' ') + '"/>';
  }

  function solid(b, tone) {
    var x0 = b[0], x1 = b[1], y0 = b[2], y1 = b[3], z0 = b[4], z1 = b[5];
    if (tone === 'datum') {
      return poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], 'mk-datum');
    }
    var top = tone === 'gold' ? 'mk-gold' : tone === 'dark' ? 'mk-dark-top' : 'mk-top';
    var fA = tone === 'gold' ? 'mk-goldside' : tone === 'dark' ? 'mk-dark' : 'mk-side';
    var fB = tone === 'gold' ? 'mk-goldside' : tone === 'dark' ? 'mk-dark2' : 'mk-side2';
    var out = '';
    out += poly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], fA);
    out += poly([[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]], fB);
    out += poly([[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], fB);
    out += poly([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], fA);
    out += poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], top);
    out += poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      tone === 'light' ? 'mk-edge' : 'mk-edge-l');
    return out;
  }

  var ORDER = ['cur', 'base', 'keyline', 'biz', 'comp', 'stress', 'notes'];

  function buildSVG() {
    var groups = {};
    ORDER.forEach(function (k) { groups[k] = []; });

    PARTS.forEach(function (p) {
      var g = p.key === 'base' ? 'base'
        : p.key === 'keyline' ? 'keyline'
        : p.key === 'biz' ? 'biz'
        : p.key.indexOf('comp-') === 0 ? 'comp'
        : p.key === 'stress' ? 'stress'
        : p.key === 'notes' ? 'notes' : 'cur';
      var markup;
      if (p.link) {
        var a = px(p.link[0], p.link[1], p.link[2]).split(',');
        var c = px(p.link[3], p.link[4], p.link[5]).split(',');
        markup = '<line class="mk-link" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + c[0] + '" y2="' + c[1] + '"/>';
      } else {
        markup = solid(p.box, p.tone);
      }
      groups[g].push('<g data-part="' + p.key + '" data-part-id="' + p.id + '">' + markup + '</g>');
    });

    var label = '<text class="mk-note" x="-70" y="-70">Isometric · live assembly</text>';
    var title = '<text class="mk-note mk-note-gold" x="8" y="34">Haika · brief model</text>';

    return '<svg viewBox="-74 -78 134 116" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid meet">'
      + ORDER.map(function (k) { return groups[k].join(''); }).join('')
      + label + title + '</svg>';
  }

  var svgHost = doc.querySelector('[data-model-svg]');
  if (svgHost) svgHost.innerHTML = buildSVG();

  function paintSVG() {
    var keys = {};
    var nodes = modelEl ? modelEl.querySelectorAll('[data-part]') : [];
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-part');
      var on = partOn(key);
      nodes[i].classList.toggle('is-on', on);
      if (on) keys[key] = 1;
    }
    return Object.keys(keys).length;
  }

  /* =======================================================================
     WEBGL RENDERER (three.js) — only loaded when it can actually be used
     ======================================================================= */
  var gl3d = null;

  function initGL() {
    if (reduced || !fine || !modelEl) return Promise.resolve();
    var canvas = doc.querySelector('[data-model-gl]');
    if (!canvas) return Promise.resolve();
    if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) return Promise.resolve();

    return import('three').then(function (THREE) {
      var renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      } catch (e) { return; }
      renderer.setClearColor(0x000000, 0);

      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(30, 1, 1, 1600);
      var rig = new THREE.Group();
      scene.add(rig);

      scene.add(new THREE.HemisphereLight(0xF0EDE6, 0x1A1A1C, 1.05));
      var key = new THREE.DirectionalLight(0xfff3dd, 1.5); key.position.set(-48, 86, 54); scene.add(key);
      var fill = new THREE.DirectionalLight(0xD0B783, 0.55); fill.position.set(66, 28, -40); scene.add(fill);
      scene.add((function () { var r = new THREE.DirectionalLight(0xffffff, 0.4); r.position.set(10, -30, -70); return r; })());

      var PALETTE = {
        light: [0xe9e6de, 0xb9b4a7, 0x9d978a],
        dark: [0x35332e, 0x242320, 0x1b1a18],
        gold: [0xD0B783, 0xB0945E, 0x8C7547],
        datum: [0xD0B783, 0xD0B783, 0xD0B783]
      };
      var mats = {};
      Object.keys(PALETTE).forEach(function (t) {
        var p = PALETTE[t];
        var mk = function (c, rough, metal) {
          return new THREE.MeshStandardMaterial({
            color: c, roughness: rough, metalness: metal,
            transparent: true, opacity: 0, depthWrite: true
          });
        };
        var rough = t === 'gold' ? 0.45 : 0.86;
        var metal = t === 'gold' ? 0.25 : 0.02;
        mats[t] = [mk(p[1], rough, metal), mk(p[2], rough, metal), mk(p[0], rough, metal), mk(0x101113, rough, metal), mk(p[1], rough, metal), mk(p[2], rough, metal)];
      });
      var edgeDark = new THREE.LineBasicMaterial({ color: 0x090A0B, transparent: true, opacity: 0 });
      var edgeGold = new THREE.LineBasicMaterial({ color: 0xD0B783, transparent: true, opacity: 0 });

      var meshes = [];

      PARTS.forEach(function (p) {
        var m, geo;
        if (p.link) {
          var len = Math.abs(p.link[3] - p.link[0]);
          geo = new THREE.BoxGeometry(len, 0.5, 0.5);
          m = new THREE.Mesh(geo, mats.gold[1].clone());
          m.position.set((p.link[0] + p.link[3]) / 2, (p.link[2] + p.link[5]) / 2, (p.link[1] + p.link[4]) / 2);
          m.userData = { key: p.key, tone: 'gold', on: false, cur: 0, base: m.position.clone(), drop: 0, link: true, edge: null };
        } else {
          var b = p.box;
          geo = new THREE.BoxGeometry(b[1] - b[0], b[5] - b[4], b[3] - b[2]);
          m = new THREE.Mesh(geo, mats[p.tone].map(function (x) { return x.clone(); }));
          m.position.set((b[0] + b[1]) / 2, (b[4] + b[5]) / 2, (b[2] + b[3]) / 2);
          var edge = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            (p.tone === 'gold' || p.tone === 'datum') ? edgeGold.clone() : edgeDark.clone()
          );
          m.add(edge);
          m.userData = { key: p.key, tone: p.tone, on: false, cur: 0, base: m.position.clone(), drop: -11, link: false, edge: edge };
        }
        m.visible = false;
        rig.add(m);
        meshes.push(m);
      });

      var CAM = {
        1: [24, 26, 74, 0, 6, 0], 2: [30, 34, 84, 0, 12, 0], 3: [34, 44, 96, 0, 24, 0],
        4: [46, 42, 96, 6, 24, 0], 5: [8, 40, 118, -8, 14, 0], 6: [30, 54, 106, 0, 30, 0],
        7: [48, 50, 118, 0, 22, 0]
      };
      var camP = new THREE.Vector3(), camT = new THREE.Vector3();
      var goalP = new THREE.Vector3(), goalT = new THREE.Vector3();
      var curStep = 1;
      var rot = 0, spin = 0, ptr = 0, ptrGoal = 0, idle = 0, alive = true, pending = true;

      // The model is ~79 x 54 x 48 units (bounding sphere ~54 + 11 units of
      // entry-drop margin). Each CAM entry keeps its own framing weight, but
      // the distance it resolves to is derived from the current panel aspect
      // so the assembly always sits inside the viewport instead of cropping.
      var FIT_R = 58;
      function fitDistance() {
        var half = 15 * Math.PI / 180;
        var a = camera.aspect > 0 ? camera.aspect : 1;
        var halfH = Math.atan(Math.tan(half) * a);
        return Math.max(FIT_R / Math.sin(half), FIT_R / Math.sin(halfH));
      }
      function applyCam(step) {
        curStep = step;
        var c = CAM[step] || CAM[7];
        var tx = c[3], ty = c[4], tz = c[5];
        var dx = c[0] - tx, dy = c[1] - ty, dz = c[2] - tz;
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        // CAM entries keep their own framing weight, but only across a narrow
        // band — enough to breathe between steps without ever cropping the
        // assembly out of the panel.
        var t = Math.min(1, Math.max(0, (len - 80) / 50));
        var d = fitDistance() * (0.86 + t * 0.10);
        goalT.set(tx, ty, tz);
        goalP.set(tx + dx / len * d, ty + dy / len * d, tz + dz / len * d);
        pending = true;
      }

      function resize() {
        var r = modelEl.getBoundingClientRect();
        var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        applyCam(curStep);
      }
      var ro = new ResizeObserver(resize);
      ro.observe(modelEl);
      resize();
      camP.copy(goalP);
      camT.copy(goalT);

      if (fine) {
        modelEl.addEventListener('pointermove', function (e) {
          var r = modelEl.getBoundingClientRect();
          ptrGoal = ((e.clientX - r.left) / r.width * 2 - 1) * 0.2;
          pending = true;
        }, { passive: true });
        modelEl.addEventListener('pointerleave', function () { ptrGoal = 0; pending = true; }, { passive: true });
      }

      gl3d = {
        sync: function (step, shouldSpin) {
          var seen = {};
          meshes.forEach(function (m) {
            var u = m.userData;
            var on = partOn(u.key);
            if (on && !u.on) u.cur = 0;
            u.on = on;
            seen[u.key] = 1;
          });
          applyCam(step);
          spin = shouldSpin ? 1 : 0;
          pending = true;
        },
        stop: function () { alive = false; ro.disconnect(); try { renderer.dispose(); } catch (e) {} }
      };

      function frame() {
        if (!alive) return;
        var moving = false;

        camP.lerp(goalP, 0.055);
        camT.lerp(goalT, 0.055);
        if (camP.distanceTo(goalP) > 0.05) moving = true;

        ptr += (ptrGoal - ptr) * 0.07;
        if (Math.abs(ptrGoal - ptr) > 0.0006) moving = true;

        if (spin) { rot += 0.0034; moving = true; }
        else if (Math.abs(rot) > 0.0005) { rot *= 0.94; moving = true; } else rot = 0;

        meshes.forEach(function (m) {
          var u = m.userData;
          var goal = u.on ? 1 : 0;
          var d = goal - u.cur;
          if (Math.abs(d) > 0.004) { u.cur += d * 0.13; moving = true; }
          else u.cur = goal;

          var op = u.tone === 'datum' ? u.cur * 0.6 : u.cur;
          if (u.tone === 'dark') op = u.cur * 0.98;
          if (Array.isArray(m.material)) m.material.forEach(function (x) { x.opacity = op; });
          else m.material.opacity = op;
          if (u.edge) u.edge.material.opacity = u.cur * 0.55;
          if (!u.link) m.position.y = u.base.y + (1 - u.cur) * u.drop;
          m.visible = u.cur > 0.01;
        });

        if (moving) pending = false;
        rig.rotation.y = ptr + rot;
        camera.position.copy(camP);
        camera.lookAt(camT);
        renderer.render(scene, camera);

        if (pending && !moving) pending = false;
        if (moving || pending) requestAnimationFrame(frame);
        else setTimeout(function () { if (alive) requestAnimationFrame(frame); }, 140);
      }

      modelEl.classList.add('is-gl');
      gl3d.sync(state.step, false);
      requestAnimationFrame(frame);
    }).catch(function () { /* stay on the SVG renderer */ });
  }

  /* =======================================================================
     MODEL READOUT
     ======================================================================= */
  var STEP_LABELS = {
    1: '01 · Base', 2: '02 · Business layer', 3: '03 · Components',
    4: '04 · Load', 5: '05 · Existing connections', 6: '06 · Vision datum', 7: '07 · Review'
  };

  function paintModel() {
    var count = paintSVG();
    var label = doc.querySelector('[data-model-label]');
    var cnt = doc.querySelector('[data-model-count]');
    if (label) label.textContent = STEP_LABELS[state.step];
    if (cnt) cnt.textContent = count + (count === 1 ? ' part' : ' parts');
    if (modelEl) modelEl.setAttribute('data-stage', String(state.step));
    if (gl3d) gl3d.sync(state.step, state.step === 7);
  }

  /* =======================================================================
     STEP MACHINE
     ======================================================================= */
  var form = doc.getElementById('intake');
  var steps = [].slice.call(form.querySelectorAll('[data-step]'));
  var railBtns = [].slice.call(doc.querySelectorAll('.steprail [data-goto]'));
  var backBtn = form.querySelector('[data-back]');
  var nextBtn = form.querySelector('[data-next]');
  var statusEl = form.querySelector('[data-status]');
  var readout = doc.querySelector('[data-step-readout]');
  var bar = doc.querySelector('[data-progress-bar]');

  function readValues() {
    var v = state.values;
    v.name = text('name'); v.email = text('email'); v.phone = text('phone');
    v.company = text('company'); v.site = text('site'); v.vision = text('vision');
    var consent = named('consent');
    v.consent = !!(consent && consent.checked);
    v.parts = [].slice.call(form.querySelectorAll('input[name="parts"]:checked'))
      .map(function (i) { return { value: i.value, model: i.getAttribute('data-model') }; });
    v.bottleneck = [].slice.call(form.querySelectorAll('input[name="bottleneck"]:checked'))
      .map(function (i) { return i.value; });
    v.current = [].slice.call(form.querySelectorAll('input[name="current"]:checked'))
      .map(function (i) { return { value: i.value, model: i.getAttribute('data-model') }; });
  }

  function setErr(id, msg) {
    var box = doc.getElementById('e-' + id);
    if (box) box.textContent = msg || '';
    var input = named(id);
    if (input && input.setAttribute) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function validate(step) {
    readValues();
    var v = state.values, firstBad = null;
    function fail(id, msg) { setErr(id, msg); if (!firstBad) firstBad = id; }
    function ok(id) { setErr(id, ''); }

    if (step === 1) {
      v.name.trim() ? ok('name') : fail('name', 'Tell us your name.');
      validEmail(v.email) ? ok('email') : fail('email', 'A valid email so we can reply.');
      if (v.phone && v.phone.replace(/\D/g, '').length < 6) fail('phone', 'That number looks short.');
      else ok('phone');
    }
    if (step === 2) {
      v.company.trim() ? ok('company') : fail('company', 'What is the business called?');
      var s = v.site.trim();
      if (s && !/^(@[\w.\-]{2,}|[\w\-]+(\.[\w\-]+)+([\/?#].*)?|https?:\/\/.*)$/i.test(s)) fail('site', 'Add a URL or an @handle.');
      else ok('site');
    }
    if (step === 3) v.parts.length ? ok('parts') : fail('parts', 'Pick at least one thing to build.');
    if (step === 4) v.bottleneck.length ? ok('bottleneck') : fail('bottleneck', 'Point at at least one bottleneck.');
    if (step === 5) v.current.length ? ok('current') : fail('current', 'Pick what exists — or “None yet”.');
    if (step === 6) ok('vision');
    if (step === 7) {
      var c = named('consent');
      if (c && c.checked) ok('consent');
      else fail('consent', 'We need your permission to reply.');
    }
    return firstBad;
  }

  function showStep(n, focus) {
    state.step = n;
    state.max = Math.max(state.max, n);
    steps.forEach(function (s) { s.hidden = Number(s.getAttribute('data-step')) !== n; });
    railBtns.forEach(function (b) {
      var i = Number(b.getAttribute('data-goto'));
      b.disabled = i > state.max;
      if (i === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    backBtn.disabled = n === 1;
    nextBtn.innerHTML = n === 7
      ? 'Send brief <span class="arrow" aria-hidden="true">&rarr;</span>'
      : 'Continue <span class="arrow" aria-hidden="true">&rarr;</span>';
    if (readout) readout.textContent = 'Step 0' + n + ' / 07';
    if (bar) bar.style.width = Math.round((n / 7) * 100) + '%';
    if (statusEl) statusEl.textContent = '';
    if (n === 7) renderReview();
    paintModel();

    if (focus !== false) {
      var head = steps[n - 1].querySelector('.step__t');
      if (head) { head.setAttribute('tabindex', '-1'); head.focus({ preventScroll: true }); }
      var col = doc.querySelector('.start__col');
      var y = col.getBoundingClientRect().top + window.scrollY - 90;
      if (window.scrollY > y) window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
    }
  }

  function renderReview() {
    readValues();
    var v = state.values;
    var rows = [
      ['Client', [v.name, v.email, v.phone].filter(Boolean).map(esc).join(' · ') || '<em>—</em>'],
      ['Business', [v.company, v.site].filter(Boolean).map(esc).join(' · ') || '<em>—</em>'],
      ['Should exist', v.parts.length ? v.parts.map(function (p) { return esc(p.value); }).join(', ') : '<em>nothing selected</em>'],
      ['Bottleneck', v.bottleneck.length ? v.bottleneck.map(esc).join(', ') : '<em>nothing selected</em>'],
      ['Current system', v.current.length ? v.current.map(function (c) { return esc(c.value); }).join(', ') : '<em>nothing selected</em>'],
      ['Vision', v.vision.trim() ? esc(v.vision.trim()) : '<em>not described</em>']
    ];
    var host = form.querySelector('[data-review]');
    host.innerHTML = rows.map(function (r) {
      return '<div class="review__row"><div class="review__k">' + r[0] + '</div><div class="review__v">' + r[1] + '</div></div>';
    }).join('');
  }

  /* =======================================================================
     NAVIGATION
     ======================================================================= */
  doc.addEventListener('click', function (e) {
    var goto = e.target.closest ? e.target.closest('[data-goto]') : null;
    if (goto && !goto.disabled) showStep(Number(goto.getAttribute('data-goto')));
  });

  backBtn.addEventListener('click', function () { if (state.step > 1) showStep(state.step - 1); });

  var rafId = 0;
  function refresh() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; readValues(); paintModel(); });
  }
  form.addEventListener('input', function (e) {
    refresh();
    if (statusEl && statusEl.textContent && e.target && e.target.id) statusEl.textContent = '';
  });
  form.addEventListener('change', refresh);

  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA' && state.step < 7) {
      e.preventDefault();
      nextBtn.click();
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.sending || state.done) return;

    if (state.step < 7) {
      var bad = validate(state.step);
      if (bad) {
        statusEl.textContent = 'Check the highlighted field before continuing.';
        var el = named(bad);
        if (el && el.focus) el.focus();
        return;
      }
      showStep(state.step + 1);
      return;
    }

    var bad7 = validate(7);
    if (bad7) {
      statusEl.textContent = 'Please confirm we can contact you.';
      var el7 = named(bad7);
      if (el7 && el7.focus) el7.focus();
      return;
    }

    state.sending = true;
    nextBtn.disabled = true;
    backBtn.disabled = true;
    var original = nextBtn.innerHTML;
    nextBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending';

    submitBrief(buildPayload()).then(function (res) {
      state.done = true;
      showReceipt(res);
    }).catch(function (err) {
      state.sending = false;
      nextBtn.disabled = false;
      backBtn.disabled = false;
      nextBtn.innerHTML = original;
      statusEl.textContent = 'That did not go through — ' + (err && err.message ? err.message : 'please try again, or email us.');
    });
  });

  /* =======================================================================
     SUBMISSION — real POST when configured, prepared email when not
     ======================================================================= */
  function buildPayload() {
    readValues();
    var v = state.values;
    return {
      reference: null,
      submittedAt: new Date().toISOString(),
      contact: { name: v.name.trim(), email: v.email.trim(), phone: v.phone.trim() },
      business: { name: v.company.trim(), presence: v.site.trim() },
      wants: v.parts.map(function (p) { return p.value; }),
      bottleneck: v.bottleneck.slice(),
      current: v.current.map(function (c) { return c.value; }),
      vision: v.vision.trim(),
      consent: v.consent
    };
  }

  function mintReference() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 6; i++) s += A.charAt(Math.floor(Math.random() * A.length));
    return ((CFG.reference && CFG.reference.prefix) || 'HK') + '-' + s;
  }

  function briefText(p, reference) {
    return [
      'HAIKA — BRIEF ' + reference, '',
      'CLIENT',
      '  ' + p.contact.name,
      '  ' + p.contact.email + (p.contact.phone ? ' · ' + p.contact.phone : ''), '',
      'BUSINESS',
      '  ' + p.business.name + (p.business.presence ? ' · ' + p.business.presence : ''), '',
      'WHAT SHOULD EXIST',
      '  ' + (p.wants.join(', ') || '—'), '',
      'BOTTLENECK',
      '  ' + (p.bottleneck.join(', ') || '—'), '',
      'CURRENT SYSTEM',
      '  ' + (p.current.join(', ') || '—'), '',
      'VISION',
      '  ' + (p.vision || '—'), '',
      'Sent from haika/start'
    ].join('\n');
  }

  function submitBrief(payload) {
    var cfg = CFG.intake || {};

    if (!cfg.endpoint) {
      var ref = mintReference();
      return Promise.resolve({ mode: 'email', reference: ref, body: briefText(payload, ref) });
    }

    var headers = {};
    if (cfg.contentType) headers['content-type'] = cfg.contentType;
    var meta = cfg.authMeta && doc.querySelector('meta[name="' + cfg.authMeta + '"]');
    if (meta && meta.content) headers['authorization'] = 'Bearer ' + meta.content;

    return fetch(cfg.endpoint, {
      method: cfg.method || 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('server responded ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      return { mode: 'stored', reference: (data && (data.reference || data.id)) || mintReference() };
    });
  }

  /* =======================================================================
     RECEIPT
     ======================================================================= */
  function showReceipt(res) {
    var receipt = doc.querySelector('[data-receipt]');
    var eyebrow = doc.querySelector('[data-receipt-eyebrow]');
    var titleEl = doc.querySelector('[data-receipt-title]');
    var ref = doc.querySelector('[data-receipt-ref]');
    var bodyEl = doc.querySelector('[data-receipt-body]');
    var actions = doc.querySelector('[data-receipt-actions]');

    ref.textContent = res.reference;

    if (res.mode === 'stored') {
      eyebrow.textContent = 'System received';
      titleEl.textContent = 'System received.';
      bodyEl.textContent = 'Your brief is with Haika. We read every one ourselves and reply from the address you gave us.';
      actions.innerHTML = '<a class="btn btn--light" href="../">Back to Haika</a>';
    } else {
      eyebrow.textContent = 'System assembled · draft reference';
      titleEl.textContent = 'Your system, assembled.';
      bodyEl.innerHTML = 'Nothing is stored until you send it. The button below opens your email app with the whole brief '
        + 'written out and addressed to Haika — or copy it and send it however you like.';
      actions.innerHTML =
        '<a class="btn btn--gold" id="mailBrief" href="#">Email this brief <span class="arrow" aria-hidden="true">&rarr;</span></a>' +
        '<button type="button" class="btn btn--ghost btn--light" data-copy>Copy brief</button>';
      doc.getElementById('mailBrief').setAttribute('href',
        mailto((CFG.contact && CFG.contact.email) || '', 'Brief ' + res.reference + ' — ' + state.values.company, res.body));
      var copyBtn = actions.querySelector('[data-copy]');
      copyBtn.addEventListener('click', function () {
        var done = function () { copyBtn.textContent = 'Copied'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res.body).then(done, function () { copyBtn.textContent = 'Copy failed'; });
        else done();
      });
    }

    form.hidden = true;
    var rail = doc.querySelector('.steprail');
    if (rail) rail.hidden = true;
    receipt.hidden = false;
    state.sending = false;
    titleEl.setAttribute('tabindex', '-1');
    titleEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }

  /* =======================================================================
     BOOT
     ======================================================================= */
  showStep(1, false);
  paintModel();
  initGL();
})();
