/* =========================================================================
   Haika — home page behaviour
   boot → stage/video → scroll choreography → nav → reveals → work plates
   → founders parallax
   ========================================================================= */
(function (root) {
  "use strict";

  var doc = document;
  var CFG = (root.HAIKA && root.HAIKA.config) || {};
  var Q = (root.HAIKA && root.HAIKA.quality) || {};

  var mq = root.matchMedia || function () { return { matches: false, addListener: function () {} }; };
  var REDUCED = Q.reduced != null ? !!Q.reduced : mq("(prefers-reduced-motion: reduce)").matches;
  var FINE = mq("(hover: hover) and (pointer: fine)").matches;
  var TIER = Q.tier || "high";
  var LOW = TIER === "low";
  var HIGH = TIER === "high";
  var START_VIDEO = Q.video !== false && !REDUCED;
  var PARALLAX = Q.parallax !== false && !REDUCED;
  var IFRAMES = Q.iframes !== false;
  var POSTER_MOTION = !REDUCED && TIER === "mid";
  var PAINT_EPS = LOW ? 0.00035 : 0.0002;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function ramp(p, a, b) {
    if (b <= a) return p >= b ? 1 : 0;
    return smooth(clamp((p - a) / (b - a), 0, 1));
  }

  /* ======================================================================
     1. CONTACT DESTINATION — rendered from config, never hardcoded
     ====================================================================== */
  (function contactLinks() {
    var email = CFG.contact && CFG.contact.email;
    if (!email) return;
    var nodes = doc.querySelectorAll("[data-contact-link]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.setAttribute("href", "mailto:" + email);
      if (el.getAttribute("data-contact-link") === "text") el.textContent = email;
    }
  })();

  /* ======================================================================
     2. STAGE — poster first, video as enhancement, never a dead end
     ====================================================================== */
  var stage = doc.getElementById("stage");
  var clip = doc.getElementById("clip");
  var poster = doc.getElementById("heroPoster");
  var duration = 0;
  var videoReady = false;
  var startClip = function () {};

  (function stageSetup() {
    if (!stage) return;

    if (!START_VIDEO || !clip) {
      stage.setAttribute("data-state", "poster");
      if (clip) clip.remove();
      clip = null;
      return;
    }

    clip.setAttribute("aria-hidden", "true");
    clip.setAttribute("tabindex", "-1");

    function live() {
      if (videoReady) return;
      videoReady = true;
      stage.classList.add("is-live");
      stage.setAttribute("data-state", "video");
      readScroll();
    }
    function fail() {
      videoReady = false;
      stage.classList.remove("is-live");
      stage.setAttribute("data-state", "fallback");
    }

    clip.addEventListener("loadedmetadata", function () {
      duration = clip.duration || 0;
      try { clip.pause(); } catch (e) {}
      readScroll();
      if (duration) {
        seekPos = seekTarget = progress * duration;
        if (clip.readyState >= 1) { try { clip.currentTime = seekPos; } catch (e) {} }
      }
    });
    clip.addEventListener("canplay", live);
    clip.addEventListener("loadeddata", live);
    clip.addEventListener("error", fail);
    clip.addEventListener("stalled", function () {
      setTimeout(function () { if (!videoReady) fail(); }, 4000);
    });
  })();

  /* ======================================================================
     3. BOOT — driven by the poster, hard-capped. Never indefinite.
     ====================================================================== */
  (function boot() {
    var el = doc.getElementById("boot");
    if (!el) return;
    var pct = doc.getElementById("bootPct");
    var bar = doc.getElementById("bootBar");
    var done = false;
    var t0 = Date.now();
    var MAX = 1250;
    var value = 0;

    function set(p) {
      value = Math.max(value, Math.round(p));
      if (pct) pct.textContent = "LOADING " + value + "%";
      if (bar) bar.style.width = value + "%";
    }

    function finish() {
      if (done) return;
      done = true;
      set(100);
      el.classList.add("done");
      doc.documentElement.setAttribute("data-booted", "1");
      if (root.requestIdleCallback) root.requestIdleCallback(startClip, { timeout: 900 });
      else setTimeout(startClip, 600);
    }

    startClip = function () {
      if (!clip || !START_VIDEO || clip.getAttribute("src")) return;
      if (track && scrollPos() > trackEnd) return;
      var url = CFG.hero && CFG.hero.video;
      if (!url) return;
      clip.preload = HIGH ? "auto" : "metadata";
      clip.src = url;
      try { clip.load(); } catch (e) {}
    };

    var ticker = setInterval(function () {
      var elapsed = Date.now() - t0;
      set(Math.min(90, (elapsed / MAX) * 100));
      if (elapsed >= MAX) { clearInterval(ticker); finish(); }
    }, 200);

    function whenPoster() {
      var elapsed = Date.now() - t0;
      var wait = Math.max(0, (REDUCED ? 100 : 260) - elapsed);
      setTimeout(function () { clearInterval(ticker); finish(); }, wait);
    }

    if (poster && poster.complete && poster.naturalWidth) whenPoster();
    else if (poster) {
      poster.addEventListener("load", whenPoster, { once: true });
      poster.addEventListener("error", function () {
        clearInterval(ticker);
        if (stage) stage.setAttribute("data-state", "fallback");
        finish();
      }, { once: true });
    } else whenPoster();

    setTimeout(function () { clearInterval(ticker); finish(); }, MAX + 600);
  })();

  /* ======================================================================
     4. SCROLL CHOREOGRAPHY
     Progress is measured against the hero track only, so the panels and the
     clip finish exactly when the track does — not somewhere in the middle
     of Selected Work.
     ====================================================================== */
  var track = doc.getElementById("track");
  var panelsWrap = doc.getElementById("panels");
  var navEl = doc.getElementById("nav");
  var panelEls = Array.prototype.slice.call(doc.querySelectorAll("[data-panel]"));
  var brainsEl = doc.querySelector(".brains");
  var chaptersEl = doc.getElementById("chapters");
  var chapterEls = chaptersEl
    ? Array.prototype.slice.call(chaptersEl.querySelectorAll("[data-chapter]"))
    : [];
  var chapterAt = [0, 0.225, 0.44, 0.70, 0.925];
  var chapterOn = -1;

  var CUES = [
    [-0.02, 0.00, 0.16, 0.19],
    [ 0.19, 0.26, 0.38, 0.41],
    [ 0.41, 0.48, 0.64, 0.67],
    [ 0.67, 0.74, 0.86, 0.89],
    [ 0.89, 0.96, 1.20, 1.30]
  ];
  var DRIFT = REDUCED || LOW ? 0 : 24;

  var progress = 0;
  var painted = -1;
  var seekTarget = 0;
  var seekPos = 0;
  var lastSeek = 0;
  var trackTop = 0;
  var trackSpan = 1;
  var trackEnd = 0;
  var navAt = 40;
  var parked = false;
  var y = 0;
  var frameId = 0;
  var needsPaint = false;
  var panelShown = [];
  var panelHit = [];
  var panelOp = [];
  var navStuck = false;
  var navScrolling = false;
  var navScrollTimer = 0;
  var brainsTop = 0;
  var brainsHeight = 1;
  var brainsLeft = 0;
  var brainsWidth = 1;
  var brainsLastP = -1;

  for (var pi = 0; pi < panelEls.length; pi++) {
    panelShown[pi] = false;
    panelHit[pi] = false;
    panelEls[pi].style.pointerEvents = "none";
    panelEls[pi].setAttribute("aria-hidden", "true");
  }

  function scrollPos() {
    return root.pageYOffset || doc.documentElement.scrollTop || 0;
  }

  function measure() {
    y = scrollPos();
    if (track) {
      var tr = track.getBoundingClientRect();
      trackTop = tr.top + y;
      trackEnd = trackTop + tr.height;
      trackSpan = Math.max(1, tr.height - (root.innerHeight || doc.documentElement.clientHeight || 1));
      navAt = trackTop + 40;
    } else {
      trackEnd = 0;
      trackSpan = 1;
      navAt = 40;
    }
    if (brainsEl) {
      var br = brainsEl.getBoundingClientRect();
      brainsTop = br.top + y;
      brainsHeight = Math.max(1, br.height);
      brainsLeft = br.left;
      brainsWidth = Math.max(1, br.width);
    }
    readScroll(y);
  }

  function updateNav(atY) {
    if (!navEl) return;
    var want = atY > navAt;
    if (want !== navStuck) {
      navStuck = want;
      navEl.classList.toggle("is-stuck", want);
    }
  }

  function updateChapters(p) {
    if (!chaptersEl || !chapterEls.length) return;
    var idx = 0;
    for (var i = 0; i < chapterAt.length; i++) {
      if (p >= chapterAt[i] - 0.02) idx = i;
    }
    if (idx === chapterOn) return;
    chapterOn = idx;
    for (var j = 0; j < chapterEls.length; j++) {
      chapterEls[j].classList.toggle("is-active", j === idx);
    }
  }

  function markScrolling() {
    if (!HIGH || !navEl || !navStuck) return;
    if (!navScrolling) {
      navScrolling = true;
      navEl.classList.add("is-scrolling");
    }
    clearTimeout(navScrollTimer);
    navScrollTimer = setTimeout(function () {
      navScrolling = false;
      navEl.classList.remove("is-scrolling");
    }, 160);
  }

  function updateBrains(atY) {
    if (!brainsEl || REDUCED || LOW) return;
    var vh = root.innerHeight || doc.documentElement.clientHeight || 0;
    if (!vh) return;
    var p = clamp((vh - (brainsTop - atY)) / (vh + brainsHeight), 0, 1);
    if (Math.abs(p - brainsLastP) < 0.001) return;
    brainsLastP = p;
    brainsEl.style.setProperty("--p", p.toFixed(4));
  }

  function readScroll(atY) {
    y = atY == null ? scrollPos() : atY;
    var next = track ? clamp((y - trackTop) / trackSpan, 0, 1) : 0;
    if (Math.abs(next - progress) > PAINT_EPS) needsPaint = true;
    progress = next;
    seekTarget = duration ? progress * duration : 0;

    var shouldPark = !!track && y >= trackEnd;
    if (shouldPark !== parked) {
      parked = shouldPark;
      if (stage) stage.classList.toggle("is-parked", parked);
      if (panelsWrap) panelsWrap.classList.toggle("is-parked", parked);
      if (chaptersEl) chaptersEl.classList.toggle("is-parked", parked);
      if (!parked) needsPaint = true;
    }

    updateNav(y);
    updateBrains(y);
    updateChapters(progress);
    schedule();
  }

  function paint(force) {
    if (parked && !force) return;
    if (!force && painted >= 0 && Math.abs(progress - painted) < PAINT_EPS) return;
    painted = progress;

    if (POSTER_MOTION && poster && !videoReady) {
      var sc = 1.03 + progress * 0.045;
      var ty2 = progress * 16;
      poster.style.transform =
        "translate3d(0," + ty2.toFixed(1) + "px,0) scale(" + sc.toFixed(4) + ")";
    }

    for (var i = 0; i < panelEls.length; i++) {
      var el = panelEls[i];
      var c = CUES[i] || CUES[CUES.length - 1];
      var enter = ramp(progress, c[0], c[1]);
      var leave = ramp(progress, c[2], c[3]);
      var opacity = enter * (1 - leave);

      if (opacity <= 0.001) {
        if (panelShown[i] !== false) {
          el.style.opacity = "0";
          panelOp[i] = "0";
          el.setAttribute("aria-hidden", "true");
          el.classList.remove("is-visible");
          panelShown[i] = false;
        }
        if (panelHit[i] !== false) {
          panelHit[i] = false;
          el.style.pointerEvents = "none";
        }
        continue;
      }

      if (!(LOW || REDUCED)) {
        var ty = (1 - enter) * DRIFT - leave * DRIFT;
        var scale = 0.985 + opacity * 0.015;
        el.style.transform = "translate3d(0," + ty.toFixed(2) + "px,0) scale(" +
          scale.toFixed(4) + ")";
      }
      var opStr = opacity.toFixed(3);
      if (panelOp[i] !== opStr) {
        el.style.opacity = opStr;
        panelOp[i] = opStr;
      }

      var show = opacity > 0.05;
      if (panelShown[i] !== show) {
        panelShown[i] = show;
        el.setAttribute("aria-hidden", show ? "false" : "true");
        el.classList.toggle("is-visible", show);
      }
      var hit = opacity > 0.55;
      if (panelHit[i] !== hit) {
        panelHit[i] = hit;
        el.style.pointerEvents = hit ? "auto" : "none";
      }
    }
  }

  function schedule() {
    if (frameId || doc.hidden) return;
    frameId = root.requestAnimationFrame(frame);
  }

  function frame(ts) {
    frameId = 0;
    if (doc.hidden) return;

    var busy = false;
    if (needsPaint) { needsPaint = false; paint(); }

    if (START_VIDEO && videoReady && duration && !parked) {
      var gap = seekTarget - seekPos;
      if (Math.abs(gap) > 0.02) {
        seekPos += gap * 0.2;
        // ~20 fps is imperceptible on a 24 fps plate and halves the decode tax
        if (ts - lastSeek >= 50 && clip && clip.readyState >= 2 && !clip.seeking) {
          lastSeek = ts;
          try { clip.currentTime = clamp(seekPos, 0, duration); } catch (e) {}
        }
        busy = true;
      } else if (seekPos !== seekTarget) {
        seekPos = seekTarget;
        if (clip && clip.readyState >= 2 && !clip.seeking) {
          try { clip.currentTime = clamp(seekTarget, 0, duration); } catch (e) {}
        }
      }
    }

    if (busy) schedule();
  }

  function onScroll() {
    startClip();
    readScroll(scrollPos());
    markScrolling();
  }

  var resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = root.requestAnimationFrame(function () {
      resizeRaf = 0;
      measure();
    });
  }

  root.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener("resize", onResize, { passive: true });
  root.addEventListener("orientationchange", onResize, { passive: true });
  root.addEventListener("load", function () { measure(); }, { passive: true });
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    doc.fonts.ready.then(function () { measure(); }, function () {});
  }
  doc.addEventListener("visibilitychange", function () {
    if (doc.hidden) {
      if (frameId) { root.cancelAnimationFrame(frameId); frameId = 0; }
    } else {
      readScroll(scrollPos());
      schedule();
    }
  });
  root.addEventListener("pageshow", function () { measure(); schedule(); });

  measure();
  paint(true);
  needsPaint = false;
  schedule();

  /* ======================================================================
     4b. SYSTEMS DRAWING — a tight crop on phones, the full drafting sheet above
     ====================================================================== */
  (function frameDrawing() {
    var svg = doc.querySelector(".sys__drawing");
    if (!svg) return;
    var FULL = "-154 -66 264 164";
    var TIGHT = "-64 -46 146 130";
    function apply() {
      var vb = root.innerWidth <= 700 ? TIGHT : FULL;
      if (svg.getAttribute("viewBox") !== vb) svg.setAttribute("viewBox", vb);
    }
    apply();
    root.addEventListener("resize", apply, { passive: true });
  })();

  /* ======================================================================
     5. NAVIGATION — always above content, always reachable
     ====================================================================== */
  (function navigation() {
    var nav = doc.getElementById("nav");
    var toggle = doc.getElementById("navToggle");
    var menu = doc.getElementById("navmenu");
    if (!nav) return;
    if (!toggle || !menu) return;

    var open = false;
    var lastFocus = null;

    function focusables() {
      return Array.prototype.slice.call(
        menu.querySelectorAll("a[href], button:not([disabled])")
      ).filter(function (n) { return n.offsetParent !== null; });
    }

    function setOpen(next) {
      if (next === open) return;
      open = next;
      menu.setAttribute("data-open", open ? "true" : "false");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      doc.body.style.overflow = open ? "hidden" : "";
      if (open) {
        lastFocus = doc.activeElement;
        var f = focusables();
        if (f.length) f[0].focus();
      } else if (lastFocus && lastFocus.focus) {
        lastFocus.focus();
      }
    }

    toggle.addEventListener("click", function () { setOpen(!open); });

    menu.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("a")) setOpen(false);
    });

    doc.addEventListener("keydown", function (e) {
      if (!open) return;
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    root.addEventListener("resize", function () {
      if (open && root.innerWidth > 860) setOpen(false);
    }, { passive: true });
  })();

  /* ======================================================================
     6. SCROLL REVEALS — used by case studies, the system drawing, founders
     ====================================================================== */
  (function reveals() {
    var nodes = Array.prototype.slice.call(doc.querySelectorAll("[data-reveal]"));
    if (!nodes.length) return;
    if (!("IntersectionObserver" in root) || REDUCED) {
      nodes.forEach(function (n) { n.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    nodes.forEach(function (n) { io.observe(n); });
  })();

  /* ======================================================================
     7. SELECTED WORK — live preview plates (fine pointers only)
     ====================================================================== */
  (function plates() {
    var list = Array.prototype.slice.call(doc.querySelectorAll("[data-plate]"));
    if (!list.length || !FINE || !IFRAMES) return;

    var livePlate = null;
    var hoverTimer = 0;
    var dropTimer = 0;

    function unmount(plate) {
      if (!plate) return;
      var live = plate.querySelector(".work-plate__live");
      if (live && live.parentNode) live.parentNode.removeChild(live);
      plate.removeAttribute("data-mounted");
      plate.classList.remove("is-live", "is-loading");
      if (livePlate === plate) livePlate = null;
    }

    function mount(plate) {
      if (livePlate === plate) return;
      if (livePlate) unmount(livePlate);
      if (plate.getAttribute("data-mounted")) return;
      var url = plate.getAttribute("data-src");
      var slot = plate.querySelector(".work-plate__frame");
      if (!url || !slot) return;

      plate.setAttribute("data-mounted", "1");
      plate.classList.add("is-loading");
      livePlate = plate;

      var live = doc.createElement("iframe");
      live.className = "work-plate__live";
      live.setAttribute("src", url);
      live.setAttribute("title", plate.getAttribute("data-title") || "Live preview");
      live.setAttribute("loading", "lazy");
      live.setAttribute("scrolling", "no");
      live.setAttribute("referrerpolicy", "no-referrer");
      live.setAttribute("aria-hidden", "true");
      live.setAttribute("tabindex", "-1");
      slot.appendChild(live);

      var settled = false;
      live.addEventListener("load", function () {
        settled = true;
        if (livePlate !== plate) return;
        plate.classList.remove("is-loading");
        plate.classList.add("is-live");
      });
      setTimeout(function () {
        if (!settled && plate.classList.contains("is-loading")) unmount(plate);
      }, 12000);
    }

    function dropLater(plate) {
      clearTimeout(dropTimer);
      dropTimer = setTimeout(function () {
        if (livePlate !== plate) return;
        if (plate.matches && plate.matches(":hover")) return;
        if (plate.contains(doc.activeElement)) return;
        unmount(plate);
      }, 8000);
    }

    list.forEach(function (plate) {
      plate.addEventListener("pointerenter", function () {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () { mount(plate); }, 260);
      }, { passive: true });
      plate.addEventListener("pointerleave", function () {
        clearTimeout(hoverTimer);
        if (livePlate === plate) dropLater(plate);
      }, { passive: true });
      plate.addEventListener("focusin", function () {
        clearTimeout(hoverTimer);
        mount(plate);
      });
      plate.addEventListener("focusout", function () {
        if (livePlate === plate) dropLater(plate);
      });
    });
  })();

  /* ======================================================================
     8. FOUNDERS — cursor parallax (--px/--py) + scroll drift (--p)
     ====================================================================== */
  (function founders() {
    if (!brainsEl || !PARALLAX || !FINE) return;

    var pxGoal = 0, pyGoal = 0, pxCur = 0, pyCur = 0, running = false;

    function easeParallax() {
      pxCur += (pxGoal - pxCur) * 0.07;
      pyCur += (pyGoal - pyCur) * 0.07;
      var settled = Math.abs(pxGoal - pxCur) < 0.0005 && Math.abs(pyGoal - pyCur) < 0.0005;
      if (settled) { pxCur = pxGoal; pyCur = pyGoal; }
      brainsEl.style.setProperty("--px", pxCur.toFixed(4));
      brainsEl.style.setProperty("--py", pyCur.toFixed(4));
      if (settled) {
        running = false;
        brainsEl.classList.remove("is-pointer");
        return;
      }
      root.requestAnimationFrame(easeParallax);
    }

    function kick() {
      brainsEl.classList.add("is-pointer");
      if (running) return;
      running = true;
      root.requestAnimationFrame(easeParallax);
    }

    brainsEl.addEventListener("pointermove", function (e) {
      if (!brainsWidth || !brainsHeight) return;
      pxGoal = clamp(((e.clientX - brainsLeft) / brainsWidth) * 2 - 1, -1, 1);
      pyGoal = clamp(((e.clientY - (brainsTop - scrollPos())) / brainsHeight) * 2 - 1, -1, 1);
      kick();
    }, { passive: true });

    brainsEl.addEventListener("pointerleave", function () {
      pxGoal = 0; pyGoal = 0; kick();
    }, { passive: true });

    brainsEl.addEventListener("pointercancel", function () {
      pxGoal = 0; pyGoal = 0; kick();
    }, { passive: true });
  })();

})(window);
