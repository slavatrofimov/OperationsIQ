// Bundles the Python `tsmp` compute package into a TypeScript module so the SPA
// can ship it *inside* each Livy statement. This removes the need to publish a
// `tsmp` wheel to a Fabric Spark Environment: the browser submits the whole
// package with every job, and the generated PySpark bootstrap materializes it
// on the driver + distributes it to executors (see buildLivyCode in
// src/lib/mp/livyClient.ts).
//
// Output: src/lib/mp/tsmpBundle.ts, exporting a gzip+base64 payload of a
// { "tsmp/<rel>.py": "<source>" } map plus a small manifest for transparency.
//
// Run automatically via the `prebuild` / `predev` npm lifecycle scripts, or
// manually with `npm run bundle:tsmp`.

import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const sparkRoot = resolve(appRoot, 'spark');
const pkgRoot = resolve(sparkRoot, 'tsmp');
const outFile = resolve(appRoot, 'src', 'lib', 'mp', 'tsmpBundle.ts');

/** Recursively collect *.py files under dir, skipping __pycache__. */
function collectPy(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '__pycache__') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectPy(full));
    else if (name.endsWith('.py')) out.push(full);
  }
  return out;
}

const files = collectPy(pkgRoot).sort();
if (files.length === 0) {
  throw new Error(`No .py files found under ${pkgRoot} — cannot build the tsmp bundle.`);
}

/** Map of forward-slash zip paths ("tsmp/...") -> UTF-8 source. */
const map = {};
let rawBytes = 0;
for (const full of files) {
  const rel = relative(sparkRoot, full).split('\\').join('/');
  // Normalize CRLF->LF so the bundle is byte-identical regardless of the
  // checkout's line endings (Windows vs CI Linux); keeps the drift guard stable.
  const src = readFileSync(full, 'utf-8').replace(/\r\n/g, '\n');
  map[rel] = src;
  rawBytes += Buffer.byteLength(src, 'utf-8');
}

const json = JSON.stringify(map);
const relPaths = Object.keys(map).sort();

// Judge drift by CONTENT, not by the exact gzip bytes. Node's bundled zlib
// version differs across major releases, so `gzipSync` is NOT byte-identical
// between, e.g., Node 20 (CI) and Node 22/24 (a dev machine) even with a fixed
// mtime — the DEFLATE body itself changes. Comparing the *decoded* payload keeps
// the guard meaningful (it fires only on real spark/tsmp source drift) instead
// of firing merely because a different Node regenerated the file.
function readCommittedMap() {
  let text;
  try {
    text = readFileSync(outFile, 'utf-8');
  } catch {
    return null; // no committed bundle yet
  }
  const m = text.match(/TSMP_BUNDLE_B64\s*=\s*'([A-Za-z0-9+/=]*)'/);
  if (!m) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(m[1], 'base64')).toString('utf-8'));
  } catch {
    return null; // unreadable/legacy payload -> treat as drift so it regenerates
  }
}

/** Canonical (sorted-key) JSON so map comparison ignores key order. */
function canonical(obj) {
  if (!obj) return null;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

const committedMap = readCommittedMap();
const contentUnchanged = committedMap != null && canonical(committedMap) === canonical(map);
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  if (contentUnchanged) {
    console.log(`bundle-tsmp: up to date (${files.length} modules) — content matches spark/tsmp/**`);
    process.exit(0);
  }
  const before = committedMap ?? {};
  const added = relPaths.filter((p) => !(p in before));
  const removed = Object.keys(before).filter((p) => !(p in map));
  const changed = relPaths.filter((p) => p in before && before[p] !== map[p]);
  console.error(
    "bundle-tsmp: DRIFT — src/lib/mp/tsmpBundle.ts is out of date relative to " +
      "spark/tsmp/**. Run 'npm run bundle:tsmp' and commit the regenerated file.",
  );
  if (added.length) console.error('  added:   ' + added.join(', '));
  if (removed.length) console.error('  removed: ' + removed.join(', '));
  if (changed.length) console.error('  changed: ' + changed.join(', '));
  process.exit(1);
}

// Skip the write when the logical content is unchanged, so regenerating on a
// different Node version does not churn the committed gzip bytes (which would
// otherwise produce noisy, meaningless diffs on every dev's machine).
if (contentUnchanged) {
  console.log(`bundle-tsmp: up to date (${files.length} modules) — left unchanged`);
  process.exit(0);
}

// Deterministic gzip (level 9, fixed mtime) so the generated file is stable
// across rebuilds on the same Node version and produces clean diffs.
const gz = gzipSync(Buffer.from(json, 'utf-8'), { level: 9, mtime: 0 });
const b64 = gz.toString('base64');

const banner = `// AUTO-GENERATED by scripts/bundle-tsmp.mjs. DO NOT EDIT BY HAND.
// Regenerated on every build (npm run build) from spark/tsmp/**/*.py.`;

const contents = `${banner}
//
// The base64 payload is a gzip-compressed JSON object mapping zip-relative
// paths ("tsmp/...") to their Python source. The Livy statement bootstrap
// (buildLivyCode) rebuilds a .zip from this and puts it on the Spark path, so
// the cluster never needs a pre-published tsmp wheel/Environment.

/** Number of Python modules embedded in the bundle. */
export const TSMP_BUNDLE_FILE_COUNT = ${files.length};

/** Uncompressed size of the embedded Python source, in bytes. */
export const TSMP_BUNDLE_RAW_BYTES = ${rawBytes};

/** Zip-relative paths of every embedded module (for transparency/debugging). */
export const TSMP_BUNDLE_FILES: readonly string[] = ${JSON.stringify(relPaths, null, 2)};

/** gzip(JSON({path: source})) base64-encoded. Decoded by the Livy bootstrap. */
export const TSMP_BUNDLE_B64 =
  '${b64}';
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, contents, 'utf-8');

const kb = (n) => (n / 1024).toFixed(1);
console.log(
  `bundle-tsmp: ${files.length} modules, ${kb(rawBytes)} KB source -> ` +
    `${kb(gz.length)} KB gzip -> ${kb(b64.length)} KB base64 -> ${relative(appRoot, outFile)}`,
);
