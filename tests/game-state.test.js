'use strict';
// Unit tests for game-state.js (completion detection), notice.js (which notice
// to show) and the completion helpers in storage.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GameState = require(path.join(ROOT, 'game-state.js'));
const Notice = require(path.join(ROOT, 'notice.js'));
const Storage = require(path.join(ROOT, 'storage.js'));

/** Build a fake document whose board matches Wordle's markup. */
function docWithBoard(rows, { rowCount = 6, flipping = [] } = {}) {
  const map = { a: 'absent', p: 'present', c: 'correct', t: 'tbd', '.': 'empty' };
  const rowEls = [];
  for (let r = 0; r < rowCount; r++) {
    const spec = rows[r] || '.....';
    const tiles = spec.split('').map((ch) => ({
      getAttribute: (k) => (k === 'data-state' ? map[ch] : k === 'data-animation' ? (flipping.includes(r) ? 'flip-out' : 'idle') : null)
    }));
    rowEls.push({ querySelectorAll: (sel) => (sel === '[data-testid="tile"]' ? tiles : []) });
  }
  const board = { querySelectorAll: (sel) => (sel === '[role="group"][aria-label^="Row"]' ? rowEls : []) };
  return { querySelector: (sel) => (sel === GameState.BOARD_SELECTOR ? board : null) };
}

/* ---------------- completion detection ---------------- */

test('no board on the page reads as absent', () => {
  assert.equal(GameState.readBoard({ querySelector: () => null }).status, 'absent');
  assert.equal(GameState.readBoard(null).status, 'absent');
});

test('an empty board is a fresh game in progress', () => {
  assert.deepEqual(GameState.readBoard(docWithBoard([])), { status: 'in-progress', evaluatedRows: 0, fresh: true });
});

test('a winning row completes the game (win), in any row', () => {
  assert.deepEqual(GameState.readBoard(docWithBoard(['ccccc'])), { status: 'win', evaluatedRows: 1 });
  assert.deepEqual(GameState.readBoard(docWithBoard(['apaac', 'cpcaa', 'ccccc'])), { status: 'win', evaluatedRows: 3 });
  assert.deepEqual(GameState.readBoard(docWithBoard(['aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'ccccc'])), { status: 'win', evaluatedRows: 6 });
});

test('six evaluated rows without a win completes the game (loss)', () => {
  assert.deepEqual(GameState.readBoard(docWithBoard(['aaaaa', 'paaaa', 'cpaaa', 'ccpaa', 'cccpa', 'ccccp'])), { status: 'loss', evaluatedRows: 6 });
});

test('six filled but unsubmitted rows do not complete the game', () => {
  const r = GameState.readBoard(docWithBoard(['aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'ttttt']));
  assert.equal(r.status, 'in-progress');
  assert.equal(r.evaluatedRows, 5);
});

test('incorrect guesses keep the game in progress', () => {
  assert.equal(GameState.readBoard(docWithBoard(['apaac', 'ccacc'])).status, 'in-progress');
  assert.equal(GameState.readBoard(docWithBoard(['apaac', 'ttttt'])).status, 'in-progress'); // rejected word stays "tbd"
});

test('a row still flipping does not count until the reveal finishes', () => {
  assert.equal(GameState.readBoard(docWithBoard(['ccccc'], { flipping: [0] })).status, 'in-progress');
  assert.equal(GameState.readBoard(docWithBoard(['aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aaaaa'], { flipping: [5] })).status, 'in-progress');
});

test('a board with an unexpected shape is treated as absent, not as finished', () => {
  assert.equal(GameState.readBoard(docWithBoard(['ccccc'], { rowCount: 5 })).status, 'absent');
  assert.equal(GameState.readBoard(docWithBoard(['cccc'])).status, 'absent');
});

test('only the daily puzzle page counts, not the archive or other hosts', () => {
  const loc = (pathname, hostname = 'www.nytimes.com') => ({ hostname, pathname });
  assert.ok(GameState.isDailyPuzzlePage(loc('/games/wordle/index.html')));
  assert.ok(GameState.isDailyPuzzlePage(loc('/games/wordle/')));
  assert.ok(!GameState.isDailyPuzzlePage(loc('/games/wordle/archive')));
  assert.ok(!GameState.isDailyPuzzlePage(loc('/games/wordle/archive/2026-11-01')));
  assert.ok(!GameState.isDailyPuzzlePage(loc('/games/wordle/index.html', 'evil.example')));
});

/* ---------------- notice rules ---------------- */

test('first activation shows the welcome notice', () => {
  assert.equal(Notice.decide(true, { welcomedAt: null, lastNoticeAt: null }, 1000), 'welcome');
  assert.equal(Notice.decide(true, null, 1000), 'welcome');
});

test('later visits show the working notice at most once per cooldown', () => {
  const t0 = Date.UTC(2026, 10, 18, 9);
  const seen = { welcomedAt: t0, lastNoticeAt: t0 };
  assert.equal(Notice.decide(true, seen, t0 + 60 * 1000), null, 'refresh a minute later: nothing');
  assert.equal(Notice.decide(true, seen, t0 + Notice.NOTICE_COOLDOWN_MS - 1), null);
  assert.equal(Notice.decide(true, seen, t0 + Notice.NOTICE_COOLDOWN_MS), 'working');
  assert.equal(Notice.decide(true, seen, t0 - 1000), 'working', 'clock moved backwards');
});

test('no notice while the extension is turned off', () => {
  assert.equal(Notice.decide(false, null, 1000), null);
  assert.equal(Notice.decide(false, { welcomedAt: 1, lastNoticeAt: 1 }, 1e12), null);
});

test('notice copy matches the spec and never contains colours', () => {
  assert.equal(Notice.CONTENT.welcome.title, 'Welcome to Colorblind Wordle!');
  assert.deepEqual(Notice.CONTENT.welcome.lines, ['Your extension has been successfully loaded.', "Today's Wordle will have a different colour palette. Good luck!"]);
  assert.equal(Notice.CONTENT.working.title, 'Colorblind Wordle is working!');
  assert.deepEqual(Notice.CONTENT.working.lines, ["It's on. Enjoy today's challenge."]);
  assert.equal(Notice.CONTENT.working.action, 'Turn off');
  assert.ok(!/#[0-9a-f]{6}/i.test(JSON.stringify(Notice.CONTENT)));
  for (const ms of Object.values(Notice.DURATION_MS)) assert.ok(ms >= 3000 && ms <= 10000, 'auto-dismiss after a few seconds');
});

/* ---------------- unlock rules ---------------- */

test('the palette is unlocked only for the exact completed date', () => {
  const c = { completedDate: '2026-11-18', result: 'win', guesses: 3 };
  assert.ok(Storage.isUnlockedFor(c, '2026-11-18'));
  assert.ok(!Storage.isUnlockedFor(c, '2026-11-19'), 'next day starts locked');
  assert.ok(!Storage.isUnlockedFor(c, '2026-11-17'));
  assert.ok(Storage.isUnlockedFor({ completedDate: '2026-11-18', result: 'loss' }, '2026-11-18'), 'losing unlocks too');
});

test('malformed completion records never unlock', () => {
  for (const bad of [null, undefined, {}, { completedDate: '2026-11-18' }, { completedDate: '2026-11-18', result: 'in-progress' },
    { completedDate: 'today', result: 'win' }, { completedDate: 20261118, result: 'win' }, 'unlocked']) {
    assert.ok(!Storage.isUnlockedFor(bad, '2026-11-18'), JSON.stringify(bad));
  }
});

test('recordCompletion writes once per date and rejects bad input', async () => {
  const data = {};
  const api = {
    storage: {
      local: {
        get: (k) => Promise.resolve(k in data ? { [k]: data[k] } : {}),
        set: (items) => { Object.assign(data, JSON.parse(JSON.stringify(items))); return Promise.resolve(); }
      }
    }
  };
  const S = Storage.createStorage(api, { promises: true });
  assert.equal(await S.recordCompletion('2026-11-18', 'win', 4), true);
  assert.equal(await S.recordCompletion('2026-11-18', 'loss', 6), false, 'same date is not overwritten');
  assert.equal((await S.getCompletion()).result, 'win');
  assert.equal(await S.recordCompletion('2026-11-19', 'maybe', 1), false);
  assert.equal(await S.recordCompletion('19/11/2026', 'win', 1), false);
  assert.equal(await S.recordCompletion('2026-11-19', 'loss', 6), true, 'a new date replaces the record');
  assert.deepEqual(await S.getCompletion(), { completedDate: '2026-11-19', result: 'loss', guesses: 6 });
});
