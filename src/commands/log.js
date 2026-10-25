import {
  isGitRepo,
  getCommitHistory,
  getCommitDetails,
  getCommitPatch,
  runGit,
} from '../utils/git.js';
import { formatDiffSnippet } from './diff.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render a compact visual table of commits.
 */
export function renderLogTable(commits, title = 'Recent Commits', options = {}) {
  const { maxCols = process.stdout.columns || 80 } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols - 1));

  line(`${colors.bold(title)} (${colors.cyan(commits.length)} commit(s)):`);
  line(colors.dim('----------------------------------------------------------------------'));

  if (commits.length === 0) {
    line(colors.dim('  No commits found.'));
    line(colors.dim('----------------------------------------------------------------------\n'));
    return lines.join('\n');
  }

  commits.forEach((c) => {
    const hash = colors.yellow(c.hash.padEnd(8));
    const date = colors.dim(`(${c.date})`.padEnd(16));
    const author = colors.cyan(c.author.padEnd(14));
    const deco = c.decorations ? ` ${colors.green(c.decorations)}` : '';
    line(`  ${hash} ${date} ${author} ${c.subject}${deco}`);
  });

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render detailed commit inspection view.
 */
export function renderCommitDetails(details, options = {}) {
  const { maxCols = process.stdout.columns || 80, maxDiffLines = 40 } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols - 1));

  line(`${colors.bold('Commit Details:')} ${colors.yellow(details.hash)}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Commit:')}    ${colors.yellow(details.fullHash)}`);
  line(`  ${colors.bold('Author:')}    ${colors.cyan(details.author)} ${colors.dim(`<${details.email}>`)}`);
  line(`  ${colors.bold('Date:')}      ${details.date} ${colors.dim(`(${details.relativeDate})`)}`);
  line(`  ${colors.bold('Subject:')}   ${colors.bold(details.subject)}`);

  if (details.message && details.message !== details.subject) {
    line(`\n  ${colors.bold('Message Body:')}`);
    details.message.split('\n').forEach((m) => {
      line(`    ${colors.dim(m)}`);
    });
  }

  line(colors.dim('----------------------------------------------------------------------'));

  if (details.files && details.files.length > 0) {
    line(`\n${colors.bold('Changed Files')} (${colors.cyan(details.totalFiles)} file(s), +${colors.green(details.totalAdditions)} / -${colors.red(details.totalDeletions)}):`);
    details.files.forEach((f) => {
      let badge = colors.yellow('[M]');
      if (f.status === 'new') badge = colors.green('[A]');
      else if (f.status === 'deleted') badge = colors.red('[D]');
      else if (f.status === 'renamed') badge = colors.cyan('[R]');

      const stats = f.isBinary ? colors.dim('[binary]') : `(+${f.additions}/-${f.deletions})`;
      const rename = f.oldPath ? ` ${colors.dim(`(from ${f.oldPath})`)}` : '';
      line(`  ${badge} ${f.path.padEnd(36)} ${colors.dim(stats)}${rename}`);
    });
  }

  line('');
  return lines.join('\n');
}

/**
 * Main entry point for preva log / preva git log.
 */
export async function logCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // Parse CLI flags
  let maxCount = 20;
  const nIndex = args.findIndex((a) => a === '-n' || a === '--max-count');
  if (nIndex !== -1 && args[nIndex + 1]) {
    maxCount = parseInt(args[nIndex + 1], 10) || 20;
  }

  const isOneLine = args.includes('--oneline');

  // Check if a specific commit hash was passed directly (e.g. preva log 55c6f80)
  const nonFlagArgs = args.filter((a) => !a.startsWith('-') && a !== String(maxCount));
  const candidateHash = nonFlagArgs.length > 0 ? nonFlagArgs[0] : null;

  if (candidateHash && /^[0-9a-f]{4,40}$/i.test(candidateHash)) {
    await handleDirectCommitInspection(candidateHash);
    return;
  }

  // Check if non-interactive or oneline requested
  if (isOneLine || !isInteractive()) {
    const commits = await getCommitHistory({ maxCount });
    console.log(renderLogTable(commits, `Git History (last ${commits.length} commits)`));
    return;
  }

  // Interactive Commit Explorer
  await handleInteractiveLogExplorer();
}

/**
 * Inspect a single commit directly.
 */
async function handleDirectCommitInspection(hash) {
  const details = await getCommitDetails(hash);
  if (!details) {
    console.error(colors.red(`Error: Cannot find commit '${hash}'.`));
    process.exit(1);
  }

  console.log(renderCommitDetails(details));

  const patch = await getCommitPatch(hash);
  if (patch) {
    console.log(`${colors.bold('Commit Patch:')}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(patch, { maxLines: 60 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
  }

  if (!isInteractive()) return;

  const actions = [
    {
      value: 'full_patch',
      name: `View full patch          (git show ${details.hash})`,
      description: 'Display entire patch without truncation',
    },
    {
      value: 'soft_reset',
      name: `Soft reset to here       (git reset --soft ${details.hash})`,
      description: 'Unwrap subsequent commits back into staging index',
    },
    {
      value: 'checkout',
      name: `Checkout this commit     (git checkout ${details.hash})`,
      description: 'Switch to this commit in detached HEAD state',
    },
    {
      value: 'exit',
      name: 'Exit                     (done)',
      description: 'Close commit inspection',
    },
  ];

  const action = await selectPrompt({
    message: `Actions for commit ${details.hash}:`,
    choices: actions,
  });

  if (action === 'full_patch') {
    console.log(formatDiffSnippet(patch, { maxLines: 500 }));
  } else if (action === 'soft_reset') {
    const confirm = await confirmPrompt({
      message: `Reset HEAD back to ${details.hash}? (Subsequent commits will be unwrapped into index)`,
      defaultValue: false,
    });
    if (confirm) {
      await runGit(['reset', '--soft', details.hash]);
      console.log(colors.green(`\nReset HEAD to ${details.hash} (commits kept in staging index).`));
    }
  } else if (action === 'checkout') {
    const confirm = await confirmPrompt({
      message: `Switch to ${details.hash} (detached HEAD)?`,
      defaultValue: false,
    });
    if (confirm) {
      await runGit(['checkout', details.hash]);
      console.log(colors.yellow(`\nChecked out commit ${details.hash}.`));
    }
  }
}

/**
 * Interactive Commit History Explorer loop.
 */
async function handleInteractiveLogExplorer() {
  let skip = 0;
  const pageSize = 15;
  let activeAuthor = null;
  let activeGrep = null;

  while (true) {
    if (isInteractive()) {
      console.clear();
    }

    const commits = await getCommitHistory({
      maxCount: pageSize,
      skip,
      author: activeAuthor,
      grep: activeGrep,
    });

    let headerTitle = `preva log - Commit History Explorer (Page ${Math.floor(skip / pageSize) + 1})`;
    if (activeAuthor || activeGrep) {
      const filters = [];
      if (activeAuthor) filters.push(`author: "${activeAuthor}"`);
      if (activeGrep) filters.push(`grep: "${activeGrep}"`);
      headerTitle += ` [filtered by ${filters.join(', ')}]`;
    }

    console.log(`\n${colors.bold(headerTitle)}`);
    console.log(colors.dim('Select a commit with arrow keys to view details, files, and diff:\n'));

    if (commits.length === 0) {
      console.log(colors.yellow('No matching commits found.'));
      const reset = await confirmPrompt({
        message: 'Reset filters and view all commits?',
        defaultValue: true,
      });
      if (reset) {
        activeAuthor = null;
        activeGrep = null;
        skip = 0;
        continue;
      }
      return;
    }

    const menuChoices = commits.map((c) => {
      const hashStr = `[${c.hash}]`;
      const dateStr = `(${c.date} by ${c.author})`;
      return {
        value: c.hash,
        name: `${hashStr.padEnd(10)} ${c.subject.padEnd(38)} ${dateStr}`,
        description: `Inspect commit ${c.hash}`,
      };
    });

    if (commits.length === pageSize) {
      menuChoices.push({
        value: '__next_page__',
        name: 'Load older commits       (next page)',
        description: 'View next page of commit history',
      });
    }

    if (skip > 0) {
      menuChoices.push({
        value: '__prev_page__',
        name: 'Load newer commits       (previous page)',
        description: 'View previous page of commit history',
      });
    }

    menuChoices.push({
      value: '__search_msg__',
      name: 'Search by commit message (git log --grep)',
      description: 'Filter commits matching keyword',
    });

    menuChoices.push({
      value: '__filter_author__',
      name: 'Filter by author name    (git log --author)',
      description: 'Filter commits written by a specific author',
    });

    if (activeAuthor || activeGrep) {
      menuChoices.push({
        value: '__clear_filters__',
        name: 'Clear active filters     (reset)',
        description: 'Remove author and message filters',
      });
    }

    menuChoices.push({
      value: '__exit__',
      name: 'Exit                     (done)',
      description: 'Close commit history explorer',
    });

    const choice = await selectPrompt({
      message: 'Select commit to inspect:',
      choices: menuChoices,
    });

    if (choice === '__exit__') {
      return;
    }

    if (choice === '__next_page__') {
      skip += pageSize;
      continue;
    }

    if (choice === '__prev_page__') {
      skip = Math.max(0, skip - pageSize);
      continue;
    }

    if (choice === '__search_msg__') {
      const keyword = await inputPrompt({
        message: 'Enter message search keyword:',
        placeholder: 'e.g. feat, fix, auth',
        allowEmpty: true,
      });
      if (keyword.trim()) {
        activeGrep = keyword.trim();
        skip = 0;
      }
      continue;
    }

    if (choice === '__filter_author__') {
      const author = await inputPrompt({
        message: 'Enter author name or email:',
        placeholder: 'e.g. Jane or jane@example.com',
        allowEmpty: true,
      });
      if (author.trim()) {
        activeAuthor = author.trim();
        skip = 0;
      }
      continue;
    }

    if (choice === '__clear_filters__') {
      activeAuthor = null;
      activeGrep = null;
      skip = 0;
      continue;
    }

    // Inspect individual commit
    await inspectSingleCommitInMenu(choice);
  }
}

/**
 * Single commit inspector screen inside interactive loop.
 */
async function inspectSingleCommitInMenu(hash) {
  if (isInteractive()) {
    console.clear();
  }

  const details = await getCommitDetails(hash);
  if (!details) {
    console.log(colors.red(`Unable to load commit details for ${hash}.`));
    return;
  }

  console.log(renderCommitDetails(details));

  const patch = await getCommitPatch(hash);
  if (patch) {
    console.log(`${colors.bold('Commit Patch Preview:')}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(patch, { maxLines: 40 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
  }

  const actions = [
    {
      value: 'full_patch',
      name: `View full patch          (git show ${details.hash})`,
      description: 'Display entire unified patch without truncation',
    },
    {
      value: 'soft_reset',
      name: `Soft reset back to here  (git reset --soft ${details.hash})`,
      description: 'Unwrap subsequent commits back into staging index',
    },
    {
      value: 'checkout',
      name: `Checkout this commit     (git checkout ${details.hash})`,
      description: 'Switch to this commit in detached HEAD state',
    },
    {
      value: 'back',
      name: 'Back to commit list      (return)',
      description: 'Return to commit history explorer',
    },
  ];

  const action = await selectPrompt({
    message: `Actions for commit ${details.hash}:`,
    choices: actions,
  });

  if (action === 'full_patch') {
    if (isInteractive()) console.clear();
    console.log(`\n${colors.bold('Full Commit Patch:')} ${colors.yellow(details.hash)}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(patch, { maxLines: 500 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
    await confirmPrompt({ message: 'Press enter to return to commit menu', defaultValue: true });
    await inspectSingleCommitInMenu(hash);
  } else if (action === 'soft_reset') {
    const confirm = await confirmPrompt({
      message: `Reset HEAD back to ${details.hash}? (Subsequent commits will be unwrapped into index)`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        await runGit(['reset', '--soft', details.hash]);
        console.log(colors.green(`\nReset HEAD to ${details.hash} (commits kept in staging index).`));
      } catch (err) {
        console.error(colors.red(`\nFailed to reset: ${err.message}`));
      }
    }
  } else if (action === 'checkout') {
    const confirm = await confirmPrompt({
      message: `Switch to ${details.hash} (detached HEAD)?`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        await runGit(['checkout', details.hash]);
        console.log(colors.yellow(`\nChecked out commit ${details.hash}.`));
      } catch (err) {
        console.error(colors.red(`\nFailed to checkout: ${err.message}`));
      }
    }
  }
}
