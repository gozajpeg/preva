import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runGitReset,
  runGitRestore,
  getFileDiffStat,
  getFileDiffSnippet,
  getUncommittedFiles,
  getLastCommit,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

describe('git reset and restore operations in live repository', () => {
  let tempDir;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preva-reset-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempDir });

    // Initial commit
    writeFileSync(join(tempDir, 'file1.txt'), 'hello world\n');
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

  it('detects last commit summary correctly', async () => {
    const commit = await getLastCommit(tempDir);
    assert.ok(commit);
    assert.strictEqual(commit.message, 'feat: initial commit');
    assert.strictEqual(commit.author, 'Tester');
    assert.ok(commit.hash);
  });

  it('unstages a file using runGitRestore with --staged', async () => {
    writeFileSync(join(tempDir, 'file1.txt'), 'hello world modified\n');
    await execFileAsync('git', ['add', 'file1.txt'], { cwd: tempDir });

    let uncommitted = await getUncommittedFiles(tempDir);
    let staged = uncommitted.find((f) => f.path === 'file1.txt');
    assert.strictEqual(staged.isStaged, true);

    await runGitRestore(['--staged', '--', 'file1.txt'], tempDir);

    uncommitted = await getUncommittedFiles(tempDir);
    staged = uncommitted.find((f) => f.path === 'file1.txt');
    assert.strictEqual(staged.isStaged, false);
    assert.strictEqual(staged.isUnstaged, true);
  });

  it('computes diff statistics and snippet for an unstaged file', async () => {
    const stat = await getFileDiffStat('file1.txt', false, tempDir);
    assert.ok(stat);
    assert.strictEqual(stat.added, 1);
    assert.strictEqual(stat.deleted, 1);

    const snippet = await getFileDiffSnippet('file1.txt', false, tempDir);
    assert.ok(snippet.includes('+hello world modified'));
    assert.ok(snippet.includes('-hello world'));
  });

  it('discards working tree changes with runGitRestore', async () => {
    await runGitRestore(['--', 'file1.txt'], tempDir);
    const content = readFileSync(join(tempDir, 'file1.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(content, 'hello world\n');

    const uncommitted = await getUncommittedFiles(tempDir);
    assert.strictEqual(uncommitted.length, 0);
  });

  it('performs a safe soft reset (--soft) keeping files staged', async () => {
    // Make second commit
    writeFileSync(join(tempDir, 'file2.txt'), 'second file\n');
    await execFileAsync('git', ['add', '.'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'feat: second commit'], { cwd: tempDir });

    const beforeReset = await getLastCommit(tempDir);
    assert.strictEqual(beforeReset.message, 'feat: second commit');

    // Soft reset back to HEAD~1
    await runGitReset(['--soft', 'HEAD~1'], tempDir);

    const afterReset = await getLastCommit(tempDir);
    assert.strictEqual(afterReset.message, 'feat: initial commit');

    // file2.txt should remain STAGED
    const uncommitted = await getUncommittedFiles(tempDir);
    const f2 = uncommitted.find((f) => f.path === 'file2.txt');
    assert.ok(f2);
    assert.strictEqual(f2.isStaged, true);
  });

  it('unstages a file using runGitReset with path', async () => {
    await runGitReset(['--', 'file2.txt'], tempDir);
    const uncommitted = await getUncommittedFiles(tempDir);
    const f2 = uncommitted.find((f) => f.path === 'file2.txt');
    assert.ok(f2);
    assert.strictEqual(f2.isStaged, false);
    assert.strictEqual(f2.isUnstaged, true);
  });

  it('performs a hard reset (--hard) clearing uncommitted changes', async () => {
    // Add an unstaged modification
    writeFileSync(join(tempDir, 'file1.txt'), 'temporary dirty edit\n');

    await runGitReset(['--hard', 'HEAD'], tempDir);

    const content = readFileSync(join(tempDir, 'file1.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(content, 'hello world\n');
  });
});
