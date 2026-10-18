import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isGitRepo,
  getRepoRoot,
  getChangedFiles,
  parsePorcelainStatus,
  stageFiles,
  getUnpushedCommits,
  getUnpushedFiles,
  runGit,
} from '../src/utils/git.js';
import { scanFiles, gitignoreToRegex, matchesGitignore } from '../src/utils/scanner.js';

const execFileAsync = promisify(execFile);

function safeCleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows file locking safety
  }
}

async function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'preva-test-suite-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'PrevaTester'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'tester@preva.dev'], { cwd: dir });
  return dir;
}

describe('50+ Real-World Git Scenarios Test Suite', () => {
  // ==========================================
  // Group 1: Repository Lifecycle & Environments (Scenarios 1-8)
  // ==========================================
  describe('Group 1: Repository Environments & States', () => {
    it('Scenario 1: Fresh repo with 0 commits (unborn branch) detects changed files', async () => {
      const repo = await createRepo();
      try {
        assert.strictEqual(await isGitRepo(repo), true);
        writeFileSync(join(repo, 'initial.txt'), 'first');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'initial.txt');
        assert.strictEqual(changed[0].status, 'new');
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 2: Fresh repo with 0 commits detects noCommits on push preview', async () => {
      const repo = await createRepo();
      try {
        const { commits, noCommits } = await getUnpushedCommits(repo);
        assert.strictEqual(noCommits, true);
        assert.strictEqual(commits.length, 0);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 3: Non-git directory correctly reports isGitRepo false', async () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'preva-non-git-'));
      try {
        const isRepo = await isGitRepo(nonRepo);
        assert.strictEqual(isRepo, false);
      } finally {
        safeCleanup(nonRepo);
      }
    });

    it('Scenario 4: Non-git directory getRepoRoot fails or rejects', async () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'preva-non-git-'));
      try {
        await assert.rejects(async () => {
          await getRepoRoot(nonRepo);
        });
      } finally {
        safeCleanup(nonRepo);
      }
    });

    it('Scenario 5: Invocation from deep subdirectory stages files correctly at repo root', async () => {
      const repo = await createRepo();
      try {
        const deepDir = join(repo, 'src', 'components', 'deep');
        mkdirSync(deepDir, { recursive: true });
        writeFileSync(join(deepDir, 'Button.js'), 'export const Button = () => {};');

        // Execute getChangedFiles from the subdirectory
        const changed = await getChangedFiles([], deepDir);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'src/components/deep/Button.js');

        // Stage from the subdirectory
        await stageFiles([changed[0].path], deepDir);

        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+src\/components\/deep\/Button\.js/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 6: Subdirectory execution respects root .gitignore', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, '.gitignore'), '*.secret\n');
        const subDir = join(repo, 'sub');
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(subDir, 'my.secret'), 'top-secret');

        const root = await getRepoRoot(subDir);
        assert.strictEqual(root.replace(/\\/g, '/').toLowerCase(), repo.replace(/\\/g, '/').toLowerCase());

        const scanned = scanFiles([{ path: 'sub/my.secret', isTracked: true, status: 'modified' }], root);
        assert.strictEqual(scanned[0].flagged, true);
        assert.match(scanned[0].reason, /matches \.gitignore/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 7: Detached HEAD state detects changes and commits', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'init.txt'), 'c1');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'commit-1'], { cwd: repo });

        writeFileSync(join(repo, 'init2.txt'), 'c2');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'commit-2'], { cwd: repo });

        // Checkout detached HEAD at commit-1
        await execFileAsync('git', ['checkout', 'HEAD~1'], { cwd: repo });

        writeFileSync(join(repo, 'detached-change.txt'), 'detached');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'detached-change.txt');

        await stageFiles(['detached-change.txt'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+detached-change\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 8: Git worktree environment stages correctly', async () => {
      const repo = await createRepo();
      const worktreeDir = mkdtempSync(join(tmpdir(), 'preva-worktree-'));
      try {
        writeFileSync(join(repo, 'init.txt'), 'c1');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

        await execFileAsync('git', ['worktree', 'add', '-b', 'wt-branch', worktreeDir], { cwd: repo });

        writeFileSync(join(worktreeDir, 'wt-file.txt'), 'in worktree');
        const changed = await getChangedFiles([], worktreeDir);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'wt-file.txt');

        await stageFiles(['wt-file.txt'], worktreeDir);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreeDir });
        assert.match(stdout, /A\s+wt-file\.txt/);
      } finally {
        try {
          await execFileAsync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repo });
        } catch {}
        safeCleanup(worktreeDir);
        safeCleanup(repo);
      }
    });
  });

  // ==========================================
  // Group 2: File Statuses & Staging States (Scenarios 9-17)
  // ==========================================
  describe('Group 2: File Statuses and Modifications', () => {
    it('Scenario 9: Staging untracked new file (??)', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'brand-new.js'), 'console.log()');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].status, 'new');
        assert.strictEqual(changed[0].isTracked, false);

        await stageFiles(['brand-new.js'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+brand-new\.js/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 10: Staging modified tracked file ( M)', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'file.txt'), 'initial');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

        writeFileSync(join(repo, 'file.txt'), 'modified');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].status, 'modified');
        assert.strictEqual(changed[0].isTracked, true);

        await stageFiles(['file.txt'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /M\s+file\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 11: Partially staged file (MM - unstaged modifications)', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'file.txt'), 'line 1\n');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

        writeFileSync(join(repo, 'file.txt'), 'line 1\nline 2\n');
        await execFileAsync('git', ['add', 'file.txt'], { cwd: repo });

        writeFileSync(join(repo, 'file.txt'), 'line 1\nline 2\nline 3\n');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].statusCode, 'MM');

        await stageFiles(['file.txt'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /^M \s+file\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 12: Deleted file in working tree ( D)', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'remove-me.txt'), 'bye');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'add file'], { cwd: repo });

        rmSync(join(repo, 'remove-me.txt'));
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].status, 'deleted');

        await stageFiles(['remove-me.txt'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /D\s+remove-me\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 13: Already staged file with clean worktree (M ) is not in changedFiles', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'file.txt'), 'initial');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

        writeFileSync(join(repo, 'file.txt'), 'modified');
        await execFileAsync('git', ['add', 'file.txt'], { cwd: repo });

        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 0);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 14: Staged rename detection (R )', () => {
      const rawPorcelain = 'R  new.txt\0old.txt\0';
      const parsed = parsePorcelainStatus(rawPorcelain);
      // Staged rename with clean working tree has workTreeStatus = ' '
      assert.strictEqual(parsed.length, 0);
    });

    it('Scenario 15: Renamed file with unstaged modification (RM)', () => {
      const rawPorcelain = 'RM new.txt\0old.txt\0';
      const parsed = parsePorcelainStatus(rawPorcelain);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].path, 'new.txt');
      assert.strictEqual(parsed[0].status, 'renamed');
    });

    it('Scenario 16: Clean working tree returns empty array', async () => {
      const repo = await createRepo();
      try {
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 0);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 17: Untracked directory with nested files discovered via -uall', async () => {
      const repo = await createRepo();
      try {
        const nestedDir = join(repo, 'new-pkg', 'src');
        mkdirSync(nestedDir, { recursive: true });
        writeFileSync(join(nestedDir, 'index.js'), 'nested');

        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'new-pkg/src/index.js');
      } finally {
        safeCleanup(repo);
      }
    });
  });

  // ==========================================
  // Group 3: Filename Edge Cases & Special Characters (Scenarios 18-27)
  // ==========================================
  describe('Group 3: Filename Edge Cases', () => {
    it('Scenario 18: File with standard space in filename', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'hello world.txt'), 'content');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'hello world.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /hello world\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 19: File with multiple consecutive spaces in filename', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'foo   bar.txt'), 'spaces');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'foo   bar.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /foo   bar\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 20: File with single quotes in filename', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, "john's notes.txt"), 'notes');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, "john's notes.txt");

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /john's notes\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 21: File with brackets and special characters', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'report [v1] (final) & $test.txt'), 'test');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'report [v1] (final) & $test.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /report \[v1\] \(final\) & \$test\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 22: Non-ASCII Latin accented characters', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'café_au_lait.txt'), 'coffee');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'café_au_lait.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], { cwd: repo });
        assert.ok(stdout.includes('café_au_lait.txt'));
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 23: CJK / Asian Unicode characters in filename', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, '东京_Tokyo_東京.txt'), 'tokyo');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, '东京_Tokyo_東京.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], { cwd: repo });
        assert.ok(stdout.includes('东京_Tokyo_東京.txt'));
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 24: Filename containing Emoji', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'rocket_🚀.js'), 'console.log("launch");');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'rocket_🚀.js');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], { cwd: repo });
        assert.ok(stdout.includes('rocket_🚀.js'));
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 25: Deeply nested directory structure (8 levels)', async () => {
      const repo = await createRepo();
      try {
        const deepPath = join(repo, '1', '2', '3', '4', '5', '6', '7', '8');
        mkdirSync(deepPath, { recursive: true });
        writeFileSync(join(deepPath, 'deep.txt'), 'deep');

        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, '1/2/3/4/5/6/7/8/deep.txt');

        await stageFiles([changed[0].path], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /1\/2\/3\/4\/5\/6\/7\/8\/deep\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 26: Empty 0-byte file staging', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'empty.txt'), '');
        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'empty.txt');

        await stageFiles(['empty.txt'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+empty\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 27: Large file staging (>1MB)', async () => {
      const repo = await createRepo();
      try {
        const largeContent = Buffer.alloc(1024 * 1024 * 2, 'a');
        writeFileSync(join(repo, 'large.bin'), largeContent);

        const changed = await getChangedFiles([], repo);
        assert.strictEqual(changed[0].path, 'large.bin');

        await stageFiles(['large.bin'], repo);
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+large\.bin/);
      } finally {
        safeCleanup(repo);
      }
    });
  });

  // ==========================================
  // Group 4: Sensitive Files & Pattern Detection (Scenarios 28-37)
  // ==========================================
  describe('Group 4: Sensitive File Scanner', () => {
    it('Scenario 28: Root .env file flagged and unchecked', () => {
      const scanned = scanFiles([{ path: '.env', status: 'new', isTracked: false }]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[0].defaultChecked, false);
    });

    it('Scenario 29: Nested and env variants flagged (.env.production, .env.local)', () => {
      const scanned = scanFiles([
        { path: 'packages/api/.env.production', status: 'new', isTracked: false },
        { path: '.env.local', status: 'modified', isTracked: true },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
    });

    it('Scenario 30: Private keys (id_rsa, server.key) flagged', () => {
      const scanned = scanFiles([
        { path: 'id_rsa', status: 'new', isTracked: false },
        { path: 'certs/server.key', status: 'new', isTracked: false },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
    });

    it('Scenario 31: Certificates and keystores (cert.pem, keystore.p12, app.p8) flagged', () => {
      const scanned = scanFiles([
        { path: 'cert.pem', status: 'new', isTracked: false },
        { path: 'bundle.p12', status: 'new', isTracked: false },
        { path: 'AuthKey.p8', status: 'new', isTracked: false },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
      assert.strictEqual(scanned[2].flagged, true);
    });

    it('Scenario 32: Cloud credential files flagged', () => {
      const scanned = scanFiles([
        { path: 'service-account.json', status: 'new', isTracked: false },
        { path: 'client_secret.json', status: 'new', isTracked: false },
        { path: 'google-services.json', status: 'new', isTracked: false },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
      assert.strictEqual(scanned[2].flagged, true);
    });

    it('Scenario 33: Package manager configs with tokens (.npmrc, .pypirc) flagged', () => {
      const scanned = scanFiles([
        { path: '.npmrc', status: 'new', isTracked: false },
        { path: '.pypirc', status: 'new', isTracked: false },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
    });

    it('Scenario 34: Local secrets config (local.settings.json) flagged', () => {
      const scanned = scanFiles([{ path: 'local.settings.json', status: 'new', isTracked: false }]);
      assert.strictEqual(scanned[0].flagged, true);
    });

    it('Scenario 35: Debug logs (npm-debug.log) flagged', () => {
      const scanned = scanFiles([{ path: 'npm-debug.log', status: 'new', isTracked: false }]);
      assert.strictEqual(scanned[0].flagged, true);
    });

    it('Scenario 36: Tracked file matching .gitignore retroactively flagged', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, '.gitignore'), 'config.json\n');
        const scanned = scanFiles(
          [{ path: 'config.json', status: 'modified', isTracked: true }],
          repo
        );
        assert.strictEqual(scanned[0].flagged, true);
        assert.strictEqual(scanned[0].defaultChecked, false);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 37: Heavy dependency directories flagged (node_modules, dist, .next)', () => {
      const scanned = scanFiles([
        { path: 'node_modules/axios/index.js', status: 'new', isTracked: false },
        { path: 'dist/bundle.js', status: 'new', isTracked: false },
        { path: '.next/static/app.js', status: 'new', isTracked: false },
      ]);
      assert.strictEqual(scanned[0].flagged, true);
      assert.strictEqual(scanned[1].flagged, true);
      assert.strictEqual(scanned[2].flagged, true);
    });
  });

  // ==========================================
  // Group 5: Gitignore Glob Matching (Scenarios 38-41)
  // ==========================================
  describe('Group 5: Gitignore Glob Matching', () => {
    it('Scenario 38: Standard glob extension (*.log)', () => {
      const p = gitignoreToRegex('*.log');
      assert.strictEqual(matchesGitignore('app.log', [p]), true);
      assert.strictEqual(matchesGitignore('deep/sub/error.log', [p]), true);
      assert.strictEqual(matchesGitignore('app.js', [p]), false);
    });

    it('Scenario 39: Negated pattern rule (!important.log)', () => {
      const p1 = gitignoreToRegex('*.log');
      const p2 = gitignoreToRegex('!important.log');
      assert.strictEqual(matchesGitignore('normal.log', [p1, p2]), true);
      assert.strictEqual(matchesGitignore('important.log', [p1, p2]), false);
    });

    it('Scenario 40: Directory-only rule (temp/)', () => {
      const p = gitignoreToRegex('temp/');
      assert.strictEqual(matchesGitignore('temp/file.txt', [p]), true);
      assert.strictEqual(matchesGitignore('temp.txt', [p]), false);
    });

    it('Scenario 41: Root-anchored rule (/root-only.txt)', () => {
      const p = gitignoreToRegex('/root-only.txt');
      assert.strictEqual(matchesGitignore('root-only.txt', [p]), true);
      assert.strictEqual(matchesGitignore('sub/root-only.txt', [p]), false);
    });
  });

  // ==========================================
  // Group 6: Selective Staging & Filtering (Scenarios 42-44)
  // ==========================================
  describe('Group 6: Selective Staging & Filtering', () => {
    it('Scenario 42: Selective staging stages only chosen files', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'a.txt'), 'a');
        writeFileSync(join(repo, 'b.txt'), 'b');
        writeFileSync(join(repo, 'c.txt'), 'c');

        // Stage only a.txt and c.txt
        await stageFiles(['a.txt', 'c.txt'], repo);

        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+a\.txt/);
        assert.match(stdout, /\?\?\s+b\.txt/);
        assert.match(stdout, /A\s+c\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 43: Path filtering discovers only targeted directory files', async () => {
      const repo = await createRepo();
      try {
        const sub = join(repo, 'packages', 'client');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'index.js'), 'client');
        writeFileSync(join(repo, 'server.js'), 'server');

        const changed = await getChangedFiles(['packages/client'], repo);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].path, 'packages/client/index.js');
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 44: Selective staging does not unstage already-staged files', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'first.txt'), '1');
        await stageFiles(['first.txt'], repo);

        writeFileSync(join(repo, 'second.txt'), '2');
        writeFileSync(join(repo, 'third.txt'), '3');

        // Stage second.txt
        await stageFiles(['second.txt'], repo);

        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /A\s+first\.txt/);
        assert.match(stdout, /A\s+second\.txt/);
        assert.match(stdout, /\?\?\s+third\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });
  });

  // ==========================================
  // Group 7: Push Preview, Remotes & Upstream Tracking (Scenarios 45-53)
  // ==========================================
  // ==========================================
  // Group 7: Push Preview, Remotes & Upstream Tracking (Scenarios 45-53)
  // ==========================================
  describe('Group 7: Push Preview & Remote Tracking', () => {
    async function createPushPair() {
      const remoteBare = mkdtempSync(join(tmpdir(), 'preva-pair-bare-'));
      await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: remoteBare });

      const localRepo = mkdtempSync(join(tmpdir(), 'preva-pair-local-'));
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: localRepo });
      await execFileAsync('git', ['config', 'user.name', 'Pusher'], { cwd: localRepo });
      await execFileAsync('git', ['config', 'user.email', 'pusher@preva.dev'], { cwd: localRepo });
      await execFileAsync('git', ['remote', 'add', 'origin', remoteBare], { cwd: localRepo });

      writeFileSync(join(localRepo, 'base.txt'), 'base');
      await execFileAsync('git', ['add', '.'], { cwd: localRepo });
      await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: localRepo });
      await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: localRepo });

      return { remoteBare, localRepo };
    }

    it('Scenario 45: Push preview when local is fully up-to-date reports 0 commits', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        assert.strictEqual(upstreamRef, 'origin/main');
        assert.strictEqual(commits.length, 0);
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 46: Push preview with upstream tracking branch shows unpushed commits', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, 'new-feature.txt'), 'feature code');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'feat: add feature code'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        assert.strictEqual(upstreamRef, 'origin/main');
        assert.strictEqual(commits.length, 1);
        assert.strictEqual(commits[0].message, 'feat: add feature code');

        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].path, 'new-feature.txt');
        assert.strictEqual(files[0].status, 'new');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 47: Push preview on a new local branch with NO upstream branch set', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        await execFileAsync('git', ['checkout', '-b', 'feature-untracked'], { cwd: localRepo });
        writeFileSync(join(localRepo, 'branch-file.txt'), 'branch file');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'feat: untracked branch commit'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        assert.strictEqual(upstreamRef, null);
        assert.strictEqual(commits.length, 1);
        assert.strictEqual(commits[0].message, 'feat: untracked branch commit');

        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].path, 'branch-file.txt');
        assert.strictEqual(files[0].status, 'new');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 48: Push preview with explicit remote and branch arguments', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, 'target-test.txt'), 'target');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'feat: target test'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo, 'origin', 'main');
        assert.strictEqual(upstreamRef, 'origin/main');
        assert.strictEqual(commits.length, 1);
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 49: Multiple unpushed commits listed with hashes, messages, authors', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, 'c1.txt'), '1');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'commit number one'], { cwd: localRepo });

        writeFileSync(join(localRepo, 'c2.txt'), '2');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'commit number two'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        assert.strictEqual(commits.length, 2);
        assert.strictEqual(commits[0].message, 'commit number two');
        assert.strictEqual(commits[1].message, 'commit number one');
        assert.strictEqual(commits[0].author, 'Pusher');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 50: Push preview detecting sensitive file in unpushed commits', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, '.env.production'), 'API_KEY=secret_live');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'chore: add env'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);
        const scanned = scanFiles(files, localRepo);

        const envFile = scanned.find((f) => f.path === '.env.production');
        assert.ok(envFile);
        assert.strictEqual(envFile.flagged, true);
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 51: Cumulative unpushed file diff across multiple commits', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, 'feature.txt'), 'v1');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'add feature v1'], { cwd: localRepo });

        writeFileSync(join(localRepo, 'feature.txt'), 'v2');
        writeFileSync(join(localRepo, 'extra.txt'), 'extra');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'update feature to v2 and add extra'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);

        const feat = files.find((f) => f.path === 'feature.txt');
        const extra = files.find((f) => f.path === 'extra.txt');
        assert.ok(feat);
        assert.strictEqual(feat.status, 'new');
        assert.ok(extra);
        assert.strictEqual(extra.status, 'new');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 52: Push preview with deleted files in commits (D)', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        rmSync(join(localRepo, 'base.txt'));
        await execFileAsync('git', ['add', 'base.txt'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'remove base.txt'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);

        const deleted = files.find((f) => f.path === 'base.txt');
        assert.ok(deleted);
        assert.strictEqual(deleted.status, 'deleted');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });

    it('Scenario 53: Push preview with renamed files in commits (R)', async () => {
      const { remoteBare, localRepo } = await createPushPair();
      try {
        writeFileSync(join(localRepo, 'source.txt'), 'renaming me');
        await execFileAsync('git', ['add', '.'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'add source.txt'], { cwd: localRepo });
        await execFileAsync('git', ['push', 'origin', 'main'], { cwd: localRepo });

        await execFileAsync('git', ['mv', 'source.txt', 'destination.txt'], { cwd: localRepo });
        await execFileAsync('git', ['commit', '-m', 'rename source to destination'], { cwd: localRepo });

        const { commits, upstreamRef } = await getUnpushedCommits(localRepo);
        const files = await getUnpushedFiles(localRepo, upstreamRef, commits);

        const renamed = files.find((f) => f.path === 'destination.txt');
        assert.ok(renamed);
        assert.strictEqual(renamed.status, 'renamed');
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(localRepo);
      }
    });
  });

  // ==========================================
  // Group 8: Advanced Git States (Scenarios 54-55)
  // ==========================================
  describe('Group 8: Advanced Git States', () => {
    it('Scenario 54: Merge conflict state (UU) detected and stageable', async () => {
      const repo = await createRepo();
      try {
        writeFileSync(join(repo, 'conflict.txt'), 'line 1\n');
        await execFileAsync('git', ['add', '.'], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });

        // Branch 1
        await execFileAsync('git', ['checkout', '-b', 'b1'], { cwd: repo });
        writeFileSync(join(repo, 'conflict.txt'), 'line 1 from b1\n');
        await execFileAsync('git', ['commit', '-am', 'b1 change'], { cwd: repo });

        // Branch 2
        await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
        await execFileAsync('git', ['checkout', '-b', 'b2'], { cwd: repo });
        writeFileSync(join(repo, 'conflict.txt'), 'line 1 from b2\n');
        await execFileAsync('git', ['commit', '-am', 'b2 change'], { cwd: repo });

        // Attempt merge to cause conflict
        try {
          await execFileAsync('git', ['merge', 'b1'], { cwd: repo });
        } catch {
          // Expected conflict
        }

        const changed = await getChangedFiles([], repo);
        const conflict = changed.find((f) => f.path === 'conflict.txt');
        assert.ok(conflict);
        assert.strictEqual(conflict.statusCode, 'UU');

        // Resolve and stage
        writeFileSync(join(repo, 'conflict.txt'), 'resolved\n');
        await stageFiles(['conflict.txt'], repo);

        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
        assert.match(stdout, /^M \s+conflict\.txt/);
      } finally {
        safeCleanup(repo);
      }
    });

    it('Scenario 55: Diverged branch correctly isolates local unpushed commits', async () => {
      const remoteBare = mkdtempSync(join(tmpdir(), 'preva-diverged-bare-'));
      const clone1 = mkdtempSync(join(tmpdir(), 'preva-diverged-c1-'));
      const clone2 = mkdtempSync(join(tmpdir(), 'preva-diverged-c2-'));

      try {
        await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: remoteBare });

        // Clone 1 sets up base commit
        await execFileAsync('git', ['clone', remoteBare, clone1]);
        await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: clone1 });
        await execFileAsync('git', ['config', 'user.email', 'tester@test.com'], { cwd: clone1 });
        writeFileSync(join(clone1, 'init.txt'), 'init');
        await execFileAsync('git', ['add', '.'], { cwd: clone1 });
        await execFileAsync('git', ['commit', '-m', 'init'], { cwd: clone1 });
        await execFileAsync('git', ['push', 'origin', 'main'], { cwd: clone1 });

        // Clone 2 clones and makes 1 commit, pushes to remote
        await execFileAsync('git', ['clone', remoteBare, clone2]);
        await execFileAsync('git', ['config', 'user.name', 'Tester2'], { cwd: clone2 });
        await execFileAsync('git', ['config', 'user.email', 'tester2@test.com'], { cwd: clone2 });
        writeFileSync(join(clone2, 'remote-change.txt'), 'remote');
        await execFileAsync('git', ['add', '.'], { cwd: clone2 });
        await execFileAsync('git', ['commit', '-m', 'remote commit from clone2'], { cwd: clone2 });
        await execFileAsync('git', ['push', 'origin', 'main'], { cwd: clone2 });

        // Clone 1 fetches remote, but does not merge, and makes 2 local commits
        await execFileAsync('git', ['fetch', 'origin'], { cwd: clone1 });
        writeFileSync(join(clone1, 'local-1.txt'), 'local 1');
        await execFileAsync('git', ['add', '.'], { cwd: clone1 });
        await execFileAsync('git', ['commit', '-m', 'local commit 1'], { cwd: clone1 });

        writeFileSync(join(clone1, 'local-2.txt'), 'local 2');
        await execFileAsync('git', ['add', '.'], { cwd: clone1 });
        await execFileAsync('git', ['commit', '-m', 'local commit 2'], { cwd: clone1 });

        // Now clone 1 is diverged: 2 ahead, 1 behind
        const { commits, upstreamRef } = await getUnpushedCommits(clone1);
        assert.strictEqual(upstreamRef, 'origin/main');
        assert.strictEqual(commits.length, 2);
        assert.strictEqual(commits[0].message, 'local commit 2');
        assert.strictEqual(commits[1].message, 'local commit 1');

        const files = await getUnpushedFiles(clone1, upstreamRef, commits);
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('local-1.txt'));
        assert.ok(paths.includes('local-2.txt'));
        assert.ok(!paths.includes('remote-change.txt'));
      } finally {
        safeCleanup(remoteBare);
        safeCleanup(clone1);
        safeCleanup(clone2);
      }
    });
  });
});
