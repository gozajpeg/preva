import {
  isGitRepo,
  runGitRestore,
  getUncommittedFiles,
  getFileDiffStat,
  getFileDiffSnippet,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, checkboxList } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export async function restoreCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // If flags or arguments are passed, handle direct command preview mode
  if (args.length > 0) {
    await handleDirectRestoreArgs(args);
    return;
  }

  // Interactive Restore Menu
  await handleInteractiveRestoreMenu();
}

/**
 * Handle direct restore arguments (e.g. preva restore --staged src/app.js, preva restore src/app.js).
 */
async function handleDirectRestoreArgs(args) {
  const isStaged = args.includes('--staged');
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));

  if (nonFlagArgs.length === 0) {
    console.error(colors.red('Error: File path(s) required for git restore.'));
    process.exit(1);
  }

  // Case 1: Unstaging files (git restore --staged <files...>)
  if (isStaged) {
    console.log(`\n${colors.bold('Restore Preview:')} ${colors.green('UNSTAGE')} (--staged)`);
    console.log(colors.cyan('----------------------------------------------------------------------'));
    console.log(colors.green('SAFE: Files will be removed from staging index.'));
    console.log('• All changes will remain intact as modified files in your working directory.');
    console.log('\nTarget file(s):');
    nonFlagArgs.forEach((f) => {
      console.log(`  • ${colors.cyan(f)}`);
    });
    console.log(colors.cyan('----------------------------------------------------------------------\n'));

    const proceed = await confirmPrompt({
      message: `Unstage ${nonFlagArgs.length} file(s)?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nRestore cancelled.'));
      process.exit(130);
    }

    try {
      await runGitRestore(['--staged', '--', ...nonFlagArgs]);
      console.log(`\n${colors.green('Unstaged')} ${nonFlagArgs.length} file(s).`);
    } catch (err) {
      console.error(colors.red(`\nRestore failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Case 2: Discarding working tree changes (git restore <files...>)
  console.log(`\n${colors.bold('Restore Preview:')} ${colors.red('DISCARD LOCAL EDITS')} (git restore)`);
  console.log(colors.yellow('----------------------------------------------------------------------'));
  console.log(colors.red('WARNING: Uncommitted changes in these files will be PERMANENTLY ERASED:'));

  for (const file of nonFlagArgs) {
    const stat = await getFileDiffStat(file, false);
    const diffStat = stat ? colors.dim(` (+${stat.added}, -${stat.deleted} lines)`) : '';
    console.log(`\n  • ${colors.bold(file)}${diffStat}`);

    const snippet = await getFileDiffSnippet(file, false);
    if (snippet) {
      console.log(colors.dim('    Diff preview:'));
      snippet.split('\n').slice(0, 8).forEach((line) => {
        if (line.startsWith('+')) console.log(`      ${colors.green(line)}`);
        else if (line.startsWith('-')) console.log(`      ${colors.red(line)}`);
        else console.log(`      ${colors.dim(line)}`);
      });
    }
  }
  console.log(colors.yellow('\n----------------------------------------------------------------------\n'));

  const proceed = await confirmPrompt({
    message: `PERMANENTLY discard changes in ${nonFlagArgs.length} file(s)?`,
    defaultValue: false,
  });

  if (!proceed) {
    console.log(colors.dim('\nRestore cancelled. No changes were discarded.'));
    process.exit(130);
  }

  try {
    await runGitRestore(['--', ...nonFlagArgs]);
    console.log(`\n${colors.green('Discarded changes in')} ${nonFlagArgs.length} file(s).`);
  } catch (err) {
    console.error(colors.red(`\nRestore failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Interactive menu when preva restore is run without arguments.
 */
async function handleInteractiveRestoreMenu() {
  const uncommitted = await getUncommittedFiles();
  const stagedFiles = uncommitted.filter((f) => f.isStaged);
  const unstagedFiles = uncommitted.filter((f) => f.isUnstaged && f.code !== '??');

  if (stagedFiles.length === 0 && unstagedFiles.length === 0) {
    console.log(colors.dim('\nNothing to restore. Working tree clean.\n'));
    return;
  }

  console.log(`\n${colors.bold('preva restore')} - Git Restore & Safety Guard\n`);

  const menuChoices = [];

  if (stagedFiles.length > 0) {
    menuChoices.push({
      value: 'unstage',
      name: 'Unstage files       (git restore --staged <file>)',
      description: `Unstage ${stagedFiles.length} file(s); keep edits`,
    });
  }

  if (unstagedFiles.length > 0) {
    menuChoices.push({
      value: 'discard',
      name: 'Discard local edits (git restore <file>)',
      description: `Discard changes in ${unstagedFiles.length} file(s)`,
    });
  }

  const choice = await selectPrompt({
    message: 'Select restore action:',
    choices: menuChoices,
  });

  if (choice === 'unstage') {
    await runInteractiveRestoreUnstage(stagedFiles);
  } else if (choice === 'discard') {
    await runInteractiveRestoreDiscard(unstagedFiles);
  }
}

/**
 * Interactive checklist to pick staged files to unstage.
 */
async function runInteractiveRestoreUnstage(stagedFiles) {
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
    await runGitRestore(['--staged', '--', ...selected]);
    console.log(`\n${colors.green('Unstaged')} ${colors.bold(selected.length)} file(s).`);
  } catch (err) {
    console.error(colors.red(`\nUnstage failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Interactive checklist to pick modified files to discard.
 */
async function runInteractiveRestoreDiscard(unstagedFiles) {
  const choices = unstagedFiles.map((f) => ({
    name: f.path,
    value: f.path,
    checked: false, // Start unchecked for safety!
  }));

  console.log(colors.yellow('\nWarning: Discarding changes will permanently overwrite files with last commit.'));

  const selected = await checkboxList({
    message: 'Select files to discard changes (starts unchecked for safety):',
    choices,
  });

  if (selected.length === 0) {
    console.log(colors.dim('\nNo files selected. Nothing discarded.'));
    return;
  }

  await handleDirectRestoreArgs(selected);
}
