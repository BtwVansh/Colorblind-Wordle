/*
 * Colorblind Wordle: popup.
 *
 * The daily palette is revealed only once today's Wordle is finished (won,
 * or six guesses used), as recorded by the content script in storage under
 * cbw.completion = { completedDate: "YYYY-MM-DD", ... }. Until then the popup
 * never computes or renders the palette: no swatches, hex codes or previews.
 */
(function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis : window;
  var Engine = G.CBWColorEngine;
  var Store = G.CBWStorage;

  var $ = function (id) { return document.getElementById(id); };
  var popup = document.querySelector('.popup');
  var enabledInput = $('enabled');
  var statusEl = $('status');
  var lockedEl = $('locked');
  var unlockedEl = $('unlocked');
  var paletteList = $('palette');
  var badge = $('preview-badge');
  var shuffleBtn = $('shuffle');
  var resetBtn = $('reset');

  var ROWS = [
    { state: 'absent', name: 'Incorrect', sub: 'Absent', letter: 'A' },
    { state: 'present', name: 'Wrong position', sub: 'Present', letter: 'P' },
    { state: 'correct', name: 'Correct', sub: 'Correct', letter: 'C' }
  ];

  var todayKey = Engine.localDateKey(new Date());
  var official = null; // computed only after unlocking
  var previewIndex = 0;
  var unlocked = false;

  function formatDate(dateKey) {
    var p = dateKey.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2], 12);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* ---------------- palette rendering (unlocked only) ---------------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function buildRows() {
    ROWS.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'swatch-row';
      li.dataset.state = row.state;

      var tile = document.createElement('span');
      tile.className = 'tile';
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = row.letter;

      var label = document.createElement('span');
      label.className = 'swatch-label';
      var name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = row.name;
      var sub = document.createElement('span');
      sub.className = 'swatch-sub';
      sub.textContent = row.sub;
      label.appendChild(name);
      label.appendChild(sub);

      var hex = document.createElement('code');
      hex.className = 'hex';

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy ' + row.sub.toLowerCase() + ' colour');
      copy.addEventListener('click', function () {
        copyText(copy.dataset.hex).then(function () {
          copy.textContent = 'Copied';
          copy.classList.add('done');
          setTimeout(function () {
            copy.textContent = 'Copy';
            copy.classList.remove('done');
          }, 1200);
        }, function () {
          statusEl.textContent = 'Could not copy. Select the code and copy it manually.';
        });
      });

      li.appendChild(tile);
      li.appendChild(label);
      li.appendChild(hex);
      li.appendChild(copy);
      paletteList.appendChild(li);
    });
  }

  function renderPalette(palette, isPreview) {
    ROWS.forEach(function (row) {
      var li = paletteList.querySelector('.swatch-row[data-state="' + row.state + '"]');
      var tile = li.querySelector('.tile');
      tile.style.backgroundColor = palette[row.state];
      tile.style.color = palette[row.state + 'Text'];
      li.querySelector('.hex').textContent = palette[row.state].toUpperCase();
      li.querySelector('.copy').dataset.hex = palette[row.state].toUpperCase();
    });
    $('metrics').textContent =
      'Closest pair ΔE2000 ' + palette.minDeltaE.toFixed(1) +
      ' · lowest letter contrast ' + palette.minContrast.toFixed(1) + ':1';
    $('palette-label').textContent = isPreview ? 'Preview palette' : "Today's palette";
    badge.hidden = !isPreview;
    resetBtn.hidden = !isPreview;
    paletteList.classList.toggle('is-preview', isPreview);
  }

  shuffleBtn.addEventListener('click', function () {
    if (!unlocked) return;
    previewIndex += 1;
    renderPalette(Engine.getPreviewPalette(todayKey, previewIndex), true);
  });

  resetBtn.addEventListener('click', function () {
    if (!unlocked) return;
    renderPalette(official, false);
  });

  /* ---------------- locked / unlocked ---------------- */

  function renderLockState(completion) {
    var isUnlocked = Store.isUnlockedFor(completion, todayKey);
    if (isUnlocked && !unlocked) {
      unlocked = true;
      official = Engine.getPaletteForDate(todayKey);
      buildRows();
      renderPalette(official, false);
      $('unlocked-text').textContent = completion.result === 'win'
        ? "You solved today's Wordle" + (completion.guesses ? ' in ' + completion.guesses + (completion.guesses === 1 ? ' guess' : ' guesses') : '') + '. Here are the colours used in your challenge.'
        : "You have completed today's Wordle. Here are the colours used in your challenge.";
    }
    lockedEl.hidden = unlocked;
    unlockedEl.hidden = !unlocked;
  }

  /* ---------------- activation status ---------------- */

  // The status line reports what is actually happening, not just the saved
  // setting: whether the browser lets the extension run on Wordle (Firefox
  // can withhold site access from MV3 extensions) and whether the content
  // script answered from the active Wordle tab.
  var WORDLE_MATCH = 'https://www.nytimes.com/games/wordle/*';
  var WORDLE_PREFIX = 'https://www.nytimes.com/games/wordle/';
  var EXT = (G.browser && G.browser.runtime) ? G.browser : G.chrome;
  var PROMISES = !!(G.browser && EXT === G.browser);
  var enabledPref = true;

  /** Call an extension API method with promise or callback style. Never rejects. */
  function callApi(namespace, method, arg) {
    return new Promise(function (resolve) {
      var api = EXT && EXT[namespace];
      if (!api || typeof api[method] !== 'function') return resolve({ unavailable: true });
      var finish = function (value) { resolve({ value: value }); };
      var fail = function (err) { resolve({ error: err || true }); };
      try {
        if (PROMISES) {
          api[method].apply(api, arg).then(finish, fail);
        } else {
          api[method].apply(api, arg.concat(function (value) {
            var err = EXT.runtime && EXT.runtime.lastError;
            err ? fail(err) : finish(value);
          }));
        }
      } catch (e) {
        fail(e);
      }
    });
  }

  function setStatus(level, text, showGrant) {
    $('activation').dataset.level = level;
    $('activation-text').textContent = text;
    $('grant').hidden = !showGrant;
  }

  function refreshStatus() {
    if (!enabledPref) {
      setStatus('off', 'Off · Wordle shows its original colours', false);
      return Promise.resolve('off');
    }
    return callApi('permissions', 'contains', [{ origins: [WORDLE_MATCH] }]).then(function (access) {
      if (access.value === false) {
        setStatus('warn', 'Needs permission to run on Wordle', true);
        return 'no-access';
      }
      return callApi('tabs', 'query', [{ active: true, currentWindow: true }]).then(function (q) {
        var tab = q.value && q.value[0];
        if (!tab || !tab.url || tab.url.indexOf(WORDLE_PREFIX) !== 0) {
          setStatus('ok', 'On · open Wordle to play', false);
          return 'on-elsewhere';
        }
        return callApi('tabs', 'sendMessage', [tab.id, { type: 'cbw:status' }]).then(function (reply) {
          if (reply.value && reply.value.running) {
            setStatus('ok', 'On · recolouring this Wordle tab', false);
            return 'running';
          }
          setStatus('warn', 'On · reload the Wordle tab to apply', false);
          return 'not-running';
        });
      });
    });
  }

  $('grant').addEventListener('click', function () {
    callApi('permissions', 'request', [{ origins: [WORDLE_MATCH] }]).then(function (res) {
      if (res.value === true) {
        setStatus('warn', 'Allowed · reload the Wordle tab to apply', false);
      } else {
        refreshStatus();
      }
    });
  });

  function renderEnabled(enabled) {
    enabledPref = enabled;
    enabledInput.checked = enabled;
    popup.classList.toggle('is-disabled', !enabled);
    refreshStatus();
  }

  enabledInput.addEventListener('change', function () {
    var next = enabledInput.checked;
    renderEnabled(next);
    Store.setPrefs({ enabled: next });
  });

  /* ---------------- start ---------------- */

  $('today').textContent = formatDate(todayKey);
  $('next').textContent = formatDate(Engine.nextDateKey(todayKey)) + ', midnight';

  Store.getPrefs().then(function (prefs) { renderEnabled(prefs.enabled); });
  Store.onPrefsChanged(function (prefs) { renderEnabled(prefs.enabled); });
  Store.getCompletion().then(renderLockState);
  // Unlock live if the game is finished while the popup is open.
  Store.onCompletionChanged(renderLockState);

  // Read-only hook for the automated browser tests.
  G.CBWPopup = Object.freeze({ refreshStatus: refreshStatus });
})();
