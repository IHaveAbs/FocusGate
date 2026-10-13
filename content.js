/* Focus Gate — content script.
   Runs on every http(s) page. If the site is gated and no goal exists for
   this tab, shows a full-screen "state your purpose" gate.
   The goal is then shown in a banner at the top of the page.

   Goals live in per-tab sessionStorage: every tab and every site starts
   clean, so each visit to a gated site asks for a fresh goal. Nothing is
   shared across tabs, and goals vanish when the tab closes. */

(() => {
  'use strict';

  if (window.top !== window) return; // gate only the top frame
  if (window.__focusGateInstalled) return;
  window.__focusGateInstalled = true;

  const BLACKLIST_KEY = 'focusgate_blacklist';
  const ENABLED_KEY = 'focusgate_enabled';
  const GOALS_KEY = 'focusgate_goals';

  const SITE = location.hostname.toLowerCase().replace(/^www\./, '');
  const BRAND = 'FOCUS GATE';
  const Z = 2147483647; // top of the world

  const COLORS = {
    ink: '#171133',
    card: '#1E1444',
    raised: '#2A1D5E',
    paper: '#F4EFE6',
    muted: '#A79FD1',
    amber: '#FFC53D',
    amberDeep: '#E09F1F',
    line: 'rgba(255, 197, 61, 0.28)'
  };

  /* ---------- storage --------------------------------------------------
     Per-tab sessionStorage: each tab keeps its own goals map keyed by
     site. No sharing across tabs, none across sites, gone with the tab. */

  let goalsCache = {}; // warm copy so the banner can restore position synchronously

  function goalsGet() {
    try {
      goalsCache = JSON.parse(sessionStorage.getItem(GOALS_KEY) || '{}');
    } catch (e) { goalsCache = {}; }
    return goalsCache;
  }

  function goalsSet(goals) {
    goalsCache = goals;
    try {
      sessionStorage.setItem(GOALS_KEY, JSON.stringify(goals));
    } catch (e) { /* storage full or blocked */ }
  }

  /* ---------- shared UI plumbing --------------------------------------- */

  function mount() {
    const host = document.createElement('div');
    host.id = '__focusGateRoot';
    host.style.cssText = 'all:initial; position:fixed; z-index:' + Z + '; top:0; left:0; width:0; height:0;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap';
    root.appendChild(link);
    return { host, root };
  }

  /* ---------- the gate (full-screen purpose prompt) -------------------- */

  function showGate(goalText) {
    const { root } = mount();
    const card = document.createElement('div');
    card.className = 'gate';

    card.innerHTML = `
      <div class="gate__card" role="dialog" aria-modal="true" aria-labelledby="fg-title">
        <div class="gate__stub">
          <div class="gate__stamp">PURPOSE<br>REQUIRED</div>
          <div class="gate__stub-lines"></div>
        </div>
        <div class="gate__body">
          <div class="gate__eyebrow">
            <span class="gate__dot"></span>${BRAND}
            <span class="gate__site">${escapeHtml(SITE)}</span>
          </div>
          <h1 id="fg-title" class="gate__title">What's the plan on <em>${escapeHtml(friendlyName(SITE))}</em>?</h1>
          <p class="gate__sub">Name your purpose in one line. Every visit asks for a fresh one — it stays up on this tab until you're done.</p>
          <form class="gate__form" novalidate>
            <input class="gate__input" type="text" maxlength="160" autocomplete="off" spellcheck="true"
                   placeholder="e.g. Watch this one lecture on signal processing"
                   aria-label="What are you here to do?">
            <div class="gate__row">
              <button class="gate__btn" type="submit">Set my goal and continue</button>
              <span class="gate__hint">Press <kbd>Enter</kbd> to commit</span>
            </div>
          </form>
          <p class="gate__note">No purpose, no page. If you can't name one, close the tab — it probably wasn't important.</p>
        </div>
        <div class="gate__ticket-edge"></div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = sharedCss() + gateCss();
    root.append(style, card);

    const input = card.querySelector('.gate__input');
    if (goalText) input.value = goalText;
    input.focus();

    const trap = (e) => {
      const focusables = card.querySelectorAll('button, input');
      if (e.key !== 'Tab' || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap, true);

    card.querySelector('.gate__form').addEventListener('submit', (e) => {
      e.preventDefault();
      const goal = input.value.trim();
      if (!goal) { input.classList.add('gate__input--error'); input.focus(); return; }
      input.classList.remove('gate__input--error');
      const goals = goalsGet();
      goals[SITE] = { goal, startedAt: Date.now() };
      goalsSet(goals);
      document.removeEventListener('keydown', trap, true);
      root.host.remove();
      showBanner();
    });

    input.addEventListener('input', () => input.classList.remove('gate__input--error'));
  }

  /* ---------- the banner (pinned goal while browsing) ------------------- */

  let bannerTimer = null;

  function showBanner() {
    const { root } = mount();

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `
      <div class="bar__handle" role="img" aria-label="Drag to move the banner; double-click to snap back to the top" title="Drag to move · double-click to dock at top"></div>
      <div class="bar__goal">
        <span class="bar__label">GOAL</span>
        <span class="bar__text"></span>
      </div>
      <div class="bar__timer" title="Time since you set this goal"></div>
      <div class="bar__actions">
        <button class="bar__btn bar__btn--ghost" type="button">Edit</button>
        <button class="bar__btn bar__btn--done" type="button">Done ✓</button>
      </div>`;

    const style = document.createElement('style');
    style.textContent = sharedCss() + bannerCss();
    root.append(style, bar);

    const textEl = bar.querySelector('.bar__text');
    const timerEl = bar.querySelector('.bar__timer');

    /* --- drag to reposition (banner must never cover what you need) ----- */

    let posY = null;   // current vertical offset in px (null = docked at top)
    let drag = null;

    const clampY = (y) => Math.max(0, Math.min(y, window.innerHeight - bar.offsetHeight));
    const setY = (y) => { bar.style.transform = 'translateY(' + Math.round(y) + 'px)'; };

    // Restore this site's position synchronously from the warm cache.
    const cached = goalsCache[SITE];
    if (cached && cached.pos && typeof cached.pos.y === 'number') {
      posY = cached.pos.y;
      setY(posY);
    }

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;      // let the buttons keep working
      drag = {
        pointerId: e.pointerId,
        startY: e.clientY,
        baseY: posY || 0,
        moved: false
      };
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      bar.classList.add('bar--dragging');
      e.preventDefault();                           // no text selection while dragging
    });

    bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) > 3) drag.moved = true;
      setY(clampY(drag.baseY + dy));
    });

    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const wasMoved = drag.moved;
      drag = null;
      bar.classList.remove('bar--dragging');
      posY = clampY(parseFloat(bar.style.transform.replace(/[^0-9.-]/g, '')) || 0);
      persistPos();
      if (wasMoved) {
        // A drag ends with a click; swallow it so nothing on the page fires.
        const swallow = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          document.removeEventListener('click', swallow, true);
        };
        document.addEventListener('click', swallow, true);
      }
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      posY = 0;
      setY(0);
      persistPos();
    });

    function persistPos() {
      const goals = goalsGet();
      const entry = goals[SITE];
      if (!entry) return;
      entry.pos = { y: posY };
      goalsSet(goals);
    }

    /* --- goal + timer --------------------------------------------------- */

    const paint = () => {
      const goals = goalsGet();
      const entry = goals[SITE];
      if (!entry) { teardown(); return; }
      textEl.textContent = entry.goal;
      textEl.title = entry.goal;
      if (posY === null && entry.pos && typeof entry.pos.y === 'number' && !drag) {
        posY = clampY(entry.pos.y);
        setY(posY);
      }
      const s = Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      timerEl.textContent = h > 0
        ? String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
        : String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    };

    const teardown = () => {
      if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
      root.host.remove();
      window.__focusGateInstalled = false;
    };

    bar.querySelector('.bar__btn--ghost').addEventListener('click', () => {
      bar.remove();
      if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
      showGate(textEl.textContent || '');
    });

    bar.querySelector('.bar__btn--done').addEventListener('click', () => {
      const goals = goalsGet();
      delete goals[SITE];
      goalsSet(goals);
      bar.querySelector('.bar__actions').remove();
      const chip = document.createElement('span');
      chip.className = 'bar__chip';
      chip.textContent = 'Gate closed — goal cleared.';
      bar.appendChild(chip);
      setTimeout(teardown, 1600);
    });

    paint();
    bannerTimer = setInterval(paint, 1000);
  }

  /* ---------- entry point ---------------------------------------------- */

  (async function init() {
    try {
      const cfg = await chrome.storage.local.get([BLACKLIST_KEY, ENABLED_KEY]);
      if (cfg[ENABLED_KEY] === false) return;
      const list = Array.isArray(cfg[BLACKLIST_KEY]) ? cfg[BLACKLIST_KEY] : [];
      const matched = list.find((entry) => {
        if (!entry) return false;
        const e = String(entry).toLowerCase().replace(/^www\./, '');
        return SITE === e || SITE.endsWith('.' + e);
      });
      if (!matched) return;
      const goals = await goalsGet();
      if (goals[SITE]) { showBanner(); return; }
      showGate('');
    } catch (err) {
      // Never break the page. If anything goes wrong, stay out of the way.
    }
  })();

  /* ---------- helpers --------------------------------------------------- */

  function friendlyName(host) {
    const parts = host.split('.');
    const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------- styles ---------------------------------------------------- */

  function sharedCss() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      .gate, .bar {
        font-family: 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
        color: ${COLORS.paper};
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      .gate button, .bar button, .gate input {
        font-family: inherit;
      }
      kbd {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        padding: 2px 5px;
        border: 1px solid ${COLORS.line};
        border-radius: 4px;
        color: ${COLORS.amber};
      }
      @media (prefers-reduced-motion: reduce) {
        .gate__card, .bar, .bar::after, .bar__label::after {
          animation: none !important; transition: none !important;
        }
      }`;
  }

  function gateCss() {
    return `
      .gate {
        position: fixed; inset: 0; z-index: ${Z};
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        background:
          radial-gradient(1200px 600px at 85% -10%, rgba(255, 197, 61, 0.10), transparent 60%),
          radial-gradient(900px 500px at -10% 110%, rgba(74, 58, 160, 0.35), transparent 55%),
          ${COLORS.ink};
        backdrop-filter: blur(2px);
      }
      .gate::before {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
        background-size: 44px 44px;
      }
      .gate__card {
        position: relative;
        display: flex;
        width: min(680px, 100%);
        background: ${COLORS.card};
        border: 1px solid ${COLORS.line};
        border-radius: 6px;
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
        animation: gateIn 320ms cubic-bezier(0.2, 0.9, 0.25, 1);
        overflow: hidden;
      }
      @keyframes gateIn {
        from { opacity: 0; transform: translateY(14px) scale(0.985); }
        to { opacity: 1; transform: none; }
      }
      /* --- ticket body --- */
      .gate__body { flex: 1; padding: 44px 44px 38px; }
      .gate__eyebrow {
        display: flex; align-items: center; gap: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 600; letter-spacing: 0.18em;
        color: ${COLORS.muted};
        text-transform: uppercase;
      }
      .gate__dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: ${COLORS.amber};
        box-shadow: 0 0 0 3px rgba(255, 197, 61, 0.22), 0 0 12px rgba(255, 197, 61, 0.7);
      }
      .gate__site {
        margin-left: auto;
        color: ${COLORS.amber};
        letter-spacing: 0.08em;
        max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        text-transform: lowercase;
      }
      .gate__title {
        font-family: 'Anton', 'Arial Narrow', sans-serif;
        font-weight: 400;
        font-size: clamp(34px, 6vw, 52px);
        line-height: 1.02;
        letter-spacing: 0.01em;
        text-transform: uppercase;
        margin: 22px 0 14px;
        color: ${COLORS.paper};
      }
      .gate__title em {
        font-style: normal;
        color: ${COLORS.amber};
        -webkit-text-stroke: 1px rgba(255, 197, 61, 0.45);
      }
      .gate__sub {
        font-size: 15px; line-height: 1.6; color: ${COLORS.muted};
        max-width: 46ch;
      }
      .gate__form { margin-top: 28px; }
      .gate__input {
        width: 100%;
        background: ${COLORS.raised};
        border: 1px solid transparent;
        border-radius: 6px;
        color: ${COLORS.paper};
        font-size: 16px;
        padding: 15px 16px;
        outline: none;
        transition: border-color 160ms ease, box-shadow 160ms ease;
      }
      .gate__input::placeholder { color: rgba(167, 159, 209, 0.55); }
      .gate__input:focus {
        border-color: ${COLORS.amber};
        box-shadow: 0 0 0 3px rgba(255, 197, 61, 0.18);
      }
      .gate__input--error { border-color: #FF6B6B !important; box-shadow: 0 0 0 3px rgba(255, 107, 107, 0.18) !important; }
      .gate__row {
        display: flex; align-items: center; gap: 18px;
        margin-top: 16px;
      }
      .gate__btn {
        background: ${COLORS.amber};
        color: ${COLORS.ink};
        border: none;
        border-radius: 6px;
        font-size: 15px; font-weight: 600;
        padding: 14px 22px;
        cursor: pointer;
        letter-spacing: 0.01em;
        transition: background 150ms ease, transform 150ms ease;
        box-shadow: 0 8px 24px rgba(255, 197, 61, 0.25);
      }
      .gate__btn:hover { background: #FFD463; }
      .gate__btn:active { transform: translateY(1px); }
      .gate__btn:focus-visible, .bar__btn:focus-visible, .gate__input:focus-visible {
        outline: 2px solid ${COLORS.paper}; outline-offset: 2px;
      }
      .gate__hint { font-size: 12px; color: ${COLORS.muted}; }
      .gate__note {
        margin-top: 22px;
        font-size: 12.5px; line-height: 1.55; color: ${COLORS.muted};
        border-left: 2px solid ${COLORS.line};
        padding-left: 12px;
      }
      /* --- ticket stub (right) --- */
      .gate__stub {
        position: relative;
        width: 128px; flex-shrink: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: space-between;
        padding: 26px 14px 22px;
        background:
          repeating-linear-gradient(45deg, rgba(255, 197, 61, 0.06) 0 8px, transparent 8px 16px),
          ${COLORS.raised};
        border-left: 2px dashed rgba(255, 197, 61, 0.35);
      }
      .gate__stamp {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; font-weight: 600;
        letter-spacing: 0.16em;
        color: ${COLORS.amber};
        border: 2px solid ${COLORS.amber};
        border-radius: 4px;
        padding: 8px 6px;
        text-align: center;
        transform: rotate(-6deg);
        line-height: 1.5;
        text-transform: uppercase;
        box-shadow: inset 0 0 0 1px rgba(255, 197, 61, 0.3);
      }
      .gate__stub-lines {
        width: 100%;
        height: 44px;
        background:
          repeating-linear-gradient(180deg, rgba(167, 159, 209, 0.35) 0 2px, transparent 2px 8px);
        -webkit-mask-image: linear-gradient(180deg, transparent, #000);
        mask-image: linear-gradient(180deg, transparent, #000);
      }
      /* --- amber caution stripe along the bottom edge --- */
      .gate__ticket-edge {
        position: absolute; left: 0; right: 0; bottom: 0; height: 8px;
        background: repeating-linear-gradient(45deg, ${COLORS.amber} 0 12px, ${COLORS.amberDeep} 12px 24px);
      }
      @media (max-width: 560px) {
        .gate__stub { display: none; }
        .gate__body { padding: 32px 24px 34px; }
        .gate__row { flex-direction: column; align-items: stretch; gap: 10px; }
        .gate__hint { display: none; }
      }`;
  }

  function bannerCss() {
    return `
      .bar {
        position: fixed; top: 0; left: 0; right: 0; z-index: ${Z};
        display: flex; align-items: center; gap: 14px;
        min-height: 56px;
        padding: 10px 14px;
        background:
          linear-gradient(180deg, rgba(255, 197, 61, 0.07), rgba(255, 197, 61, 0) 70%),
          ${COLORS.card};
        border-top: 4px solid ${COLORS.amber};
        box-shadow: 0 6px 28px rgba(0, 0, 0, 0.55);
        font-size: 14px;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        cursor: grab;
        animation: barFade 300ms ease;
        overflow: visible;
      }
      .bar--dragging { cursor: grabbing; box-shadow: 0 18px 56px rgba(0, 0, 0, 0.65); }
      @keyframes barFade { from { opacity: 0; } to { opacity: 1; } }
      /* One bright moment on entry, then it settles down. */
      .bar::after {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background: linear-gradient(90deg,
          rgba(255, 197, 61, 0.35) 0%, rgba(255, 197, 61, 0) 45%);
        animation: barFlash 3.5s ease-out forwards;
      }
      @keyframes barFlash {
        0% { opacity: 0.9; }
        60% { opacity: 0.35; }
        100% { opacity: 0; }
      }
      /* --- grip handle (drag affordance) --- */
      .bar__handle {
        align-self: stretch; width: 26px; flex-shrink: 0;
        border-radius: 4px;
        cursor: grab;
        background-image: radial-gradient(circle, rgba(255, 197, 61, 0.75) 1.5px, transparent 1.6px);
        background-size: 8px 8px;
        background-position: center;
        opacity: 0.85;
        transition: background-color 150ms ease, opacity 150ms ease;
      }
      .bar__handle:hover { background-color: rgba(255, 197, 61, 0.14); opacity: 1; }
      .bar--dragging .bar__handle { cursor: grabbing; }
      .bar__goal {
        display: flex; align-items: center; gap: 12px;
        flex: 1; min-width: 0;
      }
      .bar__label {
        display: inline-flex; align-items: center; gap: 7px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 600; letter-spacing: 0.16em;
        color: ${COLORS.ink};
        background: ${COLORS.amber};
        border-radius: 4px;
        padding: 5px 9px;
        flex-shrink: 0;
        box-shadow: 0 0 16px rgba(255, 197, 61, 0.45);
      }
      /* slow breathing status dot — visible, never flashing */
      .bar__label::after {
        content: ''; width: 7px; height: 7px; border-radius: 50%;
        background: ${COLORS.ink};
        animation: barPulse 3s ease-in-out infinite;
      }
      @keyframes barPulse {
        0%, 100% { opacity: 0.25; transform: scale(0.8); }
        50% { opacity: 1; transform: scale(1); }
      }
      .bar__text {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: ${COLORS.paper};
        font-size: 16px; font-weight: 600;
        letter-spacing: 0.01em;
      }
      .bar__timer {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px; font-weight: 600; color: ${COLORS.amber};
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
        border: 1px solid ${COLORS.line};
        border-radius: 4px;
        padding: 4px 8px;
        background: rgba(255, 197, 61, 0.08);
      }
      .bar__actions { display: flex; gap: 8px; flex-shrink: 0; }
      .bar__btn {
        border: none; border-radius: 5px;
        font-size: 13px; font-weight: 600;
        padding: 8px 13px; cursor: pointer;
        transition: background 150ms ease, color 150ms ease, transform 150ms ease;
      }
      .bar__btn--ghost {
        background: transparent; color: ${COLORS.paper};
        border: 1px solid rgba(167, 159, 209, 0.45);
      }
      .bar__btn--ghost:hover { background: rgba(167, 159, 209, 0.14); border-color: ${COLORS.muted}; }
      .bar__btn--done { background: ${COLORS.amber}; color: ${COLORS.ink}; }
      .bar__btn--done:hover { background: #FFD463; }
      .bar__chip {
        font-size: 13px; color: ${COLORS.amber};
        border: 1px solid ${COLORS.line}; border-radius: 5px;
        padding: 7px 11px;
      }
      @media (max-width: 600px) {
        .bar { flex-wrap: wrap; min-height: 50px; }
        .bar__timer { display: none; }
        .bar__handle { width: 20px; }
      }`;
  }
})();
