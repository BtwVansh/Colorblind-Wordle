/*
 * Colorblind Wordle: content script for https://www.nytimes.com/games/wordle/*
 *
 * What it does:
 *   - computes today's palette with CBWColorEngine (date + fixed seed only),
 *   - writes it to CSS custom properties on <html> (--cbw-absent, ...),
 *   - adds html.cbw-enabled so styles.css takes effect,
 *   - re-checks the local date on load, tab focus, visibility changes and at
 *     local midnight, and swaps the palette in place when the day changes,
 *   - watches the page with one MutationObserver so the palette survives
 *     anything that resets <html> and so date changes are caught as soon as
 *     new tiles are revealed,
 *   - detects when today's game is finished (won, or six guesses used) by
 *     reading the board, and records { completedDate } so the popup can
 *     reveal the palette,
 *   - shows a small welcome / "working" notice when Wordle opens.
 *
 * What it never does: change tile state, guesses, keyboard input, game
 * storage, statistics or streaks. Board reading is read-only and nothing
 * leaves the browser. It makes no network requests.
 */
(function () {
  'use strict';

  // The other content scripts attach their modules to the global scope. In
  // Firefox that scope (globalThis) is a sandbox and `window` is the page's
  // window behind an Xray wrapper, a different object, so window.CBW* would
  // be undefined there. Always read and write our own names on globalThis.
  var G = typeof globalThis !== 'undefined' ? globalThis : window;
  if (G.__cbwContentLoaded) return;
  G.__cbwContentLoaded = true;

  var Engine = G.CBWColorEngine;
  var Store = G.CBWStorage;
  var Game = G.CBWGameState;
  var Notice = G.CBWNotice;
  if (!Engine || !Store || !Game) return;

  var ENABLED_CLASS = 'cbw-enabled';
  var DATE_POLL_MS = 60 * 1000;
  var COMPLETION_CONFIRM_MS = 1200;
  var VAR_NAMES = {
    '--cbw-absent': 'absent',
    '--cbw-present': 'present',
    '--cbw-correct': 'correct',
    '--cbw-absent-text': 'absentText',
    '--cbw-present-text': 'presentText',
    '--cbw-correct-text': 'correctText'
  };
  var FEEDBACK_SELECTOR =
    '[data-testid="tile"][data-state="absent"],[data-testid="tile"][data-state="present"],[data-testid="tile"][data-state="correct"],' +
    'button[data-key][data-state]';

  var root = document.documentElement;
  var palette = null;
  var enabled = false;
  var midnightTimer = null;
  var pollTimer = null;
  var pendingCheck = false;
  // The puzzle on screen is the one for the date this page was loaded on.
  // A game finished after midnight without reloading is yesterday's puzzle
  // and must not unlock today's palette.
  var pageDate = Engine.localDateKey(new Date());
  var isDailyPage = Game.isDailyPuzzlePage(window.location);
  var completionRecordedFor = null;
  var completionTimer = null;
  var notifier = null;

  /* ---------------- palette ---------------- */

  /** Write the palette's colours to CSS variables, touching only changed values. */
  function writeVariables() {
    if (!palette) return;
    for (var name in VAR_NAMES) {
      var value = palette[VAR_NAMES[name]];
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }
  }

  function clearVariables() {
    for (var name in VAR_NAMES) {
      if (root.style.getPropertyValue(name)) root.style.removeProperty(name);
    }
  }

  /**
   * Recompute the palette if the local date has changed. Returns true when the
   * palette changed. Existing tiles and keys repaint automatically because
   * styles.css reads the variables.
   */
  function checkDate() {
    var today = Engine.localDateKey(new Date());
    if (palette && palette.date === today) return false;
    palette = Engine.getPaletteForDate(today);
    if (enabled) writeVariables();
    Store.cachePalette(palette);
    scheduleMidnight();
    return true;
  }

  function scheduleMidnight() {
    if (midnightTimer) clearTimeout(midnightTimer);
    // One second past midnight so the new local date is definitely in effect.
    midnightTimer = setTimeout(function () {
      midnightTimer = null;
      checkDate();
    }, Engine.msUntilNextLocalMidnight(new Date()) + 1000);
  }

  /* ---------------- enable / disable ---------------- */

  function setEnabled(next) {
    enabled = !!next;
    if (enabled) {
      writeVariables();
      if (!root.classList.contains(ENABLED_CLASS)) root.classList.add(ENABLED_CLASS);
    } else {
      if (root.classList.contains(ENABLED_CLASS)) root.classList.remove(ENABLED_CLASS);
      clearVariables();
    }
  }

  /** Put the root class and variables back if something on the page removed them. */
  function ensureApplied() {
    if (!enabled) return;
    if (!root.classList.contains(ENABLED_CLASS)) root.classList.add(ENABLED_CLASS);
    writeVariables();
  }

  /* ---------------- completion ---------------- */

  /**
   * If the board shows a finished game, confirm it is still finished a moment
   * later (so a transient render can't count) and record the completion for
   * today's date. Only the daily puzzle page counts, never the archive.
   */
  function checkCompletion() {
    if (!isDailyPage || completionTimer) return;
    var today = Engine.localDateKey(new Date());
    if (completionRecordedFor === today || pageDate !== today) return;
    var first = Game.readBoard(document);
    if (first.status !== 'win' && first.status !== 'loss') return;
    completionTimer = setTimeout(function () {
      completionTimer = null;
      var now = Engine.localDateKey(new Date());
      var again = Game.readBoard(document);
      if (again.status !== first.status || now !== pageDate) return;
      completionRecordedFor = now;
      Store.recordCompletion(now, again.status, again.evaluatedRows);
    }, COMPLETION_CONFIRM_MS);
  }

  /* ---------------- notice ---------------- */

  function whenDocumentReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function showStartupNotice(prefs) {
    if (!Notice) return;
    Store.getOnboarding().then(function (onboarding) {
      var now = Date.now();
      var kind = Notice.decide(prefs.enabled, onboarding, now);
      if (!kind) return;
      var update = { lastNoticeAt: now };
      if (kind === 'welcome') update.welcomedAt = now;
      Store.setOnboarding(update);
      whenDocumentReady(function () {
        notifier = notifier || Notice.createNotifier(document);
        notifier.show(kind, {
          onAction: function () {
            Store.setPrefs({ enabled: false }).then(function () {
              notifier.show('off');
            });
          }
        });
      });
    });
  }

  /* ---------------- observation ---------------- */

  function isFeedbackNode(node) {
    return node && node.nodeType === 1 && node.matches && node.matches(FEEDBACK_SELECTOR);
  }

  function containsFeedback(node) {
    if (!node || node.nodeType !== 1) return false;
    if (isFeedbackNode(node)) return true;
    return !!(node.querySelector && node.querySelector(FEEDBACK_SELECTOR));
  }

  /**
   * One observer for the whole page. It only reads mutations; the only writes
   * it can trigger are restoring our own class/variables when they are
   * missing, and those are skipped when already correct, so it cannot loop.
   * Work is batched into a single check per animation frame.
   */
  function onMutations(mutations) {
    var relevant = false;
    for (var i = 0; i < mutations.length && !relevant; i++) {
      var m = mutations[i];
      if (m.target === root && m.type === 'attributes') {
        relevant = true;
      } else if (m.type === 'attributes' && (m.attributeName === 'data-state' || m.attributeName === 'data-animation')) {
        relevant = isFeedbackNode(m.target);
      } else if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length && !relevant; j++) {
          relevant = containsFeedback(m.addedNodes[j]);
        }
      }
    }
    if (!relevant || pendingCheck) return;
    pendingCheck = true;
    var run = function () {
      pendingCheck = false;
      // A tile was just revealed: make sure it uses today's palette, even if the
      // computer slept through midnight and timers were delayed.
      checkDate();
      ensureApplied();
      checkCompletion();
    };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function startObserver() {
    var observer = new MutationObserver(onMutations);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state', 'data-animation', 'class', 'style']
    });
    return observer;
  }

  /* ---------------- date-change triggers ---------------- */

  function onBecameActive() {
    if (document.visibilityState !== 'hidden') {
      checkDate();
      ensureApplied();
      checkCompletion();
    }
  }

  function startDateWatch() {
    document.addEventListener('visibilitychange', onBecameActive);
    window.addEventListener('focus', onBecameActive);
    window.addEventListener('pageshow', onBecameActive);
    // Safety net for timers delayed by sleep or background throttling.
    pollTimer = setInterval(function () {
      if (document.visibilityState !== 'hidden') checkDate();
    }, DATE_POLL_MS);
    scheduleMidnight();
  }

  /* ---------------- start ---------------- */

  checkDate();
  startObserver();
  startDateWatch();

  Store.getPrefs().then(function (prefs) {
    setEnabled(prefs.enabled);
    showStartupNotice(prefs);
  });
  // A game that is already finished when the page loads (e.g. after a reload).
  whenDocumentReady(checkCompletion);
  Store.onPrefsChanged(function (prefs) {
    setEnabled(prefs.enabled);
  });

  /* ---------------- status for the popup ---------------- */

  // The popup asks the active Wordle tab whether the extension is really
  // running there. The reply never includes palette colours.
  var ext = (G.browser && G.browser.runtime) ? G.browser : (G.chrome && G.chrome.runtime ? G.chrome : null);
  if (ext && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'cbw:status') return undefined;
      var recoloured = enabled && root.classList.contains(ENABLED_CLASS)
        ? document.querySelectorAll(FEEDBACK_SELECTOR).length : 0;
      sendResponse({ running: true, enabled: enabled, date: palette ? palette.date : null, evaluatedElements: recoloured });
      return undefined;
    });
  }

  // Read-only hook for the automated integration test.
  G.CBWContent = Object.freeze({
    getState: function () {
      return { enabled: enabled, palette: palette, pageDate: pageDate, isDailyPage: isDailyPage, completionRecordedFor: completionRecordedFor };
    },
    getNotice: function () { return notifier ? notifier.state() : null; },
    pressNotice: function (which) { return notifier ? notifier.press(which) : false; },
    checkDate: checkDate
  });
})();
