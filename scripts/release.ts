#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dir, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const sdkPath = path.join(repoRoot, 'src', 'agent-sdk.ts');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

const args = process.argv.slice(2);
const isMinor = args.includes('--minor');
const isMajor = args.includes('--major');
const autoPublish = args.includes('--publish');

const [major, minor, patch] = currentVersion.split('.').map((n: string) => parseInt(n, 10));

let nextVersion = '';

if (isMajor || isMinor) {
  if (process.env.ALLOW_MINOR_BUMP !== 'true' && !args.includes('--force-allow')) {
    console.error(`\n[Version Guard Error]`);
    console.error(`Attempting to bump to ${isMajor ? 'Major' : 'Minor'} version!`);
    console.error(`According to project rules, jumping to 0.2.x / 0.3.x requires explicit user permission.`);
    console.error(`To proceed, pass --force-allow or set ALLOW_MINOR_BUMP=true.\n`);
    process.exit(1);
  }
  if (isMajor) {
    nextVersion = `${major + 1}.0.0`;
  } else {
    nextVersion = `${major}.${minor + 1}.0`;
  }
} else {
  // Default: strict sequential patch increment (0.1.3 -> 0.1.4 -> 0.1.5 ...)
  nextVersion = `${major}.${minor}.${patch + 1}`;
}

console.log(`\n========================================`);
console.log(` Bumping Version: ${currentVersion} -> ${nextVersion}`);
console.log(`========================================\n`);

// 1. Update package.json
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[1/4] Updated package.json version to ${nextVersion}`);

// 2. Sync src/core/types.ts and src/agent-sdk.ts AGENT_INFO.version
const coreTypesPath = path.join(repoRoot, 'src', 'core', 'types.ts');
for (const targetPath of [sdkPath, coreTypesPath]) {
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    content = content.replace(
      /version:\s*['"][0-9]+\.[0-9]+\.[0-9]+['"]/,
      `version: '${nextVersion}'`
    );
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`[2/4] Synchronized ${path.relative(repoRoot, targetPath)} AGENT_INFO.version to ${nextVersion}`);
  }
}

// 3. Run build and tests
console.log(`[3/4] Building bundle and running 104 unit tests...`);
execSync('bun run build', { cwd: repoRoot, stdio: 'inherit' });
execSync('bun test src/lib', { cwd: repoRoot, stdio: 'inherit' });

console.log(`\n[4/4] Release check completed! Version is now ${nextVersion}`);

if (autoPublish) {
  console.log(`\nLaunching npm publish...`);
  execSync('npm publish --access public', { cwd: repoRoot, stdio: 'inherit' });
} else {
  console.log(`\nReady to publish. Run: npm publish\n`);
}
