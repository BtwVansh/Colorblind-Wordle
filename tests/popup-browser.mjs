// Real-browser test of the popup's locked/unlocked behaviour. Needs no network.
//   npm run build && node tests/popup-browser.mjs
// Loads dist/chrome into a throwaway headless Chromium-family profile, sets
// completion states directly in extension storage and checks what the popup
// renders. Set CBW_SHOTS=<dir> to save screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'dist', 'chrome');
const Engine = createRequire(import.meta.url)(join(root, 'color-engine.js'));
const GITHUB = 'https://github.com/BtwVansh/Colorblind-Wordle';
const BROWSERS = [
  process.env.CBW_BROWSER,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/chromium'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const extId = [...createHash('sha256').update(extDir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

async function main() {
  const bin = BROWSERS.find((b) => existsSync(b));
  if (!bin) { console.log('SKIP  no Chromium-family browser found'); return; }
  if (!existsSync(join(extDir, 'manifest.json'))) { console.error('run `npm run build` first'); process.exit(2); }

  const today = Engine.localDateKey(new Date());
  const yesterday = Engine.localDateKey(new Date(Date.now() - 86400000 - 3600000));
  const palette = Engine.getPaletteForDate(today);
  const hexes = [palette.absent, palette.present, palette.correct];

  const profile = mkdtempSync(join(tmpdir(), 'cbw-popup-'));
  const port = 9800 + Math.floor(Math.random() * 150);
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', 'about:blank'], { stdio: 'ignore' });
  try {
    let wsUrl;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* starting */ }
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => { ws.onopen = r; });
    let n = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++n;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    await send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 600, deviceScaleFactor: 2, mobile: false }, s);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, s);
    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;

    async function openPopup(storage) {
      await send('Page.navigate', { url: popupUrl }, s);
      await sleep(500);
      await evaluate(`new Promise(r => chrome.storage.local.clear(() => chrome.storage.local.set(${JSON.stringify(storage)}, r)))`);
      await send('Page.navigate', { url: popupUrl }, s);
      await sleep(700);
    }
    async function shot(name) {
      if (!process.env.CBW_SHOTS) return;
      const h = await evaluate('document.documentElement.scrollHeight');
      await send('Emulation.setDeviceMetricsOverride', { width: 340, height: h, deviceScaleFactor: 2, mobile: false }, s);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
      writeFileSync(join(process.env.CBW_SHOTS, name + '.png'), Buffer.from(data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 600, deviceScaleFactor: 2, mobile: false }, s);
    }
    const view = () => evaluate(`(() => {
      const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
      return {
        locked: vis('locked'), unlocked: vis('unlocked'),
        lockedText: document.getElementById('locked').innerText,
        unlockedTitle: document.getElementById('palette-title').textContent,
        unlockedText: document.getElementById('unlocked-text').textContent,
        hexes: [...document.querySelectorAll('.hex')].map(e => e.textContent),
        shuffleVisible: vis('shuffle'),
        metrics: document.getElementById('metrics').textContent,
        html: document.documentElement.outerHTML.toLowerCase(),
        activation: (document.getElementById('activation-text').textContent)
      };
    })()`);
    const leaks = (html) => hexes.filter((h) => html.includes(h.toLowerCase()) || html.includes(h.slice(1).toLowerCase()));

    // 1. Fresh install: locked.
    await openPopup({});
    let v = await view();
    check('fresh install: palette is locked', v.locked && !v.unlocked);
    check('locked message shown', /Today's palette is locked\./.test(v.lockedText) && /Complete today's Wordle/.test(v.lockedText));
    check('locked: no swatches or hex codes rendered', v.hexes.length === 0);
    check('locked: preview button not shown', !v.shuffleVisible);
    check('locked: no metrics shown', v.metrics === '');
    check('locked: no daily colour appears anywhere in the popup HTML', leaks(v.html).length === 0, leaks(v.html).join(','));
    check('activation status shown', /^On/.test(v.activation), v.activation);
    const access = await evaluate(`CBWPopup.refreshStatus()`);
    check('site access to Wordle is granted and detected', access !== 'no-access', access);
    const grantHidden = await evaluate(`document.getElementById('grant').hidden`);
    check('no "Allow on Wordle" button when access is granted', grantHidden === true);
    await shot('popup-locked');

    // 2. Completed yesterday only: today still locked.
    await openPopup({ 'cbw.completion': { completedDate: yesterday, result: 'win', guesses: 3 } });
    v = await view();
    check("yesterday's completion does not unlock today", v.locked && !v.unlocked && v.hexes.length === 0 && leaks(v.html).length === 0);

    // 3. Won today: unlocked.
    await openPopup({ 'cbw.completion': { completedDate: today, result: 'win', guesses: 3 } });
    v = await view();
    check('winning today unlocks the palette', v.unlocked && !v.locked);
    check('unlocked heading', v.unlockedTitle === "Today's palette has been unlocked!", v.unlockedTitle);
    check('unlocked: three hex codes match the daily palette', v.hexes.join(' ') === hexes.map((h) => h.toUpperCase()).join(' '), v.hexes.join(' '));
    check('unlocked: Delta E and contrast info shown', /ΔE2000/.test(v.metrics) && /contrast/.test(v.metrics), v.metrics);
    check('unlocked: preview button shown', v.shuffleVisible);
    const copies = await evaluate(`document.querySelectorAll('.copy').length`);
    check('unlocked: copy buttons shown', copies === 3);
    await shot('popup-unlocked');

    // 4. Preview never changes the official palette.
    await evaluate(`document.getElementById('shuffle').click()`);
    const preview = await view();
    const badge = await evaluate(`!document.getElementById('preview-badge').hidden && document.getElementById('palette-label').textContent`);
    check('preview shows a different palette, labelled as a preview', preview.hexes.join() !== v.hexes.join() && badge === 'Preview palette', String(badge));
    const cached = await evaluate(`new Promise(r => chrome.storage.local.get('cbw.palette', i => r(i['cbw.palette'] || null)))`);
    check('preview does not write any palette to storage', !cached || cached.absent === palette.absent);
    await evaluate(`document.getElementById('reset').click()`);
    const back = await view();
    check('"Back to today\'s palette" restores the official palette', back.hexes.join(' ') === v.hexes.join(' '));

    // 5. Lost today: unlocked too.
    await openPopup({ 'cbw.completion': { completedDate: today, result: 'loss', guesses: 6 } });
    v = await view();
    check('losing today unlocks the palette', v.unlocked && v.hexes.length === 3);

    // 6. Unlocks live if the game finishes while the popup is open.
    await openPopup({});
    await evaluate(`new Promise(r => chrome.storage.local.set({ 'cbw.completion': { completedDate: ${JSON.stringify(today)}, result: 'win', guesses: 4 } }, r))`);
    await sleep(400);
    v = await view();
    check('popup unlocks live when the game is completed', v.unlocked && v.hexes.length === 3);

    // 7. Tampered/invalid record stays locked.
    await openPopup({ 'cbw.completion': { completedDate: today, result: 'peeked' } });
    v = await view();
    check('an invalid completion record keeps the palette locked', v.locked && v.hexes.length === 0);

    // 8. Toggle.
    await openPopup({});
    await evaluate(`document.getElementById('enabled').click()`);
    await sleep(300);
    const prefs = await evaluate(`new Promise(r => chrome.storage.local.get('cbw.prefs', i => r(i['cbw.prefs'])))`);
    v = await view();
    check('toggle turns the extension off and shows the status', prefs && prefs.enabled === false && /^Off/.test(v.activation), v.activation);

    // 9. GitHub link.
    const link = await evaluate(`(() => { const a = document.querySelector('a.github'); return { href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() }; })()`);
    check('GitHub link points at the repository', link.href === GITHUB, link.href);
    check('GitHub link opens in a new tab', link.target === '_blank' && /noopener/.test(link.rel));
    check('GitHub link text', link.text === 'GitHub ↗', link.text);
    await evaluate(`document.querySelector('a.github').click()`);
    await sleep(1000);
    const opened = events.some((e) => e.method === 'Target.targetCreated' && e.params.targetInfo.url.startsWith(GITHUB)) ||
      (await send('Target.getTargets')).targetInfos.some((t) => t.url.startsWith(GITHUB));
    check('clicking the GitHub link opens the repository in a new tab', opened);

    ws.close();
  } finally {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, sleep(4000)]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll popup checks passed');
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error('ERROR', e.message); process.exitCode = 1; });
