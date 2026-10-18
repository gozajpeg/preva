import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMMIT_TYPES, formatCommitMessage } from '../src/commands/commit.js';
import { getStagedFiles, commitStaged } from '../src/utils/git.js';

const execFileAsync = promisify(execFile);

function safeCleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

async function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'preva-commit-test-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'CommitTester'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'committer@preva.dev'], { cwd: dir });
  return dir;
}

describe('Conventional Commit Formatter & Logic', () => {
  it('formats commit message without scope correctly', () => {
    const msg = formatCommitMessage('feat', '', 'add user authentication');
    assert.strictEqual(msg, 'feat: add user authentication');
  });

  it('formats commit message with scope correctly', () => {
    const msg = formatCommitMessage('fix', 'auth', 'resolve jwt signature validation');
    assert.strictEqual(msg, 'fix(auth): resolve jwt signature validation');
  });

  it('trims excess whitespace and strips trailing periods', () => {
    const msg = formatCommitMessage('docs', '  readme  ', '  update quickstart guide.  ');
    assert.strictEqual(msg, 'docs(readme): update quickstart guide');
  });

  it('normalizes scope to lowercase', () => {
    const msg = formatCommitMessage('feat', 'AUTH_SERVICE', 'add oauth provider');
    assert.strictEqual(msg, 'feat(auth_service): add oauth provider');
  });

  it('formats breaking change with exclamation mark (!)', () => {
    const withScope = formatCommitMessage('feat', 'api', 'drop v1 endpoints', true);
    assert.strictEqual(withScope, 'feat(api)!: drop v1 endpoints');

    const withoutScope = formatCommitMessage('fix', '', 'change default port', true);
    assert.strictEqual(withoutScope, 'fix!: change default port');
  });

  it('defines standard conventional commit types', () => {
    const values = COMMIT_TYPES.map((t) => t.value);
    assert.ok(values.includes('feat'));
    assert.ok(values.includes('fix'));
    assert.ok(values.includes('docs'));
    assert.ok(values.includes('style'));
    assert.ok(values.includes('refactor'));
    assert.ok(values.includes('perf'));
    assert.ok(values.includes('test'));
    assert.ok(values.includes('build'));
    assert.ok(values.includes('ci'));
    assert.ok(values.includes('chore'));
    assert.ok(values.includes('revert'));
  });
});

describe('getStagedFiles & commitStaged Git Helpers', () => {
  it('returns empty array when nothing is staged', async () => {
    const repo = await createRepo();
    try {
      const staged = await getStagedFiles(repo);
      assert.strictEqual(staged.length, 0);
    } finally {
      safeCleanup(repo);
    }
  });

  it('detects newly staged files with accurate status', async () => {
    const repo = await createRepo();
    try {
      writeFileSync(join(repo, 'new-file.txt'), 'hello');
      await execFileAsync('git', ['add', '.'], { cwd: repo });

      const staged = await getStagedFiles(repo);
      assert.strictEqual(staged.length, 1);
      assert.strictEqual(staged[0].path, 'new-file.txt');
      assert.strictEqual(staged[0].status, 'new');
    } finally {
      safeCleanup(repo);
    }
  });

  it('commits staged files with formatted message', async () => {
    const repo = await createRepo();
    try {
      writeFileSync(join(repo, 'feature.js'), 'export const a = 1;');
      await execFileAsync('git', ['add', '.'], { cwd: repo });

      const formatted = formatCommitMessage('feat', 'core', 'implement feature a');
      await commitStaged(formatted, [], repo);

      const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%s%x09%an'], { cwd: repo });
      const [msg, author] = stdout.trim().split('\t');

      assert.strictEqual(msg, 'feat(core): implement feature a');
      assert.strictEqual(author, 'CommitTester');

      // Now index should be clean
      const remainingStaged = await getStagedFiles(repo);
      assert.strictEqual(remainingStaged.length, 0);
    } finally {
      safeCleanup(repo);
    }
  });
});
