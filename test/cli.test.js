import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('CLI binary tests', () => {
  it('outputs version with --version flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('outputs help menu with --help flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);
    assert.match(stdout, /preva git add/);
    assert.match(stdout, /preva git commit/);
    assert.match(stdout, /preva git push/);
    assert.match(stdout, /preva git pull/);
    assert.match(stdout, /preva git merge/);
    assert.match(stdout, /preva git branch/);
    assert.match(stdout, /preva git stash/);
    assert.match(stdout, /preva git restore/);
    assert.match(stdout, /preva git reset/);
    assert.match(stdout, /preva git clean/);
    assert.match(stdout, /preva git diff/);
    assert.match(stdout, /preva git status/);
    assert.match(stdout, /preva git rebase/);
    assert.match(stdout, /preva git log/);
    assert.match(stdout, /preva git cherry-pick/);
    assert.match(stdout, /preva git tag/);
    assert.match(stdout, /preva git clone/);
    assert.match(stdout, /preva git revert/);
    assert.match(stdout, /preva git remote/);
    assert.match(stdout, /preva git init/);
  });

  it('outputs version with -v flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '-v']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('outputs help menu with -h flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '-h']);
    assert.match(stdout, /preva git init/);
    assert.match(stdout, /preva git remote/);
  });

  it('exits with error on unknown command', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'foobar']);
      assert.fail('Should have thrown an error');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Unknown command/);
    }
  });

  it('verifies CLI routing for every git command in both forms (shorthand & git prefix)', async () => {
    // List of all supported command names and their expected handlers
    const commands = [
      'add',
      'commit',
      'push',
      'pull',
      'merge',
      'branch',
      'switch',
      'checkout',
      'restore',
      'reset',
      'undo',
      'clean',
      'stash',
      'diff',
      'status',
      'rebase',
      'log',
      'cherry-pick',
      'tag',
      'clone',
      'revert',
      'remote',
      'init',
    ];

    for (const cmd of commands) {
      // Test outside a git repo with a temp dir: each command should reach its handler
      // and either succeed (init, clone, etc.) or exit gracefully (e.g., 'Not a git repository')
      // but NEVER fail with 'Unknown command: ...'
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, cmd, '--non-interactive-test-probe'], {
          cwd: process.cwd(),
        });
        const combined = stdout + stderr;
        assert.ok(!combined.includes(`Unknown command: ${cmd}`), `Command '${cmd}' failed routing`);
      } catch (err) {
        const combined = (err.stdout || '') + (err.stderr || '');
        assert.ok(!combined.includes(`Unknown command: ${cmd}`), `Command '${cmd}' failed routing with: ${combined}`);
      }

      // Test with 'git' prefix
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, 'git', cmd, '--non-interactive-test-probe'], {
          cwd: process.cwd(),
        });
        const combined = stdout + stderr;
        assert.ok(!combined.includes(`Unknown command: git ${cmd}`), `Command 'git ${cmd}' failed routing`);
      } catch (err) {
        const combined = (err.stdout || '') + (err.stderr || '');
        assert.ok(!combined.includes(`Unknown command: git ${cmd}`), `Command 'git ${cmd}' failed routing with: ${combined}`);
      }
    }
  });
});
