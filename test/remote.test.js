import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getRemotes,
  getConfiguredRemotes,
  getBranchesTrackingRemote,
  getUrlProtocolLabel,
  addRemote,
  removeRemote,
  renameRemote,
  setRemoteUrl,
} from '../src/utils/git.js';
import {
  renderRemotesTable,
  renderRemoteDetails,
} from '../src/commands/remote.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git remote formatting & helper unit tests', () => {
  it('detects protocol labels accurately', () => {
    assert.strictEqual(getUrlProtocolLabel('https://github.com/owner/repo.git'), 'HTTPS');
    assert.strictEqual(getUrlProtocolLabel('http://github.com/owner/repo.git'), 'HTTP');
    assert.strictEqual(getUrlProtocolLabel('git@github.com:owner/repo.git'), 'SSH');
    assert.strictEqual(getUrlProtocolLabel('ssh://git@server.com/repo.git'), 'SSH');
    assert.strictEqual(getUrlProtocolLabel('file:///path/to/repo'), 'FILE');
    assert.strictEqual(getUrlProtocolLabel('git://git.kernel.org/repo.git'), 'GIT');
    assert.strictEqual(getUrlProtocolLabel(''), 'UNKNOWN');
    assert.strictEqual(getUrlProtocolLabel(null), 'UNKNOWN');
  });

  it('renders empty remotes table with helpful add tip', () => {
    const rendered = stripAnsi(renderRemotesTable([], { maxCols: 100 }));
    assert.match(rendered, /preva remote/);
    assert.match(rendered, /No remotes configured in this repository/);
    assert.match(rendered, /preva git remote add <name> <url>/);
  });

  it('renders remotes table with HTTPS and SSH endpoints', () => {
    const remotes = [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/owner/repo.git',
        pushUrl: 'https://github.com/owner/repo.git',
        protocol: 'HTTPS',
        isAsymmetric: false,
      },
      {
        name: 'upstream',
        fetchUrl: 'git@github.com:upstream/repo.git',
        pushUrl: 'git@github.com:upstream/repo.git',
        protocol: 'SSH',
        isAsymmetric: false,
      },
    ];

    const rendered = stripAnsi(renderRemotesTable(remotes, { maxCols: 120 }));
    assert.match(rendered, /2 remote\(s\)/);
    assert.match(rendered, /origin/);
    assert.match(rendered, /\[HTTPS\]/);
    assert.match(rendered, /upstream/);
    assert.match(rendered, /\[SSH\]/);
  });

  it('renders asymmetric remote where fetch and push URLs differ', () => {
    const remotes = [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/read-only/repo.git',
        pushUrl: 'git@github.com:write-access/repo.git',
        protocol: 'HTTPS',
        isAsymmetric: true,
      },
    ];

    const rendered = stripAnsi(renderRemotesTable(remotes, { maxCols: 120 }));
    assert.match(rendered, /\(fetch\)/);
    assert.match(rendered, /https:\/\/github\.com\/read-only\/repo\.git/);
    assert.match(rendered, /\(push\)/);
    assert.match(rendered, /git@github\.com:write-access\/repo\.git/);
  });

  it('renders detailed remote view with tracking branches', () => {
    const remote = {
      name: 'origin',
      fetchUrl: 'https://github.com/owner/repo.git',
      pushUrl: 'https://github.com/owner/repo.git',
      protocol: 'HTTPS',
      isAsymmetric: false,
    };

    const tracking = [
      { localBranch: 'main', remoteBranch: 'origin/main' },
      { localBranch: 'feature', remoteBranch: 'origin/feature' },
    ];

    const rendered = stripAnsi(renderRemoteDetails(remote, tracking, { maxCols: 120 }));
    assert.match(rendered, /Remote Details: origin/);
    assert.match(rendered, /HTTPS/);
    assert.match(rendered, /Tracking Branches \(2 local branch\(es\)\)/);
    assert.match(rendered, /main -> origin\/main/);
    assert.match(rendered, /feature -> origin\/feature/);
  });
});

describe('git remote operations in live repository', () => {
  let testDir;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-remote-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'RemoteTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'remote@example.com'], { cwd: testDir });

    writeFileSync(join(testDir, 'init.txt'), 'init\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit'], { cwd: testDir });
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns empty remotes initially', async () => {
    const remotes = await getConfiguredRemotes(testDir);
    assert.strictEqual(remotes.length, 0);
  });

  it('adds a remote via addRemote and discovers it in getRemotes', async () => {
    await addRemote('origin', 'https://github.com/sample/repo.git', testDir);

    const remotes = await getConfiguredRemotes(testDir);
    assert.strictEqual(remotes.length, 1);
    assert.strictEqual(remotes[0].name, 'origin');
    assert.strictEqual(remotes[0].fetchUrl, 'https://github.com/sample/repo.git');
    assert.strictEqual(remotes[0].protocol, 'HTTPS');
    assert.strictEqual(remotes[0].isAsymmetric, false);
  });

  it('updates remote URL via setRemoteUrl', async () => {
    await setRemoteUrl('origin', 'git@github.com:sample/repo.git', false, testDir);

    const remotes = await getConfiguredRemotes(testDir);
    assert.strictEqual(remotes.length, 1);
    assert.strictEqual(remotes[0].fetchUrl, 'git@github.com:sample/repo.git');
    assert.strictEqual(remotes[0].protocol, 'SSH');
  });

  it('renames a remote via renameRemote', async () => {
    await renameRemote('origin', 'upstream', testDir);

    const remotes = await getConfiguredRemotes(testDir);
    assert.strictEqual(remotes.length, 1);
    assert.strictEqual(remotes[0].name, 'upstream');
  });

  it('removes a remote via removeRemote', async () => {
    await removeRemote('upstream', testDir);

    const remotes = await getConfiguredRemotes(testDir);
    assert.strictEqual(remotes.length, 0);
  });

  it('fails non-interactively when adding remote without arguments', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'git', 'remote', 'add'], {
        cwd: testDir,
      });
      assert.fail('Should have failed without args');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Remote name and URL required/);
    }
  });

  it('adds and lists remote via preva CLI non-interactively', async () => {
    // Add remote
    const { stdout: addOut } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'remote', 'add', 'origin', 'https://github.com/test/project.git'],
      { cwd: testDir }
    );
    assert.match(stripAnsi(addOut), /Remote "origin" added successfully/);

    // List remotes
    const { stdout: listOut } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'remote', '-v'],
      { cwd: testDir }
    );
    const cleanList = stripAnsi(listOut);
    assert.match(cleanList, /Configured Repository Remotes/);
    assert.match(cleanList, /origin/);
    assert.match(cleanList, /\[HTTPS\]/);
    assert.match(cleanList, /https:\/\/github\.com\/test\/project\.git/);
  });

  it('fails non-interactively when adding an existing remote (collision guard)', async () => {
    try {
      await execFileAsync(
        process.execPath,
        [binPath, 'git', 'remote', 'add', 'origin', 'https://github.com/another/project.git'],
        { cwd: testDir }
      );
      assert.fail('Should have failed on remote collision');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Remote "origin" already exists/);
    }
  });

  it('updates URL and removes remote via CLI non-interactively', async () => {
    // Update URL
    const { stdout: setOut } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'remote', 'set-url', 'origin', 'https://github.com/test/updated.git'],
      { cwd: testDir }
    );
    assert.match(stripAnsi(setOut), /Remote "origin" URL updated successfully/);

    // Remove remote
    const { stdout: rmOut } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'remote', 'remove', 'origin'],
      { cwd: testDir }
    );
    assert.match(stripAnsi(rmOut), /Remote "origin" removed cleanly/);
  });
});
