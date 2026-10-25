import {
  isGitRepo,
  getCurrentBranch,
  getLocalBranches,
  isAncestor,
  hasWorkingTreeChanges,
  isRebaseInProgress,
  getRebaseProgress,
  getRebaseCommits,
  getRebaseFiles,
  checkRebaseConflicts,
  runGitRebase,
  runGitRebaseAbort,
  runGitRebaseContinue,
  runGitRebaseSkip,
  runGitStash,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render the pre-rebase preview card with terminal column clamping.
 */
export function renderRebasePreview(targetBranch, currentBranch, commits, files, conflictInfo, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`\n${colors.bold('Rebase Preview:')} Rebase '${colors.cyan(currentBranch)}' onto '${colors.cyan(targetBranch)}'`);
  line(colors.dim('----------------------------------------------------------------------'));

  line(`\nCommits to replay in order (${colors.cyan(commits.length)}):`);
  commits.slice(0, 15).forEach((c, idx) => {
    line(`  ${idx + 1}. ${colors.yellow(c.hash)} ${c.message} ${colors.dim(`(${c.date} by ${c.author})`)}`);
  });
  if (commits.length > 15) {
    line(colors.dim(`  ... and ${commits.length - 15} more commit(s)`));
  }

  if (files.length > 0) {
    line(`\nFiles modified across these commits (${colors.cyan(files.length)}):`);
    files.slice(0, 10).forEach((f) => {
      let badge = colors.yellow('M');
      if (f.status === 'new') badge = colors.green('A');
      else if (f.status === 'deleted') badge = colors.red('D');
      line(`  • ${badge} ${f.path}`);
    });
    if (files.length > 10) {
      line(colors.dim(`  ... and ${files.length - 10} more file(s)`));
    }
  }

  if (conflictInfo && conflictInfo.hasConflicts) {
    line(colors.red('\n----------------------------------------------------------------------'));
    line(colors.red('WARNING: Potential rebase conflict detected!'));
    line(`The following file(s) were modified on '${targetBranch}' and in your local commits:`);
    conflictInfo.conflictingFiles.forEach((p) => {
      line(`  • ${colors.red(p)} (modified on both branches)`);
    });
    line(colors.yellow('Rebasing will likely pause on conflicts during commit replay.'));
    line(colors.red('----------------------------------------------------------------------\n'));
  }

  return lines.join('\n');
}

/**
 * Format and render active rebase recovery dashboard banner with terminal column clamping.
 */
export function renderRebaseInProgress(progress, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`\n${colors.bold('preva rebase')} - ${colors.bgRed(colors.white(' ⚠️ REBASE IN PROGRESS '))}\n`);
  if (progress.step && progress.total) {
    line(`Progress: ${colors.bold(`Step ${progress.step} of ${progress.total}`)}`);
  }
  if (progress.onto) {
    line(`Onto:     ${colors.cyan(progress.onto)}`);
  }
  if (progress.headName) {
    line(`Branch:   ${colors.cyan(progress.headName)}`);
  }

  line(colors.dim('----------------------------------------------------------------------'));

  if (progress.hasConflicts) {
    line(colors.red(`\nUnresolved Conflicts (${progress.conflictingFiles.length} file(s)):`));
    progress.conflictingFiles.forEach((f) => {
      line(`  • ${colors.red(f)} (unmerged conflict markers)`);
    });
    line(colors.yellow('\nTo resolve: edit conflict markers in files, stage them with "preva add", then continue.\n'));
  } else {
    line(colors.green('\nAll conflicts resolved and staged. Ready to continue rebase.\n'));
  }

  return lines.join('\n');
}

/**
 * Main entry point for preva rebase / preva git rebase.
 */
export async function rebaseCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // 1. Check if rebase flags like --abort, --continue, --skip were passed directly
  if (args.includes('--abort')) {
    await handleRebaseAbort();
    return;
  }
  if (args.includes('--continue')) {
    await handleRebaseContinue();
    return;
  }
  if (args.includes('--skip')) {
    await handleRebaseSkip();
    return;
  }

  // 2. Check if a rebase is already in progress
  const inProgress = await isRebaseInProgress();
  if (inProgress) {
    await handleRebaseInProgressMenu();
    return;
  }

  // 3. Handle interactive rebase flag (-i or --interactive)
  const isInteractiveFlag = args.includes('-i') || args.includes('--interactive');
  if (isInteractiveFlag) {
    const targetRef = args.find((a) => a !== '-i' && a !== '--interactive') || 'HEAD~3';
    await handleInteractiveRebase(targetRef);
    return;
  }

  // 4. Target upstream branch from args
  const filteredArgs = args.filter((a) => !a.startsWith('-'));
  let targetBranch = filteredArgs[0] || null;

  const currentBranch = await getCurrentBranch();
  if (!currentBranch || currentBranch === 'HEAD' || currentBranch.includes('detached')) {
    console.error(colors.yellow('Cannot rebase in detached HEAD state. Switch to a branch first.'));
    process.exit(1);
  }

  if (!targetBranch) {
    if (!isInteractive()) {
      console.error(colors.red('Error: Target branch required for rebase (e.g. "preva git rebase main").'));
      process.exit(1);
    }

    targetBranch = await pickRebaseTargetMenu(currentBranch);
    if (!targetBranch) return;

    if (targetBranch === '__interactive__') {
      await handleInteractiveRebase('HEAD~3');
      return;
    }
  }

  await previewAndRunRebase(targetBranch, currentBranch, args.filter((a) => a !== targetBranch));
}

/**
 * Interactive menu to pick a target branch for rebase.
 */
async function pickRebaseTargetMenu(currentBranch) {
  const branches = await getLocalBranches();
  const otherBranches = branches.filter((b) => !b.isCurrent && b.name !== currentBranch);

  console.log(`\n${colors.bold('preva rebase')} - Git Rebase Safety Guard\n`);

  if (otherBranches.length === 0) {
    console.log(colors.yellow('No other local branches found to rebase onto.'));
    return null;
  }

  const choices = otherBranches.map((b) => ({
    value: b.name,
    name: `Rebase onto ${b.name.padEnd(18)} (${b.date})`,
    description: b.subject || `Replay local commits on top of ${b.name}`,
  }));

  choices.push({
    value: '__interactive__',
    name: 'Interactive rebase      (git rebase -i HEAD~N)',
    description: 'Squash, edit, reword, or reorder recent commits',
  });

  choices.push({
    value: '__cancel__',
    name: 'Cancel                  (exit)',
    description: 'Exit without rebasing',
  });

  const selected = await selectPrompt({
    message: `Select upstream branch to rebase '${currentBranch}' onto:`,
    choices,
  });

  return selected === '__cancel__' ? null : selected;
}

/**
 * Preview commits, files, and conflict risks before executing git rebase.
 */
async function previewAndRunRebase(targetBranch, currentBranch, extraArgs = []) {
  // 1. Ancestry checks
  const isTargetAncestor = await isAncestor(targetBranch, currentBranch);
  if (isTargetAncestor) {
    console.log(colors.green(`\nAlready up to date. '${currentBranch}' already contains all commits from '${targetBranch}'.\n`));
    const force = await confirmPrompt({
      message: 'Rebase anyway (git rebase -f)?',
      defaultValue: false,
    });
    if (!force) return;
  }

  // 2. Incoming commits being replayed
  const commits = await getRebaseCommits(targetBranch, currentBranch);
  if (commits.length === 0) {
    console.log(colors.yellow(`\nNo unique commits on '${currentBranch}' relative to '${targetBranch}'. Nothing to replay.\n`));
    return;
  }

  // 3. Files modified in rebase range
  const files = await getRebaseFiles(targetBranch, currentBranch);

  // 4. Pre-check potential conflicts
  const conflictInfo = await checkRebaseConflicts(targetBranch, currentBranch);
  const { hasConflicts, isDirty } = conflictInfo;

  console.log(renderRebasePreview(targetBranch, currentBranch, commits, files, conflictInfo));

  // 5. Check dirty working tree
  let autoStashed = false;
  if (isDirty) {
    console.log(colors.yellow('\nWarning: Your working tree has uncommitted modifications.'));
    console.log(colors.dim('Git rebase requires a clean working tree.'));

    const stashChoice = await confirmPrompt({
      message: 'Auto-stash uncommitted changes before rebasing?',
      defaultValue: true,
    });

    if (!stashChoice) {
      console.log(colors.dim('\nRebase cancelled to protect uncommitted changes.\n'));
      return;
    }

    try {
      await runGitStash(['push', '-m', `preva-auto-stash-before-rebase-${Date.now()}`]);
      autoStashed = true;
      console.log(colors.green('Uncommitted changes safely stashed.'));
    } catch (err) {
      console.error(colors.red(`Failed to stash changes: ${err.message}`));
      return;
    }
  }

  // 6. Execution confirmation
  const cmdStr = `git rebase ${extraArgs.join(' ')} ${targetBranch}`.replace(/\s+/g, ' ');
  console.log(`\nNative command: ${colors.cyan(cmdStr)}`);

  const proceed = await confirmPrompt({
    message: `Proceed with rebase onto '${targetBranch}'?`,
    defaultValue: !hasConflicts,
  });

  if (!proceed) {
    if (autoStashed) {
      try {
        await runGitStash(['pop']);
        console.log(colors.dim('Restored auto-stashed changes.'));
      } catch {}
    }
    console.log(colors.dim('\nRebase cancelled.\n'));
    return;
  }

  // 7. Run native git rebase
  console.log(`\nRebasing '${currentBranch}' onto '${targetBranch}'...`);
  try {
    const { stdout, stderr } = await runGitRebase([...extraArgs, targetBranch]);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
    console.log(colors.green(`\nSuccessfully rebased '${currentBranch}' onto '${targetBranch}'.`));

    if (autoStashed) {
      try {
        await runGitStash(['pop']);
        console.log(colors.green('Restored your stashed changes into working tree.'));
      } catch {
        console.log(colors.yellow('Note: Stashed changes could not be auto-restored cleanly. Run "preva git stash pop" to apply.'));
      }
    }
  } catch (err) {
    console.error(colors.red(`\nRebase paused with conflicts or errors: ${err.message}`));
    console.log(colors.yellow('\nLaunching Active Rebase Recovery Helper...\n'));
    await handleRebaseInProgressMenu();
  }
}

/**
 * Active Rebase Recovery Dashboard when a rebase is currently paused on conflicts.
 */
export async function handleRebaseInProgressMenu() {
  const progress = await getRebaseProgress();
  if (!progress.inProgress) {
    console.log(colors.dim('\nNo rebase currently in progress.\n'));
    return;
  }

  console.log(renderRebaseInProgress(progress));

  if (!isInteractive()) {
    console.log('Run "git rebase --continue", "git rebase --skip", or "git rebase --abort".');
    return;
  }

  const choices = [
    {
      value: 'continue',
      name: 'Continue rebase          (git rebase --continue)',
      description: 'Proceed to next commit after staging resolved files',
    },
    {
      value: 'skip',
      name: 'Skip this commit         (git rebase --skip)',
      description: 'Discard current commit patch and advance to next commit',
    },
    {
      value: 'abort',
      name: 'Abort rebase             (git rebase --abort)',
      description: '100% safe: rewind to state before rebase started',
    },
    {
      value: 'exit',
      name: 'Exit                     (done)',
      description: 'Leave rebase in-progress to inspect manually',
    },
  ];

  const action = await selectPrompt({
    message: 'Select rebase recovery action:',
    choices,
  });

  if (action === 'continue') {
    await handleRebaseContinue();
  } else if (action === 'skip') {
    await handleRebaseSkip();
  } else if (action === 'abort') {
    await handleRebaseAbort();
  }
}

/**
 * Handle "git rebase --continue"
 */
async function handleRebaseContinue() {
  try {
    const { stdout, stderr } = await runGitRebaseContinue();
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    if (stderr.trim()) console.log(stderr.trim());
    console.log(colors.green('\nRebase continued.'));
  } catch (err) {
    console.error(colors.red(`\nCannot continue rebase: ${err.message}`));
    console.log(colors.yellow('Ensure all conflicting files are staged with "preva add" before continuing.\n'));
  }
}

/**
 * Handle "git rebase --skip"
 */
async function handleRebaseSkip() {
  const confirm = await confirmPrompt({
    message: 'Skip current commit patch? Any unique changes in this commit will be dropped!',
    defaultValue: false,
  });

  if (!confirm) {
    console.log(colors.dim('\nSkip cancelled.\n'));
    return;
  }

  try {
    const { stdout, stderr } = await runGitRebaseSkip();
    if (stdout.trim()) console.log(`\n${stdout.trim()}`);
    if (stderr.trim()) console.log(stderr.trim());
    console.log(colors.green('\nSkipped commit and advanced rebase.'));
  } catch (err) {
    console.error(colors.red(`\nFailed to skip commit: ${err.message}`));
  }
}

/**
 * Handle "git rebase --abort"
 */
async function handleRebaseAbort() {
  const confirm = await confirmPrompt({
    message: 'Abort rebase and safely return to original branch state?',
    defaultValue: true,
  });

  if (!confirm) {
    console.log(colors.dim('\nAbort cancelled.\n'));
    return;
  }

  try {
    await runGitRebaseAbort();
    console.log(colors.green('\nRebase successfully aborted. Repository returned to original state.'));
  } catch (err) {
    console.error(colors.red(`\nFailed to abort rebase: ${err.message}`));
  }
}

/**
 * Handle interactive rebase preview & guidance (git rebase -i).
 */
async function handleInteractiveRebase(targetRef = 'HEAD~3') {
  console.log(`\n${colors.bold('Interactive Rebase Guide:')} ${colors.cyan(`git rebase -i ${targetRef}`)}`);
  console.log(colors.dim('----------------------------------------------------------------------'));
  console.log(`${colors.bold('Commands available in the interactive editor:')}`);
  console.log(`  ${colors.green('pick')}   = use commit as-is`);
  console.log(`  ${colors.yellow('reword')} = use commit, but edit commit message`);
  console.log(`  ${colors.cyan('edit')}   = pause to amend commit content`);
  console.log(`  ${colors.magenta('squash')} = melt commit into previous commit`);
  console.log(`  ${colors.blue('fixup')}  = melt commit into previous commit discarding message`);
  console.log(`  ${colors.red('drop')}   = delete commit from history`);
  console.log(colors.dim('----------------------------------------------------------------------\n'));

  const proceed = await confirmPrompt({
    message: `Launch interactive rebase editor (${targetRef})?`,
    defaultValue: true,
  });

  if (!proceed) {
    console.log(colors.dim('\nInteractive rebase cancelled.\n'));
    return;
  }

  try {
    await runGitRebase(['-i', targetRef]);
  } catch (err) {
    if (await isRebaseInProgress()) {
      await handleRebaseInProgressMenu();
    } else {
      console.error(colors.red(`\nInteractive rebase exited: ${err.message}`));
    }
  }
}
