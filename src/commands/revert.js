import {
  isGitRepo,
  getCurrentBranch,
  getCommitDetails,
  getCommitPatch,
  isRevertInProgress,
  getRevertProgress,
  getCommitParents,
  checkRevertConflicts,
  getCommitHistory,
  runGitRevert,
  runGitRevertAbort,
  runGitRevertContinue,
  runGitRevertSkip,
  runGitStash,
  runGit,
} from '../utils/git.js';
import { formatDiffSnippet } from './diff.js';
import { selectPrompt, confirmPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render revert preview with commit details, inverse changes, conflict check, and native command.
 */
export function renderRevertPreview(details, conflictInfo, parentInfo, currentBranch, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('preva revert')} - ${colors.cyan('Safety Preview')}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Target Commit:')}  ${colors.yellow(details.hash)} ${colors.bold(details.subject)}`);
  line(`  ${colors.bold('Author:')}         ${colors.cyan(details.author)} ${colors.dim(`<${details.email}>`)}`);
  line(`  ${colors.bold('Date:')}           ${details.date} ${colors.dim(`(${details.relativeDate})`)}`);
  line(`  ${colors.bold('Target Branch:')}  ${colors.green(currentBranch || 'HEAD')}`);

  if (parentInfo && parentInfo.isMerge) {
    const parentHashes = parentInfo.parents.map((p) => p.slice(0, 7)).join(', ');
    line(`  ${colors.bold('Commit Type:')}    ${colors.yellow('Merge Commit')} ${colors.dim(`(parents: ${parentHashes})`)}`);
    line(`                    ${colors.cyan('Mainline (-m) will be applied to keep specified parent.')}`);
  }

  // Changed files to invert
  const files = details.files || [];
  line(`\n  ${colors.bold('Files to Invert')} (${colors.cyan(files.length)} file(s)):`);
  if (files.length === 0) {
    line(colors.dim('    No file modifications recorded in commit.'));
  } else {
    files.forEach((f) => {
      let badge = colors.yellow('[M]');
      if (f.status === 'new') badge = colors.red('[D]'); // reverting addition means removing
      else if (f.status === 'deleted') badge = colors.green('[A]'); // reverting deletion means adding back
      else if (f.status === 'renamed') badge = colors.yellow('[R]');

      const stat = f.isBinary ? colors.dim('[binary]') : `+${colors.green(f.deletions)} / -${colors.red(f.additions)}`;
      line(`    ${badge} ${f.path.padEnd(36)} (revert: ${stat})`);
    });
  }

  // Conflict pre-check
  line(`\n  ${colors.bold('Conflict Pre-Check:')}`);
  if (!conflictInfo.hasConflicts) {
    line(`    ${colors.green('[OK]')} No subsequent overlapping changes detected.`);
  } else {
    line(`    ${colors.red('[!]')} Potential merge conflict in ${colors.bold(conflictInfo.conflictingFiles.length)} file(s):`);
    conflictInfo.conflictingFiles.forEach((cf) => {
      line(`      ${colors.red('*')} ${cf}`);
    });
    line(colors.dim('        These files were modified after the target commit or have uncommitted local edits.'));
  }

  // Working tree status
  line(`\n  ${colors.bold('Working Directory:')}`);
  if (!conflictInfo.isDirty) {
    line(`    ${colors.green('[OK]')} Clean working tree ready for revert.`);
  } else {
    line(`    ${colors.yellow('[!]')} Uncommitted changes detected in working tree.`);
    line(colors.dim('        Git requires a clean worktree. Preva can auto-stash before reverting.'));
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render in-progress revert status banner.
 */
export function renderRevertInProgress(progress, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bgRed(colors.white(' REVERT IN PROGRESS '))} - Commit ${colors.yellow(progress.hash)}`);
  line(colors.dim('----------------------------------------------------------------------'));

  if (progress.details) {
    line(`  ${colors.bold('Subject:')}  ${progress.details.subject}`);
    line(`  ${colors.bold('Author:')}   ${progress.details.author} (${progress.details.relativeDate})`);
  }

  line(`\n  ${colors.bold('Conflict Status:')}`);
  if (progress.hasConflicts) {
    line(`    ${colors.red('[!]')} ${progress.conflictingFiles.length} file(s) currently unmerged:`);
    progress.conflictingFiles.forEach((cf) => {
      line(`      ${colors.red('*')} ${cf}`);
    });
    line(`\n  ${colors.bold('Resolution Steps:')}`);
    line(`    1. Resolve conflict markers in listed files.`);
    line(`    2. Stage resolved files with ${colors.cyan('preva git add <file>')}.`);
    line(`    3. Run ${colors.cyan('preva git revert --continue')}.`);
  } else {
    line(`    ${colors.green('[OK]')} All conflicts resolved and staged. Ready to continue.`);
  }

  line(`\n  ${colors.bold('Available Native Commands:')}`);
  line(`    ${colors.cyan('git revert --continue')}  (finish revert and commit)`);
  line(`    ${colors.cyan('git revert --skip')}      (skip current commit revert)`);
  line(`    ${colors.cyan('git revert --abort')}     (safely rewind to pre-revert state)`);

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva revert / preva git revert.
 */
export async function revertCommand(args = []) {
  if (!(await isGitRepo())) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // 1. Check for active in-progress revert (REVERT_HEAD)
  const progress = await getRevertProgress();
  if (progress.inProgress) {
    await handleActiveRevert(progress, args);
    return;
  }

  // 2. Parse CLI flags
  let noCommit = false;
  let edit = null;
  let mainline = null;
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--continue') {
      console.log(colors.yellow('No revert in progress to continue.'));
      return;
    } else if (a === '--abort') {
      console.log(colors.yellow('No revert in progress to abort.'));
      return;
    } else if (a === '--skip') {
      console.log(colors.yellow('No revert in progress to skip.'));
      return;
    } else if (a === '-n' || a === '--no-commit') {
      noCommit = true;
    } else if (a === '-e' || a === '--edit') {
      edit = true;
    } else if (a === '--no-edit') {
      edit = false;
    } else if (a === '-m' || a === '--mainline') {
      mainline = args[i + 1] || '1';
      i++;
    } else if (a.startsWith('-m=')) {
      mainline = a.split('=')[1] || '1';
    } else if (a.startsWith('--mainline=')) {
      mainline = a.split('=')[1] || '1';
    } else if (!a.startsWith('-')) {
      positionals.push(a);
    }
  }

  // 3. Resolve target commit
  let targetRef = positionals[0] || null;

  if (!targetRef) {
    if (!isInteractive()) {
      console.error(
        colors.red('Error: Commit reference required for revert (e.g. "preva git revert <commit>").')
      );
      process.exit(1);
    }

    const selectedCommit = await selectCommitToRevert();
    if (!selectedCommit) {
      console.log(colors.yellow('Revert cancelled.'));
      return;
    }
    targetRef = selectedCommit;
  }

  // 4. Fetch details, parent info, and branch
  const [details, parentInfo, currentBranch] = await Promise.all([
    getCommitDetails(targetRef),
    getCommitParents(targetRef),
    getCurrentBranch(),
  ]);

  if (!details) {
    console.error(colors.red(`Error: Could not resolve commit "${targetRef}".`));
    process.exit(1);
  }

  // 5. Handle merge commits
  if (parentInfo.isMerge && !mainline) {
    if (!isInteractive()) {
      console.error(
        colors.red(
          `Error: Commit "${targetRef}" is a merge commit (${parentInfo.parentCount} parents). Specify mainline parent with -m 1 or -m 2.`
        )
      );
      process.exit(1);
    }

    console.log(
      colors.yellow(
        `\n[!] Commit "${details.hash}" is a merge commit with ${parentInfo.parentCount} parents.`
      )
    );
    const parentChoices = parentInfo.parents.map((p, idx) => ({
      value: String(idx + 1),
      name: `Parent ${idx + 1}: ${p.slice(0, 7)}  (keep this branch as mainline)`,
      description: `Reverts changes introduced by other parent branches relative to parent #${idx + 1}`,
    }));

    const chosenParent = await selectPrompt({
      message: 'Select mainline parent to retain:',
      choices: parentChoices,
    });

    if (!chosenParent) {
      console.log(colors.yellow('Revert cancelled.'));
      return;
    }
    mainline = chosenParent;
  }

  // 6. Pre-check conflicts and workspace
  const conflictInfo = await checkRevertConflicts(details.hash);

  // 7. Render pre-flight safety preview
  console.log(renderRevertPreview(details, conflictInfo, parentInfo, currentBranch));

  // 8. Interactive confirmation & execution mode selection
  if (isInteractive()) {
    const defaultRevertCmd = `git revert ${mainline ? `-m ${mainline} ` : ''}${details.hash}`;
    const noCommitCmd = `git revert -n ${mainline ? `-m ${mainline} ` : ''}${details.hash}`;
    const editCmd = `git revert -e ${mainline ? `-m ${mainline} ` : ''}${details.hash}`;

    const action = await selectPrompt({
      message: 'Choose revert action:',
      choices: [
        {
          value: 'revert',
          name: `Standard Revert          (${defaultRevertCmd})`,
          description: 'Creates a new commit inverting the changes',
        },
        {
          value: 'no-commit',
          name: `Revert into Working Tree (${noCommitCmd})`,
          description: 'Inverts changes in staging/working tree without creating commit',
        },
        {
          value: 'edit',
          name: `Edit Commit Message      (${editCmd})`,
          description: 'Opens editor to customize revert commit message',
        },
        {
          value: 'patch',
          name: 'Preview Diff Patch       (inspect exact lines being inverted)',
          description: 'View full diff patch before reverting',
        },
        {
          value: 'cancel',
          name: 'Cancel                   (abort without changes)',
          description: 'Exit without modifying repository',
        },
      ],
    });

    if (!action || action === 'cancel') {
      console.log(colors.yellow('Revert cancelled.'));
      return;
    }

    if (action === 'patch') {
      const patch = await getCommitPatch(details.hash);
      if (!patch) {
        console.log(colors.dim('No patch available for this commit.'));
      } else {
        console.log(`\n${colors.bold('Commit Patch (to be inverted):')}\n`);
        console.log(formatDiffSnippet(patch));
      }

      const proceed = await confirmPrompt({
        message: 'Proceed with revert after reviewing patch?',
        defaultValue: true,
      });
      if (!proceed) {
        console.log(colors.yellow('Revert cancelled.'));
        return;
      }
    } else if (action === 'no-commit') {
      noCommit = true;
    } else if (action === 'edit') {
      edit = true;
    }
  }

  // 9. Auto-stash safeguard if working tree is dirty
  let stashed = false;
  if (conflictInfo.isDirty) {
    if (isInteractive()) {
      const doStash = await confirmPrompt({
        message: 'Working tree is dirty. Auto-stash changes before reverting?',
        defaultValue: true,
      });
      if (!doStash) {
        console.log(colors.yellow('Revert cancelled due to uncommitted working tree changes.'));
        return;
      }
    }
    try {
      console.log(colors.cyan('Stashing working tree changes...'));
      await runGitStash(['push', '-m', 'preva-auto-stash-before-revert']);
      stashed = true;
    } catch (err) {
      console.error(colors.red(`Failed to stash changes: ${err.message}`));
      return;
    }
  }

  // 10. Assemble native git revert arguments
  const cmdArgs = [];
  if (noCommit) cmdArgs.push('-n');
  if (edit === true) cmdArgs.push('-e');
  if (edit === false) cmdArgs.push('--no-edit');
  if (mainline) cmdArgs.push('-m', String(mainline));
  cmdArgs.push(details.hash);

  console.log(`\n${colors.cyan(`Executing: git revert ${cmdArgs.join(' ')}...`)}`);

  try {
    const { stdout, stderr } = await runGitRevert(cmdArgs);
    if (stdout.trim()) console.log(colors.dim(stdout.trim()));
    if (stderr.trim()) console.log(colors.dim(stderr.trim()));

    if (noCommit) {
      console.log(
        `\n${colors.green('✔ Successfully inverted changes into working tree without committing!')}`
      );
      console.log(
        colors.dim(`Review inverted changes with ${colors.cyan('preva git diff')} or commit with ${colors.cyan('preva git commit')}.`)
      );
    } else {
      console.log(
        `\n${colors.green('✔ Successfully reverted commit')} ${colors.yellow(details.hash)}: ${colors.bold(details.subject)}`
      );
    }

    // Restore auto-stash if created
    if (stashed) {
      try {
        console.log(colors.cyan('\nRestoring auto-stashed changes...'));
        await runGitStash(['pop']);
        console.log(colors.green('✔ Auto-stash restored cleanly.'));
      } catch (popErr) {
        console.warn(
          colors.yellow(
            `\n[!] Note: Revert succeeded, but restoring auto-stashed changes had conflicts:\n${popErr.message}\nYour stash remains saved in "git stash list".`
          )
        );
      }
    }
  } catch (err) {
    console.error(colors.red(`\nRevert halted: ${err.message}`));

    // Check if revert stopped with active conflicts
    const paused = await getRevertProgress();
    if (paused.inProgress) {
      console.log('\n' + renderRevertInProgress(paused));
    }

    if (stashed) {
      console.log(
        colors.yellow(
          '\n[!] Your local uncommitted edits remain safely stashed ("preva-auto-stash-before-revert").'
        )
      );
    }
    process.exit(1);
  }
}

/**
 * Handle an active paused revert (REVERT_HEAD).
 */
async function handleActiveRevert(progress, args = []) {
  if (args.includes('--abort')) {
    try {
      console.log(colors.cyan('Executing git revert --abort...'));
      await runGitRevertAbort();
      console.log(colors.green('✔ Revert safely aborted. Working tree restored to pre-revert state.'));
      return;
    } catch (err) {
      console.error(colors.red(`Failed to abort revert: ${err.message}`));
      process.exit(1);
    }
  }

  if (args.includes('--continue')) {
    try {
      console.log(colors.cyan('Executing git revert --continue...'));
      await runGitRevertContinue();
      console.log(colors.green('✔ Revert completed successfully!'));
      return;
    } catch (err) {
      console.error(colors.red(`Failed to continue revert: ${err.message}`));
      process.exit(1);
    }
  }

  if (args.includes('--skip')) {
    try {
      console.log(colors.cyan('Executing git revert --skip...'));
      await runGitRevertSkip();
      console.log(colors.green('✔ Revert commit skipped.'));
      return;
    } catch (err) {
      console.error(colors.red(`Failed to skip revert: ${err.message}`));
      process.exit(1);
    }
  }

  // Display status
  console.log(renderRevertInProgress(progress));

  if (!isInteractive()) {
    console.log(
      colors.yellow(
        'A git revert is currently in progress. Resolve conflicts or run with --continue, --abort, or --skip.'
      )
    );
    return;
  }

  const choices = [];
  if (!progress.hasConflicts) {
    choices.push({
      value: 'continue',
      name: 'Continue Revert (git revert --continue - finalize commit)',
      description: 'Records the revert commit and completes operation',
    });
  } else {
    choices.push({
      value: 'inspect',
      name: 'Inspect Conflicts (view unmerged files and conflict markers)',
      description: 'Examines unmerged files needing manual resolution',
    });
  }

  choices.push(
    {
      value: 'skip',
      name: 'Skip This Commit (git revert --skip)',
      description: 'Discards this revert step and advances',
    },
    {
      value: 'abort',
      name: 'Abort Revert    (git revert --abort - safe rewind to pre-revert state)',
      description: 'Rolls back working tree cleanly',
    },
    {
      value: 'exit',
      name: 'Exit to resolve manually in editor',
      description: 'Keep state intact while resolving files',
    }
  );

  const action = await selectPrompt({
    message: 'Active revert recovery action:',
    choices,
  });

  if (action === 'abort') {
    try {
      console.log(colors.cyan('Executing git revert --abort...'));
      await runGitRevertAbort();
      console.log(colors.green('✔ Revert safely aborted.'));
    } catch (err) {
      console.error(colors.red(`Failed to abort revert: ${err.message}`));
    }
  } else if (action === 'continue') {
    try {
      console.log(colors.cyan('Executing git revert --continue...'));
      await runGitRevertContinue();
      console.log(colors.green('✔ Revert completed successfully!'));
    } catch (err) {
      console.error(colors.red(`Failed to continue revert: ${err.message}`));
    }
  } else if (action === 'skip') {
    try {
      console.log(colors.cyan('Executing git revert --skip...'));
      await runGitRevertSkip();
      console.log(colors.green('✔ Revert commit skipped.'));
    } catch (err) {
      console.error(colors.red(`Failed to skip revert: ${err.message}`));
    }
  } else if (action === 'inspect') {
    console.log(`\n${colors.bold('Unmerged Files Needing Resolution:')}`);
    progress.conflictingFiles.forEach((cf) => {
      console.log(`  ${colors.red('*')} ${cf}`);
    });
    console.log(
      `\nOpen files in your editor, search for <<<<<<< HEAD, resolve, and stage with ${colors.cyan('preva git add')}.`
    );
  }
}

/**
 * Interactive picker to select a commit to revert from recent history.
 */
async function selectCommitToRevert() {
  const commits = await getCommitHistory({ maxCount: 20 });
  if (commits.length === 0) {
    console.log(colors.yellow('No commit history found in repository.'));
    return null;
  }

  const choices = commits.map((c) => {
    const shortHash = c.hash.slice(0, 7);
    const relDate = (c.date || '').padEnd(12);
    const author = (c.author || '').padEnd(14);
    const subject = c.subject || '';
    return {
      value: c.hash,
      name: `${colors.yellow(shortHash)}  ${colors.dim(relDate)}  ${colors.cyan(author)}  ${subject}`,
      description: `${c.author} (${c.email}) - ${c.date}`,
    };
  });

  return selectPrompt({
    message: 'Select a commit to revert:',
    choices,
  });
}
