/*
 * Colorblind Wordle: read-only detection of whether today's Wordle is finished.
 *
 * Based on NYT Wordle's live markup (checked against the current bundle):
 *
 *   div[class*="Board-module_board"]            the game board
 *     div[role="group"][aria-label="Row 1"]     one per guess (6 rows)
 *       div > div[data-testid="tile"]           5 tiles per row
 *             data-state:     empty | tbd | absent | present | correct
 *             data-animation: idle | pop | flip-in | flip-out
 *
 * A row counts as *evaluated* only when Wordle has accepted the guess and
 * finished revealing it: every tile is absent/present/correct and idle.
 * Typed-but-unsubmitted letters ("tbd") and rejected words (which shake and are
 * never evaluated) do not count, so filling rows or guessing wrong cannot
 * complete the game.
 *
 *   win  = some evaluated row is all "correct"
 *   loss = all six rows evaluated, none all "correct"
 *
 * This module only reads the DOM. It never changes Wordle's state.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CBWGameState = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BOARD_SELECTOR = '[class*="Board-module_board"]';
  var ROW_SELECTOR = '[role="group"][aria-label^="Row"]';
  var TILE_SELECTOR = '[data-testid="tile"]';
  var ROW_COUNT = 6;
  var WORD_LENGTH = 5;
  var EVALUATED = { absent: true, present: true, correct: true };

  /** Paths that show today's puzzle (archive puzzles live under /archive). */
  var DAILY_PATHS = ['/games/wordle/index.html', '/games/wordle/', '/games/wordle'];

  function isDailyPuzzlePage(loc) {
    if (!loc || loc.hostname !== 'www.nytimes.com') return false;
    return DAILY_PATHS.indexOf(loc.pathname) !== -1;
  }

  /**
   * Read the board. Returns:
   *   { status: 'absent' }                       no board on the page
   *   { status: 'in-progress', evaluatedRows, fresh }
   *   { status: 'win', evaluatedRows }           evaluatedRows = guesses used
   *   { status: 'loss', evaluatedRows }
   * `fresh` is true when no guess has been evaluated yet.
   */
  function readBoard(doc) {
    var board = doc && doc.querySelector ? doc.querySelector(BOARD_SELECTOR) : null;
    if (!board) return { status: 'absent' };
    var rows = toArray(board.querySelectorAll(ROW_SELECTOR));
    if (rows.length !== ROW_COUNT) return { status: 'absent' };

    var evaluatedRows = 0;
    var won = false;
    for (var r = 0; r < rows.length; r++) {
      var tiles = toArray(rows[r].querySelectorAll(TILE_SELECTOR));
      if (tiles.length !== WORD_LENGTH) return { status: 'absent' };
      var evaluated = true;
      var allCorrect = true;
      for (var t = 0; t < tiles.length; t++) {
        var state = tiles[t].getAttribute('data-state');
        var anim = tiles[t].getAttribute('data-animation');
        if (!EVALUATED[state] || (anim && anim !== 'idle')) evaluated = false;
        if (state !== 'correct') allCorrect = false;
      }
      if (!evaluated) break; // rows fill top to bottom; stop at the first open row
      evaluatedRows++;
      if (allCorrect) { won = true; break; }
    }

    if (won) return { status: 'win', evaluatedRows: evaluatedRows };
    if (evaluatedRows === ROW_COUNT) return { status: 'loss', evaluatedRows: evaluatedRows };
    return { status: 'in-progress', evaluatedRows: evaluatedRows, fresh: evaluatedRows === 0 };
  }

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  return Object.freeze({
    BOARD_SELECTOR: BOARD_SELECTOR,
    readBoard: readBoard,
    isDailyPuzzlePage: isDailyPuzzlePage
  });
});
