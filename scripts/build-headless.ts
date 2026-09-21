import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('[agy-headless] skipped: the launcher is Windows-only');
  process.exit(0);
}

const go = process.env.GO_BIN || 'go';
const projectDir = path.resolve(import.meta.dir, '..', 'native', 'agy-headless');
const output = path.resolve(import.meta.dir, '..', 'dist', 'agy-headless.exe');

fs.mkdirSync(path.dirname(output), { recursive: true });

const result = spawnSync(
  go,
  ['build', '-trimpath', '-ldflags=-H=windowsgui', '-o', output, '.'],
  {
    cwd: projectDir,
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  throw new Error(
    `[agy-headless] failed to invoke Go (${go}). Install Go or set GO_BIN. ${result.error.message}`,
  );
}
if (result.status !== 0) {
  throw new Error(`[agy-headless] Go build failed with exit code ${result.status}`);
}

console.log(`[agy-headless] built ${output}`);
