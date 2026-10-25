import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isRebaseInProgress,
  getRebaseProgress,
  getRebaseCommits,
  getRebaseFiles,
  checkRebaseConflicts,
  runGitRebase,
  runGitRebaseAbort,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git rebase operations & conflict detection in live repository', () => {
  let testDir;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-rebase-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'RebaseTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'rebase@example.com'], { cwd: testDir });

    // Initial commit on main
    writeFileSync(join(testDir, 'base.txt'), 'base content\n');
    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit on main'], { cwd: testDir });

    // Create feature branch
    await execFileAsync('git', ['checkout', '-b', 'feature-auth'], { cwd: testDir });
    writeFileSync(join(testDir, 'feature.txt'), 'feature content\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: add feature file'], { cwd: testDir });

    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2 feature edit\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: update shared in feature'], { cwd: testDir });

    // Switch back to main and make a diverging commit on shared.txt
    await execFileAsync('git', ['checkout', 'main'], { cwd: testDir });
    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2 main edit\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'fix: update shared in main'], { cwd: testDir });

    // Switch back to feature-auth
    await execFileAsync('git', ['checkout', 'feature-auth'], { cwd: testDir });
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('reports false when no rebase is active', async () => {
    const inProgress = await isRebaseInProgress(testDir);
    assert.strictEqual(inProgress, false);

    const progress = await getRebaseProgress(testDir);
    assert.strictEqual(progress.inProgress, false);
  });

  it('lists rebase commits in chronological order', async () => {
    const commits = await getRebaseCommits('main', 'feature-auth', testDir);
    assert.strictEqual(commits.length, 2);
    assert.strictEqual(commits[0].message, 'feat: add feature file');
    assert.strictEqual(commits[1].message, 'feat: update shared in feature');
  });

  it('discovers files touched across rebase range', async () => {
    const files = await getRebaseFiles('main', 'feature-auth', testDir);
    assert.strictEqual(files.length, 2);
    assert.ok(files.some((f) => f.path === 'feature.txt'));
    assert.ok(files.some((f) => f.path === 'shared.txt'));
  });

  it('detects potential conflicts between main and feature-auth before rebasing', async () => {
    const { hasConflicts, conflictingFiles } = await checkRebaseConflicts('main', 'feature-auth', testDir);
    assert.strictEqual(hasConflicts, true);
    assert.strictEqual(conflictingFiles.length, 1);
    assert.strictEqual(conflictingFiles[0], 'shared.txt');
  });

  it('detects active in-progress rebase and conflict state', async () => {
    // Attempt rebase which will conflict on shared.txt
    try {
      await execFileAsync('git', ['rebase', 'main'], { cwd: testDir });
    } catch {
      // Expected to pause on conflict
    }

    const inProgress = await isRebaseInProgress(testDir);
    assert.strictEqual(inProgress, true);

    const progress = await getRebaseProgress(testDir);
    assert.strictEqual(progress.inProgress, true);
    assert.strictEqual(progress.hasConflicts, true);
    assert.ok(progress.conflictingFiles.includes('shared.txt'));

    // Test preva rebase in non-interactive mode during conflict
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'rebase'],
      { cwd: testDir }
    );
    assert.match(stdout, /REBASE IN PROGRESS/);
    assert.match(stdout, /shared\.txt/);

    // Abort cleanly
    await runGitRebaseAbort(testDir);
    const afterAbort = await isRebaseInProgress(testDir);
    assert.strictEqual(afterAbort, false);
  });
});
