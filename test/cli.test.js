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
});
