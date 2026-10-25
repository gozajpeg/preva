import {
  isGitRepo,
  getCurrentBranch,
  getLocalBranches,
  isMergeInProgress,
  isAncestor,
  getMergeCommits,
  getMergeFiles,
  checkMergeConflicts,
  runGitMerge,
  runGitMergeAbort,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, truncateAnsi } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render merge preview with terminal column clamping.
 */
export function renderMergePreview(targetBranch, currentBranch, commits, files, statusInfo, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`\n${colors.bold('Merge Preview:')} ${colors.yellow(targetBranch)} -> ${colors.green(currentBranch)}`);
  line(colors.dim('----------------------------------------------------------------------'));

  line(`${colors.bold('Incoming Commits')} (${colors.cyan(commits.length)}):`);
  commits.slice(0, 10).forEach((c) => {
    const authorHint = c.author ? colors.dim(`(${c.author})`) : '';
    line(`  • ${colors.yellow(c.hash)} ${c.message} ${authorHint}`);
  });
  if (commits.length > 10) {
    line(colors.dim(`  ... and ${commits.length - 10} more commit(s)`));
  }

  if (files.length > 0) {
    line(`\n${colors.bold('Changed Files')} (${colors.cyan(files.length)}):`);
    files.slice(0, 15).forEach((f) => {
      let badge = colors.cyan('M');
      if (f.status === 'new') badge = colors.green('A');
      else if (f.status === 'deleted') badge = colors.red('D');
      else if (f.status === 'renamed') badge = colors.yellow('R');
      line(`  • ${badge} ${f.path}`);
    });
    if (files.length > 15) {
      line(colors.dim(`  ... and ${files.length - 15} more file(s)`));
    }
  }

  line(colors.dim('----------------------------------------------------------------------'));

  if (statusInfo.canFastForward) {
    line(colors.green('Status: Fast-forward possible (clean pointer advance).'));
  } else {
    line(colors.yellow('Status: Diverged branches (standard merge commit will be created).'));
  }

  if (statusInfo.isDirty) {
    line(colors.yellow('Notice: You have uncommitted changes in your working tree.'));
  }

  if (statusInfo.hasConflicts) {
    line(colors.red('\n----------------------------------------------------------------------'));
    line(colors.red('WARNING: Potential merge conflict detected!'));
    line('Both branches modified the following file(s) since their common ancestor:');
    statusInfo.conflictingFiles.forEach((p) => {
      line(`  • ${colors.red(p)} (modified on both branches)`);
    });
    line(colors.yellow('\nMerging now may cause conflict markers (<<<<<<< / >>>>>>>).'));
    line(colors.red('----------------------------------------------------------------------'));
  }

  return lines.join('\n');
}

export async function mergeCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // Handle active merge in progress
  const inProgress = await isMergeInProgress();
  if (inProgress) {
    await handleMergeInProgress(args);
    return;
  }

  const currentBranch = await getCurrentBranch();
  if (!currentBranch || currentBranch === 'HEAD' || currentBranch.includes('detached')) {
    console.error(colors.yellow('Cannot merge in detached HEAD state. Switch to a branch first.'));
    process.exit(1);
  }

  // Parse target branch and flags
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  const flags = args.filter((a) => a.startsWith('-'));
  let targetBranch = nonFlagArgs[0] || null;

  const branches = await getLocalBranches();
  const otherBranches = branches.filter((b) => b.name !== currentBranch);

  if (!targetBranch) {
    if (otherBranches.length === 0) {
      console.log(colors.yellow(`\nNo other local branches to merge into '${currentBranch}'.\n`));
      return;
    }

    const choices = otherBranches.map((b) => ({
      value: b.name,
      name: b.name,
      description: `${b.hash} ${b.subject}`,
    }));

    targetBranch = await selectPrompt({
      message: `Select branch to merge into '${currentBranch}':`,
      choices,
    });
  }

  // 1. Check if target branch is already merged
  const alreadyMerged = await isAncestor(targetBranch, currentBranch);
  if (alreadyMerged) {
    console.log(
      `\n${colors.green('✔')} Branch '${colors.cyan(targetBranch)}' is already fully merged into '${colors.cyan(currentBranch)}'.`
    );
    console.log(colors.dim('Nothing to merge.\n'));
    return;
  }

  // 2. Analyze merge state
  const canFastForward = await isAncestor(currentBranch, targetBranch);
  const commits = await getMergeCommits(targetBranch, currentBranch);
  const files = await getMergeFiles(targetBranch, currentBranch);
  const { hasConflicts, conflictingFiles, isDirty } = await checkMergeConflicts(
    targetBranch,
    currentBranch
  );

  // 3. Render Preview
  console.log(
    renderMergePreview(targetBranch, currentBranch, commits, files, {
      canFastForward,
      isDirty,
      hasConflicts,
      conflictingFiles,
    })
  );

  // 4. Execution: Direct flags or Interactive Strategy Menu
  const hasSquash = flags.includes('--squash');
  const hasNoFf = flags.includes('--no-ff');
  const hasFfOnly = flags.includes('--ff-only');
  const hasExplicitStrategy = hasSquash || hasNoFf || hasFfOnly;

  if (hasExplicitStrategy) {
    let flagHint = 'merge';
    if (hasSquash) flagHint = 'merge --squash';
    else if (hasNoFf) flagHint = 'merge --no-ff';
    else if (hasFfOnly) flagHint = 'merge --ff-only';

    const proceed = await confirmPrompt({
      message: `Confirm ${flagHint} '${targetBranch}' into '${currentBranch}'?`,
      defaultValue: !hasConflicts && !isDirty,
    });

    if (!proceed) {
      console.log(colors.dim('\nMerge cancelled. Branch was not modified.'));
      process.exit(130);
    }

    await executeMerge([targetBranch, ...flags]);
    return;
  }

  // If there are conflicts or dirty tree, prompt user
  if (hasConflicts || isDirty) {
    const reason = hasConflicts ? 'potential file conflicts' : 'dirty working tree';
    const proceed = await confirmPrompt({
      message: `Proceed with merge despite ${reason}?`,
      defaultValue: false,
    });

    if (!proceed) {
      console.log(colors.dim('\nMerge cancelled. Branch was not modified.'));
      process.exit(130);
    }
  }

  // Interactive Strategy Menu
  const menuChoices = [];

  if (canFastForward) {
    menuChoices.push({
      value: 'ff',
      name: 'Fast-forward       (git merge --ff-only)',
      description: 'Advance branch pointer cleanly',
    });
    menuChoices.push({
      value: 'no-ff',
      name: 'Merge commit       (git merge --no-ff)',
      description: 'Force creation of a merge commit',
    });
    menuChoices.push({
      value: 'squash',
      name: 'Squash merge       (git merge --squash)',
      description: 'Combine all commits into one staged change',
    });
  } else {
    menuChoices.push({
      value: 'standard',
      name: 'Merge commit       (git merge)',
      description: 'Create standard merge commit',
    });
    menuChoices.push({
      value: 'squash',
      name: 'Squash merge       (git merge --squash)',
      description: 'Combine all commits into one staged change',
    });
  }

  const choice = await selectPrompt({
    message: 'Select merge strategy:',
    choices: menuChoices,
  });

  const mergeArgs = [targetBranch];
  if (choice === 'ff') mergeArgs.push('--ff-only');
  else if (choice === 'no-ff') mergeArgs.push('--no-ff');
  else if (choice === 'squash') mergeArgs.push('--squash');

  await executeMerge(mergeArgs);
}

/**
 * Handle merge in progress state (MERGE_HEAD).
 */
async function handleMergeInProgress(args) {
  const isAbort = args.includes('--abort');
  if (isAbort) {
    const proceed = await confirmPrompt({
      message: 'Abort active merge and restore previous state (git merge --abort)?',
      defaultValue: false,
    });
    if (!proceed) {
      console.log(colors.dim('\nMerge abort cancelled.'));
      process.exit(130);
    }
    await executeMergeAbort();
    return;
  }

  console.log(colors.yellow('\nNotice: A merge is currently in progress!'));
  console.log(colors.dim('You have an unresolved or uncommitted merge conflict in this repository.\n'));

  const choice = await selectPrompt({
    message: 'Select action for in-progress merge:',
    choices: [
      {
        value: 'abort',
        name: 'Abort merge      (git merge --abort)',
        description: 'Cancel merge and revert to pre-merge state',
      },
      {
        value: 'continue',
        name: 'Complete merge   (git commit)',
        description: 'Commit resolved files to finish merge',
      },
    ],
  });

  if (choice === 'abort') {
    await executeMergeAbort();
  } else {
    console.log(`\nRun "${colors.cyan('preva git commit')}" to complete the merge.`);
  }
}

/**
 * Execute native git merge and output result.
 */
async function executeMerge(args) {
  try {
    const { stdout, stderr } = await runGitMerge(args);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(colors.dim(stderr.trim()));
    console.log(`\n${colors.green('Merge complete.')}`);
  } catch (err) {
    console.error(colors.red(`\nMerge failed: ${err.message}`));
    console.log(colors.dim('To abort this merge at any time, run: preva git merge --abort\n'));
    process.exit(1);
  }
}

/**
 * Execute git merge --abort.
 */
async function executeMergeAbort() {
  try {
    await runGitMergeAbort();
    console.log(`\n${colors.green('Merge aborted.')} Reverted to pre-merge state.`);
  } catch (err) {
    console.error(colors.red(`\nFailed to abort merge: ${err.message}`));
    process.exit(1);
  }
}
