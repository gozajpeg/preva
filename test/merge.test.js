import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isMergeInProgress,
  getMergeBase,
  isAncestor,
  getMergeCommits,
  getMergeFiles,
  checkMergeConflicts,
  runGitMerge,
  runGitMergeAbort,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

describe('git merge preview & safety guard in live repository', () => {
  let repoDir;

  before(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'preva-merge-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir });

    // Initial commit on main
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

  it('detects that merge is not in progress initially', async () => {
    const inProgress = await isMergeInProgress(repoDir);
    assert.strictEqual(inProgress, false);
  });

  it('detects ancestor status for self and fast-forward branch', async () => {
    // Create feature-ff branch off main without committing on main
    await execFileAsync('git', ['switch', '-c', 'feature-ff'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'feature.txt'), 'feature content\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: add feature file'], { cwd: repoDir });

    // Switch back to main
    await execFileAsync('git', ['switch', 'main'], { cwd: repoDir });

    // main is ancestor of feature-ff
    const mainIsAncestor = await isAncestor('main', 'feature-ff', repoDir);
    assert.strictEqual(mainIsAncestor, true);

    // feature-ff is NOT ancestor of main (main doesn't have feature-ff's commits yet)
    const featIsAncestor = await isAncestor('feature-ff', 'main', repoDir);
    assert.strictEqual(featIsAncestor, false);
  });

  it('queries incoming merge commits and changed files', async () => {
    const commits = await getMergeCommits('feature-ff', 'main', repoDir);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].message, 'feat: add feature file');

    const files = await getMergeFiles('feature-ff', 'main', repoDir);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'feature.txt');
    assert.strictEqual(files[0].status, 'new');
  });

  it('executes fast-forward merge cleanly with runGitMerge', async () => {
    await runGitMerge(['--ff-only', 'feature-ff'], repoDir);

    // After merge, feature-ff IS ancestor of main
    const featIsAncestor = await isAncestor('feature-ff', 'main', repoDir);
    assert.strictEqual(featIsAncestor, true);
  });

  it('detects potential merge conflict when branches diverge and edit the same file', async () => {
    // Branch off main into feature-conflict
    await execFileAsync('git', ['switch', '-c', 'feature-conflict'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'shared.txt'), 'shared file line 1\nfeature change\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: modify shared file on branch'], { cwd: repoDir });

    // Switch to main and also edit shared.txt differently
    await execFileAsync('git', ['switch', 'main'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'shared.txt'), 'shared file line 1\nmain change\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: modify shared file on main'], { cwd: repoDir });

    // Check conflict detection
    const conflictResult = await checkMergeConflicts('feature-conflict', 'main', repoDir);
    assert.strictEqual(conflictResult.hasConflicts, true);
    assert.ok(conflictResult.conflictingFiles.includes('shared.txt'));
  });

  it('detects active merge in progress and aborts with runGitMergeAbort', async () => {
    // Attempt merge that conflicts
    try {
      await execFileAsync('git', ['merge', 'feature-conflict'], { cwd: repoDir });
    } catch {
      // Expected conflict failure
    }

    // Now MERGE_HEAD must exist
    const inProgress = await isMergeInProgress(repoDir);
    assert.strictEqual(inProgress, true);

    // Abort the merge cleanly
    await runGitMergeAbort(repoDir);

    // After abort, MERGE_HEAD should no longer exist
    const afterAbort = await isMergeInProgress(repoDir);
    assert.strictEqual(afterAbort, false);
  });
});
