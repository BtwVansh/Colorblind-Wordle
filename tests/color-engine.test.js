'use strict';
// Unit tests for color-engine.js. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ENGINE_PATH = path.join(__dirname, '..', 'color-engine.js');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');
const Engine = require(ENGINE_PATH);
const golden = require('./golden.json');

function triple(p) {
  return [p.absent, p.present, p.correct, p.absentText, p.presentText, p.correctText];
}

function eachDate(start, days, fn) {
  let d = start;
  for (let i = 0; i < days; i++) {
    fn(d, i);
    d = Engine.nextDateKey(d);
  }
}

/**
 * Load the engine in a fresh, isolated JS realm that looks like a different
 * installation: different (poisoned) Math.random, different storage contents,
 * different user agent and device identifiers.
 */
function loadAsInstallation(id) {
  const sandbox = {
    navigator: { userAgent: 'Installation/' + id, hardwareConcurrency: id, deviceMemory: id },
    localStorage: { getItem: () => 'install-' + id, setItem() {} },
    chrome: { runtime: { id: 'ext-' + id } },
    installationId: 'uuid-' + Math.floor(Math.random() * 1e9),
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('Math.random = function () { throw new Error("Math.random must not be used"); };', sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: 'color-engine.js' });
  return sandbox.CBWColorEngine;
}

test('identical dates always produce identical palettes', () => {
  for (const date of ['2026-11-18', '2026-11-19', '2030-06-01']) {
    const a = Engine.getPaletteForDate(date);
    for (let i = 0; i < 25; i++) assert.deepEqual(Engine.getPaletteForDate(date), a);
  }
});

test('simulated installations get identical palettes on the same date', () => {
  const installs = [1, 2, 3, 4, 5].map(loadAsInstallation);
  eachDate('2026-11-01', 60, (date) => {
    const reference = triple(Engine.getPaletteForDate(date));
    for (const inst of installs) assert.deepEqual(triple(inst.getPaletteForDate(date)), reference, date);
  });
});

test('Math.random is never called', () => {
  const inst = loadAsInstallation(99); // Math.random throws in this realm
  assert.doesNotThrow(() => {
    eachDate('2026-01-01', 365, (d) => inst.getPaletteForDate(d));
    inst.getPreviewPalette('2026-11-18', 3);
  });
});

test('golden vectors match (the cross-browser reference values)', () => {
  assert.equal(Engine.GENERATOR_VERSION, golden.generatorVersion);
  for (const [date, expected] of Object.entries(golden.vectors)) {
    assert.deepEqual(triple(Engine.getPaletteForDate(date)), expected, date);
  }
  const acc = [];
  eachDate(golden.rangeStart, golden.rangeDays, (d) => {
    const p = Engine.getPaletteForDate(d);
    acc.push(p.absent + p.present + p.correct);
  });
  assert.equal(Engine.hashString(acc.join('|')), golden.rangeHash);
});

test('different dates produce different palettes (10 years)', () => {
  const seen = new Map();
  let previous = null;
  eachDate('2024-01-01', 3653, (date) => {
    const p = Engine.getPaletteForDate(date);
    const key = p.absent + p.present + p.correct;
    assert.ok(!seen.has(key), date + ' repeats ' + seen.get(key));
    seen.set(key, date);
    if (previous) assert.notEqual(key, previous, 'consecutive days must differ: ' + date);
    previous = key;
  });
});

test('every palette meets Delta E, contrast, brightness and uniqueness rules (10 years)', () => {
  const R = Engine.RULES;
  let generated = 0;
  eachDate('2024-01-01', 3653, (date) => {
    const p = Engine.getPaletteForDate(date);
    const hexes = [p.absent, p.present, p.correct];
    assert.equal(new Set(hexes).size, 3, date + ' has duplicate hex');
    hexes.forEach((h) => assert.match(h, /^#[0-9a-f]{6}$/));
    [[0, 1], [0, 2], [1, 2]].forEach(([i, j]) => {
      const d = Engine.deltaEHex(hexes[i], hexes[j]);
      assert.ok(d >= R.minPairDeltaE, `${date} pair ${i}/${j} deltaE ${d}`);
    });
    hexes.forEach((h, i) => {
      const text = [p.absentText, p.presentText, p.correctText][i];
      assert.ok(text === '#000000' || text === '#ffffff');
      const c = Engine.contrastRatio(Engine.hexToRgb(h), Engine.hexToRgb(text));
      assert.ok(c >= R.minTextContrast, `${date} ${h} on ${text} contrast ${c}`);
      // The chosen text colour is the better of black/white.
      const other = text === '#000000' ? '#ffffff' : '#000000';
      assert.ok(c >= Engine.contrastRatio(Engine.hexToRgb(h), Engine.hexToRgb(other)));
      const L = Engine.rgbToLab(Engine.hexToRgb(h))[0];
      assert.ok(L >= R.minLabL && L <= R.maxLabL, `${date} ${h} L*=${L}`);
    });
    assert.ok(Engine.validatePalette(hexes).valid, date);
    if (p.source === 'generated') generated++;
  });
  assert.equal(generated, 3653, 'no date should need the fallback palette');
});

test('palette record contains all required fields', () => {
  const p = Engine.getPaletteForDate('2026-11-18');
  for (const k of ['date', 'version', 'absent', 'present', 'correct', 'absentText', 'presentText', 'correctText']) {
    assert.ok(k in p, k);
  }
  assert.equal(p.date, '2026-11-18');
  assert.equal(p.version, Engine.GENERATOR_VERSION);
});

test('fallback palettes are all valid', () => {
  assert.ok(Engine.FALLBACK_PALETTES.length >= 1);
  for (const p of Engine.FALLBACK_PALETTES) {
    const v = Engine.validatePalette(p);
    assert.ok(v.valid, p.join(',') + ': ' + v.reasons.join('; '));
  }
});

test('validator rejects bad palettes', () => {
  assert.ok(!Engine.validatePalette(['#3366cc', '#3366cc', '#cc6633']).valid, 'duplicates');
  assert.ok(!Engine.validatePalette(['#3366cc', '#3a6dd0', '#cc6633']).valid, 'too similar');
  assert.ok(!Engine.validatePalette(['#050505', '#cc6633', '#33aa99']).valid, 'too dark');
  assert.ok(!Engine.validatePalette(['#fbfbfb', '#cc6633', '#3366cc']).valid, 'too bright');
  assert.ok(!Engine.validatePalette(['#787c7e', '#c9b458', '#6aaa64']).valid, 'Wordle originals');
});

test('preview palettes never alter or equal the official palette', () => {
  const date = '2026-11-18';
  const official = JSON.stringify(Engine.getPaletteForDate(date));
  for (let i = 1; i <= 30; i++) {
    const preview = Engine.getPreviewPalette(date, i);
    assert.notEqual(preview.absent + preview.present + preview.correct,
      JSON.parse(official).absent + JSON.parse(official).present + JSON.parse(official).correct);
    assert.ok(Engine.validatePalette([preview.absent, preview.present, preview.correct]).valid);
  }
  assert.equal(JSON.stringify(Engine.getPaletteForDate(date)), official);
});

test('date keys use the local calendar date, not UTC', () => {
  // A fixed instant: 2026-11-18T23:30:00Z. In UTC+14 it is already Nov 19;
  // in UTC-10 it is still Nov 18 (13:30).
  const script = `const E=require(${JSON.stringify(ENGINE_PATH)});process.stdout.write(E.localDateKey(new Date(Date.UTC(2026,10,18,23,30))))`;
  const run = (tz) => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } }).toString();
  assert.equal(run('Pacific/Kiritimati'), '2026-11-19');
  assert.equal(run('Pacific/Honolulu'), '2026-11-18');
  assert.equal(run('UTC'), '2026-11-18');
  // Built from local fields:
  assert.equal(Engine.localDateKey(new Date(2026, 10, 18, 0, 0, 1)), '2026-11-18');
  assert.equal(Engine.localDateKey(new Date(2026, 10, 18, 23, 59, 59)), '2026-11-18');
});

test('same local date in different time zones gives the same palette', () => {
  const script = `const E=require(${JSON.stringify(ENGINE_PATH)});const p=E.getTodayPalette(new Date(2026,10,18,9,0));process.stdout.write(p.absent+p.present+p.correct)`;
  const outputs = ['Asia/Kolkata', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney'].map((tz) =>
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } }).toString());
  assert.equal(new Set(outputs).size, 1);
  const p = Engine.getPaletteForDate('2026-11-18');
  assert.equal(outputs[0], p.absent + p.present + p.correct);
});

test('nextDateKey handles month, year, leap-year and DST boundaries', () => {
  assert.equal(Engine.nextDateKey('2026-11-18'), '2026-11-19');
  assert.equal(Engine.nextDateKey('2026-11-30'), '2026-12-01');
  assert.equal(Engine.nextDateKey('2026-12-31'), '2027-01-01');
  assert.equal(Engine.nextDateKey('2028-02-28'), '2028-02-29');
  assert.equal(Engine.nextDateKey('2027-02-28'), '2027-03-01');
  assert.equal(Engine.nextDateKey('2026-03-08'), '2026-03-09'); // US DST start
  assert.equal(Engine.nextDateKey('2026-10-25'), '2026-10-26'); // EU DST end
  assert.throws(() => Engine.getPaletteForDate('18/11/2026'));
});

test('msUntilNextLocalMidnight points at the next local midnight', () => {
  const now = new Date(2026, 10, 18, 23, 59, 0);
  assert.equal(Engine.msUntilNextLocalMidnight(now), 60 * 1000);
  const after = new Date(now.getTime() + Engine.msUntilNextLocalMidnight(now));
  assert.equal(Engine.localDateKey(after), '2026-11-19');
});

test('CIEDE2000 matches the Sharma et al. reference data', () => {
  const cases = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]
  ];
  for (const [a, b, expected] of cases) {
    assert.ok(Math.abs(Engine.deltaE2000(a, b) - expected) < 1e-4, `${a} vs ${b}`);
    assert.ok(Math.abs(Engine.deltaE2000(b, a) - expected) < 1e-4, 'symmetry');
  }
});

test('WCAG contrast matches known values', () => {
  const close = (a, b) => Math.abs(a - b) < 0.01;
  assert.ok(close(Engine.contrastRatio([0, 0, 0], [255, 255, 255]), 21));
  assert.ok(close(Engine.contrastRatio([118, 118, 118], [255, 255, 255]), 4.54));
  assert.ok(close(Engine.contrastRatio([255, 255, 255], [255, 255, 255]), 1));
});

test('deterministic maths agrees with built-in Math to ~1e-14', () => {
  const D = Engine.DMath;
  let worst = 0;
  for (let x = -25; x <= 25; x += 0.0173) {
    worst = Math.max(worst, Math.abs(D.sin(x) - Math.sin(x)), Math.abs(D.cos(x) - Math.cos(x)), Math.abs(D.atan(x) - Math.atan(x)));
    worst = Math.max(worst, Math.abs(D.exp(x) / Math.exp(x) - 1));
  }
  for (let x = 1e-4; x <= 50; x *= 1.013) {
    worst = Math.max(worst, Math.abs(D.log(x) - Math.log(x)), Math.abs(D.cbrt(x) / Math.cbrt(x) - 1),
      Math.abs(D.pow(x, 2.4) / Math.pow(x, 2.4) - 1));
  }
  for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0, -1], [3, 0], [-3, 0]]) {
    worst = Math.max(worst, Math.abs(D.atan2(y, x) - Math.atan2(y, x)));
  }
  assert.ok(worst < 1e-13, 'worst error ' + worst);
});

test('engine source does not use Math.random or engine-dependent Math functions in the palette path', () => {
  const code = ENGINE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/(?<![A-Za-z])Math\.random/.test(code));
  for (const fn of ['pow', 'cbrt', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'hypot']) {
    assert.ok(!new RegExp('(?<![A-Za-z])Math\\.' + fn + '\\(').test(code), 'Math.' + fn + ' is not cross-engine deterministic');
  }
});
