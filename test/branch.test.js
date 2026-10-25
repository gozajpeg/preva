import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getCurrentBranch,
  getLocalBranches,
  createBranch,
  switchBranch,
  renameBranch,
  deleteBranch,
  getBranchMergeStatus,
  hasWorkingTreeChanges,
  validateRemoteUrl,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

describe('branch management & remote validation', () => {
  let tempDir;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preva-branch-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempDir });

    // Initial commit
    writeFileSync(join(tempDir, 'README.md'), '# Test');
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

  it('detects current active branch as main', async () => {
    const branch = await getCurrentBranch(tempDir);
    assert.strictEqual(branch, 'main');
  });

  it('lists local branches with commit details and active marker', async () => {
    const branches = await getLocalBranches(tempDir);
    assert.strictEqual(branches.length, 1);
    assert.strictEqual(branches[0].name, 'main');
    assert.strictEqual(branches[0].isCurrent, true);
    assert.strictEqual(branches[0].subject, 'feat: initial commit');
    assert.ok(branches[0].hash);
  });

  it('creates a new branch without switching', async () => {
    await createBranch('feature-offline', false, tempDir);
    const branches = await getLocalBranches(tempDir);
    assert.strictEqual(branches.length, 2);

    const names = branches.map((b) => b.name);
    assert.ok(names.includes('main'));
    assert.ok(names.includes('feature-offline'));

    // Should still be on main
    const current = await getCurrentBranch(tempDir);
    assert.strictEqual(current, 'main');
  });

  it('creates and switches to a new branch', async () => {
    await createBranch('feature-auth', true, tempDir);
    const current = await getCurrentBranch(tempDir);
    assert.strictEqual(current, 'feature-auth');
  });

  it('switches back to main branch', async () => {
    await switchBranch('main', tempDir);
    const current = await getCurrentBranch(tempDir);
    assert.strictEqual(current, 'main');
  });

  it('detects uncommitted working tree changes', async () => {
    const beforeDirty = await hasWorkingTreeChanges(tempDir);
    assert.strictEqual(beforeDirty, false);

    writeFileSync(join(tempDir, 'dirty.txt'), 'unstaged change');
    const afterDirty = await hasWorkingTreeChanges(tempDir);
    assert.strictEqual(afterDirty, true);

    // Clean up
    rmSync(join(tempDir, 'dirty.txt'));
    const restored = await hasWorkingTreeChanges(tempDir);
    assert.strictEqual(restored, false);
  });

  it('detects fully merged branch status', async () => {
    // feature-offline points to same commit as main, so it is fully merged
    const status = await getBranchMergeStatus('feature-offline', 'main', tempDir);
    assert.strictEqual(status.isMerged, true);
    assert.strictEqual(status.unmergedCommits.length, 0);
  });

  it('detects unmerged branch with commit list', async () => {
    // Switch to feature-offline and make an unmerged commit
    await switchBranch('feature-offline', tempDir);
    writeFileSync(join(tempDir, 'experiment.txt'), 'experimental work');
    await execFileAsync('git', ['add', '.'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'feat: unmerged experiment'], { cwd: tempDir });

    await switchBranch('main', tempDir);

    const status = await getBranchMergeStatus('feature-offline', 'main', tempDir);
    assert.strictEqual(status.isMerged, false);
    assert.strictEqual(status.unmergedCommits.length, 1);
    assert.strictEqual(status.unmergedCommits[0].message, 'feat: unmerged experiment');
  });

  it('deletes a merged branch safely with -d', async () => {
    // feature-auth has no unmerged commits against main
    await deleteBranch('feature-auth', false, tempDir);
    const branches = await getLocalBranches(tempDir);
    const names = branches.map((b) => b.name);
    assert.strictEqual(names.includes('feature-auth'), false);
  });

  it('force deletes an unmerged branch with -D', async () => {
    await deleteBranch('feature-offline', true, tempDir);
    const branches = await getLocalBranches(tempDir);
    const names = branches.map((b) => b.name);
    assert.strictEqual(names.includes('feature-offline'), false);
  });

  it('renames a branch using -m', async () => {
    await createBranch('temp-branch', false, tempDir);
    await renameBranch('temp-branch', 'renamed-branch', false, tempDir);

    const branches = await getLocalBranches(tempDir);
    const names = branches.map((b) => b.name);
    assert.strictEqual(names.includes('temp-branch'), false);
    assert.ok(names.includes('renamed-branch'));

    // Clean up
    await deleteBranch('renamed-branch', true, tempDir);
  });

  describe('validateRemoteUrl helper', () => {
    it('approves valid https and ssh git remote URLs', () => {
      const httpsRes = validateRemoteUrl('https://github.com/gozajpeg/preva.git');
      assert.strictEqual(httpsRes.valid, true);

      const sshRes = validateRemoteUrl('git@github.com:gozajpeg/preva.git');
      assert.strictEqual(sshRes.valid, true);
    });

    it('catches gttps typo and suggests https', () => {
      const result = validateRemoteUrl('gttps://github.com/gozajpeg/barstile.git');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.protocol, 'gttps');
      assert.strictEqual(result.suggestion, 'https://github.com/gozajpeg/barstile.git');
      assert.ok(result.error.includes("Malformed protocol 'gttps://'"));
    });

    it('catches htps typo and suggests https', () => {
      const result = validateRemoteUrl('htps://github.com/user/project.git');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.protocol, 'htps');
      assert.strictEqual(result.suggestion, 'https://github.com/user/project.git');
    });

    it('flags empty and unrecognized URLs', () => {
      assert.strictEqual(validateRemoteUrl('').valid, false);
      assert.strictEqual(validateRemoteUrl('not-a-valid-url').valid, false);
    });
  });
});
