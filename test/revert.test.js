import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getCommitParents,
  checkRevertConflicts,
  isRevertInProgress,
  getRevertProgress,
  runGitRevert,
  runGitRevertAbort,
} from '../src/utils/git.js';
import {
  renderRevertPreview,
  renderRevertInProgress,
} from '../src/commands/revert.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git revert formatting & inspection unit tests', () => {
  it('renders pre-revert safety preview for a clean standard commit', () => {
    const details = {
      hash: 'a1b2c3d',
      subject: 'feat: add user authentication module',
      author: 'Jane Doe',
      email: 'jane@example.com',
      date: '2026-10-24 10:00:00',
      relativeDate: '2 hours ago',
      files: [
        {
          path: 'src/auth.js',
          status: 'new',
          additions: 45,
          deletions: 0,
          isBinary: false,
        },
        {
          path: 'config/app.json',
          status: 'modified',
          additions: 3,
          deletions: 1,
          isBinary: false,
        },
      ],
    };

    const conflictInfo = {
      hasConflicts: false,
      conflictingFiles: [],
      isDirty: false,
    };

    const parentInfo = {
      isMerge: false,
      parents: ['9876543'],
      parentCount: 1,
    };

    const rendered = stripAnsi(renderRevertPreview(details, conflictInfo, parentInfo, 'main', { maxCols: 120 }));
    assert.match(rendered, /preva revert/);
    assert.match(rendered, /Safety Preview/);
    assert.match(rendered, /a1b2c3d/);
    assert.match(rendered, /feat: add user authentication module/);
    assert.match(rendered, /Target Branch:\s+main/);
    assert.match(rendered, /Files to Invert \(2 file\(s\)\)/);
    assert.match(rendered, /src\/auth\.js/);
    assert.match(rendered, /No subsequent overlapping changes detected\./);
    assert.match(rendered, /Clean working tree ready for revert\./);
  });

  it('renders pre-revert preview with merge commit warning and mainline info', () => {
    const details = {
      hash: 'e5f6a7b',
      subject: 'Merge branch feature-billing into main',
      author: 'Release Bot',
      email: 'bot@example.com',
      date: '2026-10-24',
      relativeDate: '1 hour ago',
      files: [
        {
          path: 'src/billing.js',
          status: 'new',
          additions: 100,
          deletions: 0,
          isBinary: false,
        },
      ],
    };

    const conflictInfo = {
      hasConflicts: false,
      conflictingFiles: [],
      isDirty: false,
    };

    const parentInfo = {
      isMerge: true,
      parents: ['1111111', '2222222'],
      parentCount: 2,
    };

    const rendered = stripAnsi(renderRevertPreview(details, conflictInfo, parentInfo, 'main', { maxCols: 120 }));
    assert.match(rendered, /Merge Commit/);
    assert.match(rendered, /Mainline \(-m\) will be applied/);
    assert.match(rendered, /1111111, 2222222/);
  });

  it('renders pre-revert preview with conflict warning and dirty working tree', () => {
    const details = {
      hash: 'c3d4e5f',
      subject: 'fix: update api endpoint url',
      author: 'Dev One',
      email: 'dev@example.com',
      date: '2026-10-24',
      relativeDate: '3 days ago',
      files: [
        {
          path: 'src/api.js',
          status: 'modified',
          additions: 2,
          deletions: 2,
          isBinary: false,
        },
      ],
    };

    const conflictInfo = {
      hasConflicts: true,
      conflictingFiles: ['src/api.js'],
      isDirty: true,
    };

    const parentInfo = {
      isMerge: false,
      parents: ['0000000'],
      parentCount: 1,
    };

    const rendered = stripAnsi(renderRevertPreview(details, conflictInfo, parentInfo, 'main', { maxCols: 120 }));
    assert.match(rendered, /Potential merge conflict in 1 file\(s\):/);
    assert.match(rendered, /src\/api\.js/);
    assert.match(rendered, /Uncommitted changes detected in working tree\./);
  });

  it('renders in-progress revert banner with unmerged conflicts', () => {
    const progress = {
      inProgress: true,
      hash: '9f8e7d6',
      details: {
        subject: 'refactor: database schema',
        author: 'Lead Architect',
        relativeDate: 'Yesterday',
      },
      hasConflicts: true,
      conflictingFiles: ['schema.sql', 'db.js'],
    };

    const rendered = stripAnsi(renderRevertInProgress(progress, { maxCols: 120 }));
    assert.match(rendered, /REVERT IN PROGRESS/);
    assert.match(rendered, /9f8e7d6/);
    assert.match(rendered, /refactor: database schema/);
    assert.match(rendered, /2 file\(s\) currently unmerged:/);
    assert.match(rendered, /schema\.sql/);
    assert.match(rendered, /git revert --continue/);
    assert.match(rendered, /git revert --abort/);
  });
});

describe('git revert operations in live repository', () => {
  let testDir;
  let commit1;
  let commit2;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-revert-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'RevertTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'revert@example.com'], { cwd: testDir });

    writeFileSync(join(testDir, 'file1.txt'), 'Base line 1\nBase line 2\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial commit'], { cwd: testDir });
    const { stdout: out1 } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    commit1 = out1.trim();

    writeFileSync(join(testDir, 'feature.txt'), 'Feature line A\nFeature line B\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: add feature file'], { cwd: testDir });
    const { stdout: out2 } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    commit2 = out2.trim();
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects parent count and merge status accurately', async () => {
    const parents = await getCommitParents(commit2, testDir);
    assert.strictEqual(parents.isMerge, false);
    assert.strictEqual(parents.parents.length, 1);
    assert.strictEqual(parents.parents[0], commit1);
  });

  it('reports no active revert initially', async () => {
    const inProgress = await isRevertInProgress(testDir);
    assert.strictEqual(inProgress, false);

    const progress = await getRevertProgress(testDir);
    assert.strictEqual(progress.inProgress, false);
  });

  it('fails non-interactively when no commit is supplied', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'git', 'revert'], {
        cwd: testDir,
      });
      assert.fail('Should have failed without commit ref');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Commit reference required for revert/);
    }
  });

  it('fails non-interactively when invalid commit ref is supplied', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'git', 'revert', 'invalid-ref-12345'], {
        cwd: testDir,
      });
      assert.fail('Should have failed on invalid ref');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Could not resolve commit/);
    }
  });

  it('reverts commit into working tree with -n flag (no commit created)', async () => {
    // Add another commit to revert
    writeFileSync(join(testDir, 'temp.txt'), 'Temporary content\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: add temporary file'], { cwd: testDir });
    const { stdout: tempCommitOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    const tempCommit = tempCommitOut.trim();

    // Revert with -n via CLI
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'revert', '-n', tempCommit],
      { cwd: testDir }
    );

    assert.match(stdout, /Safety Preview/);
    assert.match(stdout, /Successfully inverted changes into working tree without committing/);

    // Verify temp.txt was removed in working tree
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: testDir });
    assert.match(statusOut, /D  temp\.txt/);

    // Commit the revert to keep clean state
    await execFileAsync('git', ['commit', '-m', 'revert: temporary file'], { cwd: testDir });
  });

  it('reverts a standard commit directly with native git revert', async () => {
    writeFileSync(join(testDir, 'revert-me.txt'), 'Hello world\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: commit to revert'], { cwd: testDir });
    const { stdout: targetOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    const targetHash = targetOut.trim();

    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'revert', '--no-edit', targetHash],
      { cwd: testDir }
    );

    assert.match(stdout, /Successfully reverted commit/);

    // Latest commit should now be a revert commit
    const { stdout: logOut } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: testDir });
    assert.match(logOut, /Revert "feat: commit to revert"/);
  });

  it('handles revert conflict, detects REVERT_HEAD, and safely aborts', async () => {
    // Create commit A touching conflict.txt
    writeFileSync(join(testDir, 'conflict.txt'), 'Original Line 1\nOriginal Line 2\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial conflict file'], { cwd: testDir });
    const { stdout: baseOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    const baseCommit = baseOut.trim();

    // Create commit B modifying conflict.txt
    writeFileSync(join(testDir, 'conflict.txt'), 'Step B Line 1\nStep B Line 2\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: step B modification'], { cwd: testDir });
    const { stdout: stepBOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    const stepBCommit = stepBOut.trim();

    // Create commit C modifying conflict.txt completely
    writeFileSync(join(testDir, 'conflict.txt'), 'Step C Line X\nStep C Line Y\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: step C modification'], { cwd: testDir });

    // Now attempting to revert Step B will produce a conflict with Step C!
    try {
      await runGitRevert(['--no-edit', stepBCommit], testDir);
      assert.fail('Revert should have conflicted');
    } catch {
      // Conflict occurred
    }

    // Verify REVERT_HEAD is active
    const inProgress = await isRevertInProgress(testDir);
    assert.strictEqual(inProgress, true);

    const progress = await getRevertProgress(testDir);
    assert.strictEqual(progress.inProgress, true);
    assert.strictEqual(progress.hasConflicts, true);
    assert.ok(progress.conflictingFiles.includes('conflict.txt'));

    // Abort revert cleanly
    await runGitRevertAbort(testDir);

    const abortedProgress = await isRevertInProgress(testDir);
    assert.strictEqual(abortedProgress, false);
  });
});
