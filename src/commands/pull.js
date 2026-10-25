import {
  isGitRepo,
  getCurrentBranch,
  getRemotes,
  runGitFetch,
  getIncomingCommits,
  getIncomingFiles,
  checkPullConflicts,
  runGitPull,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, truncateAnsi } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render pull preview with terminal column clamping.
 */
export function renderPullPreview(upstreamRef, behind, incomingCommits, incomingFiles, statusInfo, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`\n${colors.bold('Pull Preview:')} ${colors.cyan(`${behind} incoming commit(s)`)} from ${colors.cyan(upstreamRef)}`);
  line(colors.dim('----------------------------------------------------------------------'));

  line(`${colors.bold('Incoming Commits')} (${colors.cyan(behind)}):`);
  incomingCommits.slice(0, 10).forEach((c) => {
    const authorHint = c.author ? colors.dim(`(${c.author})`) : '';
    line(`  • ${colors.yellow(c.hash)} ${c.message} ${authorHint}`);
  });
  if (incomingCommits.length > 10) {
    line(colors.dim(`  ... and ${incomingCommits.length - 10} more commit(s)`));
  }

  if (incomingFiles.length > 0) {
    line(`\n${colors.bold('Incoming Changed Files')} (${colors.cyan(incomingFiles.length)}):`);
    incomingFiles.slice(0, 15).forEach((f) => {
      let badge = colors.cyan('M');
      if (f.status === 'new') badge = colors.green('A');
      else if (f.status === 'deleted') badge = colors.red('D');
      else if (f.status === 'renamed') badge = colors.yellow('R');
      line(`  • ${badge} ${f.path}`);
    });
    if (incomingFiles.length > 15) {
      line(colors.dim(`  ... and ${incomingFiles.length - 15} more file(s)`));
    }
  }

  line(colors.dim('----------------------------------------------------------------------'));

  if (statusInfo.ahead === 0) {
    line(colors.green('Status: Fast-forward possible (0 local unpushed commits).'));
  } else {
    line(
      colors.yellow(`Status: Diverged branch (${colors.bold(statusInfo.ahead)} local commit(s), ${colors.bold(behind)} incoming commit(s)).`)
    );
  }

  if (statusInfo.hasConflicts) {
    line(colors.red('\n----------------------------------------------------------------------'));
    line(colors.red('WARNING: Potential merge conflict detected!'));
    line('The following local uncommitted file(s) are modified in incoming commits:');
    statusInfo.conflictingFiles.forEach((p) => {
      line(`  • ${colors.red(p)} (modified locally and modified upstream)`);
    });
    line(colors.yellow('\nPulling now may overwrite your local edits or cause a merge conflict.'));
    line(colors.yellow('Recommendation: Stash your changes or commit them before pulling.'));
    line(colors.red('----------------------------------------------------------------------'));
  }

  return lines.join('\n');
}

export async function pullCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const currentBranch = await getCurrentBranch();
  if (!currentBranch || currentBranch === 'HEAD' || currentBranch.includes('detached')) {
    console.error(colors.yellow('Cannot pull in detached HEAD state. Switch to a branch first.'));
    process.exit(1);
  }

  // Parse remote and branch if provided as non-flag arguments
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  const targetRemote = nonFlagArgs[0] || 'origin';
  const targetBranch = nonFlagArgs[1] || '';

  const remotes = await getRemotes();
  const remoteNames = remotes.map((r) => (typeof r === 'string' ? r : r.name));
  if (remoteNames.length === 0) {
    console.error(
      colors.yellow('No remote repository configured. Add a remote first using: git remote add origin <url>')
    );
    process.exit(1);
  }

  if (targetRemote && !remoteNames.includes(targetRemote)) {
    console.error(colors.red(`Error: Remote '${targetRemote}' does not exist.`));
    process.exit(1);
  }

  // 1. Silent, safe read-only fetch
  const fetchTarget = targetBranch ? `${targetRemote}/${targetBranch}` : targetRemote;
  process.stdout.write(colors.dim(`Fetching ${fetchTarget}...\n`));

  try {
    await runGitFetch(targetRemote, targetBranch);
  } catch (err) {
    console.error(
      colors.red(`\nFetch failed: ${err.message || 'Could not reach remote repository.'}`)
    );
    console.error(colors.dim('Check your internet connection, credentials, or remote URL.\n'));
    process.exit(1);
  }

  // 2. Query incoming commits and status
  const { ahead, behind, upstreamRef, incomingCommits } = await getIncomingCommits(
    process.cwd(),
    targetRemote,
    targetBranch
  );

  if (!upstreamRef) {
    console.log(
      colors.yellow(
        `\nCurrent branch '${currentBranch}' has no tracking branch on remote '${targetRemote}'.`
      )
    );
    console.log(`To push and set upstream: ${colors.cyan(`preva git push -u ${targetRemote} ${currentBranch}`)}\n`);
    return;
  }

  // 3. Up to date check
  if (behind === 0) {
    console.log(
      `\n${colors.green('✔')} Current branch '${colors.cyan(currentBranch)}' is up to date with '${colors.cyan(upstreamRef)}'.`
    );
    if (ahead > 0) {
      console.log(
        colors.dim(`You have ${ahead} unpushed local commit(s). Run "${colors.cyan('preva git push')}" to publish them.\n`)
      );
    } else {
      console.log(colors.dim('No incoming commits.\n'));
    }
    return;
  }

  // 4. Query incoming changed files
  const incomingFiles = await getIncomingFiles(process.cwd(), upstreamRef);

  // 5. Pre-merge conflict check with local uncommitted files
  const { hasConflicts, conflictingFiles } = await checkPullConflicts(incomingFiles);

  // 6. Print Preview
  console.log(
    renderPullPreview(upstreamRef, behind, incomingCommits, incomingFiles, {
      ahead,
      hasConflicts,
      conflictingFiles,
    })
  );
  console.log('');

  // 7. Execution: Direct flags or Interactive Strategy Menu
  const hasRebaseFlag = args.includes('--rebase');
  const hasNoRebaseFlag = args.includes('--no-rebase');
  const hasFfOnlyFlag = args.includes('--ff-only');
  const hasExplicitStrategy = hasRebaseFlag || hasNoRebaseFlag || hasFfOnlyFlag;

  if (hasExplicitStrategy) {
    let flagName = 'pull';
    if (hasRebaseFlag) flagName = 'pull --rebase';
    else if (hasNoRebaseFlag) flagName = 'pull --no-rebase';
    else if (hasFfOnlyFlag) flagName = 'pull --ff-only';

    const proceed = await confirmPrompt({
      message: `Confirm ${flagName} from '${upstreamRef}'?`,
      defaultValue: !hasConflicts,
    });

    if (!proceed) {
      console.log(colors.dim('\nPull cancelled. Local working files were not modified.'));
      process.exit(130);
    }

    await executePull(args);
    return;
  }

  // If there are conflicts, prompt user first before showing menu
  if (hasConflicts) {
    const proceed = await confirmPrompt({
      message: 'Pull anyway despite potential file conflicts?',
      defaultValue: false,
    });

    if (!proceed) {
      console.log(colors.dim('\nPull cancelled. Local working files were not modified.'));
      process.exit(130);
    }
  }

  // Interactive Strategy Menu
  const menuChoices = [];

  if (ahead === 0) {
    menuChoices.push({
      value: 'ff',
      name: 'Fast-forward pull  (git pull --ff-only)',
      description: 'Fast-forward to incoming commits',
    });
    menuChoices.push({
      value: 'rebase',
      name: 'Rebase pull        (git pull --rebase)',
      description: 'Replay local commits on top',
    });
    menuChoices.push({
      value: 'merge',
      name: 'Merge commit       (git pull --no-rebase)',
      description: 'Create standard merge commit',
    });
  } else {
    menuChoices.push({
      value: 'rebase',
      name: 'Rebase pull        (git pull --rebase)',
      description: `Replay your ${ahead} commit(s) on top (clean history)`,
    });
    menuChoices.push({
      value: 'merge',
      name: 'Merge commit       (git pull --no-rebase)',
      description: 'Create a standard merge commit',
    });
    menuChoices.push({
      value: 'ff',
      name: 'Fast-forward only  (git pull --ff-only)',
      description: 'Abort if branch has diverged',
    });
  }

  const choice = await selectPrompt({
    message: 'Select pull action:',
    choices: menuChoices,
  });

  const pullArgs = [...args];
  if (choice === 'rebase') {
    pullArgs.push('--rebase');
  } else if (choice === 'merge') {
    pullArgs.push('--no-rebase');
  } else if (choice === 'ff') {
    pullArgs.push('--ff-only');
  }

  await executePull(pullArgs);
}

/**
 * Execute native git pull and output result.
 */
async function executePull(args) {
  try {
    const { stdout, stderr } = await runGitPull(args);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(colors.dim(stderr.trim()));
    console.log(`\n${colors.green('Pull complete.')}`);
  } catch (err) {
    console.error(colors.red(`\nPull failed: ${err.message}`));
    process.exit(1);
  }
}
