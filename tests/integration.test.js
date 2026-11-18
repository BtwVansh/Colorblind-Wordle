'use strict';
// Integration tests: the content scripts (color-engine, storage, game-state,
// notice, content) running together against a simulated page, Wordle board,
// extension storage and clock. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CONTENT_SCRIPTS = JSON.parse(read('manifest.json')).content_scripts[0].js;
const SOURCES = CONTENT_SCRIPTS.map((f) => [f, read(f)]);
const Engine = require(path.join(ROOT, 'color-engine.js'));
const GameState = require(path.join(ROOT, 'game-state.js'));
const Notice = require(path.join(ROOT, 'notice.js'));

/* ---------------- fakes ---------------- */

function createExtensionStorage(style, initial) {
  const data = Object.assign({}, initial || {});
  const listeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // style 'firefox' behaves like Firefox's browser.* namespace: promise-only,
  // and passing a callback is a schema error thrown synchronously.
  const rejectCallback = (name, args) => {
    if (style === 'firefox' && args.length > 1) throw new Error('Incorrect argument types for storage.local.' + name + '.');
  };
  const promiseStyle = style === 'promise' || style === 'firefox';
  const local = {
    writes: 0,
    get(key, cb) {
      rejectCallback('get', arguments);
      const out = {};
      if (key in data) out[key] = clone(data[key]);
      if (promiseStyle) return Promise.resolve(out);
      setTimeout(() => cb(out), 0);
    },
    set(items, cb) {
      rejectCallback('set', arguments);
      local.writes++;
      const changes = {};
      for (const k of Object.keys(items)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(items[k]) };
        data[k] = clone(items[k]);
      }
      setTimeout(() => listeners.forEach((l) => l(changes, 'local')), 0);
      if (promiseStyle) return Promise.resolve();
      setTimeout(() => cb && cb(), 0);
    },
    clear() { for (const k of Object.keys(data)) delete data[k]; }
  };
  return {
    data,
    api: {
      storage: {
        local,
        onChanged: {
          addListener: (l) => listeners.push(l),
          removeListener: (l) => listeners.splice(listeners.indexOf(l), 1)
        }
      }
    }
  };
}

/** Minimal DOM element: enough for the notice renderer. */
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.isConnected = true;
    const self = this;
    this.classList = {
      add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c)
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  attachShadow() { this.shadow = new FakeEl('#shadow-root'); return this.shadow; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
  blur() {}
  matches() { return false; }
  /** Supports ".class" selectors only. */
  querySelector(sel) {
    const cls = sel.slice(1);
    for (const c of this.children) {
      if (c.classList && c.classList.contains(cls)) return c;
      const found = c.querySelector && c.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  allText() { return [this.textContent, ...this.children.map((c) => (c.allText ? c.allText() : ''))].join(' '); }
}

/**
 * A fake Wordle board. `rows` is up to six strings of tile states, one char per
 * tile: a=absent p=present c=correct t=tbd .=empty, with an optional "~"
 * suffix meaning the row is still mid-flip (data-animation="flip-in").
 */
function createBoard(rows) {
  const board = { rows: [] };
  board.set = (spec) => {
    board.rows = [];
    for (let r = 0; r < 6; r++) {
      const row = (spec[r] || '.....');
      const flipping = row.endsWith('~');
      const tiles = row.replace('~', '').split('').map((ch) => {
        const state = { a: 'absent', p: 'present', c: 'correct', t: 'tbd', '.': 'empty' }[ch];
        const anim = flipping ? 'flip-in' : 'idle';
        return { getAttribute: (k) => (k === 'data-state' ? state : k === 'data-animation' ? anim : null) };
      });
      board.rows.push({ querySelectorAll: (sel) => (sel === '[data-testid="tile"]' ? tiles : []) });
    }
  };
  board.querySelectorAll = (sel) => (sel === '[role="group"][aria-label^="Row"]' ? board.rows : []);
  board.set(rows || []);
  return board;
}

function createRootElement() {
  const classes = new Set();
  const props = new Map();
  const counters = { styleWrites: 0, classWrites: 0 };
  return {
    counters,
    nodeType: 1,
    classList: {
      add: (c) => { counters.classWrites++; classes.add(c); },
      remove: (c) => { counters.classWrites++; classes.delete(c); },
      contains: (c) => classes.has(c),
      _set: classes
    },
    style: {
      getPropertyValue: (n) => props.get(n) || '',
      setProperty: (n, v) => { counters.styleWrites++; props.set(n, v); },
      removeProperty: (n) => { counters.styleWrites++; props.delete(n); },
      _props: props
    },
    matches: () => false,
    querySelector: () => null,
    children: [],
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  };
}

/**
 * Boot the content script in an isolated realm that mimics a Wordle tab.
 * `clock.now` is the simulated current time (ms) and can be moved forward.
 */
function bootPage({ clock, storage, browserStyle = 'callback', board = null, path: pagePath = '/games/wordle/index.html' }) {
  const root = createRootElement();
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const network = [];
  let observerCallback = null;

  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }

  const guardThis = (self) => { if (self !== undefined && self !== sandbox) throw new TypeError('Illegal invocation'); };
  const sandbox = {
    console,
    Date: FakeDate,
    Promise,
    // Like browsers, these throw "Illegal invocation" when called as a method
    // of another object (e.g. obj.setTimeout = setTimeout; obj.setTimeout()).
    setTimeout: function (fn, ms) { guardThis(this); const t = { fn, at: clock.now + (ms || 0), kind: 'timeout', done: false }; timers.push(t); return t; },
    clearTimeout: function (t) { guardThis(this); if (t) t.done = true; },
    setInterval: function (fn, ms) { guardThis(this); const t = { fn, every: ms, at: clock.now + ms, kind: 'interval', done: false }; timers.push(t); return t; },
    clearInterval: function (t) { guardThis(this); if (t) t.done = true; },
    requestAnimationFrame: (fn) => sandbox.setTimeout(fn, 0),
    MutationObserver: class {
      constructor(cb) { observerCallback = cb; }
      observe() {}
      disconnect() {}
    },
    fetch: (...a) => { network.push(['fetch', a]); return Promise.reject(new Error('blocked')); },
    XMLHttpRequest: function () { network.push(['xhr']); },
    WebSocket: function () { network.push(['ws']); },
    navigator: { sendBeacon: (...a) => { network.push(['beacon', a]); return false; } },
    location: { hostname: 'www.nytimes.com', pathname: pagePath },
    document: {
      documentElement: root,
      visibilityState: 'visible',
      readyState: 'complete',
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
      querySelector: (sel) => (sel === GameState.BOARD_SELECTOR ? board : null),
      createElement: (tag) => new FakeEl(tag),
      createElementNS: (ns, tag) => new FakeEl(tag)
    },
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); }
  };
  sandbox.globalThis = sandbox;
  if (browserStyle === 'firefox') {
    // Firefox content scripts: the global scope is a sandbox, and `window` is
    // the page's window seen through an Xray wrapper, a *different* object.
    // Properties set on globalThis are not visible as window.<name>.
    sandbox.window = {
      location: sandbox.location,
      document: sandbox.document,
      addEventListener: sandbox.addEventListener
    };
    sandbox.browser = storage.api;
    sandbox.chrome = storage.api;
  } else {
    sandbox.window = sandbox;
  }
  if (browserStyle === 'promise') sandbox.browser = storage.api;
  else sandbox.chrome = storage.api;

  // Storage callbacks use the host's real setTimeout so promises settle.
  vm.createContext(sandbox);
  for (const [file, src] of SOURCES) vm.runInContext(src, sandbox, { filename: file });

  return {
    root,
    sandbox,
    network,
    state: () => sandbox.CBWContent.getState(),
    vars: () => Object.fromEntries(root.style._props),
    enabledClass: () => root.classList.contains('cbw-enabled'),
    /** Run simulated timers that are due at the current simulated time. */
    runDueTimers() {
      for (const t of timers.slice()) {
        if (t.done || t.at > clock.now) continue;
        if (t.kind === 'interval') t.at = clock.now + t.every; else t.done = true;
        t.fn();
      }
    },
    fire(target, type) {
      const map = target === 'document' ? docListeners : winListeners;
      (map[type] || []).forEach((fn) => fn({ type }));
    },
    mutate(records) { observerCallback(records); },
    notice: () => sandbox.CBWContent.getNotice(),
    pressNotice: (which) => sandbox.CBWContent.pressNotice(which),
    /** Advance the simulated clock and run every timer that becomes due. */
    advance(ms) { clock.now += ms; this.runDueTimers(); },
    /** Simulate Wordle revealing tiles: update the board and notify the observer. */
    reveal(spec) {
      if (board) board.set(spec);
      const tile = { nodeType: 1, matches: (sel) => sel.includes('data-testid="tile"') };
      observerCallback([{ type: 'attributes', attributeName: 'data-animation', target: tile }]);
      this.runDueTimers();
    }
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

function expectedVars(dateKey) {
  const p = Engine.getPaletteForDate(dateKey);
  return {
    '--cbw-absent': p.absent,
    '--cbw-present': p.present,
    '--cbw-correct': p.correct,
    '--cbw-absent-text': p.absentText,
    '--cbw-present-text': p.presentText,
    '--cbw-correct-text': p.correctText
  };
}

/* ---------------- content script behaviour ---------------- */

test('on load: palette applied to CSS variables and enabled class added', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  assert.equal(page.enabledClass(), true);
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
  assert.equal(page.state().palette.date, '2026-11-18');
});

test('palette is cached with date, colours, text colours and version', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  bootPage({ clock, storage });
  await settle();
  const rec = storage.data['cbw.palette'];
  const p = Engine.getPaletteForDate('2026-11-18');
  assert.equal(rec.date, '2026-11-18');
  assert.equal(rec.version, Engine.GENERATOR_VERSION);
  for (const k of ['absent', 'present', 'correct', 'absentText', 'presentText', 'correctText']) assert.equal(rec[k], p[k]);
});

test('refresh / browser restart on the same day keeps the identical palette and skips rewriting the cache', async () => {
  const clock = { now: at(2026, 11, 18, 8) };
  const storage = createExtensionStorage('callback');
  const first = bootPage({ clock, storage });
  await settle();
  const cachedAt = storage.data['cbw.palette'].cachedAt;
  clock.now = at(2026, 11, 18, 22);
  const second = bootPage({ clock, storage });
  await settle();
  assert.deepEqual(second.vars(), first.vars());
  assert.equal(storage.data['cbw.palette'].cachedAt, cachedAt, 'unchanged palette cache must not be rewritten');
});

test('clearing storage does not change the palette', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  const before = bootPage({ clock, storage });
  await settle();
  storage.api.storage.local.clear();
  const after = bootPage({ clock, storage });
  await settle();
  assert.deepEqual(after.vars(), before.vars());
});

test('a tampered cache never influences the palette', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback', {
    'cbw.palette': { date: '2026-11-18', version: 1, absent: '#000001', present: '#000002', correct: '#000003',
      absentText: '#ffffff', presentText: '#ffffff', correctText: '#ffffff' }
  });
  const page = bootPage({ clock, storage });
  await settle();
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
  assert.equal(storage.data['cbw.palette'].absent, Engine.getPaletteForDate('2026-11-18').absent, 'cache corrected');
});

test('date change while the page stays open: midnight timer swaps the palette without reload', async () => {
  const clock = { now: at(2026, 11, 18, 23, 59) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
  clock.now = at(2026, 11, 19, 0, 0) + 1500; // just past midnight
  page.runDueTimers();
  await settle();
  assert.deepEqual(page.vars(), expectedVars('2026-11-19'));
  assert.notDeepEqual(expectedVars('2026-11-19'), expectedVars('2026-11-18'));
  assert.equal(storage.data['cbw.palette'].date, '2026-11-19');
});

test('date change is detected when the tab becomes visible or focused again', async () => {
  for (const [target, type] of [['document', 'visibilitychange'], ['window', 'focus'], ['window', 'pageshow']]) {
    const clock = { now: at(2026, 11, 18, 20) };
    const storage = createExtensionStorage('callback');
    const page = bootPage({ clock, storage });
    await settle();
    clock.now = at(2026, 11, 20, 10); // computer slept for a day and a half; no timers ran
    page.fire(target, type);
    assert.deepEqual(page.vars(), expectedVars('2026-11-20'), type);
  }
});

test('date change is detected when a new tile is revealed', async () => {
  const clock = { now: at(2026, 11, 18, 23) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  clock.now = at(2026, 11, 19, 1);
  const tile = { nodeType: 1, matches: (sel) => sel.includes('data-testid="tile"') };
  page.mutate([{ type: 'attributes', attributeName: 'data-state', target: tile }]);
  page.runDueTimers(); // the observer batches work into the next frame
  assert.deepEqual(page.vars(), expectedVars('2026-11-19'));
});

test('disabling restores the original look; re-enabling restores the palette', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  await page.sandbox.CBWStorage.setPrefs({ enabled: false });
  await settle();
  assert.equal(page.enabledClass(), false);
  assert.deepEqual(page.vars(), {}, 'all --cbw-* variables removed');
  await page.sandbox.CBWStorage.setPrefs({ enabled: true });
  await settle();
  assert.equal(page.enabledClass(), true);
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
});

test('starts disabled when the saved preference is off', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback', { 'cbw.prefs': { enabled: false } });
  const page = bootPage({ clock, storage });
  await settle();
  assert.equal(page.enabledClass(), false);
  assert.deepEqual(page.vars(), {});
});

test('observer restores the class if the page strips it, and makes no writes when nothing is wrong', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  const before = { ...page.root.counters };
  // A mutation on <html> while everything is already correct: zero writes (no feedback loop).
  page.mutate([{ type: 'attributes', attributeName: 'class', target: page.root }]);
  page.runDueTimers();
  assert.deepEqual(page.root.counters, before);
  // The page removes our class: it is put back exactly once.
  page.root.classList._set.delete('cbw-enabled');
  page.mutate([{ type: 'attributes', attributeName: 'class', target: page.root }]);
  page.runDueTimers();
  assert.equal(page.enabledClass(), true);
  assert.equal(page.root.counters.classWrites, before.classWrites + 1);
});

test('irrelevant mutations (e.g. tooltips using data-state="open") are ignored', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  const before = { ...page.root.counters };
  const tooltip = { nodeType: 1, matches: () => false, querySelector: () => null };
  page.mutate([
    { type: 'attributes', attributeName: 'data-state', target: tooltip },
    { type: 'childList', addedNodes: [tooltip, { nodeType: 3 }], target: tooltip }
  ]);
  page.runDueTimers();
  assert.deepEqual(page.root.counters, before);
});

test('works with the Firefox promise-based `browser` API', async () => {
  const clock = { now: at(2026, 11, 18) };
  const storage = createExtensionStorage('promise');
  const page = bootPage({ clock, storage, browserStyle: 'promise' });
  await settle();
  assert.equal(page.enabledClass(), true);
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
  assert.equal(storage.data['cbw.palette'].date, '2026-11-18');
});

test('simulated users in Chrome-style and Firefox-style installs see identical colours', async () => {
  const clock = { now: at(2026, 11, 18, 12) };
  const a = bootPage({ clock, storage: createExtensionStorage('callback'), browserStyle: 'callback' });
  const b = bootPage({ clock, storage: createExtensionStorage('promise', { 'cbw.palette': { junk: true } }), browserStyle: 'promise' });
  await settle();
  assert.deepEqual(a.vars(), b.vars());
});

test('no network requests are made', async () => {
  const clock = { now: at(2026, 11, 18, 23, 59) };
  const page = bootPage({ clock, storage: createExtensionStorage('callback') });
  await settle();
  clock.now = at(2026, 11, 19, 0, 1);
  page.runDueTimers();
  page.fire('document', 'visibilitychange');
  await settle();
  assert.deepEqual(page.network, []);
});

/* ---------------- static checks ---------------- */

test('source never contacts the network or touches game state', () => {
  const files = ['color-engine.js', 'storage.js', 'game-state.js', 'notice.js', 'content.js', 'popup/popup.js', 'popup/popup.html', 'styles.css', 'popup/popup.css'];
  // The only URLs allowed: the GitHub link (a normal link the user clicks, not
  // a request) and the SVG XML namespace identifier (not fetched).
  // The Wordle address appears only as a match pattern / URL prefix that the
  // popup compares the active tab's URL against; it is never fetched.
  const ALLOWED = ['https://github.com/BtwVansh/Colorblind-Wordle', 'http://www.w3.org/2000/svg',
    'https://www.nytimes.com/games/wordle/*', 'https://www.nytimes.com/games/wordle/'];
  for (const f of files) {
    let src = read(f);
    for (const ok of ALLOWED) src = src.split(ok).join('');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts', 'http://', 'https://', '@import']) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
  for (const f of ['content.js', 'game-state.js']) {
    const src = read(f);
    assert.ok(!/setAttribute\(|removeAttribute\(|dataset\.state|localStorage|sessionStorage|dispatchEvent|\.click\(/.test(src),
      f + ' must not change tile state, game storage or input');
  }
});

test('styles only apply while enabled, never match empty/tbd tiles, and never touch animation', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.trim()).filter(Boolean);
  for (const rule of rules) {
    const [selectors, body] = rule.split('{');
    for (const sel of selectors.split(',')) assert.ok(sel.trim().startsWith('html.cbw-enabled'), 'unscoped selector: ' + sel);
    assert.ok(!/animation|transform|transition|border|width|height|margin|padding|display/.test(body), 'non-colour property in: ' + selectors);
  }
  assert.ok(!/data-state="?(empty|tbd)/.test(css));
  for (const state of ['absent', 'present', 'correct']) {
    assert.ok(css.includes(`[data-testid="tile"][data-state="${state}"]`));
    assert.ok(css.includes(`button[data-key][data-state="${state}"]`));
    for (const v of [`--cbw-${state}`, `--cbw-${state}-text`]) assert.ok(css.includes(`var(${v})`), v);
  }
  assert.ok(css.includes('body.dark'), 'dark theme variables overridden');
});

test('Chrome and Firefox manifests are valid, equivalent and least-privilege', () => {
  const chromeM = JSON.parse(read('manifest.json'));
  const firefoxM = JSON.parse(read('manifest.firefox.json'));
  for (const m of [chromeM, firefoxM]) {
    assert.equal(m.manifest_version, 3);
    assert.deepEqual(m.permissions, ['storage']);
    // Host access exactly equal to the content script match (no new warning),
    // declared so the popup can check / request it (Firefox MV3 may withhold it).
    assert.deepEqual(m.host_permissions, ['https://www.nytimes.com/games/wordle/*']);
    assert.equal(m.background, undefined);
    assert.equal(m.content_scripts.length, 1);
    assert.deepEqual(m.content_scripts[0].matches, ['https://www.nytimes.com/games/wordle/*']);
    assert.deepEqual(m.content_scripts[0].js, ['color-engine.js', 'storage.js', 'game-state.js', 'notice.js', 'content.js']);
    const files = [...m.content_scripts[0].js, ...m.content_scripts[0].css, m.action.default_popup,
      ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
    for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), 'missing ' + f);
  }
  const { browser_specific_settings: bss, ...firefoxRest } = firefoxM;
  assert.deepEqual(firefoxRest, chromeM, 'manifests differ only by browser_specific_settings');
  assert.ok(bss.gecko.id);
  assert.deepEqual(bss.gecko.data_collection_permissions.required, ['none']);
});

/* ---------------- welcome / working notice ---------------- */

test('first installation shows the welcome notice once', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage });
  await settle();
  const n = page.notice();
  assert.equal(n.kind, 'welcome');
  assert.equal(n.title, 'Welcome to Colorblind Wordle!');
  assert.equal(n.action, null, 'welcome has only a dismiss button');
  assert.equal(typeof storage.data['cbw.onboarding'].welcomedAt, 'number');
  // Reopen much later: the welcome never appears again.
  clock.now = at(2026, 11, 25, 9);
  const later = bootPage({ clock, storage });
  await settle();
  assert.equal(later.notice().kind, 'working');
});

test('subsequent visits show the working notice, not on every refresh', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback', { 'cbw.onboarding': { welcomedAt: at(2026, 11, 10), lastNoticeAt: at(2026, 11, 17) } });
  const first = bootPage({ clock, storage });
  await settle();
  assert.equal(first.notice().title, 'Colorblind Wordle is working!');
  assert.equal(first.notice().action, 'Turn off');
  clock.now += 2 * 60 * 1000; // refresh two minutes later
  const refreshed = bootPage({ clock, storage });
  await settle();
  assert.equal(refreshed.notice(), null);
});

test('the notice auto-dismisses after a few seconds and can be dismissed manually', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback', { 'cbw.onboarding': { welcomedAt: 1, lastNoticeAt: 1 } });
  const page = bootPage({ clock, storage });
  await settle();
  assert.ok(page.notice());
  page.advance(Notice.DURATION_MS.working + 10);
  assert.equal(page.notice(), null, 'auto-dismissed');

  const storage2 = createExtensionStorage('callback');
  const page2 = bootPage({ clock, storage: storage2 });
  await settle();
  assert.ok(page2.pressNotice('close'));
  assert.equal(page2.notice(), null, 'closed manually');
});

test('Turn off restores the original colours and can be re-enabled from the popup preference', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback', { 'cbw.onboarding': { welcomedAt: 1, lastNoticeAt: 1 } });
  const page = bootPage({ clock, storage });
  await settle();
  assert.equal(page.enabledClass(), true);
  assert.ok(page.pressNotice('action'));
  await settle();
  assert.equal(page.enabledClass(), false);
  assert.deepEqual(page.vars(), {});
  assert.equal(storage.data['cbw.prefs'].enabled, false);
  assert.equal(page.notice().kind, 'off', 'confirms it is off');
  // The popup toggle writes the same preference.
  await page.sandbox.CBWStorage.setPrefs({ enabled: true });
  await settle();
  assert.equal(page.enabledClass(), true);
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
});

test('no notice when the extension is off', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback', { 'cbw.prefs': { enabled: false } });
  const page = bootPage({ clock, storage });
  await settle();
  assert.equal(page.notice(), null);
});

/* ---------------- completion → unlock ---------------- */

const unlocked = (storage, dateKey) => require(path.join(ROOT, 'storage.js')).isUnlockedFor(storage.data['cbw.completion'], dateKey);

test('palette stays locked while the game is in progress, including after wrong guesses', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const board = createBoard([]);
  const page = bootPage({ clock, storage, board });
  await settle();
  page.reveal(['apaac']);
  page.reveal(['apaac', 'cpcaa']);
  page.reveal(['apaac', 'cpcaa', 'ttttt']); // a rejected word stays "tbd"
  page.advance(5000);
  await settle();
  assert.equal(storage.data['cbw.completion'], undefined);
  assert.ok(!unlocked(storage, '2026-11-18'));
});

test('winning unlocks the palette for today', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const board = createBoard([]);
  const page = bootPage({ clock, storage, board });
  await settle();
  page.reveal(['apaac', 'ccccc~']); // still flipping: not yet
  page.advance(2000);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-18'), 'not before the reveal finishes');
  page.reveal(['apaac', 'ccccc']);
  page.advance(1300); // confirmation delay
  await settle();
  assert.deepEqual(
    { d: storage.data['cbw.completion'].completedDate, r: storage.data['cbw.completion'].result, g: storage.data['cbw.completion'].guesses },
    { d: '2026-11-18', r: 'win', g: 2 });
  assert.ok(unlocked(storage, '2026-11-18'));
});

test('losing after six attempts unlocks the palette for today', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const board = createBoard([]);
  const page = bootPage({ clock, storage, board });
  await settle();
  page.reveal(['aaaaa', 'paaaa', 'cpaaa', 'ccpaa', 'cccpa']);
  page.advance(2000);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-18'), 'five guesses is not the end');
  page.reveal(['aaaaa', 'paaaa', 'cpaaa', 'ccpaa', 'cccpa', 'ccccp']);
  page.advance(1300);
  await settle();
  assert.equal(storage.data['cbw.completion'].result, 'loss');
  assert.ok(unlocked(storage, '2026-11-18'));
});

test('a finished board that disappears before confirmation does not unlock', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const board = createBoard([]);
  const page = bootPage({ clock, storage, board });
  await settle();
  page.reveal(['ccccc']);
  board.set([]); // e.g. Wordle briefly rendered stale state, then reset
  page.advance(1300);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-18'));
});

test('refreshing or reopening the browser before finishing keeps the palette locked', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  for (let i = 0; i < 3; i++) {
    const page = bootPage({ clock, storage, board: createBoard(['apaac', 'cpcaa']) });
    await settle();
    page.advance(5000);
    await settle();
  }
  assert.ok(!unlocked(storage, '2026-11-18'));
});

test('refreshing or reopening after finishing keeps the palette unlocked', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage, board: createBoard([]) });
  await settle();
  page.reveal(['apaac', 'ccccc']);
  page.advance(1300);
  await settle();
  const record = JSON.stringify(storage.data['cbw.completion']);
  // Refresh (same storage): Wordle restores the finished board.
  clock.now = at(2026, 11, 18, 20);
  const again = bootPage({ clock, storage, board: createBoard(['apaac', 'ccccc']) });
  await settle();
  again.advance(1300);
  await settle();
  assert.ok(unlocked(storage, '2026-11-18'));
  assert.equal(JSON.stringify(storage.data['cbw.completion']), record, 'record kept, not rewritten');
});

test('the next day starts locked until that day\'s Wordle is finished', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage, board: createBoard([]) });
  await settle();
  page.reveal(['ccccc']);
  page.advance(1300);
  await settle();
  assert.ok(unlocked(storage, '2026-11-18'));
  clock.now = at(2026, 11, 19, 9);
  assert.ok(!unlocked(storage, '2026-11-19'), 'new date defaults to locked');
  const tomorrow = bootPage({ clock, storage, board: createBoard([]) });
  await settle();
  tomorrow.reveal(['apaac']);
  tomorrow.advance(1300);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-19'));
  tomorrow.reveal(['apaac', 'ccccc']);
  tomorrow.advance(1300);
  await settle();
  assert.ok(unlocked(storage, '2026-11-19'));
});

test('finishing yesterday\'s puzzle after midnight (no reload) does not unlock today', async () => {
  const clock = { now: at(2026, 11, 18, 23, 50) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage, board: createBoard([]) });
  await settle();
  page.reveal(['apaac']);
  clock.now = at(2026, 11, 19, 0, 10);
  page.reveal(['apaac', 'ccccc']);
  page.advance(1300);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-19'));
  assert.ok(!unlocked(storage, '2026-11-18'));
});

test('finishing an archive puzzle does not unlock today', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback');
  const page = bootPage({ clock, storage, board: createBoard([]), path: '/games/wordle/archive/2026-10-01' });
  await settle();
  page.reveal(['ccccc']);
  page.advance(1300);
  await settle();
  assert.ok(!unlocked(storage, '2026-11-18'));
});

test('completion is detected even while the colours are turned off', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('promise', { 'cbw.prefs': { enabled: false } });
  const page = bootPage({ clock, storage, board: createBoard([]), browserStyle: 'promise' });
  await settle();
  page.reveal(['ccccc']);
  page.advance(1300);
  await settle();
  assert.ok(unlocked(storage, '2026-11-18'));
});

test('the notice becomes visible, and Turn off swaps it for the "off" confirmation', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('callback', { 'cbw.onboarding': { welcomedAt: 1, lastNoticeAt: 1 } });
  const page = bootPage({ clock, storage });
  await settle();
  page.advance(20); // entry transition frame
  const host = page.root.children.find((c) => c.tagName === 'cbw-notice');
  assert.ok(host, 'notice host attached to <html>');
  const card = host.shadow.querySelector('.card');
  assert.ok(card.classList.contains('shown'), 'card is made visible');
  assert.ok(!/#[0-9a-f]{6}/i.test(host.shadow.allText().replace(/#(1c1c1e|f0f0f2|303033|b4b4ba|2ea043|48484c|2a2a2d|333337|3b6ee8|9a9aa0|ffffff)/gi, '')),
    'no palette colours in the notice');
  page.pressNotice('action');
  await settle();
  assert.equal(page.notice().kind, 'off');
  page.advance(Notice.DURATION_MS.off + 300);
  assert.equal(page.notice(), null, 'confirmation auto-dismisses');
});

/* ---------------- Firefox content-script environment ---------------- */

test('Firefox: content scripts work when window is not the global object and browser.* rejects callbacks', async () => {
  const clock = { now: at(2026, 11, 18, 9) };
  const storage = createExtensionStorage('firefox');
  const page = bootPage({ clock, storage, board: createBoard([]), browserStyle: 'firefox' });
  await settle();
  assert.equal(page.enabledClass(), true, 'colours applied');
  assert.deepEqual(page.vars(), expectedVars('2026-11-18'));
  assert.equal(page.notice() && page.notice().kind, 'welcome', 'notice shown');
  assert.equal(typeof storage.data['cbw.onboarding'].welcomedAt, 'number', 'storage writes succeed');
  assert.equal(storage.data['cbw.palette'].date, '2026-11-18');
  page.reveal(['apaac', 'ccccc']);
  page.advance(1300);
  await settle();
  assert.equal(storage.data['cbw.completion'].completedDate, '2026-11-18', 'completion persisted');
  await page.sandbox.CBWStorage.setPrefs({ enabled: false });
  await settle();
  assert.equal(page.enabledClass(), false, 'turning off works');
});
