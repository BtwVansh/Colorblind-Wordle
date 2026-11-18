/*
 * Colorblind Wordle: deterministic daily colour engine.
 *
 * The palette for a date depends on exactly three inputs:
 *   1. the local calendar date ("YYYY-MM-DD"),
 *   2. APP_SEED, a fixed string shared by every installation,
 *   3. GENERATOR_VERSION, the version of this algorithm.
 *
 * Nothing else is read: no Math.random(), no storage, no device or user data.
 *
 * Cross-engine determinism
 * ------------------------
 * Built-in transcendental functions (Math.pow, Math.cbrt, Math.sin, Math.atan2,
 * Math.exp, ...) are not required to be correctly rounded, so V8 (Chrome) and
 * SpiderMonkey (Firefox) may disagree in the last bit. A last-bit difference
 * could flip a threshold decision (e.g. a Delta E of 34.9999999 vs 35.0000001)
 * and produce different palettes in different browsers.
 *
 * To rule that out, every calculation that influences the result uses only
 * operations IEEE 754 defines exactly (+, -, *, /, Math.sqrt, Math.floor,
 * Math.round, Math.abs, Math.imul, comparisons). The transcendental functions
 * are implemented below ("DMath") from those primitives, so every engine
 * produces bit-identical numbers and therefore identical palettes.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CBWColorEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Fixed, application-wide seed. Changing it changes everyone's palettes. */
  var APP_SEED = 'colorblind-wordle/7f3a9c2e-daily-palette';
  /** Bump when the algorithm changes; it is mixed into the seed. */
  var GENERATOR_VERSION = 1;

  var RULES = Object.freeze({
    minPairDeltaE: 35,      // CIEDE2000 between every pair of tile colours
    minTextContrast: 4.5,   // WCAG 2.x contrast ratio, tile colour vs letter colour
    minLabL: 28,            // reject colours that are too dark
    maxLabL: 82,            // reject colours that are too bright
    minBackgroundDeltaE: 12, // must stand out from Wordle's light and dark page
    minOriginalDeltaE: 15,  // must not look like any of Wordle's own feedback colours
    maxAttempts: 400
  });

  // Wordle's own colours (light and dark theme) and page backgrounds.
  var ORIGINAL_COLOURS = Object.freeze({
    absent: ['#787c7e', '#3a3a3c'],
    present: ['#c9b458', '#b59f3b'],
    correct: ['#6aaa64', '#538d4e']
  });
  var ORIGINAL_LIST = [].concat(ORIGINAL_COLOURS.absent, ORIGINAL_COLOURS.present, ORIGINAL_COLOURS.correct);
  var PAGE_BACKGROUNDS = ['#ffffff', '#121213'];

  // Pre-validated palettes used only if generation fails. Generation has not
  // failed for any date in the tested range, but a fallback must exist. Each
  // entry passes validatePalette() with margin (checked in the test suite).
  var FALLBACK_PALETTES = [
    ['#4cd5a7', '#ac4b1c', '#5825a4'],
    ['#d850a3', '#8fd126', '#3b92b7'],
    ['#6a3187', '#42acb6', '#d98c46'],
    ['#db7b5c', '#4393ef', '#62e05b']
  ];

  var STATES = ['absent', 'present', 'correct'];

  /* ------------------------------------------------------------------ */
  /* Deterministic maths                                                 */
  /* ------------------------------------------------------------------ */

  var PI = 3.141592653589793;
  var TWO_PI = 6.283185307179586;
  var HALF_PI = 1.5707963267948966;
  var LN2 = 0.6931471805599453;

  var DMath = {
    /** e^x via range reduction (x = k ln2 + r) and a Taylor series. */
    exp: function (x) {
      if (x !== x) return NaN;
      if (x > 709) return Infinity;
      if (x < -745) return 0;
      var k = Math.round(x / LN2);
      var r = x - k * LN2;
      var term = 1;
      var sum = 1;
      for (var n = 1; n < 30; n++) {
        term = (term * r) / n;
        sum += term;
      }
      // Scale by 2^k with exact multiplications.
      var scale = k >= 0 ? 2 : 0.5;
      var count = k >= 0 ? k : -k;
      for (var i = 0; i < count; i++) sum *= scale;
      return sum;
    },

    /** Natural log via exact power-of-two reduction and the atanh series. */
    log: function (x) {
      if (x !== x || x < 0) return NaN;
      if (x === 0) return -Infinity;
      if (x === Infinity) return Infinity;
      var e = 0;
      while (x >= 2) { x /= 2; e++; }
      while (x < 1) { x *= 2; e--; }
      // Now 1 <= x < 2; centre the range on sqrt(2) for faster convergence.
      if (x > 1.4142135623730951) { x /= 2; e++; }
      var s = (x - 1) / (x + 1);
      var s2 = s * s;
      var term = s;
      var sum = 0;
      for (var n = 1; n < 60; n += 2) {
        sum += term / n;
        term *= s2;
      }
      return 2 * sum + e * LN2;
    },

    pow: function (base, exponent) {
      if (exponent === 0) return 1;
      if (base === 0) return 0;
      if (base < 0) return NaN;
      return DMath.exp(exponent * DMath.log(base));
    },

    /** Cube root: deterministic first guess refined by Newton steps. */
    cbrt: function (x) {
      if (x === 0) return 0;
      var negative = x < 0;
      var a = negative ? -x : x;
      var y = DMath.exp(DMath.log(a) / 3);
      for (var i = 0; i < 3; i++) y = y - (y * y * y - a) / (3 * y * y);
      return negative ? -y : y;
    },

    /** sin/cos via reduction to [-pi, pi] and Taylor series. */
    sin: function (x) {
      x = reduceAngle(x);
      var term = x;
      var sum = x;
      var x2 = x * x;
      for (var n = 1; n < 25; n++) {
        term = (-term * x2) / ((2 * n) * (2 * n + 1));
        sum += term;
      }
      return sum;
    },

    cos: function (x) {
      x = reduceAngle(x);
      var term = 1;
      var sum = 1;
      var x2 = x * x;
      for (var n = 1; n < 25; n++) {
        term = (-term * x2) / ((2 * n - 1) * (2 * n));
        sum += term;
      }
      return sum;
    },

    /** atan via argument halving and a Maclaurin series. */
    atan: function (x) {
      if (x !== x) return NaN;
      var negative = x < 0;
      if (negative) x = -x;
      var invert = x > 1;
      if (invert) x = 1 / x;
      // atan(x) = 2 atan(x / (1 + sqrt(1 + x^2))); two halvings -> |x| <= 0.2
      var y = x / (1 + Math.sqrt(1 + x * x));
      y = y / (1 + Math.sqrt(1 + y * y));
      var y2 = y * y;
      var term = y;
      var sum = 0;
      for (var n = 0; n < 40; n++) {
        sum += term / (2 * n + 1);
        term = -term * y2;
      }
      var result = 4 * sum;
      if (invert) result = HALF_PI - result;
      return negative ? -result : result;
    },

    atan2: function (y, x) {
      if (x > 0) return DMath.atan(y / x);
      if (x < 0) return y >= 0 ? DMath.atan(y / x) + PI : DMath.atan(y / x) - PI;
      if (y > 0) return HALF_PI;
      if (y < 0) return -HALF_PI;
      return 0;
    }
  };

  function reduceAngle(x) {
    var k = Math.floor((x + PI) / TWO_PI);
    return x - k * TWO_PI;
  }

  /* ------------------------------------------------------------------ */
  /* Seeded PRNG                                                         */
  /* ------------------------------------------------------------------ */

  /** cyrb53-style 32-bit string hash (Math.imul is exact in every engine). */
  function hashString(str) {
    var h1 = 0xdeadbeef ^ str.length;
    var h2 = 0x41c6ce57 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 ^ h2) >>> 0;
  }

  /** Mulberry32 PRNG returning floats in [0, 1). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Colour conversions                                                  */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** HSL (h in degrees, s/l in 0..1) to integer RGB. Arithmetic only. */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    return [
      clamp(Math.round((r + m) * 255), 0, 255),
      clamp(Math.round((g + m) * 255), 0, 255),
      clamp(Math.round((b + m) * 255), 0, 255)
    ];
  }

  function rgbToHex(rgb) {
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = rgb[i].toString(16);
      out += v.length === 1 ? '0' + v : v;
    }
    return out;
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) throw new Error('Invalid hex colour: ' + hex);
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** sRGB channel (0..255) to linear light (0..1). */
  function srgbToLinear(channel) {
    var c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : DMath.pow((c + 0.055) / 1.055, 2.4);
  }

  /** WCAG relative luminance. */
  function relativeLuminance(rgb) {
    return (
      0.2126 * srgbToLinear(rgb[0]) +
      0.7152 * srgbToLinear(rgb[1]) +
      0.0722 * srgbToLinear(rgb[2])
    );
  }

  /** WCAG contrast ratio between two RGB colours (1..21). */
  function contrastRatio(rgbA, rgbB) {
    var la = relativeLuminance(rgbA);
    var lb = relativeLuminance(rgbB);
    var hi = la > lb ? la : lb;
    var lo = la > lb ? lb : la;
    return (hi + 0.05) / (lo + 0.05);
  }

  // D65 reference white.
  var XN = 0.95047, YN = 1.0, ZN = 1.08883;

  function labF(t) {
    var delta = 6 / 29;
    return t > delta * delta * delta ? DMath.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
  }

  /** sRGB (0..255) to CIE L*a*b* (D65). */
  function rgbToLab(rgb) {
    var r = srgbToLinear(rgb[0]);
    var g = srgbToLinear(rgb[1]);
    var b = srgbToLinear(rgb[2]);
    var x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    var y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    var z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
    var fx = labF(x / XN);
    var fy = labF(y / YN);
    var fz = labF(z / ZN);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  var DEG = PI / 180;

  /** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
  function deltaE2000(lab1, lab2) {
    var L1 = lab1[0], a1 = lab1[1], b1 = lab1[2];
    var L2 = lab2[0], a2 = lab2[1], b2 = lab2[2];

    var C1 = Math.sqrt(a1 * a1 + b1 * b1);
    var C2 = Math.sqrt(a2 * a2 + b2 * b2);
    var Cbar = (C1 + C2) / 2;
    var Cbar7 = pow7(Cbar);
    var G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7

    var a1p = (1 + G) * a1;
    var a2p = (1 + G) * a2;
    var C1p = Math.sqrt(a1p * a1p + b1 * b1);
    var C2p = Math.sqrt(a2p * a2p + b2 * b2);

    var h1p = hueDegrees(b1, a1p);
    var h2p = hueDegrees(b2, a2p);

    var dLp = L2 - L1;
    var dCp = C2p - C1p;

    var dhp;
    if (C1p * C2p === 0) dhp = 0;
    else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
    else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
    else dhp = h2p - h1p + 360;
    var dHp = 2 * Math.sqrt(C1p * C2p) * DMath.sin((dhp / 2) * DEG);

    var Lbarp = (L1 + L2) / 2;
    var Cbarp = (C1p + C2p) / 2;

    var hbarp;
    if (C1p * C2p === 0) hbarp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;

    var T =
      1 -
      0.17 * DMath.cos((hbarp - 30) * DEG) +
      0.24 * DMath.cos(2 * hbarp * DEG) +
      0.32 * DMath.cos((3 * hbarp + 6) * DEG) -
      0.2 * DMath.cos((4 * hbarp - 63) * DEG);

    var dTheta = 30 * DMath.exp(-((hbarp - 275) / 25) * ((hbarp - 275) / 25));
    var Cbarp7 = pow7(Cbarp);
    var Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
    var Lm50sq = (Lbarp - 50) * (Lbarp - 50);
    var Sl = 1 + (0.015 * Lm50sq) / Math.sqrt(20 + Lm50sq);
    var Sc = 1 + 0.045 * Cbarp;
    var Sh = 1 + 0.015 * Cbarp * T;
    var Rt = -DMath.sin(2 * dTheta * DEG) * Rc;

    var tl = dLp / Sl;
    var tc = dCp / Sc;
    var th = dHp / Sh;
    return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
  }

  function pow7(x) {
    var x2 = x * x;
    var x4 = x2 * x2;
    return x4 * x2 * x;
  }

  function hueDegrees(b, a) {
    if (a === 0 && b === 0) return 0;
    var h = DMath.atan2(b, a) / DEG;
    return h < 0 ? h + 360 : h;
  }

  function deltaEHex(hexA, hexB) {
    return deltaE2000(rgbToLab(hexToRgb(hexA)), rgbToLab(hexToRgb(hexB)));
  }

  /* ------------------------------------------------------------------ */
  /* Text colour and validation                                          */
  /* ------------------------------------------------------------------ */

  var BLACK = [0, 0, 0];
  var WHITE = [255, 255, 255];

  /** Pick black or white letters, whichever has the higher WCAG contrast. */
  function pickTextColour(hex) {
    var rgb = hexToRgb(hex);
    var onWhite = contrastRatio(rgb, WHITE);
    var onBlack = contrastRatio(rgb, BLACK);
    return onWhite >= onBlack
      ? { text: '#ffffff', contrast: onWhite }
      : { text: '#000000', contrast: onBlack };
  }

  /**
   * Check a palette against every rule. Returns { valid, reasons, metrics }.
   * `colours` is [absentHex, presentHex, correctHex].
   */
  function validatePalette(colours) {
    var reasons = [];
    var labs = colours.map(function (hex) { return rgbToLab(hexToRgb(hex)); });
    var lower = colours.map(function (hex) { return hex.toLowerCase(); });

    if (lower[0] === lower[1] || lower[0] === lower[2] || lower[1] === lower[2]) {
      reasons.push('duplicate hex value');
    }

    var pairs = [[0, 1], [0, 2], [1, 2]];
    var minPair = Infinity;
    pairs.forEach(function (p) {
      var d = deltaE2000(labs[p[0]], labs[p[1]]);
      if (d < minPair) minPair = d;
      if (d < RULES.minPairDeltaE) {
        reasons.push(STATES[p[0]] + '/' + STATES[p[1]] + ' deltaE ' + d.toFixed(2) + ' < ' + RULES.minPairDeltaE);
      }
    });

    var texts = [];
    var minContrast = Infinity;
    colours.forEach(function (hex, i) {
      var L = labs[i][0];
      if (L < RULES.minLabL) reasons.push(STATES[i] + ' too dark (L*=' + L.toFixed(1) + ')');
      if (L > RULES.maxLabL) reasons.push(STATES[i] + ' too bright (L*=' + L.toFixed(1) + ')');

      var t = pickTextColour(hex);
      texts.push(t.text);
      if (t.contrast < minContrast) minContrast = t.contrast;
      if (t.contrast < RULES.minTextContrast) {
        reasons.push(STATES[i] + ' text contrast ' + t.contrast.toFixed(2) + ' < ' + RULES.minTextContrast);
      }

      PAGE_BACKGROUNDS.forEach(function (bg) {
        var d = deltaE2000(labs[i], rgbToLab(hexToRgb(bg)));
        if (d < RULES.minBackgroundDeltaE) reasons.push(STATES[i] + ' too close to page background ' + bg);
      });

      // Must not resemble any of Wordle's own gray, yellow or green.
      ORIGINAL_LIST.forEach(function (orig) {
        var d = deltaE2000(labs[i], rgbToLab(hexToRgb(orig)));
        if (d < RULES.minOriginalDeltaE) reasons.push(STATES[i] + ' too close to Wordle original ' + orig);
      });
    });

    return {
      valid: reasons.length === 0,
      reasons: reasons,
      texts: texts,
      metrics: { minPairDeltaE: minPair, minTextContrast: minContrast }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  /** One candidate palette: three hues spread around the wheel, shuffled. */
  function candidate(rng) {
    var baseHue = rng() * 360;
    var hues = [0, 1, 2].map(function (i) {
      return baseHue + i * 120 + (rng() - 0.5) * 50; // +/-25 deg jitter
    });
    // Fisher-Yates shuffle so no state is tied to a fixed hue offset.
    for (var i = hues.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = hues[i]; hues[i] = hues[j]; hues[j] = tmp;
    }
    return hues.map(function (h) {
      var s = 0.45 + rng() * 0.4;  // 45-85 % saturation: colourful, not neon
      var l = 0.34 + rng() * 0.3;  // 34-64 % lightness
      return rgbToHex(hslToRgb(h, s, l));
    });
  }

  function buildPalette(date, colours, validation, source, attempt) {
    return {
      date: date,
      version: GENERATOR_VERSION,
      absent: colours[0],
      present: colours[1],
      correct: colours[2],
      absentText: validation.texts[0],
      presentText: validation.texts[1],
      correctText: validation.texts[2],
      source: source,
      attempt: attempt,
      minDeltaE: Math.round(validation.metrics.minPairDeltaE * 100) / 100,
      minContrast: Math.round(validation.metrics.minTextContrast * 100) / 100
    };
  }

  /** Generate a palette from any seed string. Pure and deterministic. */
  function generateFromSeed(seedString, label) {
    var seed = hashString(APP_SEED + '|v' + GENERATOR_VERSION + '|' + seedString);
    var rng = mulberry32(seed);
    for (var attempt = 1; attempt <= RULES.maxAttempts; attempt++) {
      var colours = candidate(rng);
      var result = validatePalette(colours);
      if (result.valid) return buildPalette(label, colours, result, 'generated', attempt);
    }
    var fallback = FALLBACK_PALETTES[seed % FALLBACK_PALETTES.length];
    return buildPalette(label, fallback.slice(), validatePalette(fallback), 'fallback', 0);
  }

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function assertDateKey(dateKey) {
    var m = DATE_RE.exec(dateKey);
    if (!m) throw new Error('Date must be YYYY-MM-DD, got: ' + dateKey);
    var month = +m[2], day = +m[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid date: ' + dateKey);
  }

  /** The official palette for a local calendar date ("YYYY-MM-DD"). */
  function getPaletteForDate(dateKey) {
    assertDateKey(dateKey);
    return generateFromSeed('daily|' + dateKey, dateKey);
  }

  /**
   * A throwaway preview palette for the popup's "shuffle preview" button.
   * Uses a separate seed namespace so it can never equal or replace the
   * official daily palette.
   */
  function getPreviewPalette(dateKey, index) {
    assertDateKey(dateKey);
    return generateFromSeed('preview|' + dateKey + '|' + index, dateKey);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** Local calendar date of a Date object as "YYYY-MM-DD" (never UTC). */
  function localDateKey(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** The date key for the day after `dateKey`, using calendar arithmetic. */
  function nextDateKey(dateKey) {
    assertDateKey(dateKey);
    var m = DATE_RE.exec(dateKey);
    // Noon avoids any DST edge; only the calendar fields are used.
    var d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
    d.setDate(d.getDate() + 1);
    return localDateKey(d);
  }

  /** Milliseconds until the next local midnight. */
  function msUntilNextLocalMidnight(now) {
    var n = now || new Date();
    var next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0);
    return next.getTime() - n.getTime();
  }

  function getTodayPalette(now) {
    return getPaletteForDate(localDateKey(now));
  }

  return Object.freeze({
    APP_SEED: APP_SEED,
    GENERATOR_VERSION: GENERATOR_VERSION,
    RULES: RULES,
    STATES: STATES.slice(),
    FALLBACK_PALETTES: FALLBACK_PALETTES.map(function (p) { return p.slice(); }),
    getPaletteForDate: getPaletteForDate,
    getTodayPalette: getTodayPalette,
    getPreviewPalette: getPreviewPalette,
    localDateKey: localDateKey,
    nextDateKey: nextDateKey,
    msUntilNextLocalMidnight: msUntilNextLocalMidnight,
    validatePalette: validatePalette,
    pickTextColour: pickTextColour,
    contrastRatio: contrastRatio,
    deltaE2000: deltaE2000,
    deltaEHex: deltaEHex,
    rgbToLab: rgbToLab,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    hslToRgb: hslToRgb,
    hashString: hashString,
    mulberry32: mulberry32,
    DMath: DMath
  });
});
