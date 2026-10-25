import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getDiffStats,
  getDiffSnippet,
  runGitDiff,
} from '../src/utils/git.js';
import { formatDiffSnippet } from '../src/commands/diff.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git diff formatting & statistics unit tests', () => {
  it('formats unified diff with syntax colors', () => {
    const rawDiff = [
      'diff --git a/file.js b/file.js',
      'index 1234567..89abcdef 100644',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,3 +1,4 @@ function test() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      '+const c = 30;',
      '}',
    ].join('\n');

    const formatted = formatDiffSnippet(rawDiff, { maxLines: 50, maxCols: 100 });
    assert.ok(formatted.includes('file.js'));
    assert.ok(formatted.includes('+const b = 20;'));
    assert.ok(formatted.includes('-const b = 2;'));
    assert.ok(formatted.includes('@@ -1,3 +1,4 @@'));
  });

  it('handles empty diff gracefully', () => {
    const formatted = formatDiffSnippet('');
    assert.match(formatted, /No differences found/);
  });

  it('truncates diffs exceeding maxLines', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`+line ${i}`);
    }
    const rawDiff = lines.join('\n');
    const formatted = formatDiffSnippet(rawDiff, { maxLines: 5 });
    assert.ok(formatted.includes('more lines truncated'));
  });
});

describe('git diff operations in live repository', () => {
  let testDir;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-diff-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'DiffTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'difftester@example.com'], { cwd: testDir });

    // Initial commit
    writeFileSync(join(testDir, 'file1.txt'), 'line 1\nline 2\nline 3\n');
    writeFileSync(join(testDir, 'file2.txt'), 'hello world\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit'], { cwd: testDir });
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('returns zero stats when working tree is clean', async () => {
    const stats = await getDiffStats({ scope: 'unstaged' }, testDir);
    assert.strictEqual(stats.totalFiles, 0);
    assert.strictEqual(stats.totalAdditions, 0);
    assert.strictEqual(stats.totalDeletions, 0);
  });

  it('detects unstaged modifications with accurate line counts', async () => {
    writeFileSync(join(testDir, 'file1.txt'), 'line 1\nline 2 modified\nline 3\nline 4 added\n');

    const stats = await getDiffStats({ scope: 'unstaged' }, testDir);
    assert.strictEqual(stats.totalFiles, 1);
    assert.strictEqual(stats.files[0].path, 'file1.txt');
    assert.strictEqual(stats.files[0].status, 'modified');
    assert.strictEqual(stats.files[0].additions, 2);
    assert.strictEqual(stats.files[0].deletions, 1);
  });

  it('retrieves single-file diff snippet correctly', async () => {
    const snippet = await getDiffSnippet({ scope: 'unstaged', file: 'file1.txt' }, testDir);
    assert.ok(snippet.includes('diff --git'));
    assert.ok(snippet.includes('+line 4 added'));
    assert.ok(snippet.includes('-line 2'));
  });

  it('distinguishes staged changes from unstaged changes', async () => {
    // Stage file1.txt changes
    await execFileAsync('git', ['add', 'file1.txt'], { cwd: testDir });

    // Modify file2.txt unstaged
    writeFileSync(join(testDir, 'file2.txt'), 'hello updated world\n');

    // Unstaged should only see file2.txt
    const unstaged = await getDiffStats({ scope: 'unstaged' }, testDir);
    assert.strictEqual(unstaged.totalFiles, 1);
    assert.strictEqual(unstaged.files[0].path, 'file2.txt');

    // Staged should only see file1.txt
    const staged = await getDiffStats({ scope: 'staged' }, testDir);
    assert.strictEqual(staged.totalFiles, 1);
    assert.strictEqual(staged.files[0].path, 'file1.txt');

    // HEAD scope should see both files
    const all = await getDiffStats({ scope: 'head' }, testDir);
    assert.strictEqual(all.totalFiles, 2);
    assert.ok(all.files.some((f) => f.path === 'file1.txt'));
    assert.ok(all.files.some((f) => f.path === 'file2.txt'));
  });

  it('runs preva diff --stat CLI and outputs visual table', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'diff', '--stat'],
      { cwd: testDir }
    );
    assert.match(stdout, /Diff Summary/);
    assert.match(stdout, /file2\.txt/);
  });

  it('runs preva git diff --staged --stat CLI and outputs staged summary', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'diff', '--staged', '--stat'],
      { cwd: testDir }
    );
    assert.match(stdout, /Staged Diff Summary/);
    assert.match(stdout, /file1\.txt/);
  });

  it('runs preva diff on specific file and outputs snippet', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'diff', 'file2.txt'],
      { cwd: testDir }
    );
    assert.match(stdout, /file2\.txt/);
    assert.match(stdout, /hello updated world/);
  });
});
