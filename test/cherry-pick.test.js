import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isCherryPickInProgress,
  getCherryPickProgress,
  checkCherryPickConflicts,
  runGitCherryPick,
  runGitCherryPickAbort,
} from '../src/utils/git.js';
import {
  renderCherryPickPreview,
  renderCherryPickInProgress,
} from '../src/commands/cherry-pick.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git cherry-pick preview & in-progress formatting unit tests', () => {
  it('renders clean cherry-pick preview with modified files and stats', () => {
    const details = {
      hash: '76e69c1',
      subject: 'feat: add user authentication',
      author: 'Jane Doe',
      email: 'jane@example.com',
      date: '2026-10-20 12:00:00',
      relativeDate: '2 days ago',
      files: [
        { path: 'src/auth.js', status: 'new', additions: 50, deletions: 0, isBinary: false },
        { path: 'src/routes.js', status: 'modified', additions: 10, deletions: 2, isBinary: false },
      ],
    };

    const conflictInfo = {
      hasConflicts: false,
      conflictingFiles: [],
      isDirty: false,
    };

    const rendered = stripAnsi(renderCherryPickPreview(details, conflictInfo, 'main', { maxCols: 100 }));
    assert.match(rendered, /preva cherry-pick/);
    assert.match(rendered, /76e69c1/);
    assert.match(rendered, /feat: add user authentication/);
    assert.match(rendered, /Jane Doe/);
    assert.match(rendered, /src\/auth\.js/);
    assert.match(rendered, /\[OK\] No merge conflicts detected/);
    assert.match(rendered, /\[OK\] Clean working tree ready/);
  });

  it('renders warnings when potential conflicts and dirty working tree are detected', () => {
    const details = {
      hash: 'abc1234',
      subject: 'fix: update shared logic',
      author: 'John Dev',
      email: 'john@example.com',
      date: '2026-10-21 14:00:00',
      relativeDate: '1 day ago',
      files: [{ path: 'shared.js', status: 'modified', additions: 5, deletions: 1, isBinary: false }],
    };

    const conflictInfo = {
      hasConflicts: true,
      conflictingFiles: ['shared.js'],
      isDirty: true,
    };

    const rendered = stripAnsi(renderCherryPickPreview(details, conflictInfo, 'main', { maxCols: 100 }));
    assert.match(rendered, /\[!\] Potential merge conflict in 1 file\(s\)/);
    assert.match(rendered, /shared\.js/);
    assert.match(rendered, /\[!\] Uncommitted changes detected in working tree/);
  });

  it('renders in-progress cherry-pick status with unmerged files', () => {
    const progress = {
      inProgress: true,
      hash: '76e69c1',
      hasConflicts: true,
      conflictingFiles: ['src/routes.js'],
      details: {
        subject: 'feat: add user authentication',
        author: 'Jane Doe',
        relativeDate: '2 days ago',
      },
    };

    const rendered = stripAnsi(renderCherryPickInProgress(progress, { maxCols: 100 }));
    assert.match(rendered, /CHERRY-PICK IN PROGRESS/);
    assert.match(rendered, /76e69c1/);
    assert.match(rendered, /src\/routes\.js/);
    assert.match(rendered, /Resolve conflicts in these files/);
  });
});

describe('git cherry-pick operations in live repository', () => {
  let testDir;
  let cleanCommitHash;
  let conflictCommitHash;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-cherry-pick-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'CherryTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'cherry@example.com'], { cwd: testDir });

    // Initial commit on main
    writeFileSync(join(testDir, 'base.txt'), 'base content\n');
    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit on main'], { cwd: testDir });

    // Create feature branch
    await execFileAsync('git', ['checkout', '-b', 'feature-auth'], { cwd: testDir });
    writeFileSync(join(testDir, 'standalone.txt'), 'standalone feature\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: clean standalone feature'], { cwd: testDir });
    const { stdout: cleanOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    cleanCommitHash = cleanOut.trim();

    // Commit that modifies shared.txt on feature branch
    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2 feature edit\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: update shared in feature'], { cwd: testDir });
    const { stdout: conflictOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    conflictCommitHash = conflictOut.trim();

    // Switch back to main and create conflicting change on shared.txt
    await execFileAsync('git', ['checkout', 'main'], { cwd: testDir });
    writeFileSync(join(testDir, 'shared.txt'), 'line 1\nline 2 main edit\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'fix: conflicting edit on main'], { cwd: testDir });
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('reports false when no cherry-pick is in progress', async () => {
    const inProgress = await isCherryPickInProgress(testDir);
    assert.strictEqual(inProgress, false);

    const progress = await getCherryPickProgress(testDir);
    assert.strictEqual(progress.inProgress, false);
  });

  it('detects potential conflicts before cherry-picking', async () => {
    const conflictInfo = await checkCherryPickConflicts(conflictCommitHash, testDir);
    assert.strictEqual(conflictInfo.hasConflicts, true);
    assert.ok(conflictInfo.conflictingFiles.includes('shared.txt'));
  });

  it('reports clean conflict check for non-overlapping commit', async () => {
    const conflictInfo = await checkCherryPickConflicts(cleanCommitHash, testDir);
    assert.strictEqual(conflictInfo.hasConflicts, false);
    assert.strictEqual(conflictInfo.conflictingFiles.length, 0);
  });

  it('applies a clean commit cleanly with runGitCherryPick', async () => {
    await runGitCherryPick([cleanCommitHash], testDir);

    const { stdout: logOut } = await execFileAsync('git', ['log', '-n', '1', '--oneline'], { cwd: testDir });
    assert.match(logOut, /feat: clean standalone feature/);

    const inProgress = await isCherryPickInProgress(testDir);
    assert.strictEqual(inProgress, false);
  });

  it('handles conflict, enters in-progress state, and aborts cleanly', async () => {
    try {
      await runGitCherryPick([conflictCommitHash], testDir);
      assert.fail('Should have failed with conflict');
    } catch {
      // Expected to fail due to conflict on shared.txt
    }

    const inProgress = await isCherryPickInProgress(testDir);
    assert.strictEqual(inProgress, true);

    const progress = await getCherryPickProgress(testDir);
    assert.strictEqual(progress.inProgress, true);
    assert.strictEqual(progress.hasConflicts, true);
    assert.ok(progress.conflictingFiles.includes('shared.txt'));

    // Abort the cherry-pick
    await runGitCherryPickAbort(testDir);

    const afterAbort = await isCherryPickInProgress(testDir);
    assert.strictEqual(afterAbort, false);
  });

  it('runs preva cherry-pick CLI in non-interactive mode without args and fails gracefully', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'cherry-pick'], { cwd: testDir });
      assert.fail('Should have failed without args in non-interactive mode');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Commit reference required for cherry-pick/);
    }
  });

  it('runs preva cherry-pick <hash> CLI in non-interactive mode and shows preview', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'cherry-pick', cleanCommitHash],
      { cwd: testDir }
    );
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /preva cherry-pick/);
    assert.match(cleanOut, /Safety Preview/);
    assert.match(cleanOut, /feat: clean standalone feature/);
  });
});
