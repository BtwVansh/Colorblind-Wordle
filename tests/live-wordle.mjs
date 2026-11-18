// End-to-end test against the real NYT Wordle in a Chromium-family browser.
//   npm run build && node tests/live-wordle.mjs          (win: CRANE, then the answer)
//   npm run build && node tests/live-wordle.mjs --lose   (six wrong guesses)
//
// Launches a headless browser with a throwaway profile and the packaged
// extension (dist/chrome), opens Wordle, plays two guesses (CRANE, then the
// day's answer from Wordle's public puzzle endpoint, so every tile state
// appears) and checks rendered colours, themes, the popup toggle, reloads,
// date changes and the extension's network activity.
//
// Requires network access to nytimes.com. Never touches your real profile.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'dist', 'chrome');
const Engine = createRequire(import.meta.url)(join(root, 'color-engine.js'));
const WORDLE = 'https://www.nytimes.com/games/wordle/index.html';

const BROWSERS = [
  process.env.CBW_BROWSER,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

/** Chromium derives an unpacked extension's ID from its absolute path. */
function unpackedExtensionId(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function hexToRgbString(hex) {
  const [r, g, b] = Engine.hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

/* ---------------- minimal CDP client ---------------- */

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach((h) => h(msg));
      }
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
  close() { this.ws.close(); }
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    sessionId,
    targetId,
    send: (m, p) => cdp.send(m, p, sessionId),
    async eval(expression, contextId) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 20000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await page.eval(expression)) return true; } catch { /* page navigating */ }
        await sleep(250);
      }
      return false;
    },
    async shot(name) {
      if (!process.env.CBW_SHOTS) return;
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(join(process.env.CBW_SHOTS, name + '.png'), Buffer.from(data, 'base64'));
    },
    async key(k) {
      const text = k.length === 1 ? k : k === 'Enter' ? '\r' : '';
      const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
      const vk = k === 'Enter' ? 13 : k === 'Escape' ? 27 : k === 'Backspace' ? 8 : k.toUpperCase().charCodeAt(0);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: vk });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    }
  };
  if (url) await page.send('Page.navigate', { url });
  return page;
}

/* ---------------- test ---------------- */

async function main() {
  if (!existsSync(join(extDir, 'manifest.json'))) {
    console.error('dist/chrome missing: run `npm run build` first.');
    process.exit(2);
  }
  const bin = BROWSERS.find((b) => existsSync(b));
  if (!bin) { console.log('SKIP  no Chromium-family browser found (set CBW_BROWSER)'); return; }
  console.log('Browser:', bin);

  const today = Engine.localDateKey(new Date());
  const palette = Engine.getPaletteForDate(today);
  console.log(`Expected palette for ${today}: absent ${palette.absent}, present ${palette.present}, correct ${palette.correct}`);

  const LOSE = process.argv.includes('--lose');
  let answer = null;
  try {
    const r = await fetch(`https://www.nytimes.com/svc/wordle/v2/${today}.json`);
    answer = (await r.json()).solution;
  } catch { /* fall back to guesses only */ }

  const profile = mkdtempSync(join(tmpdir(), 'cbw-live-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1200,1000', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* starting */ }
    }
    if (!wsUrl) throw new Error('browser did not start');
    const cdp = new CDP(wsUrl);
    await cdp.open();

    const page = await newPage(cdp);
    // Track every request and which context started it.
    const extRequests = [];
    const allRequests = [];
    cdp.on((msg) => {
      if (msg.method !== 'Network.requestWillBeSent') return;
      allRequests.push(msg.params.request.url);
      const init = JSON.stringify(msg.params.initiator || {});
      if (/chrome-extension:\/\//.test(init) || /^chrome-extension:/.test(msg.params.request.url)) extRequests.push(msg.params.request.url);
    });
    await page.send('Network.enable');
    await page.send('Runtime.enable');
    // Attach to out-of-process iframes (consent banners live in one).
    const frameSessions = new Set();
    cdp.on((msg) => {
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
        frameSessions.add(msg.params.sessionId);
        cdp.send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId).catch(() => {});
      }
      if (msg.method === 'Target.detachedFromTarget') frameSessions.delete(msg.params.sessionId);
    });
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const contexts = [];
    cdp.on((msg) => { if (msg.method === 'Runtime.executionContextCreated' && msg.sessionId === page.sessionId) contexts.push(msg.params.context); });
    await page.send('Page.navigate', { url: WORDLE });

    const loaded = await page.waitFor(`document.documentElement.classList.contains('cbw-enabled')`, 30000);
    check('extension content script runs on Wordle (html.cbw-enabled)', loaded);
    if (!loaded) throw new Error('extension did not load; this browser may not support --load-extension');

    // The extension's isolated world (for reading its in-page notice).
    const isolatedCtx = () => {
      const list = contexts.filter((c) => c.auxData && c.auxData.type === 'isolated' && /Colorblind Wordle/.test(c.name || ''));
      return list.length ? list[list.length - 1].id : null;
    };
    const noticeState = async () => { const ctx = isolatedCtx(); return ctx ? page.eval('CBWContent.getNotice()', ctx).catch(() => null) : null; };
    let firstNotice = null;
    for (let i = 0; i < 20 && !firstNotice; i++) { firstNotice = await noticeState(); if (!firstNotice) await sleep(250); }
    check('first visit shows the welcome notice', firstNotice && firstNotice.title === 'Welcome to Colorblind Wordle!', JSON.stringify(firstNotice));
    const noticeHost = await page.eval(`(() => { const h = document.querySelector('cbw-notice'); return h ? { inHtml: h.parentElement === document.documentElement, shadowHidden: h.shadowRoot === null } : null; })()`);
    check('notice is rendered in the page, isolated in a closed shadow root', noticeHost && noticeHost.inHtml && noticeHost.shadowHidden);

    // The popup before finishing: locked, no colours anywhere.
    const extId = unpackedExtensionId(extDir);
    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
    const popup = await newPage(cdp, popupUrl);
    await popup.waitFor(`document.getElementById('locked') && (!document.getElementById('locked').hidden || !document.getElementById('unlocked').hidden)`, 10000);
    const lockedView = await popup.eval(`({ locked: !document.getElementById('locked').hidden, hexes: document.querySelectorAll('.hex').length, html: document.documentElement.outerHTML.toLowerCase() })`);
    check('popup is locked before the game is finished', lockedView.locked && lockedView.hexes === 0);
    check('locked popup contains none of the daily colours',
      ![palette.absent, palette.present, palette.correct].some((h) => lockedView.html.includes(h.slice(1).toLowerCase())));

    const vars = await page.eval(`(() => { const s = document.documentElement.style; return ['absent','present','correct'].flatMap(k => [s.getPropertyValue('--cbw-'+k), s.getPropertyValue('--cbw-'+k+'-text')]); })()`);
    check('CSS variables hold today\'s deterministic palette',
      JSON.stringify(vars) === JSON.stringify([palette.absent, palette.absentText, palette.present, palette.presentText, palette.correct, palette.correctText]),
      vars.join(' '));

    // Fresh profiles may see a consent banner (sometimes in a frame or shadow
    // DOM): click "Reject all", the privacy-preserving option, with a real
    // mouse event. Keep going until Wordle's start screen or board is usable.
    const gameReady = `[...document.querySelectorAll('button')].some(b => /^play$/i.test(b.textContent.trim())) || document.querySelectorAll('[data-testid="tile"]').length >= 30`;
    // Trusted mouse click on a button with exactly this text, in the page or
    // in any (cross-origin) iframe. Coordinates are mapped to the top viewport.
    async function clickTextAnywhere(text) {
      const findRect = `(() => { const b = [...document.querySelectorAll('button, [role=button]')].find(b => { const r = b.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.top >= 0 && r.bottom <= innerHeight && b.textContent.trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())}; }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, url: location.href }; })()`;
      // Visible matching button in the page or in an out-of-process iframe.
      for (const sid of [page.sessionId, ...frameSessions]) {
        let hit;
        try { const r = await cdp.send('Runtime.evaluate', { expression: findRect, returnByValue: true }, sid); hit = r.result.value; } catch (e) { continue; }
        if (!hit) continue;
        // Try a DOM click on the visible button first, then a real mouse click.
        await cdp.send('Runtime.evaluate', { expression: findRect.replace('if (!b) return null;', 'if (!b) return null; b.click();'), returnByValue: true }, sid).catch(() => {});
        const gone = async () => {
          for (let i = 0; i < 20; i++) {
            await sleep(250);
            try { if (!(await cdp.send('Runtime.evaluate', { expression: findRect, returnByValue: true }, sid)).result.value) return true; } catch { return true; }
          }
          return false;
        };
        if (await gone()) return true;
        let { x, y } = hit;
        if (sid !== page.sessionId) {
          const offset = await page.eval(`(() => { const f = [...document.querySelectorAll('iframe')].find(f => f.src && ${JSON.stringify(hit.url)}.startsWith(f.src.split('#')[0])) || [...document.querySelectorAll('iframe')].find(f => { const r = f.getBoundingClientRect(); return r.width > 300 && r.bottom >= innerHeight - 5; }); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
          if (!offset) continue;
          x += offset.x; y += offset.y;
        }
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
        if (await gone()) return true;
      }
      return false;
    }
    let consentHandled = false;
    async function reachBoard() {
      // The banner can appear several seconds after the game, so keep looking
      // for it for a while even once the game's start screen is ready.
      for (let i = 0; i < 60; i++) {
        if (!consentHandled && await clickTextAnywhere('Reject all').catch(() => false)) { consentHandled = true; await sleep(1500); }
        const ready = await page.eval(gameReady).catch(() => false);
        if (ready && (consentHandled || i >= 24)) break;
        await sleep(500);
      }
      console.log(`      consent banner ${consentHandled ? 'dismissed with "Reject all"' : 'not shown'}`);
      await sleep(1500);
      await page.shot('0-after-consent');
      // Get past the splash screen and the How to Play dialog.
      await page.waitFor(`[...document.querySelectorAll('button')].some(b => /^play$/i.test(b.textContent.trim())) || document.querySelector('[data-testid="tile"]')`, 20000);
      for (let i = 0; i < 4; i++) {
        await clickTextAnywhere('Play');
        if (await page.waitFor(`document.querySelectorAll('[data-testid="tile"]').length >= 30`, 6000)) break;
      }
      await sleep(1200);
      return page.eval(`document.querySelectorAll('[data-testid="tile"]').length >= 30`).catch(() => false);
    }
    // Ads and consent overlays on the live site are occasionally slow: retry with a reload.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await reachBoard()) break;
      console.log(`      board not reachable (attempt ${attempt}); reloading`);
      await page.send('Page.reload', {});
      await sleep(3000);
    }
    // The How to Play dialog (it has 15 example tiles) can open a moment after
    // the board does; close it before typing or it swallows the keystrokes.
    for (let i = 0; i < 16; i++) {
      const count = await page.eval(`document.querySelectorAll('[data-testid="tile"]').length`).catch(() => 0);
      if (count === 30 && i >= 4) break;
      if (count > 30) {
        await page.key('Escape');
        await page.eval(`(() => { document.querySelectorAll('[aria-label="Close"], button[class*="closeIcon"]').forEach(b => b.click()); })()`);
      }
      await sleep(400);
    }
    await page.send('Page.bringToFront');
    await sleep(300);
    console.log('      board tiles on screen:', await page.eval(`document.querySelectorAll('[data-testid="tile"]').length`));

    await page.shot('1-before-guess');
    const emptyBefore = await page.eval(`(() => { const t = document.querySelector('[data-testid="tile"][data-state="empty"]'); return t ? getComputedStyle(t).backgroundColor : null; })()`);

    let guesses = ['crane'];
    if (LOSE) {
      // Six valid words, none of them the answer.
      guesses = ['sloth', 'pudgy', 'wimpy', 'fjord', 'vixen', 'bumpy', 'chunk', 'glyph'].filter((w) => w !== answer).slice(0, 6);
    } else if (answer && answer !== 'crane') {
      guesses.push(answer);
    }
    // Letters typed into the current row (row index = guesses already made).
    const rowLetters = (r) => page.eval(`(() => { const row = document.querySelectorAll('[class*="Board-module_board"] [role="group"]')[${r}]; return row ? [...row.querySelectorAll('[data-testid="tile"]')].map(t => t.textContent.trim()).join('').toLowerCase() : ''; })()`);
    for (let g = 0; g < guesses.length; g++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const ch of guesses[g]) { await page.key(ch); await sleep(90); }
        await sleep(200);
        if ((await rowLetters(g)) === guesses[g]) break;
        for (let i = 0; i < 6; i++) { await page.key('Backspace'); await sleep(60); }
      }
      await page.key('Enter');
      await sleep(2600); // reveal animation
      if (g === 0 && guesses.length > 1) {
        // After one wrong guess the palette must still be locked.
        await popup.send('Page.reload', {});
        await sleep(800);
        const mid = await popup.eval(`({ locked: !document.getElementById('locked').hidden, hexes: document.querySelectorAll('.hex').length })`);
        check('an incorrect guess does not unlock the palette', mid.locked && mid.hexes === 0);
        // Give keyboard focus back to the Wordle tab before typing again.
        await page.send('Page.bringToFront');
        await sleep(400);
      }
    }
    await sleep(1500);
    await page.shot('2-after-guesses');

    const tiles = await page.eval(`[...document.querySelectorAll('[data-testid="tile"]')].map(t => ({ s: t.dataset.state, bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t).color }))`);
    const keys = await page.eval(`[...document.querySelectorAll('button[data-key][data-state]')].map(k => ({ s: k.dataset.state, bg: getComputedStyle(k).backgroundColor, fg: getComputedStyle(k).color }))`);
    const byState = (list, s) => list.filter((x) => x.s === s);
    const states = ['absent', 'present', 'correct'];
    const seenStates = states.filter((s) => byState(tiles, s).length);
    console.log('      revealed tile states:', states.map((s) => `${s}=${byState(tiles, s).length}`).join(' '),
      answer ? '' : '(answer unavailable; only CRANE played)');
    check('guess was accepted and revealed', seenStates.length > 0);

    for (const s of seenStates) {
      const want = hexToRgbString(palette[s]);
      const wantText = hexToRgbString(palette[s + 'Text']);
      check(`board ${s} tiles use ${palette[s]}`, byState(tiles, s).every((t) => t.bg === want && t.fg === wantText), byState(tiles, s)[0].bg);
      if (byState(keys, s).length) {
        check(`keyboard ${s} keys use ${palette[s]}`, byState(keys, s).every((k) => k.bg === want && k.fg === wantText), byState(keys, s)[0].bg);
      }
    }
    // Report: computed colours, as hex, read back from the rendered page.
    const toHex = (rgb) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb || ''); return m ? '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('') : String(rgb); };
    for (const st of states) {
      const t = byState(tiles, st)[0], k = byState(keys, st)[0];
      console.log(`      computed ${st.padEnd(7)} expected ${palette[st]} / text ${palette[st + 'Text']}   tile ${t ? toHex(t.bg) + ' / ' + toHex(t.fg) : '(none revealed)'}   key ${k ? toHex(k.bg) + ' / ' + toHex(k.fg) : '(none)'}`);
    }
    const distinct = new Set(seenStates.map((s) => byState(tiles, s)[0].bg));
    check('each revealed state has a different colour', distinct.size === seenStates.length);
    const emptyAfter = byState(tiles, 'empty');
    check('empty tiles are not recoloured', emptyAfter.every((t) => t.bg === emptyBefore), emptyBefore);
    check('Wordle still records tile states (game logic intact)',
      tiles.slice(0, 5).every((t) => states.includes(t.s)));

    if (LOSE) {
      const lost = await page.eval(`(() => { const rows = [...document.querySelectorAll('[class*="Board-module_board"] [role="group"]')].map(r => [...r.querySelectorAll('[data-testid="tile"]')].map(t => t.dataset.state)); return rows.length === 6 && rows.every(r => r.every(s => ['absent','present','correct'].includes(s))) && !rows.some(r => r.every(s => s === 'correct')); })()`);
      check('six wrong guesses registered by Wordle (game lost)', lost);
    } else if (answer) {
      const won = await page.eval(`[...document.querySelectorAll('[data-testid="tile"]')].slice(5, 10).every(t => t.dataset.state === 'correct')`);
      check('winning guess registered by Wordle', won);
    }

    // Light and dark theme (what Wordle's own theme toggle does: body.dark).
    await page.eval(`document.querySelectorAll('[aria-label="Close"], button[class*="closeIcon"]').forEach(b => b.click())`);
    await sleep(500);
    const originalDark = await page.eval(`document.body.classList.contains('dark')`);
    for (const theme of ['light', 'dark']) {
      await page.eval(`document.body.classList.toggle('dark', ${theme === 'dark'})`);
      await sleep(300);
      await page.shot('theme-' + theme);
      const evaluated = await page.eval(`[...document.querySelectorAll('[data-testid="tile"], button[data-key]')].filter(t => ['absent','present','correct'].includes(t.dataset.state)).map(t => ({ s: t.dataset.state, bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t).color }))`);
      check(`${theme} theme: tiles and keys use the daily palette with readable letters`,
        evaluated.length > 0 && evaluated.every((t) => t.bg === hexToRgbString(palette[t.s]) && t.fg === hexToRgbString(palette[t.s + 'Text'])));
    }
    await page.eval(`document.body.classList.toggle('dark', ${originalDark})`);

    // Simulated date change inside the extension's isolated world.
    const isolated = contexts.filter((c) => c.auxData && c.auxData.type === 'isolated' && /Colorblind Wordle/.test(c.name || ''));
    if (isolated.length) {
      const ctx = isolated[isolated.length - 1].id;
      const tomorrow = Engine.nextDateKey(today);
      const next = Engine.getPaletteForDate(tomorrow);
      await page.eval(`(() => { const Real = Date; const shift = new Real(${JSON.stringify(tomorrow)} + 'T12:00:00').getTime() - Real.now();
        window.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); } static now() { return Real.now() + shift; } };
        return CBWContent.checkDate(); })()`, ctx);
      await sleep(300);
      const after = await page.eval(`(() => { const t = document.querySelector('[data-testid="tile"][data-state="absent"]'); return t && getComputedStyle(t).backgroundColor; })()`);
      check('date change swaps palette on the open page without reload', after === hexToRgbString(next.absent), `${after} (tomorrow absent ${next.absent})`);
      await page.eval(`(() => { window.Date = Object.getPrototypeOf(window.Date); return CBWContent.checkDate(); })()`, ctx);
      await sleep(300);
      const back = await page.eval(`document.documentElement.style.getPropertyValue('--cbw-absent')`);
      check('palette returns to today once the real date is restored', back === palette.absent);
    } else {
      check('found extension isolated world for date simulation', false);
    }

    // Popup after finishing: unlocked.
    await popup.send('Page.reload', {});
    const popupOk = await popup.waitFor(`document.querySelector('.hex') && document.querySelector('.hex').textContent.length === 7`, 10000);
    check(`${LOSE ? 'losing' : 'winning'} unlocks the palette in the popup`, popupOk);
    if (popupOk) {
      const title = await popup.eval(`document.getElementById('palette-title').textContent`);
      check('unlocked heading shown', title === "Today's palette has been unlocked!", title);
    }
    // Popup status comes from the content script in the active Wordle tab.
    await page.send('Page.bringToFront');
    await sleep(300);
    const status = await popup.eval(`CBWPopup.refreshStatus().then(s => ({ s, text: document.getElementById('activation-text').textContent }))`);
    check('popup status confirms the content script is running in the Wordle tab', status.s === 'running', status.text);
    if (popupOk) {
      const hexes = await popup.eval(`[...document.querySelectorAll('.hex')].map(e => e.textContent)`);
      check('popup shows the same three hex codes', hexes.join(' ') === [palette.absent, palette.present, palette.correct].map((h) => h.toUpperCase()).join(' '), hexes.join(' '));
      await popup.eval(`document.getElementById('shuffle').click()`);
      const previewHexes = await popup.eval(`[...document.querySelectorAll('.hex')].map(e => e.textContent)`);
      check('preview shows a different, temporary palette', previewHexes.join() !== hexes.join() && await popup.eval(`!document.getElementById('preview-badge').hidden`));
      await page.waitFor(`document.querySelector('[data-testid="tile"][data-state="absent"]')`, 15000);
      const stillOfficial = await page.eval(`document.documentElement.style.getPropertyValue('--cbw-absent')`);
      check('preview does not change the page palette', stillOfficial === palette.absent);

      await popup.eval(`document.getElementById('enabled').click()`);
      await sleep(600);
      const disabled = await page.eval(`(() => ({ cls: document.documentElement.classList.contains('cbw-enabled'), v: document.documentElement.style.getPropertyValue('--cbw-absent'), dark: document.body.classList.contains('dark'), bg: (t => t && getComputedStyle(t).backgroundColor)(document.querySelector('[data-testid="tile"][data-state="absent"]')) }))()`);
      check('disabling removes the class and variables', !disabled.cls && !disabled.v);
      // Wordle's own absent gray: #787c7e (light) or #3a3a3c (dark).
      check('disabling restores Wordle\'s original absent gray', disabled.bg === (disabled.dark ? 'rgb(58, 58, 60)' : 'rgb(120, 124, 126)'), `${disabled.bg} (${disabled.dark ? 'dark' : 'light'} theme)`);
      await popup.eval(`document.getElementById('enabled').click()`);
      await sleep(600);
      const reenabled = await page.eval(`document.documentElement.classList.contains('cbw-enabled')`);
      check('re-enabling restores the palette', reenabled);
    }

    // Make the next visit eligible for the "working" notice (cooldown passed).
    await popup.eval(`new Promise(r => chrome.storage.local.get('cbw.onboarding', i => chrome.storage.local.set({ 'cbw.onboarding': Object.assign({}, i['cbw.onboarding'], { lastNoticeAt: 0 }) }, r)))`);

    // Reload: palette identical.
    await page.eval(`window.__cbwBeforeReload = true`);
    await page.send('Page.reload', {});
    await page.waitFor(`!window.__cbwBeforeReload && document.readyState !== 'loading' && document.documentElement.classList.contains('cbw-enabled')`, 30000);
    const varsReload = await page.eval(`document.documentElement.style.getPropertyValue('--cbw-absent') + document.documentElement.style.getPropertyValue('--cbw-present') + document.documentElement.style.getPropertyValue('--cbw-correct')`);
    check('reload keeps the identical palette', varsReload === palette.absent + palette.present + palette.correct);

    // Later visit: the "working" notice appears straight away (and auto-dismisses after 5 s).
    let working = null;
    for (let i = 0; i < 20 && !(working && working.kind === 'working'); i++) { working = await noticeState(); if (!working || working.kind !== 'working') await sleep(200); }
    check('later visit shows the working notice with Turn off', working && working.title === 'Colorblind Wordle is working!' && working.action === 'Turn off', JSON.stringify(working));
    const pressed = await page.eval('CBWContent.pressNotice("action")', isolatedCtx()).catch(() => false);
    check('Turn off button is present and clickable', pressed === true);
    let offNotice = null;
    for (let i = 0; i < 12 && !(offNotice && offNotice.kind === 'off'); i++) { offNotice = await noticeState(); if (!offNotice || offNotice.kind !== 'off') await sleep(250); }
    check('Turn off confirms with an "off" notice', offNotice && offNotice.kind === 'off', JSON.stringify(offNotice));

    // After a finished game Wordle shows its splash screen again; open the board.
    await page.waitFor(`[...document.querySelectorAll('button')].some(b => /^(play|see stats|continue|admire puzzle)$/i.test(b.textContent.trim()))`, 15000);
    await page.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^(play|see stats|continue|admire puzzle)$/i.test(b.textContent.trim())); if (b) b.click(); })()`);
    await page.waitFor(`document.querySelector('[data-testid="tile"][data-state="absent"]')`, 15000);
    await page.eval(`document.querySelectorAll('[aria-label="Close"], button[class*="closeIcon"]').forEach(b => b.click())`);
    await page.shot('3-after-reload');
    const off = await page.eval(`(() => ({ cls: document.documentElement.classList.contains('cbw-enabled'), dark: document.body.classList.contains('dark'), bg: (t => t && getComputedStyle(t).backgroundColor)(document.querySelector('[data-testid="tile"][data-state="absent"]')) }))()`);
    check('Turn off restores Wordle\'s original colours', !off.cls && off.bg === (off.dark ? 'rgb(58, 58, 60)' : 'rgb(120, 124, 126)'), String(off.bg));
    await popup.send('Page.reload', {});
    await popup.waitFor(`document.getElementById('enabled')`, 5000);
    await sleep(400);
    await popup.eval(`document.getElementById('enabled').click()`);
    await sleep(700);
    check('popup toggle turns it back on', await page.eval(`document.documentElement.classList.contains('cbw-enabled')`));
    // Previously revealed tiles, restored by Wordle after the refresh, use the palette again.
    const restored = await page.eval(`[...document.querySelectorAll('[data-testid="tile"], button[data-key]')].filter(t => ['absent','present','correct'].includes(t.dataset.state)).map(t => ({ s: t.dataset.state, bg: getComputedStyle(t).backgroundColor }))`);
    check('after refresh, restored tiles and keys use the daily palette', restored.length > 0 && restored.every((t) => t.bg === hexToRgbString(palette[t.s])),
      `${restored.length} elements, e.g. ${restored.slice(0, 3).map((t) => t.s + '=' + t.bg).join(', ')}`);

    // Unlocked state survives the reload.
    await popup.send('Page.reload', {});
    const stillUnlocked = await popup.waitFor(`document.querySelectorAll('.hex').length === 3`, 5000);
    check('palette stays unlocked after refreshing Wordle', stillUnlocked);

    check('extension made no network requests', extRequests.length === 0, extRequests.slice(0, 3).join(', '));
    console.log(`      (Wordle itself made ${allRequests.length} requests; none were initiated by the extension)`);
    cdp.close();
  } finally {
    proc.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll live checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('ERROR', e.message); process.exitCode = 1; });
