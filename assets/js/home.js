/* =========================================================================
   Haika — home page behaviour
   boot → stage/video → scroll choreography → nav → reveals → work plates
   ========================================================================= */
(function (root) {
  "use strict";

  var doc = document;
  var CFG = (root.HAIKA && root.HAIKA.config) || {};

  var mq = root.matchMedia || function () { return { matches: false, addListener: function () {} }; };
  var REDUCED = mq("(prefers-reduced-motion: reduce)").matches;
  var FINE = mq("(hover: hover) and (pointer: fine)").matches;

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

  (function stageSetup() {
    if (!stage) return;

    // Reduced motion: the poster *is* the hero. No clip request at all.
    if (REDUCED) {
      stage.setAttribute("data-state", "poster");
      if (clip) clip.remove();
      return;
    }
    if (!clip) { stage.setAttribute("data-state", "fallback"); return; }

    clip.setAttribute("aria-hidden", "true");
    clip.setAttribute("tabindex", "-1");

    function live() {
      if (videoReady) return;
      videoReady = true;
      stage.classList.add("is-live");
      stage.setAttribute("data-state", "video");
    }
    function fail() {
      if (videoReady) return;
      stage.setAttribute("data-state", "fallback");
    }

    clip.addEventListener("loadedmetadata", function () {
      duration = clip.duration || 0;
      try { clip.pause(); } catch (e) {}
      readScroll();
      seekAt = seekTo;
      if (clip.readyState >= 1) { try { clip.currentTime = seekAt; } catch (e) {} }
    });
    clip.addEventListener("canplay", live);
    clip.addEventListener("loadeddata", live);
    clip.addEventListener("error", fail);
    clip.addEventListener("stalled", function () {
      // never leave a spinner state behind: fall back, and if the clip
      // arrives later `canplay` will still upgrade it
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
    var MAX = 2600;
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
      startClip();
    }

    function startClip() {
      if (!clip || REDUCED || clip.getAttribute("src")) return;
      var url = CFG.hero && CFG.hero.video;
      if (!url) return;
      // the clip is an enhancement: it starts only once the page is usable
      clip.src = url;
      try { clip.load(); } catch (e) {}
    }

    var ticker = setInterval(function () {
      var elapsed = Date.now() - t0;
      set(Math.min(92, (elapsed / MAX) * 100));
      if (elapsed >= MAX) { clearInterval(ticker); finish(); }
    }, 90);

    function whenPoster() {
      var elapsed = Date.now() - t0;
      var wait = Math.max(0, (REDUCED ? 220 : 420) - elapsed);
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

    // absolute backstop — the visitor is never held hostage by the network
    setTimeout(function () { clearInterval(ticker); finish(); }, MAX + 900);
  })();

  /* ======================================================================
     4. SCROLL CHOREOGRAPHY
     Progress is measured against the hero track only, so the panels and the
     clip finish exactly when the track does — not somewhere in the middle
     of Selected Work.
     ====================================================================== */
  var track = doc.getElementById("track");
  var panelsWrap = doc.getElementById("panels");
  var panelEls = Array.prototype.slice.call(doc.querySelectorAll("[data-panel]"));

  var CUES = [
    [-0.02, 0.00, 0.16, 0.19],   // 00 intro
    [ 0.19, 0.26, 0.38, 0.41],   // 01 presence
    [ 0.41, 0.48, 0.64, 0.67],   // 02 conversation
    [ 0.67, 0.74, 0.86, 0.89],   // 03 automation
    [ 0.89, 0.96, 1.20, 1.30]    // 04 closing — held, then covered by content
  ];
  var DRIFT = 24;

  var progress = 0;
  var seekTo = 0;
  var seekAt = 0;
  var trackTop = 0;
  var trackSpan = 1;
  var parked = false;

  function measure() {
    if (!track) return;
    var y = root.pageYOffset || doc.documentElement.scrollTop || 0;
    trackTop = track.getBoundingClientRect().top + y;
    trackSpan = Math.max(1, track.offsetHeight - root.innerHeight);
  }

  function readScroll() {
    var y = root.pageYOffset || doc.documentElement.scrollTop || 0;
    progress = clamp((y - trackTop) / trackSpan, 0, 1);
    if (duration) seekTo = progress * duration;

    // once content has taken the whole viewport there is nothing left to
    // paint or scrub — park the stage instead of burning frames behind it
    var shouldPark = y >= trackTop + (track ? track.offsetHeight : 0);
    if (shouldPark !== parked) {
      parked = shouldPark;
      if (stage) stage.classList.toggle("is-parked", parked);
      if (panelsWrap) panelsWrap.classList.toggle("is-parked", parked);
    }
  }

  function paint() {
    for (var i = 0; i < panelEls.length; i++) {
      var el = panelEls[i];
      var c = CUES[i] || CUES[CUES.length - 1];
      var enter = ramp(progress, c[0], c[1]);
      var leave = ramp(progress, c[2], c[3]);
      var opacity = enter * (1 - leave);
      var y = (1 - enter) * DRIFT - leave * DRIFT;
      var scale = 0.985 + opacity * 0.015;

      if (REDUCED) el.style.transform = "none";
      else el.style.transform = "translate3d(0," + y.toFixed(2) + "px,0) scale(" + scale.toFixed(4) + ")";

      el.style.opacity = opacity.toFixed(3);
      el.style.pointerEvents = opacity > 0.6 ? "auto" : "none";
      el.setAttribute("aria-hidden", opacity > 0.05 ? "false" : "true");
    }
  }

  function frame() {
    if (!doc.hidden) {
      if (duration && videoReady) {
        var gap = seekTo - seekAt;
        if (Math.abs(gap) > 0.0008) {
          seekAt += gap * 0.115;
          if (clip && clip.readyState >= 2 && !clip.seeking) {
            try { clip.currentTime = seekAt; } catch (e) {}
          }
        }
      }
      if (!parked) paint();
    }
    requestAnimationFrame(frame);
  }

  root.addEventListener("scroll", readScroll, { passive: true });
  root.addEventListener("resize", function () { measure(); readScroll(); }, { passive: true });
  root.addEventListener("orientationchange", function () { measure(); readScroll(); }, { passive: true });
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    doc.fonts.ready.then(function () { measure(); readScroll(); }, function () {});
  }
  measure();
  readScroll();
  paint();
  requestAnimationFrame(frame);
  root.addEventListener("load", function () { measure(); readScroll(); });

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

    var stuck = false;
    function onScroll() {
      var y = root.pageYOffset || doc.documentElement.scrollTop || 0;
      var want = track ? y > trackTop + 40 : y > 40;
      if (want !== stuck) { stuck = want; nav.classList.toggle("is-stuck", stuck); }
    }
    root.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

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
    if (!list.length || !FINE) return;

    function mount(plate) {
      if (plate.getAttribute("data-mounted")) return;
      var url = plate.getAttribute("data-src");
      var slot = plate.querySelector(".work-plate__frame");
      if (!url || !slot) return;
      plate.setAttribute("data-mounted", "1");

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
        plate.classList.add("is-live");
      });
      setTimeout(function () {
        if (!settled) {
          plate.removeAttribute("data-mounted");
          plate.classList.remove("is-live");
          if (live.parentNode) live.parentNode.removeChild(live);
        }
      }, 15000);
    }

    list.forEach(function (plate) {
      plate.addEventListener("pointerenter", function () { mount(plate); }, { passive: true });
      plate.addEventListener("focusin", function () { mount(plate); });
    });
  })();

})(window);
