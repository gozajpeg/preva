import {
  isGitRepo,
  getCurrentBranch,
  getLocalBranches,
  getCommitDetails,
  getCommitPatch,
  isCherryPickInProgress,
  getCherryPickProgress,
  checkCherryPickConflicts,
  getRecentCommitsOtherBranches,
  getCommitHistory,
  runGitCherryPick,
  runGitCherryPickAbort,
  runGitCherryPickContinue,
  runGitCherryPickSkip,
  runGitStash,
  runGit,
} from '../utils/git.js';
import { formatDiffSnippet } from './diff.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render cherry-pick preview with commit info, changed files, conflict check, and patch.
 */
export function renderCherryPickPreview(details, conflictInfo, currentBranch, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2), maxPatchLines = 25 } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('preva cherry-pick')} - ${colors.cyan('Safety Preview')}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Target Commit:')}  ${colors.yellow(details.hash)} ${colors.bold(details.subject)}`);
  line(`  ${colors.bold('Author:')}         ${colors.cyan(details.author)} ${colors.dim(`<${details.email}>`)}`);
  line(`  ${colors.bold('Date:')}           ${details.date} ${colors.dim(`(${details.relativeDate})`)}`);
  line(`  ${colors.bold('Target Branch:')}  ${colors.green(currentBranch || 'HEAD')}`);

  if (details.message && details.message !== details.subject) {
    line(`\n  ${colors.bold('Message Body:')}`);
    details.message.split('\n').forEach((m) => {
      line(`    ${colors.dim(m)}`);
    });
  }

  // Changed files
  const files = details.files || [];
  line(`\n  ${colors.bold('Changed Files')} (${colors.cyan(files.length)} file(s)):`);
  if (files.length === 0) {
    line(colors.dim('    No file modifications found.'));
  } else {
    files.forEach((f) => {
      let badge = colors.yellow('[M]');
      if (f.status === 'new') badge = colors.green('[A]');
      else if (f.status === 'deleted') badge = colors.red('[D]');
      else if (f.status === 'renamed') badge = colors.yellow('[R]');

      const stat = f.isBinary ? colors.dim('[binary]') : `+${colors.green(f.additions)} / -${colors.red(f.deletions)}`;
      line(`    ${badge} ${f.path.padEnd(36)} (${stat})`);
    });
  }

  // Conflict pre-check
  line(`\n  ${colors.bold('Conflict Pre-Check:')}`);
  if (!conflictInfo.hasConflicts) {
    line(`    ${colors.green('[OK]')} No merge conflicts detected with ${colors.green(currentBranch || 'HEAD')}.`);
  } else {
    line(`    ${colors.red('[!]')} Potential merge conflict in ${colors.bold(conflictInfo.conflictingFiles.length)} file(s):`);
    conflictInfo.conflictingFiles.forEach((cf) => {
      line(`      ${colors.red('*')} ${cf}`);
    });
  }

  // Working tree status
  line(`\n  ${colors.bold('Working Directory:')}`);
  if (!conflictInfo.isDirty) {
    line(`    ${colors.green('[OK]')} Clean working tree ready for cherry-pick.`);
  } else {
    line(`    ${colors.yellow('[!]')} Uncommitted changes detected in working tree.`);
    line(colors.dim('        Git requires a clean worktree. Preva can auto-stash before applying.'));
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render in-progress cherry-pick status banner.
 */
export function renderCherryPickInProgress(progress, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bgRed(colors.white(' CHERRY-PICK IN PROGRESS '))} - Commit ${colors.yellow(progress.hash)}`);
  line(colors.dim('----------------------------------------------------------------------'));

  if (progress.details) {
    line(`  ${colors.bold('Subject:')}  ${progress.details.subject}`);
    line(`  ${colors.bold('Author:')}   ${progress.details.author} (${progress.details.relativeDate})`);
  }

  if (progress.hasConflicts) {
    line(`\n  ${colors.red('[!] Unmerged Conflicting Files')} (${progress.conflictingFiles.length}):`);
    progress.conflictingFiles.forEach((f) => {
      line(`    ${colors.red('*')} ${f}`);
    });
    line(`\n  ${colors.dim('Resolve conflicts in these files, stage them with "preva add",')}`);
    line(`  ${colors.dim('then select "Continue" below or run "preva cherry-pick --continue".')}`);
  } else {
    line(`\n  ${colors.green('[OK]')} All conflicts resolved. Ready to continue cherry-pick.`);
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva cherry-pick / preva git cherry-pick.
 */
export async function cherryPickCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // 1. Direct flags
  if (args.includes('--abort')) {
    await handleCherryPickAbort();
    return;
  }
  if (args.includes('--continue')) {
    await handleCherryPickContinue();
    return;
  }
  if (args.includes('--skip')) {
    await handleCherryPickSkip();
    return;
  }

  // 2. Active in-progress check
  const inProgress = await isCherryPickInProgress();
  if (inProgress) {
    await handleCherryPickInProgressMenu();
    return;
  }

  const currentBranch = await getCurrentBranch();

  // 3. Extract target commit ref and any flags
  const flags = args.filter((a) => a.startsWith('-'));
  const targetRefs = args.filter((a) => !a.startsWith('-'));

  let targetCommit = targetRefs[0] || null;

  if (!targetCommit) {
    if (!isInteractive()) {
      console.error(
        colors.red('Error: Commit reference required for cherry-pick (e.g. "preva git cherry-pick <hash>").')
      );
      process.exit(1);
    }

    targetCommit = await pickCommitInteractive(currentBranch);
    if (!targetCommit) return;
  }

  // 4. Resolve details and patch for commit
  const details = await getCommitDetails(targetCommit);
  if (!details) {
    console.error(colors.red(`Error: Unable to load commit details for reference "${targetCommit}".`));
    process.exit(1);
  }

  const [conflictInfo, patch] = await Promise.all([
    checkCherryPickConflicts(targetCommit),
    getCommitPatch(targetCommit),
  ]);

  console.log(renderCherryPickPreview(details, conflictInfo, currentBranch));

  if (patch) {
    console.log(`${colors.bold('Patch Preview (first 25 lines):')}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(patch, { maxLines: 25 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
  }

  if (!isInteractive()) {
    return;
  }

  await promptAndExecuteCherryPick(details, conflictInfo, patch, flags, currentBranch);
}

/**
 * Interactive menu to pick a commit when no hash was supplied on CLI.
 */
async function pickCommitInteractive(currentBranch) {
  console.log(`\n${colors.bold('preva cherry-pick')} - Select Commit to Cherry-Pick\n`);

  const otherCommits = await getRecentCommitsOtherBranches(20);

  const menuChoices = [];

  if (otherCommits.length > 0) {
    otherCommits.forEach((c) => {
      const hashStr = `[${c.hash}]`;
      const dateStr = `(${c.date} by ${c.author})`;
      menuChoices.push({
        value: c.hash,
        name: `${hashStr.padEnd(10)} ${c.subject.padEnd(36)} ${dateStr}`,
        description: `Cherry-pick commit ${c.hash}`,
      });
    });
  }

  menuChoices.push({
    value: '__pick_branch__',
    name: 'Browse commits from another branch (select branch)',
    description: 'Choose a specific branch to view its recent commits',
  });

  menuChoices.push({
    value: '__enter_hash__',
    name: 'Enter commit hash / reference      (manual entry)',
    description: 'Type a commit hash, tag, or branch name manually',
  });

  menuChoices.push({
    value: '__exit__',
    name: 'Exit                               (done)',
    description: 'Cancel cherry-pick',
  });

  const selected = await selectPrompt({
    message: `Select commit to cherry-pick into ${colors.green(currentBranch || 'HEAD')}:`,
    choices: menuChoices,
  });

  if (selected === '__exit__') {
    return null;
  }

  if (selected === '__enter_hash__') {
    const input = await inputPrompt({
      message: 'Enter commit hash or reference:',
      placeholder: 'e.g. 76e69c1 or feature-branch',
      allowEmpty: false,
    });
    return input ? input.trim() : null;
  }

  if (selected === '__pick_branch__') {
    const branches = await getLocalBranches();
    const otherBranches = branches.filter((b) => !b.isCurrent && b.name !== currentBranch);

    if (otherBranches.length === 0) {
      console.log(colors.yellow('No other local branches found.'));
      const input = await inputPrompt({
        message: 'Enter commit hash or branch name directly:',
        allowEmpty: false,
      });
      return input ? input.trim() : null;
    }

    const branchChoices = otherBranches.map((b) => ({
      value: b.name,
      name: `${b.name.padEnd(28)} [${b.hash}] ${b.subject}`,
      description: `Select commits from ${b.name}`,
    }));
    branchChoices.push({ value: '__exit__', name: 'Exit', description: 'Cancel' });

    const chosenBranch = await selectPrompt({
      message: 'Select source branch:',
      choices: branchChoices,
    });

    if (chosenBranch === '__exit__') return null;

    const branchCommits = await getCommitHistory({ maxCount: 15, ref: chosenBranch });
    if (branchCommits.length === 0) {
      console.log(colors.yellow(`No commits found on branch ${chosenBranch}.`));
      return null;
    }

    const commitChoices = branchCommits.map((c) => ({
      value: c.hash,
      name: `[${c.hash}] ${c.subject.padEnd(36)} (${c.date})`,
      description: `Pick commit ${c.hash}`,
    }));
    commitChoices.push({ value: '__exit__', name: 'Exit', description: 'Cancel' });

    const chosenCommit = await selectPrompt({
      message: `Select commit from ${chosenBranch}:`,
      choices: commitChoices,
    });

    return chosenCommit === '__exit__' ? null : chosenCommit;
  }

  return selected;
}

/**
 * Interactive action prompt to confirm and run cherry-pick.
 */
async function promptAndExecuteCherryPick(details, conflictInfo, patch, initialFlags, currentBranch) {
  const actions = [
    {
      value: 'standard',
      name: `Apply and commit        (git cherry-pick ${details.hash})`,
      description: 'Apply commit patch and preserve original commit message',
    },
    {
      value: 'no_commit',
      name: `Apply without commit    (git cherry-pick -n ${details.hash})`,
      description: 'Stage changes in index without creating a commit',
    },
    {
      value: 'edit_msg',
      name: `Edit commit message     (git cherry-pick -e ${details.hash})`,
      description: 'Open commit message editor before committing',
    },
    {
      value: 'signoff',
      name: `Apply with sign-off     (git cherry-pick -s ${details.hash})`,
      description: 'Add Signed-off-by trailer to commit message',
    },
    {
      value: 'full_patch',
      name: `View full patch         (git show ${details.hash})`,
      description: 'Inspect full unified diff without truncation',
    },
    {
      value: 'exit',
      name: 'Exit                    (done)',
      description: 'Cancel cherry-pick',
    },
  ];

  const action = await selectPrompt({
    message: `Actions for commit ${details.hash}:`,
    choices: actions,
  });

  if (action === 'exit') return;

  if (action === 'full_patch') {
    if (isInteractive()) console.clear();
    console.log(`\n${colors.bold('Full Patch:')} ${colors.yellow(details.hash)}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(patch, { maxLines: 500 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
    await confirmPrompt({ message: 'Press enter to return to cherry-pick menu', defaultValue: true });
    await promptAndExecuteCherryPick(details, conflictInfo, patch, initialFlags, currentBranch);
    return;
  }

  // Handle auto-stash if working directory is dirty
  let didAutoStash = false;
  if (conflictInfo.isDirty) {
    const shouldStash = await confirmPrompt({
      message: 'Working tree is dirty. Auto-stash changes before cherry-picking?',
      defaultValue: true,
    });

    if (!shouldStash) {
      console.log(colors.yellow('\nCherry-pick cancelled. Commit or stash changes before cherry-picking.'));
      return;
    }

    try {
      await runGitStash(['push', '-m', `preva auto-stash before cherry-pick ${details.hash}`]);
      didAutoStash = true;
      console.log(colors.green('\nAuto-stashed working tree changes.'));
    } catch (err) {
      console.error(colors.red(`\nFailed to auto-stash: ${err.message}`));
      return;
    }
  }

  // Build flags
  const runFlags = [];
  if (action === 'no_commit') runFlags.push('-n');
  if (action === 'edit_msg') runFlags.push('-e');
  if (action === 'signoff') runFlags.push('-s');

  console.log(`\n${colors.cyan(`Executing: git cherry-pick ${runFlags.join(' ')} ${details.hash}`)}...`);

  try {
    await runGitCherryPick([...runFlags, details.hash]);
    console.log(
      colors.green(
        `\nSuccessfully cherry-picked ${details.hash} ("${details.subject}") into ${currentBranch || 'HEAD'}!`
      )
    );

    if (didAutoStash) {
      try {
        await runGitStash(['pop']);
        console.log(colors.green('Restored auto-stashed changes into working tree.'));
      } catch (err) {
        console.log(colors.yellow(`\nAuto-stash was preserved. Restore with "git stash pop" (${err.message}).`));
      }
    }
  } catch (err) {
    console.error(colors.red(`\nCherry-pick stopped due to conflict: ${err.message}`));
    console.log(colors.yellow('\nRecovery actions:'));
    console.log(`  1. Resolve conflicting files and stage them with: ${colors.bold('preva git add')}`);
    console.log(`  2. Continue cherry-pick with:                     ${colors.bold('preva git cherry-pick --continue')}`);
    console.log(`  3. Or safely cancel cherry-pick with:             ${colors.bold('preva git cherry-pick --abort')}`);
    if (didAutoStash) {
      console.log(colors.dim('  (Your auto-stashed changes are preserved in git stash)'));
    }
  }
}

/**
 * Handle active cherry-pick in progress interactive menu.
 */
async function handleCherryPickInProgressMenu() {
  const progress = await getCherryPickProgress();

  console.log(renderCherryPickInProgress(progress));

  const choices = [
    {
      value: 'continue',
      name: 'Continue cherry-pick    (git cherry-pick --continue)',
      description: 'Proceed after resolving conflicts and staging files',
    },
    {
      value: 'skip',
      name: 'Skip this commit        (git cherry-pick --skip)',
      description: 'Discard this commit patch and proceed to next',
    },
    {
      value: 'abort',
      name: 'Abort cherry-pick       (git cherry-pick --abort)',
      description: 'Cancel cherry-pick and restore original branch state',
    },
    {
      value: 'diff',
      name: 'Review conflicts        (git diff)',
      description: 'View conflict markers in unmerged files',
    },
    {
      value: 'exit',
      name: 'Exit                    (done)',
      description: 'Leave cherry-pick in current state',
    },
  ];

  const action = await selectPrompt({
    message: 'Select cherry-pick recovery action:',
    choices,
  });

  if (action === 'continue') {
    await handleCherryPickContinue();
  } else if (action === 'abort') {
    await handleCherryPickAbort();
  } else if (action === 'skip') {
    await handleCherryPickSkip();
  } else if (action === 'diff') {
    const { stdout } = await runGit(['diff']);
    console.log(`\n${colors.bold('Conflict Diff:')}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(stdout));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
    await confirmPrompt({ message: 'Press enter to return to recovery menu', defaultValue: true });
    await handleCherryPickInProgressMenu();
  }
}

/**
 * Execute native git cherry-pick --abort with confirmation.
 */
async function handleCherryPickAbort() {
  const confirm = await confirmPrompt({
    message: 'Abort active cherry-pick and restore branch state?',
    defaultValue: true,
  });
  if (!confirm) {
    console.log(colors.dim('Aborted cancelled.'));
    return;
  }

  try {
    await runGitCherryPickAbort();
    console.log(colors.green('\nSuccessfully aborted cherry-pick. Branch state restored.'));
  } catch (err) {
    console.error(colors.red(`\nFailed to abort cherry-pick: ${err.message}`));
  }
}

/**
 * Execute native git cherry-pick --continue.
 */
async function handleCherryPickContinue() {
  try {
    await runGitCherryPickContinue();
    console.log(colors.green('\nSuccessfully continued cherry-pick!'));
  } catch (err) {
    console.error(colors.red(`\nCannot continue cherry-pick: ${err.message}`));
    console.log(colors.yellow('Ensure all conflicting files are resolved and staged with "preva git add".'));
  }
}

/**
 * Execute native git cherry-pick --skip.
 */
async function handleCherryPickSkip() {
  const confirm = await confirmPrompt({
    message: 'Skip current commit patch and advance?',
    defaultValue: false,
  });
  if (!confirm) return;

  try {
    await runGitCherryPickSkip();
    console.log(colors.yellow('\nSkipped commit patch.'));
  } catch (err) {
    console.error(colors.red(`\nFailed to skip commit: ${err.message}`));
  }
}
