// Cross-engine parity: runs color-engine.js in every JavaScript engine found on
// this machine and checks each produces exactly the golden palettes.
//   node tests/engine-parity.mjs
// Engines tried: Node (V8), JavaScriptCore (macOS built-in), SpiderMonkey
// (`js` shell, if installed), and headless Chromium-family browsers via
// tests/parity.html. Missing engines are reported as skipped.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));
writeFileSync(join(here, 'golden-data.js'), '// Generated from golden.json by engine-parity.mjs\nwindow.CBW_GOLDEN = ' + JSON.stringify(golden) + ';\n');

// Plain-JS check used for shells (print() based).
const shellScript = (enginePath) => `
var module = undefined;
load(${JSON.stringify(enginePath)});
var E = this.CBWColorEngine || globalThis.CBWColorEngine;
var G = ${JSON.stringify(golden)};
var bad = [];
for (var date in G.vectors) {
  var p = E.getPaletteForDate(date);
  var got = [p.absent,p.present,p.correct,p.absentText,p.presentText,p.correctText].join(' ');
  if (got !== G.vectors[date].join(' ')) bad.push(date + ': ' + got);
}
var acc = [], d = G.rangeStart;
for (var i = 0; i < G.rangeDays; i++) { var q = E.getPaletteForDate(d); acc.push(q.absent+q.present+q.correct); d = E.nextDateKey(d); }
var h = E.hashString(acc.join('|'));
if (h !== G.rangeHash) bad.push('range hash ' + h);
print(bad.length ? 'FAIL ' + bad.join('; ') : 'PASS hash=' + h);
`;

const results = [];
const record = (engine, outcome) => { results.push([engine, outcome]); console.log(engine.padEnd(34), outcome); };

// 1. Node / V8
{
  const require = (await import('node:module')).createRequire(import.meta.url);
  const E = require(join(root, 'color-engine.js'));
  const acc = []; let d = golden.rangeStart;
  for (let i = 0; i < golden.rangeDays; i++) { const p = E.getPaletteForDate(d); acc.push(p.absent + p.present + p.correct); d = E.nextDateKey(d); }
  const h = E.hashString(acc.join('|'));
  record('Node ' + process.version + ' (V8)', h === golden.rangeHash ? 'PASS hash=' + h : 'FAIL hash=' + h);
}

// 2. Shell engines
const tmp = mkdtempSync(join(tmpdir(), 'cbw-parity-'));
const scriptPath = join(tmp, 'check.js');
writeFileSync(scriptPath, shellScript(join(root, 'color-engine.js')));
const shells = [
  ['JavaScriptCore (Safari engine)', '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'],
  ['SpiderMonkey (Firefox engine)', 'js'],
  ['SpiderMonkey (Firefox engine)', join(process.env.HOME || '', '.jsvu/bin/spidermonkey')],
  ['SpiderMonkey (Firefox engine)', join(process.env.HOME || '', '.esvu/bin/spidermonkey')]
];
const seen = new Set();
for (const [name, bin] of shells) {
  if (seen.has(name)) continue;
  try {
    const out = execFileSync(bin, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    record(name, out);
    seen.add(name);
  } catch (e) {
    if (e.code !== 'ENOENT' && !/not found/.test(String(e))) { record(name, 'ERROR ' + String(e.stderr || e.message).trim()); seen.add(name); }
  }
}
if (!seen.has('SpiderMonkey (Firefox engine)')) record('SpiderMonkey (Firefox engine)', 'SKIPPED (not installed; open tests/parity.html in Firefox)');

// 3. Headless Chromium-family browsers
const browsers = [
  ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Brave Browser', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium']
];
async function runInBrowser(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'cbw-profile-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, pathToFileURL(join(here, 'parity.html')).href], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const pg = pages.find((t) => t.url.endsWith('parity.html'));
        if (pg && (pg.title === 'PASS' || pg.title === 'FAIL')) return pg.title;
      } catch { /* starting */ }
    }
    return 'ERROR timed out';
  } finally {
    // Wait for the browser to exit before deleting its profile.
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir; OS cleans it */ }
  }
}
for (const [name, bin] of browsers) {
  if (!existsSync(bin)) continue;
  record(name + ' (headless)', await runInBrowser(bin));
}

const failed = results.filter(([, o]) => /^(FAIL|ERROR)/.test(o));
process.exitCode = failed.length ? 1 : 0;
