import { resolve, isAbsolute, basename } from 'node:path';
import {
  extractRepoNameFromUrl,
  checkTargetDirectory,
  suggestAlternativeDirectory,
  detectProjectTech,
  runGitClone,
  getCurrentBranch,
  getCommitHistory,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render pre-clone safety preview.
 */
export function renderClonePreview(plan, dirStatus, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('preva clone')} - ${colors.cyan('Pre-Flight Safety Preview')}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Repository URL:')}   ${colors.cyan(plan.url)}`);
  line(`  ${colors.bold('Target Directory:')} ${colors.bold(plan.targetDir)}`);
  line(`  ${colors.bold('Absolute Path:')}    ${colors.dim(dirStatus.absPath)}`);

  if (plan.branch) {
    line(`  ${colors.bold('Branch:')}           ${colors.green(plan.branch)}`);
  }
  if (plan.depth) {
    line(`  ${colors.bold('Depth (Shallow):')}  ${colors.yellow(plan.depth)} commit(s)`);
  }
  if (plan.recurseSubmodules) {
    line(`  ${colors.bold('Submodules:')}       ${colors.magenta('Recursive initialization enabled')}`);
  }

  // Directory status check
  line(`\n  ${colors.bold('Destination Directory Status:')}`);
  if (!dirStatus.exists) {
    line(`    ${colors.green('[OK]')} Directory does not exist yet. Ready for clean clone.`);
  } else if (dirStatus.isEmpty) {
    line(`    ${colors.green('[OK]')} Directory exists and is empty. Ready for clean clone.`);
  } else {
    line(
      `    ${colors.red('[!]')} Directory already exists and contains ${colors.bold(
        dirStatus.fileCount
      )} file(s)!`
    );
    line(colors.dim('        Git will reject cloning into an existing non-empty directory.'));
  }

  // Native command preview
  line(`\n  ${colors.bold('Native Git Command:')}`);
  line(`    ${colors.dim('$')} ${colors.cyan(`git ${plan.cmdArgs.join(' ')}`)}`);

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render post-clone summary and next steps.
 */
export function renderCloneSuccess(plan, summary = {}, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.green('✔ Successfully cloned repository into')} ${colors.bold(plan.targetDir)}!`);
  line(colors.dim('----------------------------------------------------------------------'));

  if (summary.branch) {
    line(`  ${colors.bold('Default Branch:')}   ${colors.green(summary.branch)}`);
  }
  if (summary.latestCommit) {
    line(
      `  ${colors.bold('Latest Commit:')}    ${colors.yellow(summary.latestCommit.hash)} ${summary.latestCommit.subject}`
    );
    line(
      `  ${colors.bold('Author:')}           ${summary.latestCommit.author} (${summary.latestCommit.date})`
    );
  }

  if (summary.techHints && summary.techHints.length > 0) {
    line(`\n  ${colors.bold('Detected Technologies:')}`);
    summary.techHints.forEach((h) => {
      line(`    * ${colors.cyan(h.tech)}`);
    });
  }

  line(`\n  ${colors.bold('Suggested Next Steps:')}`);
  line(`    ${colors.cyan(`cd ${plan.targetDir}`)}`);
  if (summary.techHints && summary.techHints.length > 0) {
    summary.techHints.forEach((h) => {
      line(`    ${colors.cyan(h.command)}`);
    });
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva clone / preva git clone.
 */
export async function cloneCommand(args = []) {
  // Extract flags and positional arguments
  const flags = [];
  const positionals = [];
  let depth = null;
  let branch = null;
  let recurseSubmodules = false;
  let singleBranch = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--depth') {
      depth = args[i + 1] || '1';
      flags.push('--depth', depth);
      i++;
    } else if (a.startsWith('--depth=')) {
      depth = a.split('=')[1] || '1';
      flags.push(a);
    } else if (a === '-b' || a === '--branch') {
      branch = args[i + 1] || null;
      if (branch) flags.push('-b', branch);
      i++;
    } else if (a.startsWith('--branch=')) {
      branch = a.split('=')[1] || null;
      flags.push(a);
    } else if (a === '--recurse-submodules') {
      recurseSubmodules = true;
      flags.push(a);
    } else if (a === '--single-branch') {
      singleBranch = true;
      flags.push(a);
    } else if (a.startsWith('-')) {
      flags.push(a);
    } else {
      positionals.push(a);
    }
  }

  let repoUrl = positionals[0] || null;
  let targetDir = positionals[1] || null;

  // 1. If no URL provided on CLI
  if (!repoUrl) {
    if (!isInteractive()) {
      console.error(
        colors.red('Error: Repository URL required for clone (e.g. "preva git clone <url> [directory]").')
      );
      process.exit(1);
    }

    const wizardResult = await handleCloneWizard();
    if (!wizardResult) return;
    repoUrl = wizardResult.url;
    targetDir = wizardResult.targetDir;
    depth = wizardResult.depth;
    branch = wizardResult.branch;
    recurseSubmodules = wizardResult.recurseSubmodules;
    singleBranch = wizardResult.singleBranch;
  }

  if (!targetDir) {
    targetDir = extractRepoNameFromUrl(repoUrl);
  }

  // 2. Check target directory for collision
  let dirStatus = checkTargetDirectory(targetDir);
  if (dirStatus.exists && !dirStatus.isEmpty) {
    if (!isInteractive()) {
      console.error(
        colors.red(
          `Error: Destination path "${targetDir}" already exists and is not an empty directory (${dirStatus.fileCount} files found).`
        )
      );
      process.exit(1);
    }

    const resolvedDir = await handleDirectoryCollision(targetDir, dirStatus);
    if (!resolvedDir) {
      console.log(colors.yellow('Clone cancelled.'));
      return;
    }
    targetDir = resolvedDir;
    dirStatus = checkTargetDirectory(targetDir);
  }

  // 3. Assemble command arguments
  const cmdArgs = ['clone'];
  if (depth) cmdArgs.push('--depth', depth);
  if (branch) cmdArgs.push('-b', branch);
  if (recurseSubmodules) cmdArgs.push('--recurse-submodules');
  if (singleBranch) cmdArgs.push('--single-branch');
  // Include any extra flags
  flags.forEach((f) => {
    if (!cmdArgs.includes(f) && f !== depth && f !== branch) {
      cmdArgs.push(f);
    }
  });
  cmdArgs.push(repoUrl, targetDir);

  const plan = {
    url: repoUrl,
    targetDir,
    branch,
    depth,
    recurseSubmodules,
    singleBranch,
    cmdArgs,
  };

  console.log(renderClonePreview(plan, dirStatus));

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Execute git clone into "${targetDir}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('Clone cancelled by user.'));
      return;
    }
  }

  console.log(`\n${colors.cyan(`Cloning ${repoUrl} into "${targetDir}"...`)}`);

  try {
    const { stdout, stderr } = await runGitClone(cmdArgs.slice(1));
    if (stdout.trim()) console.log(colors.dim(stdout.trim()));
    if (stderr.trim()) console.log(colors.dim(stderr.trim()));

    // Post-clone inspection
    const targetAbs = resolve(process.cwd(), targetDir);
    const [clonedBranch, recentCommits] = await Promise.all([
      getCurrentBranch(targetAbs).catch(() => null),
      getCommitHistory({ maxCount: 1 }, targetAbs).catch(() => []),
    ]);
    const techHints = detectProjectTech(targetAbs);

    const summary = {
      branch: clonedBranch,
      latestCommit: recentCommits[0] || null,
      techHints,
    };

    console.log(renderCloneSuccess(plan, summary));
  } catch (err) {
    console.error(colors.red(`\nClone failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Interactive wizard when clone is called without arguments.
 */
async function handleCloneWizard() {
  if (isInteractive()) console.clear();
  console.log(`\n${colors.bold('preva clone')} - Interactive Setup Wizard\n`);

  const urlInput = await inputPrompt({
    message: 'Enter repository URL to clone:',
    placeholder: 'https://github.com/owner/repo.git or git@github.com:owner/repo.git',
    allowEmpty: false,
  });

  if (!urlInput || !urlInput.trim()) {
    return null;
  }

  const url = urlInput.trim();
  const defaultDir = extractRepoNameFromUrl(url);

  const dirInput = await inputPrompt({
    message: 'Enter destination folder name:',
    defaultValue: defaultDir,
    placeholder: defaultDir,
    allowEmpty: true,
  });

  const targetDir = (dirInput && dirInput.trim()) || defaultDir;

  const mode = await selectPrompt({
    message: 'Select clone mode:',
    choices: [
      {
        value: 'full',
        name: 'Standard Full Clone     (Full commit history and all branches)',
        description: 'Complete copy of repository',
      },
      {
        value: 'shallow',
        name: 'Shallow Clone           (git clone --depth 1 - Fast & lightweight)',
        description: 'Downloads latest snapshot only, saving bandwidth',
      },
      {
        value: 'submodules',
        name: 'Recursive with Submodules (git clone --recurse-submodules)',
        description: 'Automatically clones nested submodules',
      },
    ],
  });

  let depth = null;
  let recurseSubmodules = false;
  if (mode === 'shallow') {
    depth = '1';
  } else if (mode === 'submodules') {
    recurseSubmodules = true;
  }

  return {
    url,
    targetDir,
    depth,
    branch: null,
    recurseSubmodules,
    singleBranch: false,
  };
}

/**
 * Handle destination directory collision.
 */
async function handleDirectoryCollision(targetDir, dirStatus) {
  const suggested = suggestAlternativeDirectory(targetDir);

  console.log(
    colors.yellow(
      `\n[!] Destination "${targetDir}" already exists and contains ${dirStatus.fileCount} file(s).`
    )
  );

  const choice = await selectPrompt({
    message: 'Choose how to resolve destination collision:',
    choices: [
      {
        value: 'suggested',
        name: `Clone into "${suggested}"     (recommended alternative)`,
        description: `Creates new non-colliding directory "${suggested}"`,
      },
      {
        value: 'custom',
        name: 'Enter a custom folder name (specify new destination)',
        description: 'Type another folder name',
      },
      {
        value: 'cancel',
        name: 'Cancel clone               (abort)',
        description: 'Do not clone',
      },
    ],
  });

  if (choice === 'cancel') return null;

  if (choice === 'suggested') return suggested;

  if (choice === 'custom') {
    const custom = await inputPrompt({
      message: 'Enter new directory name:',
      allowEmpty: false,
    });
    return custom ? custom.trim() : null;
  }

  return null;
}
