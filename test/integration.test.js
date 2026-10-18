import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getChangedFiles, stageFiles, isGitRepo } from '../src/utils/git.js';
import { scanFiles } from '../src/utils/scanner.js';

const execFileAsync = promisify(execFile);

describe('git & scanner integration in live temp repo', () => {
  let tempDir;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preva-test-'));
    // Initialize git repo in tempDir
    await execFileAsync('git', ['init'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempDir });
  });

  after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  it('detects git repo correctly', async () => {
    const isRepo = await isGitRepo(tempDir);
    assert.strictEqual(isRepo, true);
  });

  it('detects untracked files and flags sensitive files', async () => {
    writeFileSync(join(tempDir, 'safe.txt'), 'hello');
    writeFileSync(join(tempDir, '.env'), 'SECRET=123');

    const changed = await getChangedFiles([], tempDir);
    assert.strictEqual(changed.length, 2);

    const scanned = scanFiles(changed, tempDir);
    const env = scanned.find((f) => f.path === '.env');
    const safe = scanned.find((f) => f.path === 'safe.txt');

    assert.strictEqual(env.flagged, true);
    assert.strictEqual(env.defaultChecked, false);

    assert.strictEqual(safe.flagged, false);
    assert.strictEqual(safe.defaultChecked, true);
  });

  it('stages selected files without staging unselected sensitive files', async () => {
    // Stage only safe.txt
    await stageFiles(['safe.txt'], tempDir);

    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tempDir });
    // safe.txt should be staged (A ), .env should still be untracked (??)
    assert.match(stdout, /A\s+safe\.txt/);
    assert.match(stdout, /\?\?\s+\.env/);
  });
});
