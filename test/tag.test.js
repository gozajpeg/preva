import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getTags,
  createTag,
  deleteTag,
} from '../src/utils/git.js';
import {
  renderTagsTable,
  renderTagDetails,
} from '../src/commands/tag.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git tag formatting & inspection unit tests', () => {
  it('renders empty tags table message when no tags found', () => {
    const rendered = stripAnsi(renderTagsTable([], 'Repository Tags', { maxCols: 100 }));
    assert.match(rendered, /Repository Tags/);
    assert.match(rendered, /No tags found in repository/);
  });

  it('renders tags table with annotated and lightweight tags', () => {
    const tags = [
      {
        name: 'v1.0.0',
        tagHash: 'be81822',
        commitHash: '937fda2',
        isAnnotated: true,
        type: 'annotated',
        author: 'Jane Doe',
        date: '2 days ago',
        subject: 'Release 1.0.0',
        body: 'Full release notes',
      },
      {
        name: 'v0.1.0-alpha',
        tagHash: '82e2bd3',
        commitHash: '82e2bd3',
        isAnnotated: false,
        type: 'lightweight',
        author: 'John Dev',
        date: '5 days ago',
        subject: 'chore: initial commit',
        body: '',
      },
    ];

    const rendered = stripAnsi(renderTagsTable(tags, 'Release Tags', { maxCols: 120 }));
    assert.match(rendered, /Release Tags \(2 tag\(s\)\)/);
    assert.match(rendered, /v1\.0\.0/);
    assert.match(rendered, /\[annotated\]/);
    assert.match(rendered, /v0\.1\.0-alpha/);
    assert.match(rendered, /\[lightweight\]/);
    assert.match(rendered, /Jane Doe/);
  });

  it('renders detailed tag view with commit and annotation info', () => {
    const tag = {
      name: 'v1.2.0',
      tagHash: 'be81822',
      commitHash: '937fda2',
      isAnnotated: true,
      type: 'annotated',
      author: 'Release Lead',
      date: '2026-10-22',
      subject: 'Release v1.2.0',
      body: 'Contains security fixes and new features',
    };

    const commit = {
      hash: '937fda2',
      subject: 'feat: add tag safety guard',
      author: 'Jane Doe',
      email: 'jane@example.com',
      date: '2026-10-22 10:00:00',
      relativeDate: '2 days ago',
    };

    const rendered = stripAnsi(renderTagDetails(tag, commit, { maxCols: 100 }));
    assert.match(rendered, /Tag Details: v1\.2\.0/);
    assert.match(rendered, /Annotated Tag/);
    assert.match(rendered, /Release Lead/);
    assert.match(rendered, /Contains security fixes and new features/);
    assert.match(rendered, /feat: add tag safety guard/);
  });
});

describe('git tag operations in live repository', () => {
  let testDir;
  let commitHash;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'preva-tag-test-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.name', 'TagTester'], { cwd: testDir });
    await execFileAsync('git', ['config', 'user.email', 'tag@example.com'], { cwd: testDir });

    writeFileSync(join(testDir, 'version.txt'), '1.0.0\n');
    await execFileAsync('git', ['add', '.'], { cwd: testDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial release commit'], { cwd: testDir });

    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: testDir });
    commitHash = stdout.trim();
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks on windows
    }
  });

  it('returns empty tag list initially', async () => {
    const tags = await getTags({}, testDir);
    assert.strictEqual(tags.length, 0);
  });

  it('creates a lightweight tag and retrieves it', async () => {
    await createTag('v0.1.0', { annotated: false }, testDir);

    const tags = await getTags({}, testDir);
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].name, 'v0.1.0');
    assert.strictEqual(tags[0].isAnnotated, false);
    assert.strictEqual(tags[0].commitHash.slice(0, 7), commitHash.slice(0, 7));
  });

  it('creates an annotated tag with message and retrieves it', async () => {
    await createTag('v1.0.0', { annotated: true, message: 'Official Release 1.0.0' }, testDir);

    const tags = await getTags({}, testDir);
    assert.strictEqual(tags.length, 2);

    const annotatedTag = tags.find((t) => t.name === 'v1.0.0');
    assert.ok(annotatedTag);
    assert.strictEqual(annotatedTag.isAnnotated, true);
    assert.strictEqual(annotatedTag.type, 'annotated');
    assert.strictEqual(annotatedTag.subject, 'Official Release 1.0.0');
  });

  it('filters tags by glob pattern', async () => {
    const v1Tags = await getTags({ pattern: 'v1.*' }, testDir);
    assert.strictEqual(v1Tags.length, 1);
    assert.strictEqual(v1Tags[0].name, 'v1.0.0');

    const v0Tags = await getTags({ pattern: 'v0.*' }, testDir);
    assert.strictEqual(v0Tags.length, 1);
    assert.strictEqual(v0Tags[0].name, 'v0.1.0');
  });

  it('deletes a local tag with deleteTag', async () => {
    await deleteTag('v0.1.0', testDir);

    const tags = await getTags({}, testDir);
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].name, 'v1.0.0');
  });

  it('runs preva tag CLI in non-interactive mode and prints tag table', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'tag'], { cwd: testDir });
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Repository Tags/);
    assert.match(cleanOut, /v1\.0\.0/);
    assert.match(cleanOut, /\[annotated\]/);
  });

  it('runs preva tag -l CLI with filter pattern', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'tag', '-l', 'v1.*'], {
      cwd: testDir,
    });
    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Tags matching "v1\.\*"/);
    assert.match(cleanOut, /v1\.0\.0/);
  });

  it('runs preva tag -a <name> -m <msg> in CLI directly', async () => {
    await execFileAsync(
      process.execPath,
      [binPath, 'tag', '-a', 'v1.1.0', '-m', 'Feature update v1.1.0'],
      { cwd: testDir }
    );

    const tags = await getTags({}, testDir);
    const newTag = tags.find((t) => t.name === 'v1.1.0');
    assert.ok(newTag);
    assert.strictEqual(newTag.isAnnotated, true);
    assert.strictEqual(newTag.subject, 'Feature update v1.1.0');
  });
});
