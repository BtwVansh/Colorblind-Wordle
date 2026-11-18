/*
 * Colorblind Wordle: small in-page notification shown when Wordle opens.
 *
 *   - First activation per installation: a welcome message.
 *   - Later visits: a short "working" message with a Turn off button, shown
 *     at most once per NOTICE_COOLDOWN_MS so refreshes don't repeat it.
 *
 * The notification lives in a closed shadow root attached to <html>, so
 * Wordle's styles can't affect it and it can't affect Wordle. It never takes
 * keyboard focus by itself, never contains palette colours, auto-dismisses
 * after a few seconds (pausing while hovered or focused) and can be closed.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CBWNotice = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
  var DURATION_MS = { welcome: 8000, working: 5000, off: 4500 };

  var CONTENT = {
    welcome: {
      title: 'Welcome to Colorblind Wordle!',
      lines: ['Your extension has been successfully loaded.', "Today's Wordle will have a different colour palette. Good luck!"],
      action: null
    },
    working: {
      title: 'Colorblind Wordle is working!',
      lines: ["It's on. Enjoy today's challenge."],
      action: 'Turn off'
    },
    off: {
      title: 'Colorblind Wordle is off',
      lines: ["Wordle's original colours are back. Turn it on again from the extension's toolbar button."],
      action: null
    }
  };

  /**
   * Decide which notice to show. Pure, so it is unit-tested directly.
   * Returns 'welcome', 'working' or null.
   */
  function decide(enabled, onboarding, now) {
    if (!enabled) return null;
    if (!onboarding || onboarding.welcomedAt == null) return 'welcome';
    var last = onboarding.lastNoticeAt;
    if (last == null || now - last >= NOTICE_COOLDOWN_MS || now < last) return 'working';
    return null;
  }

  var CSS = [
    ':host { all: initial; }',
    '.wrap { position: fixed; top: 16px; right: 16px; z-index: 2147483000; width: 320px; max-width: calc(100vw - 32px);',
    '  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }',
    '@media (max-width: 480px) { .wrap { top: 12px; left: 12px; right: 12px; width: auto; max-width: none; } }',
    '.card { display: flex; gap: 10px; align-items: flex-start; padding: 12px 12px 12px 14px; border-radius: 12px;',
    '  background: #1c1c1e; color: #f0f0f2; border: 1px solid #303033; box-shadow: 0 8px 24px rgba(0,0,0,.28);',
    '  opacity: 0; transform: translateY(-6px); transition: opacity 160ms ease, transform 160ms ease; }',
    '.card.shown { opacity: 1; transform: none; }',
    '@media (prefers-reduced-motion: reduce) { .card { transition: none; transform: none; } }',
    '.badge { flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; background: #2ea043; }',
    '.badge.neutral { background: #48484c; }',
    '.badge svg { width: 12px; height: 12px; }',
    '.body { flex: 1; min-width: 0; }',
    '.title { margin: 0; font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }',
    '.line { margin: 2px 0 0; color: #b4b4ba; }',
    '.actions { margin-top: 8px; }',
    'button { font: inherit; cursor: pointer; color: inherit; }',
    'button:focus-visible { outline: 2px solid #3b6ee8; outline-offset: 2px; }',
    '.action { font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px; border: 1px solid #48484c; background: #2a2a2d; }',
    '.action:hover { background: #333337; }',
    '.close { flex: none; width: 24px; height: 24px; margin: -4px -4px 0 0; border: 0; border-radius: 6px; background: transparent;',
    '  color: #9a9aa0; display: grid; place-items: center; }',
    '.close:hover { background: #2a2a2d; color: #f0f0f2; }',
    '.close svg { width: 12px; height: 12px; }'
  ].join('\n');

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgIcon(doc, pathD, strokeWidth) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    var path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', strokeWidth);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  /**
   * Create a notifier bound to a document. `show(kind, { onAction })` replaces
   * any visible notice. Returns an object for tests and the content script.
   */
  function createNotifier(doc, timers) {
    // Wrap the globals: calling window.setTimeout as a method of another
    // object throws "Illegal invocation" in browsers.
    var t = timers || {
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimeout: function (id) { clearTimeout(id); }
    };
    var host = null;
    var shadow = null;
    var current = null; // { kind, card, timer, remaining, startedAt }

    function ensureHost() {
      if (host && host.isConnected) return;
      host = doc.createElement('cbw-notice');
      shadow = host.attachShadow({ mode: 'closed' });
      var style = doc.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      (doc.documentElement || doc.body).appendChild(host);
    }

    function dismiss() {
      if (!current) return;
      var c = current;
      current = null;
      t.clearTimeout(c.timer);
      c.card.classList.remove('shown');
      t.setTimeout(function () { if (c.wrap.parentNode) c.wrap.parentNode.removeChild(c.wrap); }, 200);
    }

    function startTimer(ms) {
      if (!current) return;
      t.clearTimeout(current.timer);
      current.remaining = ms;
      current.startedAt = Date.now();
      current.timer = t.setTimeout(dismiss, ms);
    }

    function pause() {
      if (!current || current.paused) return;
      current.paused = true;
      t.clearTimeout(current.timer);
      current.remaining = Math.max(1500, current.remaining - (Date.now() - current.startedAt));
    }

    function resume() {
      if (!current || !current.paused) return;
      current.paused = false;
      startTimer(current.remaining);
    }

    function show(kind, options) {
      var content = CONTENT[kind];
      if (!content) return null;
      dismiss();
      ensureHost();

      var wrap = el(doc, 'div', 'wrap');
      var card = el(doc, 'div', 'card');
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');

      var badge = el(doc, 'span', 'badge' + (kind === 'off' ? ' neutral' : ''));
      badge.appendChild(svgIcon(doc, kind === 'off' ? 'M3 6h6' : 'M2.5 6.2 5 8.6 9.5 3.6', '1.8'));
      card.appendChild(badge);

      var body = el(doc, 'div', 'body');
      body.appendChild(el(doc, 'p', 'title', content.title));
      content.lines.forEach(function (line) { body.appendChild(el(doc, 'p', 'line', line)); });
      var actionButton = null;
      if (content.action) {
        var actions = el(doc, 'div', 'actions');
        actionButton = el(doc, 'button', 'action', content.action);
        actionButton.type = 'button';
        actionButton.addEventListener('click', function (ev) {
          ev.stopPropagation();
          actionButton.blur(); // never keep focus, so Enter keeps submitting guesses
          if (options && options.onAction) options.onAction();
        });
        actions.appendChild(actionButton);
        body.appendChild(actions);
      }
      card.appendChild(body);

      var close = el(doc, 'button', 'close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dismiss');
      close.appendChild(svgIcon(doc, 'M3 3l6 6M9 3 3 9', '1.6'));
      close.addEventListener('click', function (ev) {
        ev.stopPropagation();
        close.blur();
        dismiss();
      });
      card.appendChild(close);

      card.addEventListener('mouseenter', pause);
      card.addEventListener('mouseleave', resume);
      card.addEventListener('focusin', pause);
      card.addEventListener('focusout', resume);

      wrap.appendChild(card);
      shadow.appendChild(wrap);
      current = { kind: kind, card: card, wrap: wrap, timer: null, remaining: 0, startedAt: 0, paused: false };
      // Next frame, so the entry transition runs.
      t.setTimeout(function () { card.classList.add('shown'); }, 16);
      startTimer(DURATION_MS[kind]);
      return current;
    }

    return {
      show: show,
      dismiss: dismiss,
      /** For tests: what is on screen right now. */
      state: function () {
        if (!current) return null;
        var title = current.card.querySelector('.title');
        var action = current.card.querySelector('.action');
        return { kind: current.kind, title: title && title.textContent, action: action && action.textContent };
      },
      /** For tests: press the notice's action button or close button. */
      press: function (which) {
        if (!current) return false;
        var btn = current.card.querySelector(which === 'close' ? '.close' : '.action');
        if (!btn) return false;
        btn.click();
        return true;
      }
    };
  }

  return Object.freeze({
    NOTICE_COOLDOWN_MS: NOTICE_COOLDOWN_MS,
    DURATION_MS: DURATION_MS,
    CONTENT: CONTENT,
    decide: decide,
    createNotifier: createNotifier
  });
});
