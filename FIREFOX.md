# Colorblind Wordle for Firefox: build and AMO submission

## The upload file

```
dist/colorblind-wordle-firefox.zip
```

This is the file you upload to addons.mozilla.org (AMO). `manifest.json` sits at the root of the archive, and it contains only the 14 runtime files:

```
manifest.json          (from manifest.firefox.json)
color-engine.js  storage.js  game-state.js  notice.js  content.js  styles.css
popup/popup.html  popup/popup.css  popup/popup.js
icons/icon16.png  icons/icon32.png  icons/icon48.png  icons/icon128.png
```

Tests, scripts, docs, `package.json`, the Chrome manifest, dotfiles and `node_modules` are never packaged. The unpacked build is in `dist/firefox/`; load that folder in `about:debugging` for local testing.

## Build

You need Node 22.2 or later. There are no npm dependencies and no compile step, because the extension is plain JavaScript, HTML and CSS.

```bash
npm run build:firefox      # writes dist/firefox/ and dist/colorblind-wordle-firefox.zip
npm run lint:firefox       # builds, then runs Mozilla's web-ext lint (fetched via npx)
npm test                   # 69 unit and integration tests
```

`npm run build` builds Chrome and Firefox together. The build copies the shared source files, uses `manifest.firefox.json` as `manifest.json`, and writes the ZIP with fixed timestamps. That makes the output reproducible: the same source always produces the same archive.

## Before each new upload

1. Bump `"version"` in **both** `manifest.firefox.json` and `manifest.json`. AMO rejects a version number it has seen before.
2. Run `npm test && npm run lint:firefox`. Lint must report 0 errors.
3. Upload `dist/colorblind-wordle-firefox.zip`.

## Submitting to AMO

1. Go to https://addons.mozilla.org/developers/ and sign in with a Firefox account.
2. Click **Submit a New Add-on**.
3. Choose where to list it: **On this site** (public listing, reviewed by Mozilla) or **On your own** (self-distribution, signed but not listed).
4. Upload `dist/colorblind-wordle-firefox.zip` and tick the platforms (Firefox desktop and, optionally, Firefox for Android). AMO runs its validator; this package passes with 0 errors and 0 warnings.
5. When asked **"Do You Need to Submit Source Code?"**, answer **No**. Mozilla requires source code only when code is minified, concatenated, transpiled or otherwise machine-generated. Every file in this package is the original, human-readable source.
6. Fill in the listing details (name, summary, category such as *Games & Entertainment*, description, screenshots from `docs/screenshots/`) and submit.
7. Mozilla reviews it and **signs it automatically**. You don't need signing keys or credentials, and none are included anywhere in the project.

Suggested reviewer note: "Recolours the three Wordle feedback states using a deterministic palette computed from the local date. Reads the board's tile states locally to detect when the game is over (to reveal the palette in the popup) and shows a small in-page notice. No network access, no remote code, no data collection. Only permission: storage, plus host access to the Wordle page itself. The popup's GitHub link is an ordinary link the user clicks."

## Firefox-specific manifest settings

| Setting | Value | Why |
|---|---|---|
| `manifest_version` | 3 | Supported in Firefox, and the same as the Chrome build |
| `browser_specific_settings.gecko.id` | `colorblind-wordle@extension.local` | Required for MV3 on AMO. **It becomes permanent after the first upload**, so change it now if you want a different ID (any email-style string works, for example `colorblind-wordle@yourdomain`) |
| `gecko.strict_min_version` | `140.0` | The first desktop version that supports `data_collection_permissions` (also the current ESR) |
| `gecko_android.strict_min_version` | `142.0` | The first Android version that supports `data_collection_permissions` |
| `gecko.data_collection_permissions.required` | `["none"]` | AMO now requires every new extension to declare its data collection. This extension collects nothing |
| `permissions` | `["storage"]` | The only API used |
| `host_permissions` | `["https://www.nytimes.com/games/wordle/*"]` | Exactly the content script match, so there is no extra install warning. It is declared so the popup can check whether Firefox actually granted it, and request it if not |
| content script `matches` | `https://www.nytimes.com/games/wordle/*` | The narrowest pattern that covers Wordle. Firefox grants this at install time |

The Chrome manifest (`manifest.json`) is unchanged.

## API differences handled

- **`window` is not the global object in Firefox content scripts.** The global scope is a sandbox and `window` is the page's window behind an Xray wrapper. Modules attach themselves to `globalThis`, and `content.js` reads them from `globalThis` as well. Before version 1.1.1 it read them from `window`, which is `undefined` in Firefox, so the content script quietly did nothing there: no colours, no notification and no completion tracking. A test now runs every content script with a separate `window` object, the way Firefox does.
- **Firefox's `browser.*` namespace is promise-only.** Passing a callback, as Chrome-style code does, is a schema error. `storage.js` calls `browser.storage` without callbacks and `chrome.storage` with them, and the tests' fake Firefox storage rejects callbacks the same way.
- **Site access can be withheld.** Firefox lets users, or the install flow, keep an MV3 extension off a site. The popup checks `permissions.contains` for Wordle and shows **Allow on Wordle** (`permissions.request`) when access is missing. It also asks the active Wordle tab's content script whether it is running, so the status line reports what is really happening rather than just the saved on/off setting.

- There is no background script, so the background-page and service-worker differences between Firefox and Chrome MV3 don't apply.
- The popup copies to the clipboard with `navigator.clipboard.writeText` inside a click handler. Firefox allows that without the `clipboardWrite` permission.
- The content script and CSS are declared in the manifest (not injected via `scripting`), and they behave the same in both browsers.
