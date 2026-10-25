import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getRepoState,
  getUpstreamSyncStatus,
} from '../src/utils/git.js';
import {
  renderStatusDashboard,
  getStatusData,
} from '../src/commands/status.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git status dashboard formatting & state unit tests', () => {
  it('renders clean working tree dashboard', () => {
    const mockData = {
      branch: 'main',
      repoState: { inProgress: false, type: null, label: 'Clean' },
      upstream: { hasUpstream: true, upstream: 'origin/main', ahead: 0, behind: 0 },
      staged: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, files: [] },
      unstaged: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, files: [] },
      untracked: [],
      stashes: [],
    };

    const output = renderStatusDashboard(mockData);
    assert.ok(output.includes('main'));
    assert.ok(output.includes('synced with origin/main'));
    assert.ok(output.includes('Working tree clean'));
  });

  it('renders staged, unstaged, and sensitive untracked files with badges', () => {
    const mockData = {
      branch: 'feature-auth',
      repoState: { inProgress: true, type: 'merge', label: 'MERGE IN PROGRESS' },
      upstream: { hasUpstream: true, upstream: 'origin/feature-auth', ahead: 2, behind: 1 },
      staged: {
        totalFiles: 1,
        totalAdditions: 25,
        totalDeletions: 2,
        files: [{ path: 'src/index.js', status: 'modified', additions: 25, deletions: 2 }],
      },
      unstaged: {
        totalFiles: 1,
        totalAdditions: 5,
        totalDeletions: 1,
        files: [{ path: 'README.md', status: 'modified', additions: 5, deletions: 1 }],
      },
      untracked: [
        { path: '.env.local', sizeFormatted: '450 B', flagged: true, reason: 'environment variable file' },
      ],
      stashes: [{ ref: 'stash@{0}' }],
    };

    const output = renderStatusDashboard(mockData);
    assert.ok(output.includes('feature-auth'));
    assert.ok(output.includes('ahead 2'));
    assert.ok(output.includes('behind 1'));
    assert.ok(output.includes('MERGE IN PROGRESS'));
    assert.ok(output.includes('Staged for Commit'));
    assert.ok(output.includes('src/index.js'));
    assert.ok(output.includes('README.md'));
    assert.ok(output.includes('.env.local'));
    assert.ok(output.includes('SECRET'));
    assert.ok(output.includes('1 saved stash(es)'));
  });
});

describe('git status operations in live repository', () => {
  let bareRemoteDir;
  let localDir;

  before(async () => {
    bareRemoteDir = mkdtempSync(join(tmpdir(), 'preva-status-remote-'));
    await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: bareRemoteDir });

    localDir = mkdtempSync(join(tmpdir(), 'preva-status-local-'));
    await execFileAsync('git', ['clone', bareRemoteDir, '.'], { cwd: localDir });
    await execFileAsync('git', ['config', 'user.name', 'StatusTester'], { cwd: localDir });
    await execFileAsync('git', ['config', 'user.email', 'status@example.com'], { cwd: localDir });

    // Initial commit
    writeFileSync(join(localDir, 'init.txt'), 'hello\n');
    await execFileAsync('git', ['add', '.'], { cwd: localDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit'], { cwd: localDir });
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: localDir });
  });

  after(() => {
    try {
      rmSync(bareRemoteDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('detects clean repo state and upstream tracking', async () => {
    const state = await getRepoState(localDir);
    assert.strictEqual(state.inProgress, false);

    const upstream = await getUpstreamSyncStatus(localDir);
    assert.strictEqual(upstream.hasUpstream, true);
    assert.strictEqual(upstream.ahead, 0);
    assert.strictEqual(upstream.behind, 0);
  });

  it('detects ahead status when local commit exists', async () => {
    writeFileSync(join(localDir, 'commit1.txt'), 'content\n');
    await execFileAsync('git', ['add', '.'], { cwd: localDir });
    await execFileAsync('git', ['commit', '-m', 'feat: local feature'], { cwd: localDir });

    const upstream = await getUpstreamSyncStatus(localDir);
    assert.strictEqual(upstream.hasUpstream, true);
    assert.strictEqual(upstream.ahead, 1);
    assert.strictEqual(upstream.behind, 0);
  });

  it('detects in-progress merge state via getRepoState', async () => {
    const gitDir = join(localDir, '.git');
    const mergeHeadPath = join(gitDir, 'MERGE_HEAD');

    writeFileSync(mergeHeadPath, 'fake-merge-hash\n');
    const state = await getRepoState(localDir);
    assert.strictEqual(state.inProgress, true);
    assert.strictEqual(state.type, 'merge');

    rmSync(mergeHeadPath, { force: true });
  });

  it('gathers full status data with staged, unstaged, and untracked files', async () => {
    // Staged file
    writeFileSync(join(localDir, 'staged.txt'), 'staged\n');
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: localDir });

    // Unstaged modification
    writeFileSync(join(localDir, 'init.txt'), 'hello modified\n');

    // Untracked sensitive file
    writeFileSync(join(localDir, '.env'), 'SECRET_KEY=12345\n');

    const data = await getStatusData(localDir);
    assert.strictEqual(data.staged.totalFiles, 1);
    assert.strictEqual(data.staged.files[0].path, 'staged.txt');

    assert.strictEqual(data.unstaged.totalFiles, 1);
    assert.strictEqual(data.unstaged.files[0].path, 'init.txt');

    const envFile = data.untracked.find((f) => f.path === '.env');
    assert.ok(envFile);
    assert.strictEqual(envFile.flagged, true);
  });

  it('runs preva status CLI in non-interactive mode', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'status'],
      { cwd: localDir }
    );

    assert.match(stdout, /Repository Health Dashboard/);
    assert.match(stdout, /main/);
    assert.match(stdout, /Staged for Commit/);
    assert.match(stdout, /staged\.txt/);
    assert.match(stdout, /Unstaged Modifications/);
    assert.match(stdout, /init\.txt/);
    assert.match(stdout, /SECRET/);
  });

  it('runs preva git status -s CLI', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'status', '-s'],
      { cwd: localDir }
    );

    assert.match(stdout, /Repository Health Dashboard/);
    assert.match(stdout, /staged\.txt/);
  });
});
