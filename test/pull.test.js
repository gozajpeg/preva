import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getRemotes,
  getUpstreamRef,
  getIncomingCommits,
  getIncomingFiles,
  checkPullConflicts,
  runGitFetch,
  runGitPull,
} from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

describe('git pull & fetch preview operations in live repository', () => {
  let bareRemoteDir;
  let localDir;
  let remotePeerDir;

  before(async () => {
    // 1. Create a bare remote repository to act as origin
    bareRemoteDir = mkdtempSync(join(tmpdir(), 'preva-pull-remote-'));
    await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: bareRemoteDir });

    // 2. Clone to localDir
    localDir = mkdtempSync(join(tmpdir(), 'preva-pull-local-'));
    await execFileAsync('git', ['clone', bareRemoteDir, '.'], { cwd: localDir });
    await execFileAsync('git', ['config', 'user.name', 'LocalUser'], { cwd: localDir });
    await execFileAsync('git', ['config', 'user.email', 'local@example.com'], { cwd: localDir });

    // Initial commit in local and push to bare remote
    writeFileSync(join(localDir, 'README.md'), '# Initial Repo\n');
    await execFileAsync('git', ['add', '.'], { cwd: localDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial commit'], { cwd: localDir });
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: localDir });

    // 3. Clone peer to simulate remote teammate
    remotePeerDir = mkdtempSync(join(tmpdir(), 'preva-pull-peer-'));
    await execFileAsync('git', ['clone', bareRemoteDir, '.'], { cwd: remotePeerDir });
    await execFileAsync('git', ['config', 'user.name', 'PeerUser'], { cwd: remotePeerDir });
    await execFileAsync('git', ['config', 'user.email', 'peer@example.com'], { cwd: remotePeerDir });
  });

  after(() => {
    try {
      rmSync(bareRemoteDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
      rmSync(remotePeerDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('detects configured remotes correctly', async () => {
    const remotes = await getRemotes(localDir);
    assert.deepStrictEqual(remotes, ['origin']);
  });

  it('detects upstream tracking ref for active branch', async () => {
    const upstream = await getUpstreamRef(localDir);
    assert.strictEqual(upstream, 'origin/main');
  });

  it('reports 0 incoming commits when local is up to date', async () => {
    const { ahead, behind, incomingCommits } = await getIncomingCommits(localDir);
    assert.strictEqual(ahead, 0);
    assert.strictEqual(behind, 0);
    assert.strictEqual(incomingCommits.length, 0);
  });

  it('detects incoming commits after teammate pushes to remote', async () => {
    // Teammate adds 2 commits in peer repo and pushes
    writeFileSync(join(remotePeerDir, 'feature.js'), 'export const x = 1;\n');
    await execFileAsync('git', ['add', '.'], { cwd: remotePeerDir });
    await execFileAsync('git', ['commit', '-m', 'feat: add feature file'], { cwd: remotePeerDir });

    writeFileSync(join(remotePeerDir, 'feature.js'), 'export const x = 2;\n');
    await execFileAsync('git', ['add', '.'], { cwd: remotePeerDir });
    await execFileAsync('git', ['commit', '-m', 'fix: update feature file'], { cwd: remotePeerDir });

    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: remotePeerDir });

    // Fetch silently in localDir
    await runGitFetch('origin', 'main', localDir);

    // Query incoming commits in localDir
    const { ahead, behind, upstreamRef, incomingCommits } = await getIncomingCommits(localDir);
    assert.strictEqual(ahead, 0);
    assert.strictEqual(behind, 2);
    assert.strictEqual(upstreamRef, 'origin/main');
    assert.strictEqual(incomingCommits.length, 2);
    assert.strictEqual(incomingCommits[0].message, 'fix: update feature file');
    assert.strictEqual(incomingCommits[1].message, 'feat: add feature file');
  });

  it('detects incoming changed files', async () => {
    const files = await getIncomingFiles(localDir, 'origin/main');
    assert.ok(files.length > 0);
    const featureFile = files.find((f) => f.path === 'feature.js');
    assert.ok(featureFile);
  });

  it('detects potential merge conflicts when local uncommitted edits overlap', async () => {
    // Create local dirty edit in feature.js (which was changed upstream!)
    writeFileSync(join(localDir, 'feature.js'), 'conflicting local edit\n');

    const incomingFiles = await getIncomingFiles(localDir, 'origin/main');
    const conflictCheck = await checkPullConflicts(incomingFiles, localDir);

    assert.strictEqual(conflictCheck.hasConflicts, true);
    assert.ok(conflictCheck.conflictingFiles.includes('feature.js'));

    // Discard the dirty edit
    rmSync(join(localDir, 'feature.js'), { force: true });
  });

  it('reports no conflict when local uncommitted edits do not overlap', async () => {
    // Create local dirty edit in an unrelated file
    writeFileSync(join(localDir, 'local-notes.txt'), 'notes\n');

    const incomingFiles = await getIncomingFiles(localDir, 'origin/main');
    const conflictCheck = await checkPullConflicts(incomingFiles, localDir);

    assert.strictEqual(conflictCheck.hasConflicts, false);
    assert.strictEqual(conflictCheck.conflictingFiles.length, 0);

    // Clean up local notes
    rmSync(join(localDir, 'local-notes.txt'));
  });

  it('pulls incoming changes cleanly with runGitPull', async () => {
    await runGitPull(['--ff-only'], localDir);

    const { behind } = await getIncomingCommits(localDir);
    assert.strictEqual(behind, 0);
  });
});
