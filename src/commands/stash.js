import {
  isGitRepo,
  getStashes,
  getStashFiles,
  getStashDiffSnippet,
  checkStashConflicts,
  hasWorkingTreeChanges,
  getUncommittedFiles,
  runGitStash,
} from '../utils/git.js';
import { selectPrompt, inputPrompt, confirmPrompt } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export async function stashCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const subCommand = args[0] || null;

  if (subCommand === 'list') {
    await handleStashList();
    return;
  }

  if (subCommand === 'push' || subCommand === 'save') {
    await handleStashPush(args.slice(1));
    return;
  }

  if (subCommand === 'pop') {
    const targetRef = args[1] || 'stash@{0}';
    await handleStashPop(targetRef);
    return;
  }

  if (subCommand === 'apply') {
    const targetRef = args[1] || 'stash@{0}';
    await handleStashApply(targetRef);
    return;
  }

  if (subCommand === 'show') {
    const targetRef = args[1] || 'stash@{0}';
    await handleStashShow(targetRef);
    return;
  }

  if (subCommand === 'drop') {
    const targetRef = args[1] || 'stash@{0}';
    await handleStashDrop(targetRef);
    return;
  }

  if (subCommand === 'clear') {
    await handleStashClear();
    return;
  }

  // If unrecognized subCommand was passed:
  if (subCommand && !subCommand.startsWith('-')) {
    console.error(colors.red(`Unknown stash command: ${subCommand}`));
    console.log(colors.dim('Available: push, pop, apply, show, drop, clear, list\n'));
    process.exit(1);
  }

  // Interactive Stash Explorer Menu
  await handleInteractiveStashMenu();
}

/**
 * Handle "git stash list"
 */
async function handleStashList() {
  const stashes = await getStashes();
  if (stashes.length === 0) {
    console.log(colors.dim('\nNo saved stashes found.\n'));
    return;
  }

  console.log(`\n${colors.bold('Saved Stashes')} (${colors.cyan(stashes.length)}):`);
  stashes.forEach((s) => {
    console.log(`  ${colors.yellow(s.ref.padEnd(12))} ${colors.dim(`(${s.date})`)} ${s.message}`);
  });
  console.log('');
}

/**
 * Interactive Stash Menu when preva stash is run without args.
 */
async function handleInteractiveStashMenu() {
  const stashes = await getStashes();
  const hasChanges = await hasWorkingTreeChanges();

  if (stashes.length === 0 && !hasChanges) {
    console.log(colors.dim('\nNo saved stashes found and working tree is clean.\n'));
    return;
  }

  console.log(`\n${colors.bold('preva stash')} - Git Stash Safety Guard\n`);

  const menuChoices = [];

  if (hasChanges) {
    menuChoices.push({
      value: 'push',
      name: 'Save stash          (git stash push)',
      description: 'Stash uncommitted edits to clean working tree',
    });
  }

  if (stashes.length > 0) {
    menuChoices.push({
      value: 'inspect',
      name: 'Inspect stash       (git stash show -p)',
      description: 'View file diffs inside a stash',
    });
    menuChoices.push({
      value: 'pop',
      name: 'Pop stash           (git stash pop)',
      description: 'Apply stash and remove it from list',
    });
    menuChoices.push({
      value: 'apply',
      name: 'Apply stash         (git stash apply)',
      description: 'Apply stash and keep it in list',
    });
    menuChoices.push({
      value: 'drop',
      name: 'Drop stash          (git stash drop)',
      description: 'Permanently delete a specific stash',
    });
    menuChoices.push({
      value: 'clear',
      name: 'Clear all stashes   (git stash clear)',
      description: 'Permanently delete all stashes',
    });
  }

  const choice = await selectPrompt({
    message: 'Select stash action:',
    choices: menuChoices,
  });

  if (choice === 'push') {
    await handleStashPush();
  } else if (choice === 'inspect') {
    const target = await pickStashPrompt(stashes, 'Select stash to inspect:');
    if (target) await handleStashShow(target);
  } else if (choice === 'pop') {
    const target = await pickStashPrompt(stashes, 'Select stash to pop:');
    if (target) await handleStashPop(target);
  } else if (choice === 'apply') {
    const target = await pickStashPrompt(stashes, 'Select stash to apply:');
    if (target) await handleStashApply(target);
  } else if (choice === 'drop') {
    const target = await pickStashPrompt(stashes, 'Select stash to delete (destructive):');
    if (target) await handleStashDrop(target);
  } else if (choice === 'clear') {
    await handleStashClear();
  }
}

/**
 * Helper to pick a stash from list.
 */
async function pickStashPrompt(stashes, message) {
  if (stashes.length === 1) return stashes[0].ref;

  const choices = stashes.map((s) => ({
    value: s.ref,
    name: `${s.ref} (${s.date})`,
    description: s.message,
  }));

  return await selectPrompt({ message, choices });
}

/**
 * Handle "preva stash push"
 */
async function handleStashPush(extraArgs = []) {
  const uncommitted = await getUncommittedFiles();
  if (uncommitted.length === 0) {
    console.log(colors.dim('\nNo uncommitted changes to stash.\n'));
    return;
  }

  console.log(`\n${colors.bold('Stash Preview:')} Stashing ${colors.cyan(uncommitted.length)} uncommitted file(s)`);
  uncommitted.slice(0, 10).forEach((f) => {
    const badge = f.isStaged ? colors.cyan('staged') : colors.yellow('modified');
    console.log(`  • ${f.path} (${badge})`);
  });
  if (uncommitted.length > 10) {
    console.log(colors.dim(`  ... and ${uncommitted.length - 10} more file(s)`));
  }

  let message = '';
  const msgFlagIndex = extraArgs.findIndex((a) => a === '-m' || a === '--message');
  if (msgFlagIndex !== -1 && extraArgs[msgFlagIndex + 1]) {
    message = extraArgs[msgFlagIndex + 1];
  } else {
    message = await inputPrompt({
      message: 'Stash message (optional)',
      placeholder: 'press enter to use default WIP message',
      allowEmpty: true,
    });
  }

  const includeUntracked = await confirmPrompt({
    message: 'Include untracked files (-u)?',
    defaultValue: false,
  });

  const stashArgs = ['push'];
  if (includeUntracked) stashArgs.push('-u');
  if (message.trim()) stashArgs.push('-m', message.trim());

  try {
    const { stdout } = await runGitStash(stashArgs);
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    console.log(colors.green('\nStashed changes. Working tree is now clean.'));
  } catch (err) {
    console.error(colors.red(`\nStash failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "preva stash show"
 */
async function handleStashShow(stashRef) {
  const files = await getStashFiles(stashRef);
  if (files.length === 0) {
    console.log(colors.dim(`\nStash '${stashRef}' is empty or does not exist.\n`));
    return;
  }

  console.log(`\n${colors.bold('Stash Inspection:')} ${colors.cyan(stashRef)} (${files.length} file(s))`);
  console.log(colors.dim('----------------------------------------------------------------------'));

  files.forEach((f) => {
    let badge = colors.cyan('M');
    if (f.status === 'new') badge = colors.green('A');
    else if (f.status === 'deleted') badge = colors.red('D');
    else if (f.status === 'renamed') badge = colors.yellow('R');
    console.log(`  • ${badge} ${f.path}`);
  });

  const snippet = await getStashDiffSnippet(stashRef);
  if (snippet) {
    console.log(colors.dim('\nDiff Preview (first 25 lines):'));
    snippet
      .split('\n')
      .slice(0, 25)
      .forEach((line) => {
        if (line.startsWith('+')) console.log(colors.green(line));
        else if (line.startsWith('-')) console.log(colors.red(line));
        else console.log(colors.dim(line));
      });
  }
  console.log(colors.dim('----------------------------------------------------------------------\n'));
}

/**
 * Handle "preva stash pop"
 */
async function handleStashPop(stashRef) {
  const files = await getStashFiles(stashRef);
  if (files.length === 0) {
    console.log(colors.dim(`\nStash '${stashRef}' does not exist or has no files.\n`));
    return;
  }

  const { hasConflicts, conflictingFiles } = await checkStashConflicts(stashRef);

  console.log(`\n${colors.bold('Pop Preview:')} Apply and remove ${colors.cyan(stashRef)} (${files.length} file(s))`);
  files.forEach((f) => {
    console.log(`  • ${f.path}`);
  });

  if (hasConflicts) {
    console.log(colors.red('\n----------------------------------------------------------------------'));
    console.log(colors.red('WARNING: Potential merge conflict detected!'));
    console.log('The following uncommitted working file(s) overlap with this stash:');
    conflictingFiles.forEach((p) => {
      console.log(`  • ${colors.red(p)} (modified in workspace and modified in stash)`);
    });
    console.log(colors.yellow('Popping now will cause a merge conflict!'));
    console.log(colors.red('----------------------------------------------------------------------\n'));
  }

  const proceed = await confirmPrompt({
    message: `Pop '${stashRef}' into working directory?`,
    defaultValue: !hasConflicts,
  });

  if (!proceed) {
    console.log(colors.dim('\nPop cancelled. Working directory unchanged.'));
    process.exit(130);
  }

  try {
    const { stdout } = await runGitStash(['pop', stashRef]);
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    console.log(colors.green(`\nPopped '${stashRef}'.`));
  } catch (err) {
    console.error(colors.red(`\nPop failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "preva stash apply"
 */
async function handleStashApply(stashRef) {
  const files = await getStashFiles(stashRef);
  if (files.length === 0) {
    console.log(colors.dim(`\nStash '${stashRef}' does not exist or has no files.\n`));
    return;
  }

  const { hasConflicts, conflictingFiles } = await checkStashConflicts(stashRef);

  console.log(`\n${colors.bold('Apply Preview:')} Apply ${colors.cyan(stashRef)} (keeps stash in list)`);
  files.forEach((f) => {
    console.log(`  • ${f.path}`);
  });

  if (hasConflicts) {
    console.log(colors.red('\nWARNING: Potential merge conflict with working tree files!'));
    conflictingFiles.forEach((p) => {
      console.log(`  • ${colors.red(p)}`);
    });
  }

  const proceed = await confirmPrompt({
    message: `Apply '${stashRef}' to working directory?`,
    defaultValue: !hasConflicts,
  });

  if (!proceed) {
    console.log(colors.dim('\nApply cancelled.'));
    process.exit(130);
  }

  try {
    const { stdout } = await runGitStash(['apply', stashRef]);
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    console.log(colors.green(`\nApplied '${stashRef}'.`));
  } catch (err) {
    console.error(colors.red(`\nApply failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "preva stash drop" (Destructive Guard)
 */
async function handleStashDrop(stashRef) {
  const files = await getStashFiles(stashRef);

  console.log(`\n${colors.bold('Drop Preview:')} ${colors.red(`PERMANENTLY DELETE ${stashRef}`)}`);
  console.log(colors.yellow('----------------------------------------------------------------------'));
  console.log(colors.red('WARNING: Dropping a stash will PERMANENTLY ERASE its saved code forever:'));

  if (files.length > 0) {
    files.forEach((f) => {
      console.log(`  • ${colors.red(f.path)}`);
    });
  } else {
    console.log(colors.dim('  (No files found in stash ref)'));
  }
  console.log(colors.yellow('----------------------------------------------------------------------\n'));

  const proceed = await confirmPrompt({
    message: `PERMANENTLY delete '${stashRef}'?`,
    defaultValue: false,
  });

  if (!proceed) {
    console.log(colors.dim('\nDrop cancelled. Stash was preserved.'));
    process.exit(130);
  }

  try {
    const { stdout } = await runGitStash(['drop', stashRef]);
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    console.log(colors.green(`\nDeleted '${stashRef}'.`));
  } catch (err) {
    console.error(colors.red(`\nDrop failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "preva stash clear" (Destructive Guard)
 */
async function handleStashClear() {
  const stashes = await getStashes();
  if (stashes.length === 0) {
    console.log(colors.dim('\nNo stashes to clear.\n'));
    return;
  }

  console.log(`\n${colors.bold('Clear Preview:')} ${colors.red(`PERMANENTLY DELETE ALL ${stashes.length} STASHES`)}`);
  console.log(colors.yellow('----------------------------------------------------------------------'));
  console.log(colors.red(`WARNING: This will PERMANENTLY ERASE all ${stashes.length} saved stashes forever:`));
  stashes.forEach((s) => {
    console.log(`  • ${colors.red(s.ref)} (${s.date}): ${s.message}`);
  });
  console.log(colors.yellow('----------------------------------------------------------------------\n'));

  const proceed = await confirmPrompt({
    message: `PERMANENTLY delete ALL ${stashes.length} stashes?`,
    defaultValue: false,
  });

  if (!proceed) {
    console.log(colors.dim('\nClear cancelled. All stashes were preserved.'));
    process.exit(130);
  }

  try {
    await runGitStash(['clear']);
    console.log(colors.green(`\nCleared all ${stashes.length} stashes.`));
  } catch (err) {
    console.error(colors.red(`\nClear failed: ${err.message}`));
    process.exit(1);
  }
}
