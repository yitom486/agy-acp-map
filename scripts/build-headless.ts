import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CROSS_WINDOWS = process.env.GOOS === 'windows' || process.env.AGY_HEADLESS_CROSS === '1';

if (process.platform !== 'win32' && !CROSS_WINDOWS) {
  console.log('[agy-headless] skipped: the launcher is Windows-only (set AGY_HEADLESS_CROSS=1 with Go to cross-compile)');
  process.exit(0);
}

const projectDir = path.resolve(import.meta.dir, '..', 'native', 'agy-headless');
const goSource = path.join(projectDir, 'main.go');
const csSource = path.join(projectDir, 'agy-headless.cs');
const output = path.resolve(import.meta.dir, '..', 'dist', 'agy-headless.exe');

fs.mkdirSync(path.dirname(output), { recursive: true });

const failures: string[] = [];

// Primary: Go (self-contained binary, argv passthrough, no quoting risk).
if (fs.existsSync(goSource) && tryGoBuild()) {
  verifyGuiSubsystem(output);
  console.log(`[agy-headless] built ${output} (go)`);
  process.exit(0);
}

// Fallback: inbox C# compiler, zero dependency on vanilla Windows.
if (process.platform === 'win32' && fs.existsSync(csSource) && tryCscBuild()) {
  verifyGuiSubsystem(output);
  console.log(`[agy-headless] built ${output} (csc)`);
  process.exit(0);
}

if (process.platform === 'win32' || process.env.AGY_HEADLESS_CROSS === '1' || process.env.GOOS === 'windows') {
  throw new Error(
    `[agy-headless] could not build ${output}. ` +
      failures.join(' ') +
      ' Install Go, or (Windows) ensure csc.exe exists at C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe.',
  );
}
console.log('[agy-headless] skipped: no Go toolchain for cross-compile (publish CI installs Go)');
process.exit(0);

function tryGoBuild(): boolean {
  const go = process.env.GO_BIN || 'go';
  // On non-Windows CI (npm publish runs there), cross-compile so the
  // published package always ships dist/agy-headless.exe.
  const cross = process.platform !== 'win32';
  const result = spawnSync(
    go,
    ['build', '-trimpath', '-ldflags=-H=windowsgui', '-o', output, '.'],
    {
      cwd: projectDir,
      stdio: 'inherit',
      windowsHide: true,
      env: cross ? { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' } : process.env,
    },
  );
  if (result.error) {
    failures.push(`Go unavailable (${(result.error as Error).message}).`);
    return false;
  }
  if (result.status !== 0) {
    failures.push(`Go build failed with exit code ${result.status}.`);
    return false;
  }
  return true;
}

function findCsc(): string | null {
  const windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    process.env.CSC_BIN,
    process.env.CSC,
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    'csc.exe',
    'csc',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === 'csc.exe' || candidate === 'csc') return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function tryCscBuild(): boolean {
  const csc = findCsc();
  if (!csc) {
    failures.push('csc.exe not found (checked Framework64/Framework v4.0.30319 and PATH).');
    return false;
  }
  // /target:winexe is what keeps Windows from allocating a conhost for the shim.
  const result = spawnSync(
    csc,
    ['/target:winexe', '/optimize+', '/nologo', `/out:${output}`, csSource],
    {
      cwd: projectDir,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) {
    failures.push(`csc unavailable (${(result.error as Error).message}).`);
    return false;
  }
  if (result.status !== 0) {
    failures.push(`csc build failed with exit code ${result.status}.`);
    return false;
  }
  return true;
}

/** Fail loudly if the shim is a console-subsystem binary (it would flash itself). */
function verifyGuiSubsystem(binaryPath: string): void {
  const subsystem = readPeSubsystem(binaryPath);
  // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI, 3 = IMAGE_SUBSYSTEM_WINDOWS_CUI
  if (subsystem !== 2) {
    throw new Error(
      `[agy-headless] ${binaryPath} has PE subsystem=${subsystem} (want 2=GUI); ` +
        'it would flash its own console window. Refusing to accept it.',
    );
  }
}

function readPeSubsystem(binaryPath: string): number | null {
  let fd: number | null = null;
  try {
    const buf = Buffer.alloc(16);
    fd = fs.openSync(binaryPath, 'r');
    fs.readSync(fd, buf, 0, 2, 0);
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // MZ
    fs.readSync(fd, buf, 0, 4, 0x3c);
    const peOffset = buf.readUInt32LE(0);
    // Subsystem sits at optional-header offset +68 in BOTH PE32 and PE32+
    // (the ImageBase size difference is absorbed before offset 68).
    fs.readSync(fd, buf, 0, 2, peOffset + 24 + 68);
    return buf.readUInt16LE(0);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
