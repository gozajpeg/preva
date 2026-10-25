import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import {
  checkInitTarget,
  detectProjectTech,
  generateGitignoreContent,
  runGitInit,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render pre-init safety preview.
 */
export function renderInitPreview(plan, targetStatus, techHints = [], options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('preva init')} - ${colors.cyan('Pre-Flight Safety Preview')}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Target Directory:')} ${colors.bold(plan.targetDir)}`);
  line(`  ${colors.bold('Absolute Path:')}    ${colors.dim(targetStatus.absPath)}`);
  line(`  ${colors.bold('Initial Branch:')}   ${colors.green(plan.initialBranch)}`);
  line(`  ${colors.bold('Repository Type:')}  ${plan.isBare ? colors.yellow('Bare repository (--bare)') : colors.cyan('Standard repository')}`);

  // Repository state checks & warnings
  line(`\n  ${colors.bold('Repository Status:')}`);
  if (targetStatus.isDirectRepo) {
    line(`    ${colors.yellow('[!]')} Directory is already an initialized Git repository (.git exists).`);
    line(colors.dim('        Running git init will safely re-initialize and update configuration.'));
  } else if (targetStatus.isNestedRepo) {
    line(`    ${colors.yellow('[!] Nested Repo Alert:')} Directory is inside an existing Git repository:`);
    line(`        ${colors.dim(targetStatus.parentRepoPath)}`);
  } else {
    line(`    ${colors.green('[OK]')} Clean target path. Ready for new repository initialization.`);
  }

  // Technology ecosystem detection
  if (techHints && techHints.length > 0) {
    line(`\n  ${colors.bold('Detected Technologies:')}`);
    techHints.forEach((h) => {
      line(`    * ${colors.cyan(h.tech)}`);
    });
  }

  // .gitignore status
  line(`\n  ${colors.bold('.gitignore Protection:')}`);
  if (targetStatus.hasGitignore) {
    line(`    ${colors.green('[OK]')} Existing .gitignore file found in target directory.`);
  } else if (plan.createGitignore) {
    line(`    ${colors.green('[+]')} Smart .gitignore will be generated (secrets, keys, OS, and tech rules).`);
  } else {
    line(`    ${colors.yellow('[!]')} No .gitignore file found.`);
  }

  // Native command preview
  line(`\n  ${colors.bold('Native Git Command:')}`);
  line(`    ${colors.dim('$')} ${colors.cyan(`git ${plan.cmdArgs.join(' ')}`)}`);

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render post-init success summary and next steps.
 */
export function renderInitSuccess(plan, details = {}, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.green('✔ Initialized Git repository in')} ${colors.bold(plan.targetDir)}!`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Initial Branch:')}   ${colors.green(plan.initialBranch)}`);
  if (details.gitignoreCreated) {
    line(`  ${colors.bold('.gitignore:')}       ${colors.green('Created with credential & ecosystem protections')}`);
  }

  line(`\n  ${colors.bold('Recommended Next Steps:')}`);
  if (plan.targetDir !== '.' && plan.targetDir !== process.cwd()) {
    line(`    ${colors.cyan(`cd ${plan.targetDir}`)}`);
  }
  line(`    ${colors.cyan('preva git add .')}                (review & select files to stage)`);
  line(`    ${colors.cyan('preva git commit')}               (create your first commit)`);
  line(`    ${colors.cyan('preva git remote add origin <url>')} (connect remote repository)`);
  line(`    ${colors.cyan(`preva git push -u origin ${plan.initialBranch}`)}  (publish to remote)`);

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva init / preva git init.
 */
export async function initCommand(args = []) {
  let initialBranch = 'main';
  let isBare = false;
  let quiet = false;
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-b' || a === '--initial-branch') {
      initialBranch = args[i + 1] || 'main';
      i++;
    } else if (a.startsWith('-b=')) {
      initialBranch = a.split('=')[1] || 'main';
    } else if (a.startsWith('--initial-branch=')) {
      initialBranch = a.split('=')[1] || 'main';
    } else if (a === '--bare') {
      isBare = true;
    } else if (a === '-q' || a === '--quiet') {
      quiet = true;
    } else if (!a.startsWith('-')) {
      positionals.push(a);
    }
  }

  const targetDir = positionals[0] || '.';
  const targetStatus = await checkInitTarget(targetDir);

  // Detect project ecosystem
  const techHints = detectProjectTech(targetStatus.absPath);

  // Safety checks for existing repositories
  if (targetStatus.isDirectRepo && isInteractive()) {
    console.log(
      colors.yellow(
        `\n[!] Note: "${targetDir}" is already an initialized Git repository (.git exists).`
      )
    );
    const proceed = await confirmPrompt({
      message: 'Re-initialize existing repository?',
      defaultValue: true,
    });
    if (!proceed) {
      console.log(colors.yellow('Initialization cancelled.'));
      return;
    }
  }

  if (targetStatus.isNestedRepo && isInteractive()) {
    console.log(
      colors.yellow(
        `\n[!] Warning: "${targetDir}" is inside an existing Git repository:\n    ${targetStatus.parentRepoPath}`
      )
    );
    const proceed = await confirmPrompt({
      message: 'Create a nested Git repository here anyway?',
      defaultValue: false,
    });
    if (!proceed) {
      console.log(colors.yellow('Initialization cancelled.'));
      return;
    }
  }

  // Ask for smart .gitignore generation if none exists
  let createGitignore = false;
  if (!targetStatus.hasGitignore && !isBare) {
    if (isInteractive()) {
      createGitignore = await confirmPrompt({
        message: 'Generate a smart .gitignore with security and framework rules?',
        defaultValue: true,
      });
    } else {
      createGitignore = true;
    }
  }

  // Assemble native command arguments
  const cmdArgs = ['init'];
  if (initialBranch) {
    cmdArgs.push('-b', initialBranch);
  }
  if (isBare) {
    cmdArgs.push('--bare');
  }
  if (targetDir !== '.') {
    cmdArgs.push(targetDir);
  }

  const plan = {
    targetDir,
    initialBranch,
    isBare,
    createGitignore,
    cmdArgs,
  };

  if (!quiet) {
    console.log(renderInitPreview(plan, targetStatus, techHints));
  }

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Initialize Git repository in "${targetDir}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('Initialization cancelled.'));
      return;
    }
  }

  // Ensure target folder exists if path was specified
  if (!targetStatus.exists) {
    try {
      mkdirSync(targetStatus.absPath, { recursive: true });
    } catch (err) {
      console.error(colors.red(`Failed to create directory: ${err.message}`));
      process.exit(1);
    }
  }

  try {
    const { stdout, stderr } = await runGitInit(cmdArgs.slice(1));
    if (stdout.trim() && !quiet) console.log(colors.dim(stdout.trim()));
    if (stderr.trim()) console.log(colors.dim(stderr.trim()));

    // Generate .gitignore if requested
    let gitignoreCreated = false;
    if (createGitignore && !targetStatus.hasGitignore && !isBare) {
      const gitignorePath = join(targetStatus.absPath, '.gitignore');
      const gitignoreContent = generateGitignoreContent(techHints);
      try {
        writeFileSync(gitignorePath, gitignoreContent, 'utf8');
        gitignoreCreated = true;
      } catch (err) {
        console.warn(colors.yellow(`Warning: Could not create .gitignore: ${err.message}`));
      }
    }

    if (!quiet) {
      console.log(renderInitSuccess(plan, { gitignoreCreated }));
    }
  } catch (err) {
    console.error(colors.red(`\nInitialization failed: ${err.message}`));
    process.exit(1);
  }
}
