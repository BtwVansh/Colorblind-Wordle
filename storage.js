/*
 * Colorblind Wordle: storage wrapper over browser.storage.local / chrome.storage.local.
 *
 * Storage holds:
 *   - preferences (currently just `enabled`)
 *   - a cache of today's palette
 *   - completion: { completedDate: "YYYY-MM-DD", result: "win" | "loss" }, the
 *     last local date on which today's Wordle was finished. The popup reveals
 *     the palette only when completedDate equals today's date, so a new day
 *     always starts locked.
 *   - onboarding: { welcomedAt, lastNoticeAt }, used to show the in-page
 *     welcome once per installation and to rate-limit the "working" notice.
 *
 * The palette cache is write-through only. The colour engine always computes
 * the palette from the date and the fixed seed; the cache is never used as the
 * source of a palette, so clearing or editing storage cannot change colours.
 * The cache exists so a repeated visit on the same day skips a storage write
 * and so the stored record (date, colours, version) can be inspected.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CBWStorage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PREFS_KEY = 'cbw.prefs';
  var PALETTE_KEY = 'cbw.palette';
  var COMPLETION_KEY = 'cbw.completion';
  var ONBOARDING_KEY = 'cbw.onboarding';
  var DEFAULT_PREFS = Object.freeze({ enabled: true });
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function normaliseCompletion(raw) {
    if (!raw || typeof raw.completedDate !== 'string' || !DATE_RE.test(raw.completedDate)) return null;
    if (raw.result !== 'win' && raw.result !== 'loss') return null;
    return { completedDate: raw.completedDate, result: raw.result, guesses: typeof raw.guesses === 'number' ? raw.guesses : null };
  }

  /** True only if `completion` records a finished game for exactly `dateKey`. */
  function isUnlockedFor(completion, dateKey) {
    var c = normaliseCompletion(completion);
    return !!c && c.completedDate === dateKey;
  }

  function normaliseOnboarding(raw) {
    return {
      welcomedAt: raw && typeof raw.welcomedAt === 'number' ? raw.welcomedAt : null,
      lastNoticeAt: raw && typeof raw.lastNoticeAt === 'number' ? raw.lastNoticeAt : null
    };
  }

  /**
   * Resolve the extension API. Firefox exposes the promise-based `browser`
   * namespace, which rejects a trailing callback argument as a schema error,
   * so it must be called promise-style. Chrome's `chrome` namespace is called
   * with callbacks (supported by every Chrome version).
   */
  function resolveApi(override, options) {
    if (override) return { ext: override, promises: !!(options && options.promises) };
    if (typeof browser !== 'undefined' && browser && browser.storage) return { ext: browser, promises: true };
    if (typeof chrome !== 'undefined' && chrome && chrome.storage) return { ext: chrome, promises: false };
    return { ext: null, promises: false };
  }

  function createStorage(apiOverride, options) {
    var resolved = resolveApi(apiOverride, options);
    var ext = resolved.ext;
    var promises = resolved.promises;
    var area = ext && ext.storage && ext.storage.local;

    function lastError() {
      return ext && ext.runtime && ext.runtime.lastError;
    }

    function get(key) {
      if (!area) return Promise.resolve(undefined);
      return new Promise(function (resolve) {
        var done = function (items) { resolve(items ? items[key] : undefined); };
        try {
          if (promises) {
            area.get(key).then(done, function () { resolve(undefined); });
          } else {
            var maybe = area.get(key, function (items) { done(lastError() ? undefined : items); });
            if (maybe && typeof maybe.then === 'function') maybe.then(done, function () { resolve(undefined); });
          }
        } catch (e) {
          resolve(undefined);
        }
      });
    }

    function set(key, value) {
      if (!area) return Promise.resolve();
      var items = {};
      items[key] = value;
      return new Promise(function (resolve) {
        try {
          if (promises) {
            area.set(items).then(function () { resolve(); }, function () { resolve(); });
          } else {
            var maybe = area.set(items, function () { lastError(); resolve(); });
            if (maybe && typeof maybe.then === 'function') maybe.then(function () { resolve(); }, function () { resolve(); });
          }
        } catch (e) {
          resolve();
        }
      });
    }

    function normalisePrefs(raw) {
      var prefs = { enabled: DEFAULT_PREFS.enabled };
      if (raw && typeof raw.enabled === 'boolean') prefs.enabled = raw.enabled;
      return prefs;
    }

    function samePalette(a, b) {
      if (!a || !b) return false;
      return a.date === b.date && a.version === b.version &&
        a.absent === b.absent && a.present === b.present && a.correct === b.correct &&
        a.absentText === b.absentText && a.presentText === b.presentText && a.correctText === b.correctText;
    }

    return {
      PREFS_KEY: PREFS_KEY,
      PALETTE_KEY: PALETTE_KEY,
      COMPLETION_KEY: COMPLETION_KEY,
      ONBOARDING_KEY: ONBOARDING_KEY,
      isUnlockedFor: isUnlockedFor,

      /** The stored completion record (normalised), or null. */
      getCompletion: function () {
        return get(COMPLETION_KEY).then(normaliseCompletion);
      },

      /**
       * Record that the Wordle for `dateKey` was finished. Writes once per
       * date: a later write for the same date (e.g. a reload of a finished
       * game) is skipped. Resolves to true if a write happened.
       */
      recordCompletion: function (dateKey, result, guesses) {
        if (!DATE_RE.test(dateKey) || (result !== 'win' && result !== 'loss')) return Promise.resolve(false);
        return get(COMPLETION_KEY).then(function (raw) {
          var existing = normaliseCompletion(raw);
          if (existing && existing.completedDate === dateKey) return false;
          return set(COMPLETION_KEY, { completedDate: dateKey, result: result, guesses: guesses, completedAt: Date.now() })
            .then(function () { return true; });
        });
      },

      getOnboarding: function () {
        return get(ONBOARDING_KEY).then(normaliseOnboarding);
      },

      setOnboarding: function (partial) {
        return get(ONBOARDING_KEY).then(function (raw) {
          var next = normaliseOnboarding(raw);
          if (partial && typeof partial.welcomedAt === 'number') next.welcomedAt = partial.welcomedAt;
          if (partial && typeof partial.lastNoticeAt === 'number') next.lastNoticeAt = partial.lastNoticeAt;
          return set(ONBOARDING_KEY, next).then(function () { return next; });
        });
      },

      /** Subscribe to completion changes (e.g. the popup unlocking live). */
      onCompletionChanged: function (callback) {
        if (!ext || !ext.storage || !ext.storage.onChanged) return function () {};
        var listener = function (changes, areaName) {
          if (areaName !== 'local' || !changes[COMPLETION_KEY]) return;
          callback(normaliseCompletion(changes[COMPLETION_KEY].newValue));
        };
        ext.storage.onChanged.addListener(listener);
        return function () { ext.storage.onChanged.removeListener(listener); };
      },

      getPrefs: function () {
        return get(PREFS_KEY).then(normalisePrefs);
      },

      setPrefs: function (partial) {
        return get(PREFS_KEY).then(function (raw) {
          var next = normalisePrefs(raw);
          if (partial && typeof partial.enabled === 'boolean') next.enabled = partial.enabled;
          return set(PREFS_KEY, next).then(function () { return next; });
        });
      },

      /** Read the cached record (informational only; never a palette source). */
      getCachedPalette: function () {
        return get(PALETTE_KEY);
      },

      /**
       * Store a freshly computed palette. Skips the write if the cache already
       * holds the identical record. Resolves to true if a write happened.
       */
      cachePalette: function (palette) {
        var record = {
          date: palette.date,
          version: palette.version,
          absent: palette.absent,
          present: palette.present,
          correct: palette.correct,
          absentText: palette.absentText,
          presentText: palette.presentText,
          correctText: palette.correctText,
          cachedAt: new Date().toISOString()
        };
        return get(PALETTE_KEY).then(function (existing) {
          if (samePalette(existing, record)) return false;
          return set(PALETTE_KEY, record).then(function () { return true; });
        });
      },

      /** Subscribe to preference changes made elsewhere (e.g. the popup). */
      onPrefsChanged: function (callback) {
        if (!ext || !ext.storage || !ext.storage.onChanged) return function () {};
        var listener = function (changes, areaName) {
          if (areaName !== 'local' || !changes[PREFS_KEY]) return;
          callback(normalisePrefs(changes[PREFS_KEY].newValue));
        };
        ext.storage.onChanged.addListener(listener);
        return function () { ext.storage.onChanged.removeListener(listener); };
      }
    };
  }

  var defaultStorage = createStorage();
  defaultStorage.createStorage = createStorage;
  defaultStorage.DEFAULT_PREFS = DEFAULT_PREFS;
  defaultStorage.isUnlockedFor = isUnlockedFor;
  return defaultStorage;
});
