import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A private additional workspace, never the user's project or global config. */
export class SessionResources {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-session-'));
  constructor(source?: string) {
    try {
      fs.mkdirSync(path.join(this.directory, '.agents'), { recursive: true });
      if (!source) return;
      if (!path.isAbsolute(source)) throw new Error('AGY_ACP_RESOURCES_DIR must be absolute');
      const root = fs.realpathSync(source);
      let bytes = 0;
      const copy = (from: string, to: string) => {
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) throw new Error('Application resources must not contain symlinks');
        const rel = path.relative(root, fs.realpathSync(from));
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Resource escapes directory');
        if (stat.isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
        } else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > 16 * 1024 * 1024) throw new Error('Application resources exceed 16 MiB');
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        }
      };
      const rules = path.join(source, 'AGENTS.md');
      if (fs.existsSync(rules)) copy(rules, path.join(this.directory, 'AGENTS.md'));
      const skills = path.join(source, 'skills');
      if (fs.existsSync(skills)) copy(skills, path.join(this.directory, '.agents', 'skills'));
    } catch (error) { this.dispose(); throw error; }
  }
  dispose(): void {
    fs.rmSync(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
