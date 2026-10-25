import {
  isGitRepo,
  getCurrentBranch,
  getRepoState,
  getUpstreamSyncStatus,
  getDiffStats,
  getUntrackedFiles,
  getStashes,
  runGit,
} from '../utils/git.js';
import { scanFiles } from '../utils/scanner.js';
import { selectPrompt, confirmPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';
import { addCommand } from './add.js';
import { commitCommand } from './commit.js';
import { pushCommand } from './push.js';
import { pullCommand } from './pull.js';
import { diffCommand } from './diff.js';
import { stashCommand } from './stash.js';
import { cleanCommand } from './clean.js';

/**
 * Format and render repository health status dashboard.
 */
export function renderStatusDashboard(data, options = {}) {
  const { maxItems = 10, maxCols = process.stdout.columns || 80 } = options;
  const lines = [];

  const line = (text = '') => lines.push(truncateAnsi(text, maxCols - 1));

  line(`${colors.bold('preva status')} - ${colors.cyan('Repository Health Dashboard')}`);
  line(colors.dim('----------------------------------------------------------------------'));

  // 1. Branch and upstream sync status
  const branchName = data.branch || colors.yellow('(detached HEAD)');
  let syncText = colors.dim('(no upstream remote tracking configured)');

  if (data.upstream.hasUpstream) {
    if (data.upstream.ahead === 0 && data.upstream.behind === 0) {
      syncText = colors.green(`(synced with ${data.upstream.upstream})`);
    } else {
      const parts = [];
      if (data.upstream.ahead > 0) parts.push(colors.green(`ahead ${data.upstream.ahead}`));
      if (data.upstream.behind > 0) parts.push(colors.red(`behind ${data.upstream.behind}`));
      syncText = `${colors.yellow(`(${parts.join(', ')} relative to ${data.upstream.upstream})`)}`;
    }
  }

  line(`  ${colors.bold('Branch:')}    ${colors.cyan(branchName)} ${syncText}`);

  // 2. In-progress states (merge, rebase, cherry-pick, revert, bisect)
  if (data.repoState.inProgress) {
    line(`  ${colors.bold('State:')}     ${colors.bgRed(colors.white(` ⚠️  ${data.repoState.label} `))}`);
  } else {
    line(`  ${colors.bold('State:')}     ${colors.green('Clean')} ${colors.dim('(no active merge/rebase/cherry-pick)')}`);
  }

  // 3. Stashes
  const stashCount = data.stashes.length;
  if (stashCount > 0) {
    line(`  ${colors.bold('Stashes:')}   ${colors.yellow(`${stashCount} saved stash(es)`)}`);
  }

  line(colors.dim('----------------------------------------------------------------------'));

  let hasChanges = false;

  // 4. Staged files section
  if (data.staged.totalFiles > 0) {
    hasChanges = true;
    line(`\n${colors.bold('Staged for Commit')} (${colors.cyan(data.staged.totalFiles)} file(s), +${colors.green(data.staged.totalAdditions)} / -${colors.red(data.staged.totalDeletions)}):`);
    const visibleStaged = data.staged.files.slice(0, maxItems);
    visibleStaged.forEach((f) => {
      let badge = colors.green('[A]');
      if (f.status === 'modified') badge = colors.yellow('[M]');
      else if (f.status === 'deleted') badge = colors.red('[D]');
      else if (f.status === 'renamed') badge = colors.cyan('[R]');

      const stats = f.isBinary ? colors.dim('[binary]') : `(+${f.additions}/-${f.deletions})`;
      const rename = f.oldPath ? ` ${colors.dim(`(from ${f.oldPath})`)}` : '';
      line(`  ${badge} ${f.path.padEnd(36)} ${colors.dim(stats)}${rename}`);
    });

    if (data.staged.totalFiles > maxItems) {
      line(colors.dim(`  ... and ${data.staged.totalFiles - maxItems} more staged file(s)`));
    }
  }

  // 5. Unstaged files section
  if (data.unstaged.totalFiles > 0) {
    hasChanges = true;
    line(`\n${colors.bold('Unstaged Modifications')} (${colors.cyan(data.unstaged.totalFiles)} file(s), +${colors.green(data.unstaged.totalAdditions)} / -${colors.red(data.unstaged.totalDeletions)}):`);
    const visibleUnstaged = data.unstaged.files.slice(0, maxItems);
    visibleUnstaged.forEach((f) => {
      let badge = colors.yellow('[M]');
      if (f.status === 'new') badge = colors.green('[A]');
      else if (f.status === 'deleted') badge = colors.red('[D]');

      const stats = f.isBinary ? colors.dim('[binary]') : `(+${f.additions}/-${f.deletions})`;
      line(`  ${badge} ${f.path.padEnd(36)} ${colors.dim(stats)}`);
    });

    if (data.unstaged.totalFiles > maxItems) {
      line(colors.dim(`  ... and ${data.unstaged.totalFiles - maxItems} more unstaged file(s)`));
    }
  }

  // 6. Untracked files section
  if (data.untracked.length > 0) {
    hasChanges = true;
    line(`\n${colors.bold('Untracked Files')} (${colors.cyan(data.untracked.length)} file(s)):`);
    const visibleUntracked = data.untracked.slice(0, maxItems);
    let secretCount = 0;

    visibleUntracked.forEach((f) => {
      const sizeStr = f.sizeFormatted ? ` (${f.sizeFormatted})` : '';
      let flagStr = '';
      if (f.flagged) {
        secretCount++;
        flagStr = ` ${colors.bgRed(colors.white(' ⚠️ SECRET '))} ${colors.red(f.reason)}`;
      }
      line(`  ${colors.dim('[?]')} ${f.path.padEnd(36)}${colors.dim(sizeStr)}${flagStr}`);
    });

    if (data.untracked.length > maxItems) {
      line(colors.dim(`  ... and ${data.untracked.length - maxItems} more untracked file(s)`));
    }

    if (secretCount > 0) {
      line(colors.yellow(`\n  ⚠️  ${secretCount} sensitive credential file(s) detected above! Do not stage.`));
    }
  }

  if (!hasChanges) {
    line(`\n${colors.green('✔ Working tree clean.')} Nothing to commit.`);
  }

  line('');
  return lines.join('\n');
}

/**
 * Gather full repository status details.
 */
export async function getStatusData(cwd = process.cwd()) {
  const [
    branch,
    repoState,
    upstream,
    staged,
    unstaged,
    rawUntracked,
    stashes,
  ] = await Promise.all([
    getCurrentBranch(cwd),
    getRepoState(cwd),
    getUpstreamSyncStatus(cwd),
    getDiffStats({ scope: 'staged' }, cwd),
    getDiffStats({ scope: 'unstaged' }, cwd),
    getUntrackedFiles(cwd).catch(() => []),
    getStashes(cwd),
  ]);

  const untracked = scanFiles(rawUntracked, cwd);

  return {
    branch,
    repoState,
    upstream,
    staged,
    unstaged,
    untracked,
    stashes,
  };
}

/**
 * Main entry point for preva status / preva git status.
 */
export async function statusCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const isShort = args.includes('-s') || args.includes('--short');
  const data = await getStatusData();

  if (isShort) {
    // Print short output
    console.log(renderStatusDashboard(data, { maxItems: 50 }));
    return;
  }

  if (!isInteractive()) {
    console.log(renderStatusDashboard(data));
    return;
  }

  // Interactive Status Hub loop
  while (true) {
    if (isInteractive()) {
      console.clear();
    }

    const currentData = await getStatusData();
    console.log(renderStatusDashboard(currentData));

    const menuChoices = [];

    // In-progress conflict handling
    if (currentData.repoState.inProgress) {
      menuChoices.push({
        value: 'abort_op',
        name: `Abort ${currentData.repoState.type}     (git ${currentData.repoState.type} --abort)`,
        description: `Cancel in-progress ${currentData.repoState.type} operation`,
      });
    }

    // Staged options
    if (currentData.staged.totalFiles > 0) {
      menuChoices.push({
        value: 'commit',
        name: 'Commit staged changes   (git commit)',
        description: `Launch Conventional Commit generator (${currentData.staged.totalFiles} files staged)`,
      });
      menuChoices.push({
        value: 'diff_staged',
        name: 'Review staged diff      (git diff --staged)',
        description: 'Inspect exact line additions and deletions in staging index',
      });
      menuChoices.push({
        value: 'unstage_all',
        name: 'Unstage all files       (git restore --staged .)',
        description: 'Remove all files from staging index',
      });
    }

    // Unstaged options
    if (currentData.unstaged.totalFiles > 0 || currentData.untracked.length > 0) {
      menuChoices.push({
        value: 'add',
        name: 'Review & stage files    (git add)',
        description: 'Select files to stage with safety checklist and secret shield',
      });
    }

    if (currentData.unstaged.totalFiles > 0) {
      menuChoices.push({
        value: 'diff_unstaged',
        name: 'Review unstaged diff    (git diff)',
        description: 'Inspect working tree modifications',
      });
      menuChoices.push({
        value: 'stash_push',
        name: 'Stash working edits     (git stash push)',
        description: 'Temporarily stash uncommitted changes',
      });
    }

    // Untracked options
    if (currentData.untracked.length > 0) {
      menuChoices.push({
        value: 'clean',
        name: 'Clean untracked files   (git clean)',
        description: 'Inspect and safely delete untracked files',
      });
    }

    // Remote sync options
    if (currentData.upstream.hasUpstream && currentData.upstream.ahead > 0) {
      menuChoices.push({
        value: 'push',
        name: `Push unpushed commits   (git push) [${currentData.upstream.ahead} ahead]`,
        description: 'Preview and push local commits to remote',
      });
    }

    if (currentData.upstream.hasUpstream && currentData.upstream.behind > 0) {
      menuChoices.push({
        value: 'pull',
        name: `Pull remote commits     (git pull) [${currentData.upstream.behind} behind]`,
        description: 'Preview incoming commits and conflicts before pulling',
      });
    }

    menuChoices.push({
      value: 'exit',
      name: 'Exit                    (done)',
      description: 'Close status dashboard',
    });

    const action = await selectPrompt({
      message: 'Select action to execute:',
      choices: menuChoices,
    });

    if (action === 'exit') {
      return;
    }

    if (action === 'abort_op') {
      const type = currentData.repoState.type;
      const confirm = await confirmPrompt({
        message: `Abort the in-progress ${type} operation?`,
        defaultValue: false,
      });
      if (confirm) {
        try {
          await runGit([type, '--abort']);
          console.log(colors.green(`\nAborted ${type} operation.`));
        } catch (err) {
          console.error(colors.red(`\nFailed to abort ${type}: ${err.message}`));
        }
      }
      continue;
    }

    if (action === 'commit') {
      await commitCommand();
      return;
    }

    if (action === 'diff_staged') {
      await diffCommand(['--staged']);
      continue;
    }

    if (action === 'diff_unstaged') {
      await diffCommand();
      continue;
    }

    if (action === 'add') {
      await addCommand();
      continue;
    }

    if (action === 'unstage_all') {
      try {
        await runGit(['restore', '--staged', '.']);
        console.log(colors.yellow('\nUnstaged all files from index.'));
      } catch (err) {
        console.error(colors.red(`\nFailed to unstage: ${err.message}`));
      }
      continue;
    }

    if (action === 'stash_push') {
      await stashCommand(['push']);
      continue;
    }

    if (action === 'clean') {
      await cleanCommand();
      continue;
    }

    if (action === 'push') {
      await pushCommand();
      return;
    }

    if (action === 'pull') {
      await pullCommand();
      continue;
    }
  }
}
