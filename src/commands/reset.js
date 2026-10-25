import {
  isGitRepo,
  runGitReset,
  getUncommittedFiles,
  getLastCommit,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, checkboxList } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export async function resetCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // If flags or arguments are passed, handle direct command preview mode
  if (args.length > 0) {
    await handleDirectResetArgs(args);
    return;
  }

  // Interactive Reset Menu
  await handleInteractiveResetMenu();
}

/**
 * Handle direct reset arguments (e.g. preva reset --soft HEAD~1, preva reset --hard).
 */
async function handleDirectResetArgs(args) {
  const isHard = args.includes('--hard');
  const isSoft = args.includes('--soft');
  const isMixed = args.includes('--mixed');
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));

  // Case 1: Hard reset (--hard)
  if (isHard) {
    const targetRef = nonFlagArgs[0] || 'HEAD';
    const uncommitted = await getUncommittedFiles();

    console.log(`\n${colors.bold('Reset Preview:')} ${colors.red('HARD RESET')} to ${colors.cyan(targetRef)}`);
    console.log(colors.yellow('----------------------------------------------------------------------'));
    console.log(colors.red('WARNING: This is a HARD reset.'));
    console.log('• All uncommitted changes in your working tree will be PERMANENTLY ERASED.');

    if (uncommitted.length > 0) {
      console.log(`\nFiles that will be permanently lost (${colors.bold(uncommitted.length)}):`);
      uncommitted.slice(0, 15).forEach((f) => {
        const badge = f.isStaged ? colors.cyan('staged') : colors.yellow('modified');
        console.log(`  • ${colors.red(f.path)} (${badge})`);
      });
      if (uncommitted.length > 15) {
        console.log(colors.dim(`  ... and ${uncommitted.length - 15} more files`));
      }
    } else {
      console.log(colors.dim('\nWorking tree is currently clean. Only commit pointer will move.'));
    }
    console.log(colors.yellow('----------------------------------------------------------------------\n'));

    const proceed = await confirmPrompt({
      message: `Confirm HARD reset (--hard) to ${targetRef}?`,
      defaultValue: false,
    });

    if (!proceed) {
      console.log(colors.dim('\nReset cancelled. No files or commits were modified.'));
      process.exit(130);
    }

    try {
      const { stdout } = await runGitReset(args);
      if (stdout.trim()) console.log(stdout.trim());
      console.log(`\n${colors.green('Hard reset complete.')}`);
    } catch (err) {
      console.error(colors.red(`\nReset failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Case 2: Soft reset (--soft)
  if (isSoft) {
    const targetRef = nonFlagArgs[0] || 'HEAD~1';
    const lastCommit = await getLastCommit();

    console.log(`\n${colors.bold('Reset Preview:')} ${colors.green('SOFT RESET')} to ${colors.cyan(targetRef)}`);
    console.log(colors.cyan('----------------------------------------------------------------------'));
    console.log(colors.green('SAFE: No code will be lost.'));
    console.log('• Unwraps commits back into your staging area.');
    console.log('• All files will remain STAGED in your index, ready to edit or recommit.');

    if (lastCommit && targetRef === 'HEAD~1') {
      console.log(`\nCommit being unwrapped: ${colors.yellow(lastCommit.hash)} ${lastCommit.message}`);
    }
    console.log(colors.cyan('----------------------------------------------------------------------\n'));

    const proceed = await confirmPrompt({
      message: `Confirm soft reset (--soft) to ${targetRef}?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nReset cancelled.'));
      process.exit(130);
    }

    try {
      const { stdout } = await runGitReset(args);
      if (stdout.trim()) console.log(stdout.trim());
      console.log(`\n${colors.green('Soft reset complete. Files are staged and preserved.')}`);
    } catch (err) {
      console.error(colors.red(`\nReset failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Case 3: Mixed reset (--mixed or default git reset [ref])
  if (isMixed || (nonFlagArgs.length > 0 && !nonFlagArgs[0].includes('.'))) {
    const targetRef = nonFlagArgs[0] || 'HEAD~1';
    console.log(`\n${colors.bold('Reset Preview:')} ${colors.cyan('MIXED RESET')} to ${colors.cyan(targetRef)}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log('• Commits will be unwrapped.');
    console.log('• Staged files will be kept in your working tree as unstaged modifications.');
    console.log('• Zero code lost.');
    console.log(colors.dim('----------------------------------------------------------------------\n'));

    const proceed = await confirmPrompt({
      message: `Confirm reset to ${targetRef}?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nReset cancelled.'));
      process.exit(130);
    }

    try {
      const { stdout } = await runGitReset(args);
      if (stdout.trim()) console.log(stdout.trim());
      console.log(`\n${colors.green('Reset complete. Changes kept in working directory.')}`);
    } catch (err) {
      console.error(colors.red(`\nReset failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Case 4: File path unstage (e.g. preva reset src/app.js)
  const paths = nonFlagArgs;
  console.log(`\n${colors.bold('Unstage Preview:')} ${paths.join(', ')}`);
  console.log('• Files will be removed from staging index.');
  console.log('• All changes will remain intact in your working directory.');

  const proceed = await confirmPrompt({
    message: `Unstage ${paths.length} file(s)?`,
    defaultValue: true,
  });

  if (!proceed) {
    console.log(colors.dim('\nUnstage cancelled.'));
    process.exit(130);
  }

  try {
    await runGitReset(['--', ...paths]);
    console.log(`\n${colors.green('Unstaged')} ${paths.length} file(s).`);
  } catch (err) {
    console.error(colors.red(`\nUnstage failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Interactive menu when preva reset is run without arguments.
 */
async function handleInteractiveResetMenu() {
  const uncommitted = await getUncommittedFiles();
  const lastCommit = await getLastCommit();
  const stagedFiles = uncommitted.filter((f) => f.isStaged);

  if (uncommitted.length === 0 && !lastCommit) {
    console.log(colors.dim('\nNothing to reset. Working tree is clean.\n'));
    return;
  }

  console.log(`\n${colors.bold('preva reset')} - Git Reset & Undo Guard\n`);

  const menuChoices = [];

  if (stagedFiles.length > 0) {
    menuChoices.push({
      value: 'unstage',
      name: 'Unstage files   (git reset <file>)',
      description: `Unstage ${stagedFiles.length} file(s); keep edits`,
    });
  }

  if (lastCommit) {
    menuChoices.push({
      value: 'soft',
      name: 'Soft Reset      (git reset --soft HEAD~1)',
      description: 'Unwrap commit; keep files staged',
    });
    menuChoices.push({
      value: 'mixed',
      name: 'Mixed Reset     (git reset HEAD~1)',
      description: 'Unwrap commit; keep files unstaged',
    });
  }

  if (uncommitted.length > 0) {
    menuChoices.push({
      value: 'hard',
      name: 'Hard Reset      (git reset --hard HEAD)',
      description: 'Erase changes (destructive)',
    });
  }

  const choice = await selectPrompt({
    message: 'Select reset action:',
    choices: menuChoices,
  });

  if (choice === 'unstage') {
    await runInteractiveUnstage(stagedFiles);
  } else if (choice === 'soft') {
    await handleDirectResetArgs(['--soft', 'HEAD~1']);
  } else if (choice === 'mixed') {
    await handleDirectResetArgs(['--mixed', 'HEAD~1']);
  } else if (choice === 'hard') {
    await handleDirectResetArgs(['--hard', 'HEAD']);
  }
}

/**
 * Interactive checklist to pick which staged files to unstage.
 */
async function runInteractiveUnstage(stagedFiles) {
  const choices = stagedFiles.map((f) => ({
    name: f.path,
    value: f.path,
    checked: true,
  }));

  const selected = await checkboxList({
    message: 'Select files to unstage (changes stay in working tree):',
    choices,
  });

  if (selected.length === 0) {
    console.log(colors.yellow('\nNo files selected. Nothing unstaged.'));
    return;
  }

  try {
    await runGitReset(['--', ...selected]);
    console.log(`\n${colors.green('Unstaged')} ${colors.bold(selected.length)} file(s).`);
  } catch (err) {
    console.error(colors.red(`\nUnstage failed: ${err.message}`));
    process.exit(1);
  }
}
