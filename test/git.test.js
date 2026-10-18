import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePorcelainStatus } from '../src/utils/git.js';

describe('git - parsePorcelainStatus', () => {
  it('parses modified, new, and deleted files', () => {
    // Simulated git status --porcelain=v1 -z
    // " M src/index.js\0?? untracked.txt\0 D removed.js\0"
    const rawOutput = ' M src/index.js\0?? untracked.txt\0 D removed.js\0';
    const files = parsePorcelainStatus(rawOutput);

    assert.strictEqual(files.length, 3);

    const modified = files.find((f) => f.path === 'src/index.js');
    assert.ok(modified);
    assert.strictEqual(modified.status, 'modified');
    assert.strictEqual(modified.isTracked, true);

    const untracked = files.find((f) => f.path === 'untracked.txt');
    assert.ok(untracked);
    assert.strictEqual(untracked.status, 'new');
    assert.strictEqual(untracked.isTracked, false);

    const deleted = files.find((f) => f.path === 'removed.js');
    assert.ok(deleted);
    assert.strictEqual(deleted.status, 'deleted');
  });

  it('handles renamed files without off-by-one indexing bugs', () => {
    // In git status -z:
    // "R  new_name.js\0old_name.js\0 M other.js\0"
    const rawOutput = 'R  new_name.js\0old_name.js\0 M other.js\0';
    const files = parsePorcelainStatus(rawOutput);

    // Note: old_name.js is skipped, so only 2 files should be parsed
    // Wait, let's see if R  has worktree changes. In "R ", workTreeStatus is ' '.
    // Wait! Let's check: if it was renamed AND staged already with no unstaged changes,
    // workTreeStatus is ' ', so it's not stageable with git add unless workTreeStatus is modified or similar.
    // What if "RM new_name.js\0old_name.js\0"? Then workTreeStatus is 'M'!
    const rawOutputWithUnstaged = 'RM new_name.js\0old_name.js\0 M other.js\0';
    const filesUnstaged = parsePorcelainStatus(rawOutputWithUnstaged);

    assert.strictEqual(filesUnstaged.length, 2);
    assert.strictEqual(filesUnstaged[0].path, 'new_name.js');
    assert.strictEqual(filesUnstaged[0].status, 'renamed');
    assert.strictEqual(filesUnstaged[1].path, 'other.js');
    assert.strictEqual(filesUnstaged[1].status, 'modified');
  });

  it('normalizes Windows backslashes in paths', () => {
    const rawOutput = ' M src\\utils\\helper.js\0';
    const files = parsePorcelainStatus(rawOutput);

    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'src/utils/helper.js');
  });
});
