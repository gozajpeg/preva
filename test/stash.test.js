import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getStashes,
  getStashFiles,
  getStashDiffSnippet,
  checkStashConflicts,
  runGitStash,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

describe('git stash preview & safety guard in live repository', () => {
  let repoDir;

  before(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'preva-stash-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir });

    // Initial commit
    writeFileSync(join(repoDir, 'base.txt'), 'base content\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial base commit'], { cwd: repoDir });
  });

  after(() => {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('reports empty stash list initially', async () => {
    const stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 0);
  });

  it('creates a stash and discovers it in getStashes', async () => {
    writeFileSync(join(repoDir, 'base.txt'), 'base content\nmodified line\n');
    await runGitStash(['push', '-m', 'my first stash'], repoDir);

    const stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 1);
    assert.strictEqual(stashes[0].ref, 'stash@{0}');
    assert.ok(stashes[0].message.includes('my first stash'));
  });

  it('inspects stash files and diff snippet', async () => {
    const files = await getStashFiles('stash@{0}', repoDir);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'base.txt');
    assert.strictEqual(files[0].status, 'modified');

    const snippet = await getStashDiffSnippet('stash@{0}', repoDir);
    assert.ok(snippet.includes('+modified line'));
  });

  it('detects potential conflict when local uncommitted edits overlap with stash', async () => {
    // Add local edit to base.txt (which is in the stash)
    writeFileSync(join(repoDir, 'base.txt'), 'base content\nconflicting local edit\n');

    const conflictResult = await checkStashConflicts('stash@{0}', repoDir);
    assert.strictEqual(conflictResult.hasConflicts, true);
    assert.ok(conflictResult.conflictingFiles.includes('base.txt'));

    // Revert local edit
    await execFileAsync('git', ['checkout', '--', 'base.txt'], { cwd: repoDir });
  });

  it('reports no conflict when local uncommitted edits do not overlap with stash', async () => {
    // Add local edit to unrelated file
    writeFileSync(join(repoDir, 'other.txt'), 'other edit\n');

    const conflictResult = await checkStashConflicts('stash@{0}', repoDir);
    assert.strictEqual(conflictResult.hasConflicts, false);
    assert.strictEqual(conflictResult.conflictingFiles.length, 0);

    // Clean up other.txt
    rmSync(join(repoDir, 'other.txt'));
  });

  it('applies a stash cleanly with runGitStash apply', async () => {
    await runGitStash(['apply', 'stash@{0}'], repoDir);

    // Stash should still exist after apply
    const stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 1);

    // Clean working tree
    await execFileAsync('git', ['checkout', '--', 'base.txt'], { cwd: repoDir });
  });

  it('drops a stash with runGitStash drop', async () => {
    await runGitStash(['drop', 'stash@{0}'], repoDir);

    const stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 0);
  });

  it('clears multiple stashes with runGitStash clear', async () => {
    // Create 2 stashes
    writeFileSync(join(repoDir, 'base.txt'), 'edit 1\n');
    await runGitStash(['push', '-m', 'stash one'], repoDir);

    writeFileSync(join(repoDir, 'base.txt'), 'edit 2\n');
    await runGitStash(['push', '-m', 'stash two'], repoDir);

    let stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 2);

    await runGitStash(['clear'], repoDir);

    stashes = await getStashes(repoDir);
    assert.strictEqual(stashes.length, 0);
  });
});
