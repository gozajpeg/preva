import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getCommitHistory,
  getCommitDetails,
  getCommitPatch,
} from '../src/utils/git.js';
import {
  renderLogTable,
  renderCommitDetails,
} from '../src/commands/log.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git log table formatting & commit details unit tests', () => {
  it('renders compact log table', () => {
    const mockCommits = [
      {
        hash: 'a1b2c3d',
        fullHash: 'a1b2c3d4e5f6',
        author: 'Jane Doe',
        email: 'jane@example.com',
        date: '2 hours ago',
        subject: 'feat: add authentication endpoints',
        decorations: '(HEAD -> main, origin/main)',
      },
      {
        hash: 'e4f5g6h',
        fullHash: 'e4f5g6h7i8j9',
        author: 'John Smith',
        email: 'john@example.com',
        date: '1 day ago',
        subject: 'fix: resolve race condition in cache',
        decorations: '',
      },
    ];

    const output = stripAnsi(renderLogTable(mockCommits, 'Recent Commits', { maxCols: 120 }));
    assert.ok(output.includes('a1b2c3d'));
    assert.ok(output.includes('Jane Doe'));
    assert.ok(output.includes('add authentication endpoints'));
    assert.ok(output.includes('e4f5g6h'));
    assert.ok(output.includes('resolve race condition in cache'));
  });

  it('renders commit details view with changed files', () => {
    const mockDetails = {
      hash: 'a1b2c3d',
      fullHash: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      author: 'Jane Doe',
      email: 'jane@example.com',
      date: 'Fri Oct 23 20:00:00 2026',
      relativeDate: '2 hours ago',
      subject: 'feat: add authentication endpoints',
      message: 'feat: add authentication endpoints\n\nImplements JWT token issue and refresh logic.',
      files: [
        { path: 'src/auth.js', status: 'new', code: 'A', additions: 120, deletions: 0, isBinary: false },
        { path: 'package.json', status: 'modified', code: 'M', additions: 2, deletions: 1, isBinary: false },
      ],
      totalFiles: 2,
      totalAdditions: 122,
      totalDeletions: 1,
    };

    const output = stripAnsi(renderCommitDetails(mockDetails));
    assert.ok(output.includes('a1b2c3d'));
    assert.ok(output.includes('Jane Doe'));
    assert.ok(output.includes('Implements JWT token issue'));
    assert.ok(output.includes('src/auth.js'));
    assert.ok(output.includes('package.json'));
    assert.ok(output.includes('+122'));
  });
});

describe('git log operations in live repository', () => {
  let testDir;
  let firstCommitHash;
  let secondCommitHash;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-log-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'LogTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'logtester@example.com'], { cwd: testDir });

    // Commit 1
    writeFileSync(join(testDir, 'init.txt'), 'hello world\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial project setup'], { cwd: testDir });
    const { stdout: out1 } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: testDir });
    firstCommitHash = out1.trim();

    // Commit 2
    writeFileSync(join(testDir, 'app.js'), 'console.log("app");\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'feat: create main application entrypoint'], { cwd: testDir });
    const { stdout: out2 } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: testDir });
    secondCommitHash = out2.trim();
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('retrieves commit history with getCommitHistory', async () => {
    const history = await getCommitHistory({ maxCount: 10 }, testDir);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].hash, secondCommitHash);
    assert.strictEqual(history[0].subject, 'feat: create main application entrypoint');
    assert.strictEqual(history[1].hash, firstCommitHash);
    assert.strictEqual(history[1].subject, 'chore: initial project setup');
  });

  it('filters commit history by grep keyword', async () => {
    const filtered = await getCommitHistory({ grep: 'entrypoint' }, testDir);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].hash, secondCommitHash);
  });

  it('retrieves commit details with getCommitDetails', async () => {
    const details = await getCommitDetails(secondCommitHash, testDir);
    assert.ok(details);
    assert.strictEqual(details.hash, secondCommitHash);
    assert.strictEqual(details.author, 'LogTester');
    assert.strictEqual(details.files.length, 1);
    assert.strictEqual(details.files[0].path, 'app.js');
    assert.strictEqual(details.files[0].status, 'new');
  });

  it('retrieves commit patch with getCommitPatch', async () => {
    const patch = await getCommitPatch(secondCommitHash, testDir);
    assert.ok(patch.includes('diff --git'));
    assert.ok(patch.includes('+console.log("app");'));
  });

  it('runs preva log CLI in non-interactive mode', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'log'],
      { cwd: testDir }
    );
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Git History/);
    assert.match(cleanOut, /chore: initial project setup/);
    assert.match(cleanOut, /feat: create main application/);
  });

  it('runs preva log --oneline CLI', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'log', '--oneline'],
      { cwd: testDir }
    );
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Git History/);
    assert.match(cleanOut, /chore: initial project setup/);
  });

  it('runs preva log <hash> CLI directly', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'log', firstCommitHash],
      { cwd: testDir }
    );
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Commit Details:/);
    assert.match(cleanOut, /init\.txt/);
  });
});
