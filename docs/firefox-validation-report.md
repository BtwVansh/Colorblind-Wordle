# Firefox validation report

**Package:** `dist/colorblind-wordle-firefox.zip`, version 1.1.1, 14 files
**Date:** 18 November 2026 (re-run for 1.1.1 after fixing the Firefox content-script bug)
**Linter:** Mozilla `web-ext` 10.8.0 (`web-ext lint`, the same addons-linter AMO uses)

## Summary

| Check | Result |
|---|---|
| `web-ext lint` on `dist/firefox/` | **0 errors, 0 warnings, 0 notices** |
| `web-ext lint` on the extracted upload ZIP | **0 errors, 0 warnings, 0 notices** |
| ZIP integrity (`unzip -t`) | No errors |
| `manifest.json` at archive root | Yes |
| Manifest JSON validity | Valid; MV3, version 1.1.1 |
| Files referenced by manifest and popup HTML | All present |
| JavaScript syntax (`node --check`, 6 files) | All pass |
| Remote URLs or external dependencies in package | None fetched. The only URLs are the Wordle match pattern, the SVG namespace identifier and the popup's GitHub link (an ordinary link the user clicks) |
| Permissions | `storage`, plus `host_permissions` for exactly the content script match (`https://www.nytimes.com/games/wordle/*`) |
| Content script match | `https://www.nytimes.com/games/wordle/*` |
| Excluded from package | tests, scripts, docs, `package.json`, Chrome manifest, dotfiles, `node_modules`, source maps (none exist) |
| Compared with `web-ext build` output | Same 14 runtime files, byte-identical |
| Unit and integration tests (`npm test`) | 69/69 pass, including a Firefox-mode run (separate `window` object, callback-rejecting `browser.storage`) |
| Popup in a real browser (`tests/popup-browser.mjs`) | All checks pass (locked and unlocked states, previews, GitHub link) |
| Live Wordle, win and loss paths (`tests/live-wordle.mjs`) | All checks pass in headless Brave |
| Palette determinism across engines | V8 (Node), JavaScriptCore and headless Brave all match the golden hash `1465286938` across 3,653 days |

## Issues found and fixed

| Issue | Fix |
|---|---|
| Lint warning `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`: `data_collection_permissions` needs Firefox 140, but `strict_min_version` was 128 | Raised `gecko.strict_min_version` to **140.0** |
| Lint warning `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: the same key needs Firefox for Android 142 | Added `gecko_android.strict_min_version` **142.0**, so desktop 140 ESR stays supported |
| The Firefox ZIP name included the version, so the upload file name changed with every release | It is now always `dist/colorblind-wordle-firefox.zip` |
| Dotfiles such as `.DS_Store` could end up in the package | The build skips dotfiles; tested by planting a `.DS_Store` |
| **1.1.1 — the extension did nothing in Firefox.** `content.js` looked up its modules on `window`, but in Firefox content scripts `window` is an Xray wrapper rather than the global scope where the modules live, so the lookup returned `undefined` and the script exited. The board kept Wordle's colours and completion was never detected, while the popup still showed "On" | `content.js` and the popup read the modules from `globalThis`. A Firefox-mode integration test reproduced the failure before the fix and passes after it |
| **1.1.1 — Firefox storage calls passed callbacks** to the promise-only `browser.storage`, which Firefox rejects, so nothing could be saved | `storage.js` calls `browser.*` promise-style and `chrome.*` with callbacks |
| **1.1.1 — the popup said "On" without proof** | The popup checks Firefox site access (with an **Allow on Wordle** button) and asks the active Wordle tab's content script whether it is running |

No lint warnings remain.

## Not verified

- **The extension has not been run in a real Firefox.** Firefox is not installed on the build machine, so the SpiderMonkey parity check and a live Wordle run in Firefox were skipped. Everything Firefox-specific has been checked statically and with simulated APIs: the lint, the promise-based storage code path, and the manifest. The same extension code passes every check on the live NYT Wordle in Chromium. To confirm in Firefox:
  1. Open `tests/parity.html` in Firefox. It must say **RESULT: PASS**, which proves Firefox computes the same palettes.
  2. Load `dist/firefox/manifest.json` at `about:debugging#/runtime/this-firefox`, open Wordle, make a guess, and check that the tiles, the keys and the popup show the same hex codes.
- AMO's server-side validator and human review run only after upload. It uses the same linter as `web-ext lint`, so no new issues are expected.
