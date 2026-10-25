import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractRepoNameFromUrl,
  checkTargetDirectory,
  suggestAlternativeDirectory,
  detectProjectTech,
  runGitClone,
} from '../src/utils/git.js';
import {
  renderClonePreview,
  renderCloneSuccess,
} from '../src/commands/clone.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git clone formatting & helper unit tests', () => {
  it('extracts repository name from various URL formats', () => {
    assert.strictEqual(
      extractRepoNameFromUrl('https://github.com/owner/super-app.git'),
      'super-app'
    );
    assert.strictEqual(
      extractRepoNameFromUrl('git@github.com:owner/backend-api.git'),
      'backend-api'
    );
    assert.strictEqual(
      extractRepoNameFromUrl('https://gitlab.com/team/core-lib/'),
      'core-lib'
    );
    assert.strictEqual(
      extractRepoNameFromUrl('https://github.com/owner/simple-name'),
      'simple-name'
    );
    assert.strictEqual(extractRepoNameFromUrl(''), '');
    assert.strictEqual(extractRepoNameFromUrl(null), '');
  });

  it('renders pre-clone preview for a clean destination', () => {
    const plan = {
      url: 'https://github.com/owner/cool-repo.git',
      targetDir: 'cool-repo',
      branch: 'main',
      depth: '1',
      recurseSubmodules: true,
      singleBranch: true,
      cmdArgs: [
        'clone',
        '--depth',
        '1',
        '-b',
        'main',
        '--recurse-submodules',
        '--single-branch',
        'https://github.com/owner/cool-repo.git',
        'cool-repo',
      ],
    };

    const dirStatus = {
      exists: false,
      isDirectory: false,
      isEmpty: true,
      fileCount: 0,
      absPath: '/mock/path/cool-repo',
    };

    const rendered = stripAnsi(renderClonePreview(plan, dirStatus, { maxCols: 120 }));
    assert.match(rendered, /Pre-Flight Safety Preview/);
    assert.match(rendered, /https:\/\/github\.com\/owner\/cool-repo\.git/);
    assert.match(rendered, /Target Directory:\s+cool-repo/);
    assert.match(rendered, /Branch:\s+main/);
    assert.match(rendered, /Depth \(Shallow\):\s+1 commit\(s\)/);
    assert.match(rendered, /Submodules:\s+Recursive initialization enabled/);
    assert.match(rendered, /Directory does not exist yet\. Ready for clean clone\./);
    assert.match(rendered, /git clone --depth 1 -b main/);
  });

  it('renders pre-clone preview with collision warning when directory is non-empty', () => {
    const plan = {
      url: 'https://github.com/owner/project.git',
      targetDir: 'project',
      branch: null,
      depth: null,
      recurseSubmodules: false,
      singleBranch: false,
      cmdArgs: ['clone', 'https://github.com/owner/project.git', 'project'],
    };

    const dirStatus = {
      exists: true,
      isDirectory: true,
      isEmpty: false,
      fileCount: 5,
      absPath: '/mock/path/project',
    };

    const rendered = stripAnsi(renderClonePreview(plan, dirStatus, { maxCols: 120 }));
    assert.match(rendered, /Directory already exists and contains 5 file\(s\)!/);
    assert.match(rendered, /Git will reject cloning into an existing non-empty directory/);
  });

  it('renders post-clone success summary with detected technology hints', () => {
    const plan = {
      url: 'https://github.com/owner/node-project.git',
      targetDir: 'node-project',
      cmdArgs: ['clone', 'https://github.com/owner/node-project.git', 'node-project'],
    };

    const summary = {
      branch: 'main',
      latestCommit: {
        hash: 'a1b2c3d',
        subject: 'feat: initialize project structure',
        author: 'Jane Dev',
        date: '2026-10-24',
      },
      techHints: [
        { tech: 'Node.js', command: 'npm install' },
      ],
    };

    const rendered = stripAnsi(renderCloneSuccess(plan, summary, { maxCols: 120 }));
    assert.match(rendered, /Successfully cloned repository into node-project/);
    assert.match(rendered, /Default Branch:\s+main/);
    assert.match(rendered, /Latest Commit:\s+a1b2c3d feat: initialize project structure/);
    assert.match(rendered, /Detected Technologies:/);
    assert.match(rendered, /Node\.js/);
    assert.match(rendered, /cd node-project/);
    assert.match(rendered, /npm install/);
  });
});

describe('git clone directory inspection and tech detection', () => {
  let tempBaseDir;

  before(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'preva-clone-inspect-'));
  });

  after(() => {
    try {
      rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('checks non-existent, empty, and non-empty directories accurately', () => {
    const nonExistent = join(tempBaseDir, 'does-not-exist');
    const emptyFolder = join(tempBaseDir, 'empty-folder');
    const fullFolder = join(tempBaseDir, 'full-folder');

    mkdirSync(emptyFolder);
    mkdirSync(fullFolder);
    writeFileSync(join(fullFolder, 'index.js'), 'console.log("hello");');
    writeFileSync(join(fullFolder, 'package.json'), '{}');

    const status1 = checkTargetDirectory(nonExistent);
    assert.strictEqual(status1.exists, false);
    assert.strictEqual(status1.isEmpty, true);
    assert.strictEqual(status1.fileCount, 0);

    const status2 = checkTargetDirectory(emptyFolder);
    assert.strictEqual(status2.exists, true);
    assert.strictEqual(status2.isEmpty, true);
    assert.strictEqual(status2.fileCount, 0);

    const status3 = checkTargetDirectory(fullFolder);
    assert.strictEqual(status3.exists, true);
    assert.strictEqual(status3.isEmpty, false);
    assert.strictEqual(status3.fileCount, 2);
  });

  it('suggests non-colliding directory names correctly', () => {
    const baseName = 'my-app';
    const folder1 = join(tempBaseDir, baseName);
    mkdirSync(folder1);

    const suggestion1 = suggestAlternativeDirectory(baseName, tempBaseDir);
    assert.strictEqual(suggestion1, 'my-app-1');

    mkdirSync(join(tempBaseDir, 'my-app-1'));
    const suggestion2 = suggestAlternativeDirectory(baseName, tempBaseDir);
    assert.strictEqual(suggestion2, 'my-app-2');
  });

  it('detects ecosystems correctly from files', () => {
    const projectDir = join(tempBaseDir, 'detected-proj');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'package.json'), '{"name":"test"}');
    writeFileSync(join(projectDir, 'Cargo.toml'), '[package]\nname="test"');

    const tech = detectProjectTech(projectDir);
    const techNames = tech.map((t) => t.tech);
    assert.ok(techNames.includes('Node.js'));
    assert.ok(techNames.includes('Rust'));
  });
});

describe('git clone CLI operations in live environment', () => {
  let sourceRepoDir;
  let workspaceDir;

  before(async () => {
    sourceRepoDir = mkdtempSync(join(tmpdir(), 'preva-clone-src-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'preva-clone-ws-'));

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: sourceRepoDir });
    await execFileAsync('git', ['config', 'user.name', 'CloneTester'], { cwd: sourceRepoDir });
    await execFileAsync('git', ['config', 'user.email', 'clonetest@example.com'], { cwd: sourceRepoDir });

    writeFileSync(join(sourceRepoDir, 'package.json'), '{"name":"sample-lib","version":"1.0.0"}\n');
    writeFileSync(join(sourceRepoDir, 'README.md'), '# Sample Library\n');
    await execFileAsync('git', ['add', '.'], { cwd: sourceRepoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial sample repository commit'], { cwd: sourceRepoDir });
  });

  after(() => {
    try {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {}
  });

  it('fails non-interactively when no repo URL is supplied', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'git', 'clone'], {
        cwd: workspaceDir,
      });
      assert.fail('Should have failed without repo URL');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Repository URL required/);
    }
  });

  it('fails non-interactively when target directory exists and is not empty', async () => {
    const collidingDir = join(workspaceDir, 'collision-target');
    mkdirSync(collidingDir);
    writeFileSync(join(collidingDir, 'some-file.txt'), 'already here');

    try {
      await execFileAsync(
        process.execPath,
        [binPath, 'git', 'clone', sourceRepoDir, 'collision-target'],
        {
          cwd: workspaceDir,
        }
      );
      assert.fail('Should have failed on directory collision');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /already exists and is not an empty directory/);
    }
  });

  it('clones repository successfully via runGitClone helper', async () => {
    const cloneDest = join(workspaceDir, 'cloned-direct');
    const { stdout, stderr } = await runGitClone([sourceRepoDir, cloneDest]);
    assert.strictEqual(checkTargetDirectory(cloneDest).exists, true);
    assert.strictEqual(checkTargetDirectory(cloneDest).isEmpty, false);
  });

  it('clones repository via preva CLI binary non-interactively', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'clone', sourceRepoDir, 'cloned-via-preva'],
      {
        cwd: workspaceDir,
      }
    );

    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Pre-Flight Safety Preview/);
    assert.match(cleanOut, /Successfully cloned repository into cloned-via-preva/);
    assert.match(cleanOut, /Node\.js/);
    assert.match(cleanOut, /npm install/);

    const targetPath = join(workspaceDir, 'cloned-via-preva');
    assert.strictEqual(checkTargetDirectory(targetPath).exists, true);
  });
});
