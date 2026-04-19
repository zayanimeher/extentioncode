/**
 * Facebook Full Post Saver — content.js v84
 * v84: Remove second scroll (forceLoadAllImages), remove HTML fallback.
 *      Safe CSS 350KB without selector matching, remove invisible elements from clone.
 * v82: FIX Unicode emoji (🥺😂💔) — add emoji font stack to MHTML CSS so OS renders them.
 *      FIX file size — CSS filtered to only rules matching post elements (selector test),
 *      skip rules with external url(), cap at 300KB. Typical saving: 2-3 MB per MHT.
 * v81: THREE TARGETED FIXES:
 *      FIX 1 — Emoji inline style: write data: URI (not http URL) into inline style attr
 *        so cloneNode captures the encoded image, not the broken http reference.
 *        For class-based background-image (no inline style), force-write data: URI
 *        with !important so the clone has it even without computed CSS.
 *      FIX 2 — Canvas taint prevention: check img.crossOrigin==='anonymous' BEFORE
 *        attempting canvas.toDataURL(). Skip canvas entirely for imgs without CORS attr.
 *        This eliminates all "Tainted canvas" errors — goes directly to XHR fallback.
 *      FIX 3 — filteredResources: replaced unreliable htmlStr.includes(url) with a
 *        DOM-based Set of http URLs still present in the clone. Data: URIs already
 *        inlined by prepareAvatars are excluded, preventing double-embedding and
 *        significantly reducing final MHT size.
 * v80: ROOT CAUSE FIXES based on log analysis (DOM imgs loaded: 0/42, 6.92 MB):
 *      FIX A — crossOrigin BEFORE src: setting crossOrigin='anonymous' after img.src
 *        triggers CORS re-fetch → resets complete=false → all 42 imgs appear unloaded.
 *        Now reads getAttribute('src') (not .src prop) and sets crossOrigin first.
 *      FIX A2 — injected helper images also get crossOrigin set before src.
 *      FIX B — CSS-only emoji capture: FB comment emojis are <i data-visualcompletion>
 *        and <span> with background-image — no <img> tag at all. Added explicit
 *        selector scan for FB emoji elements; writes URL into inline style so clone captures it.
 *      FIX C — filteredResources URL-encoding bug: XMLSerializer encodes & → &amp;
 *        so htmlStr.includes(url) always returns false. Now decodes &amp; before lookup.
 *      FIX D — size reduction:
 *        MAX_AV_PX 60→48 (avatars display at ≤40px on FB),
 *        large images recompressed at JPEG 0.75 (not returned raw from XHR),
 *        canvas large path uses JPEG 0.75 (was 0.82).
 *      FIX E — strip @font-face and @import from inlined CSS (fonts can't load in
 *        MHTML and often contain large embedded base64 woff2 data).
 * v79: FIX emoji pipeline; FIX file size (URL normalization, pre-inlined skip); FIX resource scoping
 * v74: fix MHTML missing avatars+CSS — sync img.src property→attribute before
 *      clone (cloneNode copies attrs not props); inline all CSS from
 *      document.styleSheets (avoids CORS-blocked CDN fetches); fetch only
 *      remaining non-dataURI images; inline fetched images directly into HTML.
 * v73: TRUE in-page MHTML builder — replaced captureViaBg()/background script
 *      with buildMHTMLAndDownload(): clones DOM, serializes HTML, fetches all
 *      img/css/bg resources as base64, assembles RFC-2822 multipart/related,
 *      downloads as .mht. Fallback to saveHTML() on error. No MV3 bug dependency.
 * v72: fix MHTML comment; getElementsByTagName loops (return→continue fix);
 *      CONCURRENCY capped at 6; injected try/finally cleanup; video+canvas pruning.
 * v71: canvasEncode() micro-opt: skip scale math when img already within
 *      guard invalid rawUrl before BG fallback, progress updates every 16 ops,
 *      adaptive CONCURRENCY via hardwareConcurrency.
 * v67: encodeKey() perf: skip re-encode if already dataURI, skip canvas
 *      keep XHR fallback + BG worker fallback, keep pool/quality/resize.
 * v65: XHR from content script (page cookies) + BG fallback, debug logging.
 * v64: skip inject+wait — canvas for DOM imgs, BG worker for rest (sends FB cookies).
 * v63: fix avatar scope (doc-wide), spinner-aware expand (no blind wait),
 *      BOTTOM_EXTRA_MS 4000→1500ms (spinner replaces wait).
 * v62: scoped DOM queries (postEl not document), 3-tier JPEG quality,
 *      URL query-strip dedup, post-expand verification sweep.
 * FIX: Avatars now embedded as base64 data URIs before pageCapture,
 *      covering img[src], inline background-image, AND computed background-image
 *      (CSS-class-applied avatars — the main missing case in prior versions).
 *
 * IMPROVEMENTS vs v20:
 *  1. Smart early-exit: exits as soon as scrollHeight stops growing
 *     (2 identical readings) instead of waiting all STABLE_ROUNDS × BOTTOM_EXTRA_MS.
 *  2. Fingerprint bucket 40px → 80px: prevents double-clicks after minor
 *     FB re-renders that shift button positions by ~20-40px.
 *  3. Adaptive settle floor: tracks recent settle durations and adjusts
 *     the minimum wait floor accordingly (fast conn=400ms, slow=up to 2000ms).
 *  4. Removed unused isReplyBtn function.
 *  5. Save: real in-page MHTML builder (no background/pageCapture), HTML fallback.
 *     Panel hidden before MHTML capture, restored after. 60s timeout.
 *  6. No-scroll full-page click: fullPageScan uses el.click() directly,
 *     no scrollIntoView() jarring jumps.
 */
(function () {
  'use strict';

  if (window.__fbpsSaverLoaded) {
    const p = document.getElementById('fbps-panel');
    if (p) p.style.display = (p.style.display === 'none') ? '' : 'none';
    return;
  }
  window.__fbpsSaverLoaded = true;

  const CFG = {
    MAX_RUNTIME_MS:   15 * 60 * 1000,
    SCROLL_STEP_PX:   400,
    DWELL_MS:         350,
    SETTLE_QUIET_MS:  400,
    SETTLE_MIN_MS:    400,   // base floor — adapted dynamically
    SETTLE_MAX_MS:    5000,
    STABLE_ROUNDS:    2,
    BOTTOM_EXTRA_MS:  400,
    MAX_CLICKS:       8000,
  };

  const TARGETS = [
    'en voir plus',
    'voir plus de commentaires',
    'voir les réponses',
    'voir plus de réponses',
    'réponse',
    'afficher les réponses',
    'réponses',
    'a répondu',
  ];

  const DENY_NORM = new Set([
    'répondre','réagir',"j'aime",'like','share','send',
    'laissez un commentaire','envoyez ce contenu à vos ami(e)s ou publiez-le sur votre profil.',
    'masquer ou signaler un abus cela','voix disponibles',
    'commentez avec un sticker avatar','insérez un emoji',
    'commentez avec un gif','commentez avec un sticker',
    'post comment','facebook menu','messenger','notifications',
    'votre profil','photo précédente','photo suivante',
    'zoom','dézoom','passer en plein écran',
    'retour à la page précédente','quitter la saisie semi-automatique',
    'actions pour cette publication',
    'follow','report','hide','delete','edit','save','bookmark','copy link',
  ]);

  let capturedBodyBg = 'rgb(255,255,255)';
  const S = {
    running: false, cancelled: false,
    clickedFps: new Set(),
    nClicks: 0, t0: 0, log: [],
    scroller: null,
    scrollerMinH: 0,
    settleTimes: [],   // history of recent settle durations for adaptive floor
  };

  /* ── PANEL ─────────────────────────────────────────────────────────── */
  function buildPanel() {
    const el = document.createElement('div'); el.id = 'fbps-panel';
    el.innerHTML = [
      '<div id="fbps-hdr"><div id="fbps-title"><span>💾</span> Post Saver</div><button id="fbps-min">−</button></div>',
      '<div id="fbps-body">',
      '<button id="fbps-btn-save"><span id="fbps-btn-ico">📥</span><span id="fbps-btn-lbl"> Save Full Post</span></button>',
      '<button id="fbps-btn-diag">🔍 Scan (debug)</button>',
      '<label id="fbps-av-wrap"><input type="checkbox" id="fbps-av" checked> Include avatars</label>',
      '<button id="fbps-btn-cancel" class="fbps-hide">✕ Annuler</button>',
      '<div id="fbps-prog-wrap" class="fbps-hide"><div id="fbps-prog-track"><div id="fbps-prog-bar"></div></div></div>',
      '<div id="fbps-status-row"><div id="fbps-dot"></div><div id="fbps-msg">Idle</div></div>',
      '<div id="fbps-stats" class="fbps-hide">',
      '<div class="fbs"><div class="fbv" id="fbps-nc">0</div><div class="fbl">Clics</div></div>',
      '<div class="fbs"><div class="fbv" id="fbps-nt">0s</div><div class="fbl">Temps</div></div>',
      '</div>',
      '<div id="fbps-logwrap" class="fbps-hide"><div id="fbps-log"></div></div>',
      '<button id="fbps-btn-copy" class="fbps-hide">📋 Copier log</button>',
      '<div id="fbps-done" class="fbps-hide">✅ Sauvegardé !</div>',
      '</div>',
    ].join('');
    document.body.appendChild(el);
    drag(el, g('fbps-hdr'));
    g('fbps-btn-save').onclick   = startSave;
    g('fbps-btn-diag').onclick   = runDiag;
    g('fbps-btn-cancel').onclick = () => { S.cancelled = true; status('Annulé', 'err'); };
    g('fbps-min').onclick = () => { const m = el.classList.toggle('fbps-mini'); g('fbps-min').textContent = m ? '+' : '−'; };
    g('fbps-btn-copy').onclick = copyLog;
  }

  function drag(panel, handle) {
    let ox, oy, sx, sy;
    handle.onmousedown = e => {
      e.preventDefault();
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      document.body.style.userSelect = 'none';
      document.onmousemove = e => { panel.style.right = 'auto'; panel.style.left = (ox + e.clientX - sx) + 'px'; panel.style.top = (oy + e.clientY - sy) + 'px'; };
      document.onmouseup  = () => { document.onmousemove = null; document.onmouseup = null; document.body.style.userSelect = ''; };
    };
  }

  const g     = id => document.getElementById(id);
  const show  = id => { const e = g(id); if (e) e.classList.remove('fbps-hide'); };
  const hide  = id => { const e = g(id); if (e) e.classList.add('fbps-hide'); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function status(msg, type) {
    const dot = g('fbps-dot'), txt = g('fbps-msg');
    if (dot) dot.className = type || '';
    if (txt) txt.textContent = msg;
    log(msg, type === 'ok' ? 'ok' : type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'inf');
  }
  function prog(pct) { const bar = g('fbps-prog-bar'); if (!bar) return; show('fbps-prog-wrap'); bar.classList.remove('ind'); bar.style.width = Math.min(100, pct) + '%'; }
  function log(msg, cls) {
    const el = g('fbps-log'); if (!el) return; show('fbps-logwrap');
    const e = document.createElement('div');
    const t = S.t0 ? '+' + Math.round((Date.now() - S.t0) / 1000) + 's' : '+0s';
    e.className = 'fbl-' + (cls || 'inf'); e.textContent = t + ' ' + msg;
    el.appendChild(e); el.scrollTop = el.scrollHeight;
    S.log.push(t + ' ' + msg);
    while (el.children.length > 500) el.removeChild(el.firstChild);
  }
  function tick() {
    const nc = g('fbps-nc'), nt = g('fbps-nt'); if (!nc) return;
    nc.textContent = S.nClicks;
    nt.textContent = Math.round((Date.now() - S.t0) / 1000) + 's';
  }
  function copyLog() {
    const txt = S.log.join('\n');
    navigator.clipboard.writeText(txt)
      .then(() => { g('fbps-btn-copy').textContent = '✅ Copié !'; setTimeout(() => g('fbps-btn-copy').textContent = '📋 Copier log', 2500); })
      .catch(() => { const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;width:500px;height:280px;font:11px monospace;background:#111;color:#eee;border:1px solid #555;border-radius:8px;padding:10px'; document.body.appendChild(ta); ta.select(); alert('Ctrl+C pour copier'); ta.addEventListener('blur', () => setTimeout(() => ta.remove(), 200)); });
  }

  /* ══════════════════════════════════════════════════════════════════
     ADAPTIVE SETTLE — waitForDOMSettle() with dynamic floor
     Tracks the last 3 actual settle durations and sets the minimum
     wait floor to 120% of their average, clamped 400ms–2000ms.
  ══════════════════════════════════════════════════════════════════ */
  function adaptiveFloor() {
    const BASE = 400, MAX = 2000;
    if (S.settleTimes.length === 0) return BASE;
    const recent = S.settleTimes.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return Math.min(MAX, Math.max(BASE, Math.round(avg * 1.2)));
  }

  function waitForDOMSettle() {
    return new Promise(resolve => {
      const root    = S.scroller || document.body;
      const start   = Date.now();
      const floor   = adaptiveFloor();
      let quietTimer = null;
      let settled   = false;

      function done() {
        if (settled) return;
        settled = true;
        observer.disconnect();
        const duration = Date.now() - start;
        S.settleTimes.push(duration);
        if (S.settleTimes.length > 10) S.settleTimes.shift();
        resolve();
      }
      function resetQuiet() {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          const elapsed = Date.now() - start;
          const rem = floor - elapsed;
          if (rem > 0) setTimeout(done, rem); else done();
        }, CFG.SETTLE_QUIET_MS);
      }

      const observer = new MutationObserver(resetQuiet);
      observer.observe(root, { childList: true, subtree: true });
      resetQuiet();
      setTimeout(done, CFG.SETTLE_MAX_MS);
    });
  }

  /* ── SCROLLER ──────────────────────────────────────────────────────── */
  const MODAL_SELECTORS = [
    'div[role="dialog"]',
    'div[data-pagelet="MediaViewerPhoto"]',
    'div[data-pagelet="permalink_reaction_dialog"]',
  ];

  function findScrollerInside(root) {
    let best = null, bestH = 0;
    const allEls = root.getElementsByTagName('*'); for (let i = 0; i < allEls.length; i++) { const el = allEls[i];
      try {
        const ov = window.getComputedStyle(el).overflowY;
        if (ov !== 'auto' && ov !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 10) continue;
        const b = el.scrollTop; el.scrollTop = b + 1;
        const moved = el.scrollTop !== b; el.scrollTop = b;
        if (moved && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
      } catch (_) {}
    }
    return best;
  }

  function findModalScroller() {
    for (const sel of MODAL_SELECTORS) {
      for (const dialog of document.querySelectorAll(sel)) {
        const sc = findScrollerInside(dialog);
        if (sc) return sc;
      }
    }
    return null;
  }

  function findAnyScroller() {
    let best = null, bestH = 0;
    const allEls = document.getElementsByTagName('*'); for (let i = 0; i < allEls.length; i++) { const el = allEls[i];
      if (el === document.body || el === document.documentElement) continue;
      try {
        const ov = window.getComputedStyle(el).overflowY;
        if (ov !== 'auto' && ov !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 10) continue;
        const b = el.scrollTop; el.scrollTop = b + 1;
        const moved = el.scrollTop !== b; el.scrollTop = b;
        if (moved && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
      } catch (_) {}
    }
    return best;
  }

  async function waitForModalScroller(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const sc = findModalScroller();
      if (sc) return sc;
      await sleep(300);
    }
    return null;
  }

  function ensureScroller() {
    if (S.scroller && document.contains(S.scroller)) return;
    if (S.scroller) log('Scroller déconnecté — re-détection…', 'warn');
    const candidate = findModalScroller() || findAnyScroller();
    if (candidate && candidate.scrollHeight >= S.scrollerMinH * 0.8) {
      S.scroller = candidate;
      log('Scroller: scrollH=' + S.scroller.scrollHeight, 'ok');
    } else {
      log('Pas de scroller acceptable — scroll window', 'warn');
      S.scroller = null;
    }
  }

  function scrollTop()    { return S.scroller ? S.scroller.scrollTop    : window.scrollY; }
  function scrollHeight() { return S.scroller ? S.scroller.scrollHeight : document.documentElement.scrollHeight; }
  function clientHeight() { return S.scroller ? S.scroller.clientHeight : window.innerHeight; }
  function scrollBy(px)   { if (S.scroller) S.scroller.scrollTop += px; else window.scrollBy(0, px); }
  function scrollTo(y)    { if (S.scroller) S.scroller.scrollTop = y;   else window.scrollTo(0, y); }

  /* ── FINGERPRINT v3 — 80px bucket ─────────────────────────────────── */
  function fingerprint(el) {
    const text = norm(
      el.getAttribute('aria-label') ||
      (el.innerText || el.textContent || '').slice(0, 80)
    );
    let anc = el.parentElement, ancId = '';
    for (let i = 0; i < 12 && anc; i++, anc = anc.parentElement) {
      const id = anc.getAttribute('data-testid') ||
                 anc.getAttribute('id') ||
                 anc.getAttribute('aria-labelledby') || '';
      if (id) { ancId = id.slice(0, 40); break; }
    }
    let bucketY = 0;
    try {
      const r  = el.getBoundingClientRect();
      const sr = S.scroller ? S.scroller.getBoundingClientRect() : { top: 0 };
      const absY = (S.scroller ? S.scroller.scrollTop : window.scrollY) + r.top - sr.top;
      bucketY = Math.round(absY / 80); // 80px bucket (was 40px)
    } catch (_) {}
    return `${text}||${ancId}||y${bucketY}`;
  }

  /* ── MATCHING ──────────────────────────────────────────────────────── */
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  function matchesTarget(label) {
    const n = norm(label);
    return TARGETS.some(t => n.includes(t));
  }

  function isDenied(label) {
    const n = norm(label);
    if (DENY_NORM.has(n)) return true;
    if (/\d[\d\s]*(k|personne|people|réaction)/i.test(n)) return true;
    if (/toutes.*réactions/i.test(n)) return true;
    if (/^\d+$/.test(n)) return true;
    if (/voir qui a réagi/i.test(n)) return true;
    if (/afficher/i.test(n) && !/réponse|comment/i.test(n)) return true;
    if (/:\s*\d/.test(n)) return true;
    return false;
  }

  function isInView(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (!S.scroller) return r.top < window.innerHeight && r.bottom > 0;
      const sr = S.scroller.getBoundingClientRect();
      return r.top < sr.bottom && r.bottom > sr.top && r.left < sr.right && r.right > sr.left;
    } catch (_) { return false; }
  }

  /* ── DIAGNOSTIC ────────────────────────────────────────────────────── */
  function runDiag() {
    g('fbps-log') && (g('fbps-log').innerHTML = '');
    S.log = []; S.t0 = Date.now(); show('fbps-logwrap'); show('fbps-btn-copy');
    const sc = findModalScroller() || findAnyScroller();
    log('Scroller: ' + (sc ? sc.tagName + ' scrollH=' + sc.scrollHeight + ' clientH=' + sc.clientHeight : 'window'));
    const root = sc || document;
    const els = root.querySelectorAll('div[role="button"],span[role="button"],a[role="button"],button');
    const seen = new Set(); let found = 0, denied = 0;
    for (const el of els) {
      const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const n = norm(label); if (!n || seen.has(n)) continue; seen.add(n);
      if (matchesTarget(label) && !isDenied(label)) { log('✅ "' + label + '"', 'ok'); found++; }
      else if (matchesTarget(label)) { log('🚫 "' + label + '"', 'warn'); denied++; }
    }
    log('─── Clickables: ' + found + ' | Bloqués: ' + denied + ' ───', found > 0 ? 'ok' : 'warn');
  }

  /* ── ENTRY POINT ───────────────────────────────────────────────────── */
  async function startSave() {
    if (S.running) return;
    S.running = true; S.cancelled = false;
    S.nClicks = 0; S.log = []; S.t0 = Date.now();
    S.clickedFps = new Set();
    S.scroller = null; S.scrollerMinH = 0;
    S.settleTimes = [];
    hide('fbps-done'); g('fbps-log').innerHTML = '';
    show('fbps-stats'); show('fbps-logwrap'); show('fbps-btn-copy');
    g('fbps-btn-save').disabled = true; g('fbps-btn-save').classList.add('fbps-running');
    g('fbps-btn-lbl').textContent = ' En cours…'; show('fbps-btn-cancel');
    const ticker = setInterval(tick, 500);
    try { await pipeline(); }
    catch (err) { if (!S.cancelled) { status('Erreur: ' + (err && err.message ? err.message : err), 'err'); if (err && err.stack) log(err.stack, 'err'); } }
    finally {
      clearInterval(ticker); tick();
      S.running = false; g('fbps-btn-save').disabled = false;
      g('fbps-btn-save').classList.remove('fbps-running');
      g('fbps-btn-ico').textContent = '📥'; g('fbps-btn-lbl').textContent = ' Save Full Post';
      hide('fbps-btn-cancel');
    }
  }

  async function pipeline() {
    status('Recherche du scroller…'); prog(3);
    log('Tentative scroller modal (3s)…');
    let sc = await waitForModalScroller(3000);
    if (sc) {
      log('Scroller modal: scrollH=' + sc.scrollHeight + ' clientH=' + sc.clientHeight, 'ok');
    } else {
      sc = findAnyScroller();
      if (sc) log('Scroller direct: scrollH=' + sc.scrollHeight + ' clientH=' + sc.clientHeight, 'ok');
      else     log('Utilisation de window', 'warn');
    }
    S.scroller = sc;
    S.scrollerMinH = sc ? sc.scrollHeight : 0;

    status('Retour en haut…'); prog(5);
    scrollTo(0); await sleep(500);
    if (S.cancelled) return;

    const totalSteps = (g('fbps-av') && g('fbps-av').checked) ? 4 : 3;
    status('[1/' + totalSteps + '] Expansion des commentaires…'); prog(7);
    await ensureAllCommentsFilter();
    if (S.cancelled) return;

    await expandLoop();
    if (S.cancelled) return;

    // Post-expand verification: one final height-stable sweep
    // Catches any buttons FB lazy-renders after scroll-back to top.
    await postExpandVerify();
    if (S.cancelled) return;

    status('[' + (totalSteps - 1) + '/' + totalSteps + '] Capture de la page…'); prog(90);
    await savePage();
    status('✅ Terminé !', 'ok'); prog(100);
    g('fbps-dot').className = 'ok'; show('fbps-done');
  }

  /* ══════════════════════════════════════════════════════════════════
     ENSURE ALL COMMENTS FILTER
     Detects the comment sort button, opens the menu (rendered as a
     body-level portal by FB), selects "Tous les commentaires", and
     waits for the comment list to reload via waitForDOMSettle().
     Falls back to "Les plus récents" if the primary option is missing.
     Retries the full sequence up to 3 times.
  ══════════════════════════════════════════════════════════════════ */
  async function ensureAllCommentsFilter() {
    const TARGET_LABEL   = 'tous les commentaires';
    const FALLBACK_LABEL = 'les plus récents';
    const FILTER_TEXTS   = ['plus pertinents', 'les plus récents', 'tous les commentaires'];
    const MAX_RETRIES    = 3;

    // Find the comment sort/filter button (aria-haspopup="menu")
    function findFilterBtn() {
      const candidates = document.querySelectorAll('[role="button"][aria-haspopup="menu"]');
      for (const el of candidates) {
        const t = norm(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
        if (FILTER_TEXTS.some(f => t.includes(f))) return el;
      }
      return null;
    }

    // Read current filter button label
    function currentFilterText(btn) {
      return norm(btn.getAttribute('aria-label') || btn.innerText || btn.textContent || '');
    }

    // Poll document for role="menuitem" elements appearing after the click.
    // This is the reliable signal that the menu portal is rendered —
    // aria-expanded stays false on this button regardless of menu state.
    async function waitForMenuOption(labelToFind) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const el of items) {
          const t = norm(el.innerText || el.textContent || '');
          if (t.startsWith(labelToFind)) return el;
        }
        await sleep(80);
      }
      return null;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (S.cancelled) return;

      const btn = findFilterBtn();
      if (!btn) {
        log('Filtre introuvable (tentative ' + attempt + '/' + MAX_RETRIES + ')', 'warn');
        await sleep(800);
        continue;
      }

      const current = currentFilterText(btn);
      if (current.includes(TARGET_LABEL)) {
        log('Filtre déjà sur "Tous les commentaires" ✓', 'ok');
        return;
      }

      log('Filtre actuel: "' + current + '" — clic pour ouvrir le menu…');

      // Click the filter button — menu appears as a body-level portal
      btn.click();

      // Step 2: wait for role="menuitem" to appear in document (not aria-expanded)
      let option = await waitForMenuOption(TARGET_LABEL);
      if (!option) {
        log('"Tous les commentaires" absent — fallback "Les plus récents"', 'warn');
        option = await waitForMenuOption(FALLBACK_LABEL);
      }

      if (!option) {
        log('Aucune option trouvée (tentative ' + attempt + '/' + MAX_RETRIES + ')', 'warn');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(400);
        continue;
      }

      log('Clic sur "' + norm(option.innerText || option.textContent || '').slice(0, 30) + '"…');
      option.click();

      // Step 3: wait for comment list to reload
      await waitForDOMSettle();

      // Step 4: verify the filter button now shows the right label
      const updated = findFilterBtn();
      if (updated && currentFilterText(updated).includes(TARGET_LABEL)) {
        log('Filtre "Tous les commentaires" actif ✓', 'ok');
        return;
      }

      // Also accept fallback as success
      if (updated && currentFilterText(updated).includes(FALLBACK_LABEL)) {
        log('Filtre "Les plus récents" actif (fallback) ✓', 'ok');
        return;
      }

      log('Vérification filtre échouée (tentative ' + attempt + '/' + MAX_RETRIES + ')', 'warn');
      await sleep(500);
    }

    log('Impossible de changer le filtre — continuation quand même', 'warn');
  }

  /* ── Post-expand verification sweep ─────────────────────────────────
     After expandLoop finishes, scroll back to top and do one final
     click pass. Repeats if new buttons appear, stops when two
     consecutive height readings are equal (guarantees stability).
     Max 3 extra rounds to avoid infinite loops on adversarial pages.
  ────────────────────────────────────────────────────────────────── */
  async function postExpandVerify() {
    const MAX_VERIFY_ROUNDS = 3;
    log('Vérification post-expansion…');
    scrollTo(0); await sleep(400);

    for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
      if (S.cancelled) return;
      const hBefore = scrollHeight();

      // Full-page scan for any remaining unclicked buttons
      const extra = await fullPageScan();
      S.nClicks += extra;

      if (extra === 0) {
        // No buttons found — check if height is stable (no lazy-loaded content)
        await sleep(CFG.BOTTOM_EXTRA_MS / 2);
        const hAfter = scrollHeight();
        if (hAfter <= hBefore) {
          log('Post-expand: stable ✓ (' + round + ' rounds)', 'ok');
          break;
        }
        log('Post-expand: +' + (hAfter - hBefore) + 'px new content — re-sweep…', 'warn');
      } else {
        log('Post-expand round ' + (round + 1) + ': ' + extra + ' clics supplémentaires', 'ok');
      }
    }
    scrollTo(0); await sleep(200);
  }

  /* ── Loading-spinner detection (your idea — like a human watching the UI) ──
     FB renders a spinner/progressbar while fetching more comments.
     We detect it and wait for it to disappear before declaring "done".
     Selectors cover: role=progressbar, SVG circles, data-visualcompletion,
     and the specific aria-label FB uses on the loading overlay.
  ─────────────────────────────────────────────────────────────────────── */
  function isLoading() {
    const root = S.scroller || document;
    // 1) ARIA progressbar — most reliable
    if (root.querySelector('[role="progressbar"]')) return true;
    // 2) FB's data-visualcompletion loading marker
    if (root.querySelector('[data-visualcompletion="loading-state"]')) return true;
    // 3) Spinning SVG (FB uses animated <circle> inside comment list)
    if (root.querySelector('svg circle[stroke-dasharray]')) return true;
    // 4) Generic aria-label "Loading" / "Chargement"
    const loaders = root.querySelectorAll('[aria-label]');
    for (const el of loaders) {
      const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
      if (lbl === 'loading' || lbl === 'chargement' || lbl === 'تحميل') return true;
    }
    return false;
  }

  // Wait until spinner gone OR timeout. Returns true if clean, false if timed out.
  async function waitForSpinnerGone(maxMs = 8000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!isLoading()) return true;
      await sleep(150);
    }
    return false; // timed out — content may still be loading
  }

  /* ══════════════════════════════════════════════════════════════════
     EXPAND LOOP — smart early-exit on scrollHeight plateau
  ══════════════════════════════════════════════════════════════════ */
  async function expandLoop() {
    const deadline = S.t0 + CFG.MAX_RUNTIME_MS;
    let stableRounds = 0;
    const scrollHHistory = []; // track scrollHeight each stable round for early-exit

    while (Date.now() < deadline) {
      if (S.cancelled) return;
      ensureScroller();

      const sweepClicks = await sweepDown();
      const fullClicks  = await fullPageScan();
      const clicked = sweepClicks + fullClicks;
      S.nClicks += clicked;

      if (fullClicks > 0) log('Full-scan: +' + fullClicks + ' supplémentaires', 'ok');

      if (clicked > 0) {
        stableRounds = 0;
        scrollHHistory.length = 0;
        log('Round: ' + clicked + ' clics.', 'ok');
        prog(10 + Math.min(75, S.nClicks / 2));
      } else {
        // No buttons found — check spinner then measure height
        const shBefore = scrollHeight();

        // Step 1: scroll to bottom to trigger any lazy-load FB might have
        scrollTo(shBefore);
        scrollBy(CFG.SCROLL_STEP_PX);
        await sleep(300);

        // Step 2: if FB is loading more content, wait for spinner to disappear
        //         (like a human watching for the loading animation to stop)
        if (isLoading()) {
          log('⏳ Spinner détecté — attente fin de chargement…', 'warn');
          const clean = await waitForSpinnerGone(10000);
          log(clean ? '✓ Spinner disparu — re-sweep' : '⚠ Timeout spinner', clean ? 'ok' : 'warn');
          stableRounds = 0; // loading was happening — don't count as stable
          continue;
        }

        // Step 3: short wait then re-measure (covers slow network with no spinner)
        await sleep(CFG.BOTTOM_EXTRA_MS);

        const shAfter = scrollHeight();
        scrollHHistory.push(shAfter);
        log('scrollH: ' + shBefore + ' → ' + shAfter +
          (shAfter > shBefore ? ' (+' + (shAfter - shBefore) + ' chargé)' : ' (stable)'));

        if (shAfter > shBefore) {
          stableRounds = 0;
          log('Nouveau contenu — re-sweep…', 'ok');
          continue;
        }

        // Step 4: check spinner one more time after the wait
        //         FB sometimes starts loading AFTER height stabilises
        if (isLoading()) {
          log('⏳ Spinner après stabilité — attente…', 'warn');
          await waitForSpinnerGone(10000);
          stableRounds = 0;
          continue;
        }

        stableRounds++;
        log('Stable ' + stableRounds + '/' + CFG.STABLE_ROUNDS
          + ' | scrollH=' + shAfter + ' | spinner=none');

        if (stableRounds >= CFG.STABLE_ROUNDS) {
          log('✅ Tous les commentaires sont ouverts (spinner + hauteur stables).', 'ok');
          break;
        }
      }

      if (S.nClicks >= CFG.MAX_CLICKS) { log('Limite de clics.', 'warn'); break; }
    }

    if (Date.now() >= S.t0 + CFG.MAX_RUNTIME_MS) log('Temps limite.', 'warn');
    scrollTo(0); await sleep(300);
  }

  /* ── Sweep viewport top→bottom ─────────────────────────────────────── */
  async function sweepDown() {
    let total = 0;
    while (true) {
      if (S.cancelled) return total;
      let local;
      do {
        local = await clickVisible();
        if (local > 0) { total += local; await waitForDOMSettle(); }
      } while (local > 0 && !S.cancelled);
      await sleep(CFG.DWELL_MS);
      const prev = scrollTop();
      scrollBy(CFG.SCROLL_STEP_PX);
      await sleep(80);
      if (scrollTop() === prev) break;
    }
    await sleep(CFG.DWELL_MS);
    const last = await clickVisible();
    if (last > 0) { total += last; await waitForDOMSettle(); }
    return total;
  }

  /* ── Full-page scan — no scrollIntoView, direct click ──────────────── */
  async function fullPageScan() {
    let total = 0;
    const root = S.scroller || document;

    while (true) {
      if (S.cancelled) return total;
      const all = root.querySelectorAll('div[role="button"],span[role="button"],a[role="button"],button');
      const unclicked = [];
      for (const el of all) {
        const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!label || isDenied(label) || !matchesTarget(label)) continue;
        const fp = fingerprint(el);
        if (S.clickedFps.has(fp)) continue;
        unclicked.push({ el, label, fp });
      }
      if (unclicked.length === 0) break;

      log('Full-scan: ' + unclicked.length + ' non-cliqué(s)', 'ok');
      for (const { el, label, fp } of unclicked) {
        if (S.cancelled) return total;
        S.clickedFps.add(fp);
        log('  [full] → "' + label.slice(0, 60) + '"', 'ok');
        try { el.click(); total++; await waitForDOMSettle(); } catch (_) {}
      }
    }
    return total;
  }

  /* ── Click visible in-viewport buttons ─────────────────────────────── */
  async function clickVisible() {
    const root = S.scroller || document;
    const all = root.querySelectorAll('div[role="button"],span[role="button"],a[role="button"],button');
    const toClick = [];
    for (const el of all) {
      if (!isInView(el)) continue;
      const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!label || isDenied(label) || !matchesTarget(label)) continue;
      const fp = fingerprint(el);
      if (S.clickedFps.has(fp)) continue;
      S.clickedFps.add(fp);
      log('  → "' + label.slice(0, 60) + '"  y' + fp.split('||y')[1], 'ok');
      toClick.push(el);
    }
    let clicked = 0;
    for (const el of toClick) {
      if (S.cancelled) break;
      try { el.click(); clicked++; await waitForDOMSettle(); } catch (_) {}
    }
    return clicked;
  }

  /* ══════════════════════════════════════════════════════════════════
     SAVE AS MHTML — via background pageCapture (MV3 workaround).

     WHY: chrome.pageCapture.saveAsMHTML() returns 0 bytes in MV3
     service workers when triggered from a message handler (not a direct
     user gesture). This is a long-standing Chrome MV3 bug with no
     reliable workaround via the API itself.

     HOW: We build a valid MHTML (multipart/related) document ourselves:
       1. Serialize the live, expanded DOM with XMLSerializer.
       2. Collect every external resource URL referenced in the page
          (stylesheets, images, fonts) from <link>, <img>, <style>,
          inline style attributes, and computed styles.
       3. Fetch each resource via fetch() (content scripts can cross-origin
          fetch resources that are already on the page — they're same-origin
          from the browser's cache/CORS perspective for resources the page
          already loaded).
       4. Encode resources as base64 and assemble the MHTML boundary format.
       5. Download the result as a .mht file via a blob URL.

     The resulting .mht opens correctly in Edge, IE, and any MHTML viewer.
  ══════════════════════════════════════════════════════════════════ */

  

  async function savePage() {
    scrollTo(0);
    await sleep(600);
    await waitForDOMSettle();

    const panel = document.getElementById('fbps-panel');
    if (panel) panel.style.display = 'none';

    const avEnabled = g('fbps-av') && g('fbps-av').checked;
    if (avEnabled) {
      status('[2/4] Préparation avatars…'); prog(80);
      await prepareAvatars();
    } else { log('Avatars désactivés', 'warn'); }

    status('[3/4] Capture de la page…'); prog(95);
    await captureIsolated();
    if (panel) panel.style.display = '';
  }


  /* ══════════════════════════════════════════════════════════════════
     UNIFIED AVATAR PIPELINE  (v61)
     Replaces: forceLoadAllAssets + normalizeAvatars + waitAllImages
               + inlineAvatarsAsBase64  (4 functions → 1 pass)

     ONE DOM SCAN collects all fbcdn URLs across img[src], background-image
     (inline + computed), and SVG <image href>. Then:
       • Injects hidden <img> for URLs not yet in an img tag
       • Waits for all to finish loading (8s max)
       • Encodes each unique URL ONCE (shared cache = full dedup)
       • RESIZE: canvas capped at 60px — avatars display at ≤48px
       • JPEG quality: adaptive (src >40px → q=0.80, smaller → q=0.72)
       • PARALLEL: pool of 6 concurrent canvas encodings
       • RETRY: auto-fallback to background-worker fetch if canvas tainted
       • CLEANUP: removes injected helper imgs after encoding
       • DEBUG: logs count, KB embedded, failures
  ══════════════════════════════════════════════════════════════════ */
  async function prepareAvatars() {
    const MAX_AV_PX   = 48;  // FIX D: reduced from 60 → 48px (avatars display at ≤40px on FB)
    const CONCURRENCY = Math.min(6, navigator.hardwareConcurrency || 4);
    const isFbcdn = u => u && (u.includes('fbcdn.net') || u.includes('fbcdn.com'));
    const normalizeFbcdnUrl = u => {
      try { const p = new URL(u); p.search = ''; return p.toString(); } catch (_) { return u; }
    };
    const urlToImgEl  = new Map();
    const urlToBgEls  = new Map();
    const urlToSvgEls = new Map();

    const addBg = (rawUrl, el) => {
      if (!urlToBgEls.has(rawUrl)) urlToBgEls.set(rawUrl, []);
      urlToBgEls.get(rawUrl).push({ el, rawUrl });
    };
    const addSvg = (rawUrl, el) => {
      if (!urlToSvgEls.has(rawUrl)) urlToSvgEls.set(rawUrl, []);
      urlToSvgEls.get(rawUrl).push(el);
    };

    // Phase 1: DOM scan
    const isHttpUrl = u => u && (u.startsWith('http://') || u.startsWith('https://'));

    // FIX 1: Emoji detection — tiny image OR short alt text (≤4 chars) → treat as emoji
    // Emoji set: tracks URLs that must be PNG-only, never JPEG
    const emojiUrls = new Set();
    const markEmoji = url => { if (url) emojiUrls.add(url); };

    document.querySelectorAll('img').forEach(img => {
      // A: Resolve all known lazy-load attributes
      // CRITICAL: read src via getAttribute (not .src property) to get the raw attribute value.
      // img.src property is always absolute — getAttribute gives us what FB actually wrote.
      const attrSrc = img.getAttribute('src') || '';
      if (!attrSrc || attrSrc.startsWith('data:') || img.src === window.location.href) {
        const lazy = img.getAttribute('data-src')
          || img.getAttribute('data-lazy-src')
          || img.getAttribute('data-actual-src')
          || img.getAttribute('data-imgperflogname');
        // FIX A: set crossOrigin BEFORE setting src — prevents CORS re-fetch that resets complete=false
        if (lazy && isHttpUrl(lazy)) { img.crossOrigin = 'anonymous'; img.src = lazy; }
      }
      if (img.srcset && (!img.src || !isHttpUrl(img.src))) {
        const parts = img.srcset.split(',').map(s => s.trim().split(' ')[0]);
        if (parts.length && isHttpUrl(parts[parts.length - 1])) {
          img.crossOrigin = 'anonymous';
          img.src = parts[parts.length - 1];
        }
      }
      // FIX A: only set crossOrigin if not already set (setting it after load triggers re-fetch)
      if (img.crossOrigin !== 'anonymous' && !img.complete) img.crossOrigin = 'anonymous';
      const rawUrl = img.src;
      if (!isHttpUrl(rawUrl)) return;
      if (!urlToImgEl.has(rawUrl) || (!urlToImgEl.get(rawUrl).complete && img.complete))
        urlToImgEl.set(rawUrl, img);
      // FIX 1: short alt = emoji; tiny rendered size = emoji
      const alt = img.getAttribute('alt') || '';
      const rw = img.width || img.naturalWidth || 0;
      const rh = img.height || img.naturalHeight || 0;
      if (alt.length <= 4 || (rw > 0 && rw <= 32) || (rh > 0 && rh <= 32)) markEmoji(rawUrl);
    });

    document.querySelectorAll('[style]').forEach(el => {
      const style = el.getAttribute('style') || '';
      if (!style.includes('url(')) return;
      const re = /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi;
      let m;
      while ((m = re.exec(style)) !== null) addBg(m[1], el);
    });

    document.querySelectorAll('image').forEach(si => {
      const rawUrl = si.getAttribute('href') || si.getAttribute('xlink:href') || '';
      if (isHttpUrl(rawUrl)) addSvg(rawUrl, si);
    });

    // FIX 1: Also capture CSS mask-image / -webkit-mask-image in Phase 1
    // (These are almost always emoji/icon sprites — mark them as emoji)
    document.querySelectorAll('*').forEach(el => {
      try {
        const st = window.getComputedStyle(el);
        const masks = [st.maskImage, st.webkitMaskImage];
        for (const v of masks) {
          if (!v || !v.includes('url(')) continue;
          const re = /url\(["']?(https?:\/\/[^"')]+)["']?\)/g;
          let m;
          while ((m = re.exec(v)) !== null) {
            addBg(m[1], el);
            markEmoji(m[1]); // mask-images are always icon/emoji — force PNG
          }
        }
      } catch (_) {}
    });

    // FIX B: Capture Facebook CSS-only emojis — FB renders comment emojis as
    // <i> or <span> with data-visualcompletion="ignore" or class containing "emoji"
    // These have NO <img> tag — purely background-image CSS. Scan them explicitly.
    const isSafeMediaEl = el => {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') return true;
      if (el.querySelector('img,video,canvas')) return true;
      const hasText = (el.textContent || '').trim().length > 0;
      return !hasText;
    };

    const fbEmojiSelectors = [
      'i[data-visualcompletion="ignore"]',
      'i[data-visualcompletion]',
      'span[aria-label][style*="background"]',
      'i[style*="background-image"]',
      'span[style*="background-image"]',
      'i.img',                     // FB often uses i.img for sprite-based emojis
      '[class*="emoji" i]',        // any element with "emoji" in class name
      'image[href]', 'image[xlink\\:href]', // SVG image elements
    ];
    document.querySelectorAll(fbEmojiSelectors.join(',')).forEach(el => {
      try {
        // Inline style first (fastest)
        const inlineStyle = el.getAttribute('style') || '';
        const bgRe = /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi;
        let m;
        while ((m = bgRe.exec(inlineStyle)) !== null) {
          addBg(m[1], el);
          markEmoji(m[1]);
        }
        // Computed style (catches class-applied background-image)
        const bg = window.getComputedStyle(el).backgroundImage || '';
        if (bg.includes('url(')) {
          bgRe.lastIndex = 0;
          while ((m = bgRe.exec(bg)) !== null) {
            const rawUrl = m[1];
            if (!inlineStyle.includes(rawUrl) && isSafeMediaEl(el)) {
              el.style.backgroundImage = 'url("' + rawUrl + '")';
            }
            addBg(rawUrl, el);
            markEmoji(rawUrl);
          }
        }
      } catch (_) {}
    });

    const postEl = (() => {
      const d = [...document.querySelectorAll('[role="dialog"]')]
        .sort((a, b) => b.scrollHeight - a.scrollHeight);
      if (d.length && d[0].scrollHeight > 500) return d[0];
      if (S.scroller && document.contains(S.scroller)) return S.scroller;
      const arts = [...document.querySelectorAll('div[role="article"]')]
        .filter(e => (e.innerText || '').length > 200)
        .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      return arts[0] || document.querySelector('[role="main"]') || document.body;
    })();

    const allEls = postEl.getElementsByTagName('*'); for (let i = 0; i < allEls.length; i++) { const el = allEls[i];
      try {
        const bg = window.getComputedStyle(el).backgroundImage || '';
        if (!bg.includes('url(')) continue;
        const re = /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi;
        let m;
        while ((m = re.exec(bg)) !== null) {
          const rawUrl = m[1];
          const cur = el.getAttribute('style') || '';
          if (!cur.includes(rawUrl) && isSafeMediaEl(el)) el.style.backgroundImage = 'url("' + rawUrl + '")';
          addBg(rawUrl, el);
          // FIX 1: mark emoji if element renders small (emoji/reaction icons ≤32px)
          try {
            const r = el.getBoundingClientRect();
            if ((r.width > 0 && r.width <= 32) || (r.height > 0 && r.height <= 32)) markEmoji(rawUrl);
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Deduplicate keys by normalized URL (strip query params — same image, different tokens)
    // normMap: normalized → [all original rawUrls that share this normalized form]
    const normMap = new Map(); // normalized → original rawUrl[] 
    for (const rawUrl of [...urlToImgEl.keys(), ...urlToBgEls.keys(), ...urlToSvgEls.keys()]) {
      const norm = normalizeFbcdnUrl(rawUrl);
      if (!normMap.has(norm)) normMap.set(norm, []);
      if (!normMap.get(norm).includes(rawUrl)) normMap.get(norm).push(rawUrl);
    }
    // allKeys = one representative per group (first original) — encoded once
    const allKeys = new Set([...normMap.values()].map(originals => originals[0]));
    const domLoaded = [...urlToImgEl.values()].filter(i => i.complete && i.naturalWidth).length;
    log('Assets: ' + allKeys.size + ' uniques | DOM imgs loaded: ' + domLoaded + '/' + urlToImgEl.size);

    // If many images unloaded, try scrollIntoView on each to trigger FB's lazy loader
    if (domLoaded < urlToImgEl.size) {
      const unloaded = [...urlToImgEl.values()].filter(i => !i.complete || !i.naturalWidth);
      for (const img of unloaded) {
        try { img.loading = 'eager'; img.scrollIntoView({block:'center',behavior:'instant'}); } catch(_) {}
      }
      await sleep(800);
      // Also dispatch scroll on scroller to re-fire IntersectionObserver
      if (S.scroller) S.scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
      await sleep(500);
    }

    let injected = [];
    const origDomImgEl = new Map(urlToImgEl);
    const origAllDomImgs = new Map();
    document.querySelectorAll('img').forEach(img => {
      const u = img.getAttribute('src') || '';
      if (!isHttpUrl(u)) return;
      if (!origAllDomImgs.has(u)) origAllDomImgs.set(u, []);
      origAllDomImgs.get(u).push(img);
    });
    try {
    for (const url of allKeys) {
      const ex = urlToImgEl.get(url);
      if (ex && ex.complete && ex.naturalWidth) continue;
      const img = new Image();
      // FIX A2: crossOrigin MUST be set before src — otherwise browser fetches without CORS
      // headers first, caches the opaque response, then canvas.toDataURL() throws SecurityError
      img.crossOrigin = 'anonymous';
      img.loading = 'eager';
      img.decoding = 'sync';
      const srcUrl = (urlToBgEls.get(url) || [])[0]?.rawUrl
             || (urlToSvgEls.get(url) || [])[0]?.getAttribute?.('href')
             || url;
      img.src = srcUrl;
      img.style.cssText = 'position:fixed;bottom:0;right:0;width:60px;height:60px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(img);
      injected.push(img);
      urlToImgEl.set(url, img);
    }
    // Wait for injected imgs to load (8s max)
    await new Promise(resolve => {
      const pending = injected.filter(i => !i.complete);
      if (!pending.length) return resolve();
      let n = pending.length;
      const done = () => { if (--n <= 0) resolve(); };
      setTimeout(resolve, 8000);
      pending.forEach(i => {
        i.addEventListener('load',  done, { once: true });
        i.addEventListener('error', done, { once: true });
      });
    });
    const afterInject = [...urlToImgEl.values()].filter(i => i.complete && i.naturalWidth).length;
    log('Apres injection: ' + afterInject + '/' + urlToImgEl.size + ' imgs chargees');

    // Phase 2: encode
    // Path A: canvas for already-loaded DOM imgs (free, instant)
    // Path B: XHR from content script context (has FB cookies, unlike SW fetch)
    //   XHR in a content script runs with the page's origin cookies because the
    //   browser treats content script network requests as coming from the page.

    // Is this a large content image (post photo, comment image)?
    const isLargeContentImg = img => img && Math.max(img.naturalWidth||0, img.naturalHeight||0) > 120;

    function canvasEncode(img, key) {
      try {
        if (!img.complete || !img.naturalWidth) return null;
        const nw = img.naturalWidth, nh = img.naturalHeight;

        // FIX 1: STRICT EMOJI RULE — if URL is in emojiUrls set OR img is ≤32px
        // OR alt length ≤4 → ALWAYS PNG, NEVER JPEG, NEVER resize
        const isEmoji = emojiUrls.has(key)
          || Math.max(nw, nh) <= 32
          || (img.getAttribute && (img.getAttribute('alt') || '').length <= 4);
        if (isEmoji) {
          if (img.src && img.src.startsWith('data:image/png')) return img.src;
          const c = document.createElement('canvas');
          c.width = nw; c.height = nh;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, nw, nh);
          return c.toDataURL('image/png'); // ALWAYS PNG for emoji — never JPEG
        }

        if (isLargeContentImg(img)) {
          const MAX_PX = 800;
          const scale = Math.min(1, MAX_PX / Math.max(nw, nh, 1));
          const cw = Math.max(1, Math.round(nw * scale));
          const ch = Math.max(1, Math.round(nh * scale));
          const c = document.createElement("canvas");
          c.width = cw; c.height = ch;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, cw, ch);
          return c.toDataURL("image/jpeg", 0.65);
        }

        // Micro-opt: small image already within target size — no resize needed
        if (Math.max(nw, nh) <= MAX_AV_PX) {
          if (img.src && img.src.startsWith('data:')) return img.src;
          const c = document.createElement('canvas');
          c.width = nw; c.height = nh;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nw, nh);
          ctx.drawImage(img, 0, 0, nw, nh);
          const q = 0.72;
          const jpeg = c.toDataURL('image/jpeg', q);
          const png  = c.toDataURL('image/png');
          return jpeg.length <= png.length ? jpeg : png;
        }

        const scale = Math.min(1, MAX_AV_PX / Math.max(nw, nh, 1));
        const w = Math.max(1, Math.round(nw * scale));
        const h = Math.max(1, Math.round(nh * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const isSmall = Math.max(nw, nh) <= 48;
        const q = isSmall ? 0.72 : 0.80;
        const jpeg = c.toDataURL('image/jpeg', q);
        const png  = c.toDataURL('image/png');
        return jpeg.length <= png.length ? jpeg : png;
      } catch (e) {
        log('  canvas fail: ' + e.message, 'warn');
        return null;
      }
    }

    // XHR fetch from content script — uses page cookies (facebook.com origin)
    function xhrFetchDataURI(rawUrl) {
      return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', rawUrl, true);
        xhr.responseType = 'blob';
        xhr.withCredentials = true;
        xhr.timeout = 10000;
        xhr.onload = () => {
          if (xhr.status !== 200) { resolve(null); return; }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(xhr.response);
        };
        xhr.onerror   = () => resolve(null);
        xhr.ontimeout = () => resolve(null);
        xhr.send();
      });
    }

    // Re-compress a fetched dataURI through canvas for resize + quality
    function recompress(dataURI, key) {
      return new Promise(resolve => {
        const tmp = new Image();
        tmp.onload  = () => resolve(canvasEncode(tmp, key) || dataURI);
        tmp.onerror = () => resolve(dataURI);
        tmp.src = dataURI;
      });
    }

    async function encodeKey(key) {
      const imgEl = urlToImgEl.get(key);

      // 1) Already a dataURI — return immediately, nothing to encode
      if (imgEl && imgEl.src && imgEl.src.startsWith('data:')) return imgEl.src;

      // 2) Canvas only when img exists AND is fully loaded AND crossOrigin succeeded
      //    FIX: skip canvas for bg-only resources (no real img element = injected proxy)
      //    and detect taint risk BEFORE drawing by checking if the img loaded with CORS headers.
      //    An injected img with crossOrigin='anonymous' that loaded successfully is safe.
      //    An original DOM img without crossOrigin set will always taint the canvas.
      if (imgEl && imgEl.complete && imgEl.naturalWidth) {
        // FIX: only attempt canvas if the img element has crossOrigin='anonymous'
        // (either we set it, or it was already set). Without it, canvas WILL be tainted.
        const hasCors = imgEl.crossOrigin === 'anonymous';
        if (hasCors) {
          const r = canvasEncode(imgEl, key);
          if (r) return r;
          // canvas failed despite CORS attr — fall through to XHR
        }
        // FIX: no CORS attr → skip canvas entirely, go straight to XHR (no taint attempt)
      }
      // 3) img not loaded (or missing or no CORS) — skip canvas, go straight to XHR

      // key IS the raw URL (normUrl removed); use imgEl.src if available for freshness
      const rawUrl = (imgEl && imgEl.src && imgEl.src.startsWith('http'))
        ? imgEl.src : key;

      // Try XHR from content script (has page cookies — works for fbcdn)
      const xhrResult = await xhrFetchDataURI(rawUrl);
      if (xhrResult) {
        // FIX 1: emoji URLs → return raw XHR result, NEVER recompress (preserves PNG/transparency)
        if (emojiUrls.has(key)) return xhrResult;
        // FIX D2: Large content images — recompress at 0.75 quality (saves ~30% vs raw)
        // Raw XHR returns original FB quality which is already compressed; re-encoding at 0.75
        // saves significant space with minimal visible quality loss on saved MHT files.
        if (imgEl && isLargeContentImg(imgEl)) return await recompress(xhrResult, key);
        // Skip recompress for small avatars already at target size
        if (imgEl &&
            Math.max(imgEl.naturalWidth || 0, imgEl.naturalHeight || 0) <= 48 &&
            xhrResult.length < 20 * 1024) {
          return xhrResult;
        }
        return await recompress(xhrResult, key);
      }

      // Final fallback: background worker (in case XHR blocked by CORS header)
      if (!rawUrl || !rawUrl.startsWith('http')) return null;
      return await new Promise(resolve => {
        const t = setTimeout(() => resolve(null), 10000);
        chrome.runtime.sendMessage({ action: 'fetchAsDataURI', url: rawUrl }, resp => {
          clearTimeout(t);
          if (chrome.runtime.lastError || !resp || !resp.dataURI) { resolve(null); return; }
          // FIX 1: emoji URLs → never recompress (preserve PNG/transparency)
          if (emojiUrls.has(key)) { resolve(resp.dataURI); return; }
          // Large images: skip recompress
          if (imgEl && isLargeContentImg(imgEl)) { resolve(resp.dataURI); return; }
          recompress(resp.dataURI, key).then(resolve);
        });
      });
    }

    async function poolRun(keys, fn, limit) {
      const results = new Map(), queue = [...keys];
      let done = 0; const total = queue.length;
      const worker = async () => {
        while (queue.length) {
          const key = queue.shift();
          results.set(key, await fn(key));
          done++;
          if (done % 16 === 0 || done === total) prog(90 + Math.round(done / total * 7));
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, total || 1) }, worker));
      return results;
    }

    status('[2/4] Encodage avatars...'); prog(90);
    const cache = await poolRun(allKeys, encodeKey, CONCURRENCY);

    const ok   = [...cache.values()].filter(Boolean).length;
    const fail = cache.size - ok;
    const estKB = Math.round([...cache.values()].filter(Boolean).reduce((s,v) => s + v.length, 0) * 0.75 / 1024);
    log('Avatars: ' + ok + ' ok | ' + fail + ' echecs | ~' + estKB + ' KB', ok > 0 ? 'ok' : 'warn');

    // Sample first failure for debug
    if (fail > 0) {
      for (const [key, val] of cache) {
        if (!val) { log('  DBG fail key: ' + key.slice(0, 80), 'warn'); break; }
      }
    }

    // Phase 3: apply to DOM
    // Build reverse lookup: representative key → all original rawUrls in its group
    const repToOriginals = new Map();
    for (const originals of normMap.values()) repToOriginals.set(originals[0], originals);

    for (const [key, dataURI] of cache) {
      if (!dataURI) continue;
      // Fan out: apply to every original URL that was deduplicated under this representative
      const originals = repToOriginals.get(key) || [key];
      for (const rawUrl of originals) {
        const img = urlToImgEl.get(rawUrl);      // may be injected off-screen img
        const origImg = origDomImgEl.get(rawUrl); // always the real DOM img
        // Apply to injected img (used by canvas encode path)
        if (img && img.src && img.src.startsWith('http')) {
          img.src = dataURI; img.removeAttribute('srcset'); img.removeAttribute('data-src');
        }
        const allSameImgs = origAllDomImgs.get(rawUrl) || (origImg ? [origImg] : []);
        for (const domImg of allSameImgs) {
          if (!domImg.isConnected) continue;
          domImg.src = dataURI;
          domImg.setAttribute('src', dataURI);
          domImg.removeAttribute('srcset');
          domImg.removeAttribute('data-src');
        }
        for (const { el, rawUrl: bgRaw } of (urlToBgEls.get(rawUrl) || [])) {
          const style = el.getAttribute('style') || '';
          // FIX: replace the http URL with the data: URI in inline style so cloneNode captures it
          if (style.includes(bgRaw)) {
            el.setAttribute('style', style.split(bgRaw).join(dataURI));
          } else {
            // FIX: If background was set via computed CSS (class), force-write data: URI now
            // so the clone attribute has the inlined image, not a broken class-based reference
            const cur = el.getAttribute('style') || '';
            if (!cur.includes('data:')) {
              el.setAttribute('style', cur + (cur && !cur.endsWith(';') ? ';' : '') +
                'background-image:url("' + dataURI + '") !important;');
            }
          }
        }
        for (const si of (urlToSvgEls.get(rawUrl) || [])) {
          si.setAttribute('href', dataURI); si.setAttribute('xlink:href', dataURI);
        }
      }
    }

    } finally {
      injected.forEach(img => { try { img.remove(); } catch (_) {} });
    }
  }


  /* ══════════════════════════════════════════════════════════════════
     STEP 4 — ISOLATION PHASE
     Detach non-post body children, hide inner siblings.
     Uses snapshot array to avoid mutation issues during detach.
  ══════════════════════════════════════════════════════════════════ */
  async function captureIsolated() {
    const filename = buildFilename('mht');

    // Read bg from live DOM (read-only)
    capturedBodyBg = window.getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';

    // Find post in live DOM (read-only — NO modifications)
    let postEl = null;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const postDialog = dialogs.find(d => d.querySelector('[role="article"]'));
    if (postDialog) { postEl = postDialog; log('Dialog h=' + postEl.scrollHeight); }
    if (!postEl) {
      const articles = [...document.querySelectorAll('[role="article"]')];
      const visible = articles.filter(el => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
      if (visible.length) { postEl = visible.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]; log('Article visible'); }
    }
    if (!postEl && S.scroller && document.contains(S.scroller)) { postEl = S.scroller; log('Scroller h=' + postEl.scrollHeight); }
    if (!postEl) {
      const arts = [...document.querySelectorAll('div[role="article"]')].filter(e => (e.innerText||'').length > 200).sort((a,b) => (b.innerText||'').length - (a.innerText||'').length);
      if (arts[0]) { postEl = arts[0]; log('Article chars=' + (postEl.innerText||'').length); }
    }
    if (!postEl) { postEl = document.querySelector('[role="main"]'); if (postEl) log('Main utilisé'); }
    if (!postEl) { log('Post introuvable — capture complète', 'warn'); return buildMHTMLAndDownload(filename, null); }
    log('Post: ' + postEl.tagName + (postEl.id ? '#'+postEl.id : '') + ' h=' + postEl.scrollHeight);

    // Sync data-URI src attrs BEFORE cloning (setAttribute only — safe)
    document.querySelectorAll('img').forEach(img => {
      try {
        if (img.src && img.src.startsWith('data:')) {
          img.setAttribute('src', img.src);
          img.removeAttribute('srcset');
          img.removeAttribute('data-src');
        }
      } catch (_) {}
    });

    // Pass live post element to builder — ALL DOM work done there on clone
    try {
      await buildMHTMLAndDownload(filename, postEl);
    } catch (e) {
      log('Erreur capture: ' + e.message, 'err');
      throw e;
    }
    // Live DOM never modified — no restore needed
  }


  /* ── Build filename ─────────────────────────────────────────────────── */
  function buildFilename(ext) {
    let author = '';

    // Strategy 1: scan text nodes for "Publication de X" pattern
    const pubPrefixes = ['publication de', 'posted by', 'منشور'];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !author) {
      const t = node.textContent.trim();
      const low = t.toLowerCase();
      for (const prefix of pubPrefixes) {
        if (low.startsWith(prefix)) {
          const raw = t.slice(prefix.length).replace(/^[\s\u200e\u200f\u202a-\u202e]+/, '').trim();
          const clean = raw.replace(/[\u200e\u200f\u202a-\u202e]+$/, '').trim();
          if (clean.length > 1) { author = clean; break; }
        }
      }
    }

    // Strategy 2: first <h2> or <h3> content
    if (!author) {
      for (const tag of ['h2', 'h3']) {
        const el = document.querySelector(tag);
        if (el) {
          const t = (el.innerText || el.textContent || '').trim().split('\n')[0].trim();
          if (t.length > 1) { author = t; break; }
        }
      }
    }

    // Strategy 3: first profile link
    if (!author) {
      const el = document.querySelector('a[href*="/"][role="link"]');
      if (el) author = (el.innerText || el.textContent || '').trim();
    }

    const now = new Date();
    const date = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') + '-' +
      String(now.getMinutes()).padStart(2, '0');

    const safeName = author
      ? 'facebook_' + author
          .replace(/[\u200e\u200f\u202a-\u202e\u200b\ufeff]+/g, '')
          .replace(/\s+/g, '_')
          .replace(/[<>:"/\\|?*]+/g, '')
          .replace(/_+/g, '_').replace(/^_|_$/g, '')
          .slice(0, 60)
      : 'facebook_post';

    return safeName + '_' + date + '.' + ext;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /* ── Real in-page MHTML builder ─────────────────────────────────────── */
  async function buildMHTMLAndDownload(filename, livePostEl) {
    filename = filename || buildFilename('mht');
    status('[4/4] Construction MHTML…'); prog(95);

    try {
      // B. Determine source element — ONLY the post, never full page
      const sourceEl = livePostEl
        || document.querySelector('[role="dialog"]')
        || document.querySelector('[role="article"]')
        || document.querySelector('[role="main"]')
        || document.body;

      // C. Deep clone of ONLY the post element
      const clonePostEl = sourceEl.cloneNode(true);

      // D. Prune inside clone only (never live DOM)
      clonePostEl.querySelectorAll('script,noscript,video,canvas').forEach(e => e.remove());
      clonePostEl.querySelector('#fbps-panel')?.remove();

      // D2. Remove invisible elements (clone only)
      const isInvisible = el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden') return true;
        if (style.opacity === '0') return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if (el.getAttribute('role') === 'presentation') return true;
        return false;
      };
      clonePostEl.querySelectorAll('*').forEach(el => {
        if (isInvisible(el)) el.remove();
      });

      // D3. Remove empty divs with no children and no visual role
      clonePostEl.querySelectorAll('div').forEach(el => {
        if (el.children.length === 0 && !el.getAttribute('role') && !el.textContent.trim()) {
          el.remove();
        }
      });

      // E. Build a minimal HTML document containing ONLY the post
      const clone = document.implementation.createHTMLDocument(document.title || 'Facebook Post');
      // Copy html attributes (dark mode class, lang, etc.)
      try {
        const liveHtml = document.documentElement;
        if (liveHtml.className) clone.documentElement.className = liveHtml.className;
        if (liveHtml.lang) clone.documentElement.lang = liveHtml.lang;
      } catch(_) {}
      clone.body.appendChild(clonePostEl);

      // F. Setup head
      let head = clone.querySelector('head');
      if (!head) { head = clone.createElement('head'); clone.documentElement.insertBefore(head, clone.body); }
      const metaCharset = clone.createElement('meta'); metaCharset.setAttribute('charset', 'UTF-8'); head.insertBefore(metaCharset, head.firstChild);

      // G. Collect CSS — safe filtering without selector querySelector (breaks layout)
      const cssParts = [];
      let cssBytes = 0;
      const CSS_BYTE_LIMIT = 350 * 1024; // 350KB limit

      for (const sheet of document.styleSheets) {
        if (cssBytes >= CSS_BYTE_LIMIT) break;
        try {
          for (const rule of (sheet.cssRules || [])) {
            if (cssBytes >= CSS_BYTE_LIMIT) break;
            try {
              if (rule.type === CSSRule.FONT_FACE_RULE) continue;
              if (rule.type === CSSRule.IMPORT_RULE) continue;
              if (rule.cssText && /url\(["']?https?:\/\//.test(rule.cssText)) continue;
              if (rule.selectorText && rule.selectorText.length > 500) continue;
              if (rule.type === CSSRule.STYLE_RULE) {
                const text2 = rule.cssText || '';
                // Skip purely interactive/animation rules — useless in static MHTML
                if (/^\s*(cursor|pointer-events|user-select|transition|animation|will-change)\s*:/.test(text2)) continue;
              }
              const text = rule.cssText;
              cssParts.push(text);
              cssBytes += text.length;
            } catch (_) {}
          }
        } catch (_) {}
      }

      cssParts.unshift(
        'body { font-family: system-ui, -apple-system, "Segoe UI Emoji", "Apple Color Emoji",' +
        ' "Noto Color Emoji", "Android Emoji", sans-serif !important;' +
        ' background:' + capturedBodyBg + ' !important; }' +
        'img { max-width:100% !important; }'
      );

      const styleEl = clone.createElement('style');
      styleEl.textContent = cssParts.join('\n');
      head.appendChild(styleEl);
      log('CSS: ' + cssParts.length + ' règles | ' + Math.round(cssBytes/1024) + ' KB');

      // H. Serialize HTML
      const serializer = new XMLSerializer();
      let htmlStr = '<!DOCTYPE html>\n' + serializer.serializeToString(clone);

      // I. Collect remaining http image URLs from clonePostEl
      const seen = new Set();
      const resources = [];
      const normalizeForDedup = url => {
        try {
          const u = new URL(url);
          u.search = '';
          u.hostname = u.hostname.replace(/^scontent\.[^.]+\./, 'scontent.');
          return u.toString();
        } catch (_) { return url; }
      };
      const seenNorm = new Set();
      const addUrl = (url, mimeHint) => {
        if (!url) return;
        url = url.trim();
        if (url.includes('data:image')) return;
        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
        try { new URL(url); } catch (_) { return; }
        const norm = normalizeForDedup(url);
        if (seenNorm.has(norm)) return;
        seenNorm.add(norm);
        if (seen.has(url)) return;
        seen.add(url);
        resources.push({ url, mimeHint });
      };

      clonePostEl.querySelectorAll('img').forEach(el => {
        if (el.width === 1 && el.height === 1) return;
        const src = el.getAttribute('src') || '';
        if (src && !src.startsWith('data:')) addUrl(src, 'image/jpeg');
        const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-actual-src');
        if (dataSrc && !dataSrc.startsWith('data:')) addUrl(dataSrc, 'image/jpeg');
        if (el.srcset) {
          const first = el.srcset.split(',')[0];
          if (first) { const u = first.trim().split(' ')[0]; if (u && !u.startsWith('data:')) addUrl(u, 'image/jpeg'); }
        }
        const alt = el.getAttribute('alt') || '';
        const w = parseInt(el.getAttribute('width') || '0', 10);
        const h = parseInt(el.getAttribute('height') || '0', 10);
        if ((alt.length <= 4 || (w > 0 && w <= 32) || (h > 0 && h <= 32)) && src && !src.startsWith('data:')) {
          const idx = resources.findIndex(r => r.url === src);
          if (idx >= 0) resources[idx].mimeHint = 'image/png';
        }
      });

      clonePostEl.querySelectorAll('[style]').forEach(el => {
        const re = /url\(["']?(https?:\/\/[^"')]+)["']?\)/g;
        let m; while ((m = re.exec(el.getAttribute('style') || '')) !== null) addUrl(m[1], '');
      });
      log('MHTML: resources avant filtre=' + resources.length);

      // Filter to only URLs actually present in serialized HTML
      const htmlStrDecoded = htmlStr.replace(/&amp;/g, '&');
      const stillHttp = new Set();
      clonePostEl.querySelectorAll('img').forEach(img => {
        const s = img.getAttribute('src') || '';
        if (s.startsWith('http')) stillHttp.add(s);
      });
      clonePostEl.querySelectorAll('[style]').forEach(el => {
        const re = /url\(["']?(https?:\/\/[^"')]+)["']?\)/g;
        let m; while ((m = re.exec(el.getAttribute('style') || '')) !== null) stillHttp.add(m[1]);
      });

      const filteredResources = resources.filter(({ url }) => {
        if (stillHttp.has(url)) return true;
        try {
          const norm = new URL(url); norm.search = '';
          const ns = norm.toString();
          for (const u of stillHttp) { try { const n2 = new URL(u); n2.search = ''; if (n2.toString() === ns) return true; } catch(_) {} }
        } catch(_) {}
        return htmlStrDecoded.includes(url) || htmlStr.includes(url);
      });
      log('MHTML: après filtre=' + filteredResources.length);

      // J. Fetch remaining resources
      const MHTML_CONC = 5;
      const fetched = new Map();
      const blobToB64 = blob => new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
      });
      const detectMime = (url, mimeHint, blob) => {
        if (blob.type && blob.type !== 'application/octet-stream') return blob.type;
        if (mimeHint) return mimeHint;
        if (/\.png(\?|$)/.test(url)) return 'image/png';
        if (/\.gif(\?|$)/.test(url)) return 'image/gif';
        if (/\.webp(\?|$)/.test(url)) return 'image/webp';
        if (/\.(jpg|jpeg)(\?|$)/.test(url)) return 'image/jpeg';
        return 'application/octet-stream';
      };

      const queue = [...filteredResources]; let qi = 0;
      const worker = async () => {
        while (qi < queue.length) {
          const { url, mimeHint } = queue[qi++];
          try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (!resp.ok) continue;
            const blob = await resp.blob();
            const b64 = await blobToB64(blob);
            let mime = detectMime(url, mimeHint, blob);
            if (mimeHint === 'image/png') mime = 'image/png';
            fetched.set(url, { b64, mime });
          } catch (_) {}
        }
      };
      await Promise.all(Array.from({ length: Math.min(MHTML_CONC, queue.length || 1) }, worker));
      log('MHTML: ' + fetched.size + '/' + filteredResources.length + ' imgs encodées');

      // K. Inline fetched images into HTML
      for (const [url, { b64, mime }] of fetched) {
        const dataURI = 'data:' + mime + ';base64,' + b64;
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        htmlStr = htmlStr.replace(new RegExp('(src=["\'\'])' + escaped + '(["\'\'])', 'g'), '$1' + dataURI + '$2');
        htmlStr = htmlStr.replace(new RegExp('url\\(["\'\']?' + escaped + '["\'\']?\\)', 'g'), 'url("' + dataURI + '")');
      }

      // L. Assemble MHTML
      const boundary = '----=NextPart_' + Date.now();
      const CRLF = '\r\n';
      const mhtml =
        'From: <saved by FacebookFullPostSaver>' + CRLF +
        'Subject: ' + (document.title || 'Facebook Post') + CRLF +
        'MIME-Version: 1.0' + CRLF +
        'Content-Type: multipart/related;' + CRLF +
        '\ttype="text/html";' + CRLF +
        '\tboundary="' + boundary + '"' + CRLF + CRLF +
        '--' + boundary + CRLF +
        'Content-Type: text/html; charset="utf-8"' + CRLF +
        'Content-Transfer-Encoding: 8bit' + CRLF +
        'Content-Location: ' + location.href + CRLF + CRLF +
        htmlStr + CRLF +
        '--' + boundary + '--' + CRLF;

      const sz = Math.round(mhtml.length / 1024);
      log('💾 MHTML: ' + (sz/1024).toFixed(2) + ' MB (' + sz + ' KB)', 'ok');
      status('[4/4] Sauvegarde… (' + sz + ' KB)', 'ok'); prog(98);

      const blob = new Blob([mhtml], { type: 'message/rfc822' });
      const dlUrl = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: dlUrl, download: filename });
      a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(dlUrl); a.remove(); }, 5000);
      log('MHT sauvegardé ✓ — ' + filename, 'ok');

    } catch (e) {
      log('MHTML builder échoué: ' + (e && e.message ? e.message : e), 'err');
      throw e;
    }
  }

  buildPanel();
  log('Prêt — cliquez "Save Full Post" pour commencer.', 'ok');

})();
