import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  checkInitTarget,
  generateGitignoreContent,
  runGitInit,
} from '../src/utils/git.js';
import {
  renderInitPreview,
  renderInitSuccess,
} from '../src/commands/init.js';
import { stripAnsi } from '../src/utils/ui.js';

const execFileAsync = promisify(execFile);
const binPath = join(process.cwd(), 'bin', 'preva.js');

describe('git init formatting & helper unit tests', () => {
  it('generates protective .gitignore with universal secrets and tech rules', () => {
    const gitignoreDefault = generateGitignoreContent();
    assert.match(gitignoreDefault, /\.env/);
    assert.match(gitignoreDefault, /\*\.key/);
    assert.match(gitignoreDefault, /credentials\.json/);
    assert.match(gitignoreDefault, /\.DS_Store/);
    assert.match(gitignoreDefault, /\.vscode\//);

    // Node.js specific
    const gitignoreNode = generateGitignoreContent([{ tech: 'Node.js' }]);
    assert.match(gitignoreNode, /node_modules\//);
    assert.match(gitignoreNode, /dist\//);

    // Python specific
    const gitignorePy = generateGitignoreContent([{ tech: 'Python' }]);
    assert.match(gitignorePy, /__pycache__\//);
    assert.match(gitignorePy, /\.venv\//);

    // Rust specific
    const gitignoreRust = generateGitignoreContent([{ tech: 'Rust' }]);
    assert.match(gitignoreRust, /target\//);

    // Go specific
    const gitignoreGo = generateGitignoreContent([{ tech: 'Go' }]);
    assert.match(gitignoreGo, /bin\//);
  });

  it('renders pre-init safety preview for a clean new project', () => {
    const plan = {
      targetDir: 'my-project',
      initialBranch: 'main',
      isBare: false,
      createGitignore: true,
      cmdArgs: ['init', '-b', 'main', 'my-project'],
    };

    const targetStatus = {
      absPath: '/tmp/my-project',
      exists: true,
      isDirectRepo: false,
      isNestedRepo: false,
      parentRepoPath: null,
      hasGitignore: false,
    };

    const techHints = [{ tech: 'Node.js' }];

    const rendered = stripAnsi(renderInitPreview(plan, targetStatus, techHints, { maxCols: 120 }));
    assert.match(rendered, /preva init/);
    assert.match(rendered, /Pre-Flight Safety Preview/);
    assert.match(rendered, /Target Directory:\s+my-project/);
    assert.match(rendered, /Initial Branch:\s+main/);
    assert.match(rendered, /Standard repository/);
    assert.match(rendered, /Clean target path\. Ready for new repository initialization\./);
    assert.match(rendered, /Detected Technologies:/);
    assert.match(rendered, /Node\.js/);
    assert.match(rendered, /Smart \.gitignore will be generated/);
    assert.match(rendered, /git init -b main my-project/);
  });

  it('renders pre-init preview with re-initialization warning', () => {
    const plan = {
      targetDir: '.',
      initialBranch: 'main',
      isBare: false,
      createGitignore: false,
      cmdArgs: ['init', '-b', 'main'],
    };

    const targetStatus = {
      absPath: '/tmp/existing-repo',
      exists: true,
      isDirectRepo: true,
      isNestedRepo: false,
      parentRepoPath: null,
      hasGitignore: true,
    };

    const rendered = stripAnsi(renderInitPreview(plan, targetStatus, [], { maxCols: 120 }));
    assert.match(rendered, /Directory is already an initialized Git repository/);
    assert.match(rendered, /Existing \.gitignore file found in target directory\./);
  });

  it('renders pre-init preview with nested repository alert', () => {
    const plan = {
      targetDir: 'submodule-folder',
      initialBranch: 'main',
      isBare: false,
      createGitignore: true,
      cmdArgs: ['init', '-b', 'main', 'submodule-folder'],
    };

    const targetStatus = {
      absPath: '/tmp/parent-repo/submodule-folder',
      exists: true,
      isDirectRepo: false,
      isNestedRepo: true,
      parentRepoPath: '/tmp/parent-repo',
      hasGitignore: false,
    };

    const rendered = stripAnsi(renderInitPreview(plan, targetStatus, [], { maxCols: 120 }));
    assert.match(rendered, /Nested Repo Alert/);
    assert.match(rendered, /Directory is inside an existing Git repository/);
    assert.match(rendered, /\/tmp\/parent-repo/);
  });

  it('renders post-init success summary with actionable next steps', () => {
    const plan = {
      targetDir: 'new-app',
      initialBranch: 'main',
      cmdArgs: ['init', '-b', 'main', 'new-app'],
    };

    const rendered = stripAnsi(renderInitSuccess(plan, { gitignoreCreated: true }, { maxCols: 120 }));
    assert.match(rendered, /Initialized Git repository in new-app/);
    assert.match(rendered, /Initial Branch:\s+main/);
    assert.match(rendered, /Created with credential & ecosystem protections/);
    assert.match(rendered, /cd new-app/);
    assert.match(rendered, /preva git add \./);
    assert.match(rendered, /preva git commit/);
    assert.match(rendered, /preva git remote add origin <url>/);
    assert.match(rendered, /preva git push -u origin main/);
  });
});

describe('git init operations in live environment', () => {
  let tempBaseDir;

  before(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'preva-init-test-'));
  });

  after(() => {
    try {
      rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('inspects clean, existing, and nested repository structures accurately', async () => {
    const cleanDir = join(tempBaseDir, 'clean-project');
    mkdirSync(cleanDir);

    const status1 = await checkInitTarget(cleanDir);
    assert.strictEqual(status1.isDirectRepo, false);
    assert.strictEqual(status1.isNestedRepo, false);

    // Initialize git in cleanDir
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: cleanDir });
    const status2 = await checkInitTarget(cleanDir);
    assert.strictEqual(status2.isDirectRepo, true);

    // Create a subfolder inside cleanDir
    const subFolder = join(cleanDir, 'nested-folder');
    mkdirSync(subFolder);
    const status3 = await checkInitTarget(subFolder);
    assert.strictEqual(status3.isDirectRepo, false);
    assert.strictEqual(status3.isNestedRepo, true);
  });

  it('initializes a fresh repository with default main branch and smart .gitignore', async () => {
    const projectDir = join(tempBaseDir, 'app-one');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'package.json'), '{"name":"app-one"}');

    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'init'],
      { cwd: projectDir }
    );

    const cleanOut = stripAnsi(stdout);
    assert.match(cleanOut, /Pre-Flight Safety Preview/);
    assert.match(cleanOut, /Initialized Git repository in \./);
    assert.match(cleanOut, /Node\.js/);

    // Verify .git was created
    assert.strictEqual(existsSync(join(projectDir, '.git')), true);

    // Verify .gitignore was created with secrets & node_modules
    const gitignorePath = join(projectDir, '.gitignore');
    assert.strictEqual(existsSync(gitignorePath), true);
    const gitignoreContent = readFileSync(gitignorePath, 'utf8');
    assert.match(gitignoreContent, /\.env/);
    assert.match(gitignoreContent, /node_modules\//);

    // Verify initial branch is main
    const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], { cwd: projectDir });
    // In an empty git repo with no commits yet, symbolic-ref HEAD points to refs/heads/main
    const { stdout: headRefOut } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectDir });
    assert.strictEqual(headRefOut.trim(), 'main');
  });

  it('initializes with custom initial branch name', async () => {
    const projectDir = join(tempBaseDir, 'custom-branch-app');
    mkdirSync(projectDir);

    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'init', '-b', 'develop'],
      { cwd: projectDir }
    );

    assert.match(stripAnsi(stdout), /Initial Branch:\s+develop/);

    const { stdout: headRefOut } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectDir });
    assert.strictEqual(headRefOut.trim(), 'develop');
  });

  it('initializes in target subdirectory directly', async () => {
    const subTarget = 'sub-app-dir';
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'init', subTarget],
      { cwd: tempBaseDir }
    );

    assert.match(stripAnsi(stdout), /Initialized Git repository in sub-app-dir/);
    const expectedGitDir = join(tempBaseDir, subTarget, '.git');
    assert.strictEqual(existsSync(expectedGitDir), true);
  });

  it('initializes bare repository with --bare flag', async () => {
    const bareDir = join(tempBaseDir, 'bare-repo.git');
    mkdirSync(bareDir);

    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'git', 'init', '--bare'],
      { cwd: bareDir }
    );

    assert.match(stripAnsi(stdout), /Bare repository/);
    // In bare repo, HEAD and config exist directly in bareDir
    assert.strictEqual(existsSync(join(bareDir, 'HEAD')), true);
    assert.strictEqual(existsSync(join(bareDir, 'config')), true);
  });
});
