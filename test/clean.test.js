import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  formatBytes,
  getUntrackedFiles,
  runGitClean,
} from '../src/utils/git.js';
import { scanFiles } from '../src/utils/scanner.js';

const execFileAsync = promisify(execFile);

describe('git clean untracked file operations in live repository', () => {
  let tempDir;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preva-clean-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempDir });

    // Tracked initial commit
    writeFileSync(join(tempDir, 'tracked.txt'), 'hello world\n');
    await execFileAsync('git', ['add', '.'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial commit'], { cwd: tempDir });
  });

  after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  it('formats byte sizes correctly', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(1048576 * 2.5), '2.5 MB');
  });

  it('detects untracked files with file sizes', async () => {
    writeFileSync(join(tempDir, 'temp1.log'), 'test log file\n');
    writeFileSync(join(tempDir, 'temp2.txt'), 'temporary text\n');

    const untracked = await getUntrackedFiles(tempDir);
    assert.strictEqual(untracked.length, 2);

    const logFile = untracked.find((f) => f.path === 'temp1.log');
    assert.ok(logFile);
    assert.ok(logFile.size > 0);
    assert.ok(logFile.sizeFormatted);
  });

  it('scans untracked files and identifies sensitive files', async () => {
    writeFileSync(join(tempDir, '.env'), 'SECRET_KEY=123\n');

    const untracked = await getUntrackedFiles(tempDir);
    const scanned = scanFiles(untracked);

    const envFile = scanned.find((f) => f.path === '.env');
    assert.ok(envFile);
    assert.strictEqual(envFile.flagged, true);
    assert.strictEqual(envFile.defaultChecked, false);

    // Clean up .env for subsequent clean test
    rmSync(join(tempDir, '.env'));
  });

  it('dry run (-n) does not delete files', async () => {
    await runGitClean(['-n', '-f'], tempDir);
    assert.strictEqual(existsSync(join(tempDir, 'temp1.log')), true);
    assert.strictEqual(existsSync(join(tempDir, 'temp2.txt')), true);
  });

  it('cleans untracked files with runGitClean -f', async () => {
    await runGitClean(['-f', '--', 'temp1.log', 'temp2.txt'], tempDir);

    assert.strictEqual(existsSync(join(tempDir, 'temp1.log')), false);
    assert.strictEqual(existsSync(join(tempDir, 'temp2.txt')), false);

    const untracked = await getUntrackedFiles(tempDir);
    assert.strictEqual(untracked.length, 0);

    // Tracked file should be completely untouched
    assert.strictEqual(existsSync(join(tempDir, 'tracked.txt')), true);
  });
});
