// Packages the extension for distribution with no dependencies.
//   node scripts/build.mjs            -> dist/chrome/, dist/firefox/ and two .zip files
// The Chrome zip uses manifest.json; the Firefox zip uses manifest.firefox.json
// renamed to manifest.json. All other files are shared.
import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const SHARED = ['color-engine.js', 'storage.js', 'game-state.js', 'notice.js', 'content.js', 'styles.css', 'popup', 'icons'];
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;

// zipName: the Firefox package keeps a fixed name so it is always the file to
// upload to addons.mozilla.org (the version lives inside manifest.json).
const targets = [
  { name: 'chrome', manifest: 'manifest.json', zipName: `colorblind-wordle-chrome-${version}.zip` },
  { name: 'firefox', manifest: 'manifest.firefox.json', zipName: 'colorblind-wordle-firefox.zip' }
];
const only = process.argv[2]; // optional: "chrome" or "firefox"

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  }).sort();
}

// Minimal ZIP writer (deflate, no zip64): enough for a small extension.
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed timestamp: reproducible builds
  for (const { path, data } of files) {
    const name = Buffer.from(path);
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

mkdirSync(dist, { recursive: true });
for (const t of targets.filter((x) => !only || x.name === only)) {
  const outDir = join(dist, t.name);
  rmSync(outDir, { recursive: true, force: true });
  rmSync(join(dist, t.zipName), { force: true });
  mkdirSync(outDir, { recursive: true });
  // Runtime files only; dotfiles (.DS_Store etc.) are never packaged.
  const noDotfiles = (src) => !basename(src).startsWith('.');
  for (const item of SHARED) cpSync(join(root, item), join(outDir, item), { recursive: true, filter: noDotfiles });
  cpSync(join(root, t.manifest), join(outDir, 'manifest.json'));
  const files = listFiles(outDir).map((full) => ({
    path: relative(outDir, full).split(sep).join('/'),
    data: readFileSync(full)
  }));
  const zipPath = join(dist, t.zipName);
  writeFileSync(zipPath, zip(files));
  console.log(`${relative(root, zipPath)}  (${files.length} files)`);
}
