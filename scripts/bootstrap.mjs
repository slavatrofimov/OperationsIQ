#!/usr/bin/env node
// Idempotent dependency bootstrap for OperationsIQ worktree sessions.
//
// Every git worktree is a separate directory, and node_modules / .venv are
// git-ignored and live inside the working dir — so a fresh session starts with
// no installed dependencies. This script installs them, but ONLY when they are
// missing or stale. It fingerprints each project's lockfile and stores the hash
// alongside the installed tree; on subsequent runs, if the lockfile is
// unchanged and the install is present, it does nothing. That makes it safe and
// cheap to run on every session start and eliminates repeated reinstalls.
//
// Usage:
//   node scripts/bootstrap.mjs            # install/refresh everything as needed
//   node scripts/bootstrap.mjs --force    # ignore hashes; reinstall everything
//   node scripts/bootstrap.mjs --only=npm       # only the Node projects
//   node scripts/bootstrap.mjs --only=python    # only the Python (spark) project
//   node scripts/bootstrap.mjs --verbose  # show install command output

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWindows = platform() === 'win32';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const VERBOSE = args.includes('--verbose');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null; // 'npm' | 'python' | null

// --- Project definitions -------------------------------------------------

/** Node projects: install via `npm ci` (falls back to `npm install`). */
const nodeProjects = [
  { name: 'OperationsIQApp', dir: 'OperationsIQApp' },
  { name: 'docs-site', dir: 'docs-site' },
];

/** Python project: create a .venv and install requirements. */
const pythonProjects = [
  {
    name: 'spark',
    dir: join('OperationsIQApp', 'spark'),
    // Files whose contents define the dependency set.
    lockFiles: ['requirements.txt', 'pyproject.toml'],
    // Extras installed from pyproject (kept in sync with tests + Spark runtime).
    extras: 'test',
  },
];

// --- Helpers -------------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function hashFiles(paths) {
  const h = createHash('sha256');
  for (const p of paths) {
    h.update(p); // include the path so add/remove of a file changes the hash
    h.update('\0');
    if (existsSync(p)) h.update(readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex');
}

function readMarker(markerPath) {
  try {
    return existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function run(cmd, cmdArgs, cwd) {
  // On Windows, npm is a .cmd shim; resolve it explicitly so we can avoid
  // spawning through a shell (which triggers Node's DEP0190 warning and needs
  // arg escaping). Absolute paths (e.g. the venv pip) and .exe launchers
  // (py/python) are spawned directly.
  const exe = isWindows && cmd === 'npm' ? 'npm.cmd' : cmd;
  const res = spawnSync(exe, cmdArgs, {
    cwd,
    stdio: VERBOSE ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0 && !VERBOSE) {
    // Surface captured output only on failure to keep the happy path quiet.
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return res.status ?? 1;
}

function findPython() {
  const candidates = isWindows ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const res = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (res.status === 0) return c;
  }
  return null;
}

// --- Node projects -------------------------------------------------------

function bootstrapNode(project) {
  const projDir = join(repoRoot, project.dir);
  const pkgJson = join(projDir, 'package.json');
  if (!existsSync(pkgJson)) {
    log(`  skip ${project.name}: no package.json`);
    return 0;
  }

  const lockFile = join(projDir, 'package-lock.json');
  const hasLock = existsSync(lockFile);
  const nodeModules = join(projDir, 'node_modules');
  const marker = join(nodeModules, '.bootstrap.lockhash');

  const fingerprintBefore = hashFiles([hasLock ? lockFile : pkgJson]);
  const installed = existsSync(nodeModules);
  const current = readMarker(marker);

  if (!FORCE && installed && current === fingerprintBefore) {
    log(`  ok   ${project.name}: dependencies up to date`);
    return 0;
  }

  const installCmd = hasLock ? 'ci' : 'install';
  log(`  ->   ${project.name}: npm ${installCmd} ...`);
  let code = run(
    'npm',
    [installCmd, '--prefer-offline', '--no-audit', '--fund=false'],
    projDir,
  );
  if (code !== 0 && hasLock) {
    // `npm ci` refuses when package-lock.json is out of sync with package.json.
    // Fall back to `npm install` so a stale lockfile never blocks a session; it
    // reconciles (and rewrites) the lockfile. Warn so the drift gets noticed.
    log(`  warn ${project.name}: npm ci failed (lockfile likely stale); retrying with npm install ...`);
    code = run('npm', ['install', '--prefer-offline', '--no-audit', '--fund=false'], projDir);
  }
  if (code !== 0) {
    log(`  FAIL ${project.name}: npm install exited ${code}`);
    return code;
  }
  // node_modules now exists. Record a fingerprint of the CURRENT lockfile —
  // recomputed here because the npm install fallback may have rewritten it — so
  // the next run is a no-op.
  writeFileSync(marker, hashFiles([hasLock ? lockFile : pkgJson]));
  log(`  done ${project.name}`);
  return 0;
}

// --- Python project ------------------------------------------------------

function bootstrapPython(project, python) {
  const projDir = join(repoRoot, project.dir);
  const lockPaths = project.lockFiles.map((f) => join(projDir, f));
  const hasAnyLock = lockPaths.some((p) => existsSync(p));
  if (!hasAnyLock) {
    log(`  skip ${project.name}: no requirements`);
    return 0;
  }

  const venv = join(projDir, '.venv');
  const marker = join(venv, '.bootstrap.lockhash');
  const pip = isWindows
    ? join(venv, 'Scripts', 'pip.exe')
    : join(venv, 'bin', 'pip');

  const fingerprint = hashFiles(lockPaths);
  const installed = existsSync(pip);
  const current = readMarker(marker);

  if (!FORCE && installed && current === fingerprint) {
    log(`  ok   ${project.name}: venv up to date`);
    return 0;
  }

  if (!installed) {
    log(`  ->   ${project.name}: creating .venv ...`);
    const venvCode = run(python, ['-m', 'venv', venv], projDir);
    if (venvCode !== 0) {
      log(`  FAIL ${project.name}: could not create venv (exit ${venvCode})`);
      return venvCode;
    }
  }

  log(`  ->   ${project.name}: pip install ...`);
  // Prefer an editable install with extras when a pyproject is present so the
  // package + test/Spark deps resolve together; otherwise fall back to
  // requirements.txt.
  const hasPyproject = existsSync(join(projDir, 'pyproject.toml'));
  const target = hasPyproject
    ? [project.extras ? `.[${project.extras}]` : '.']
    : ['-r', 'requirements.txt'];
  const code = run(
    pip,
    ['install', '--disable-pip-version-check', ...(hasPyproject ? ['-e'] : []), ...target],
    projDir,
  );
  if (code !== 0) {
    log(`  FAIL ${project.name}: pip install exited ${code}`);
    return code;
  }
  writeFileSync(marker, fingerprint);
  log(`  done ${project.name}`);
  return 0;
}

// --- Main ----------------------------------------------------------------

function main() {
  let failures = 0;

  if (ONLY !== 'python') {
    log('Node projects:');
    for (const p of nodeProjects) {
      if (bootstrapNode(p) !== 0) failures += 1;
    }
  }

  if (ONLY !== 'npm') {
    log('Python projects:');
    const python = findPython();
    if (!python) {
      log('  skip: no Python interpreter found on PATH (spark venv not created).');
    } else {
      for (const p of pythonProjects) {
        // Python deps are optional for most frontend work; a failure here is a
        // warning, not a hard error, so it never blocks a Node-only session.
        if (bootstrapPython(p, python) !== 0) {
          log(`  warn ${p.name}: skipped due to install error (non-fatal).`);
        }
      }
    }
  }

  if (failures > 0) {
    log(`\nBootstrap finished with ${failures} failed Node project(s).`);
    process.exit(1);
  }
  log('\nBootstrap complete.');
}

main();
