import {
  isGitRepo,
  getDiffStats,
  getDiffSnippet,
  runGitDiff,
  getUntrackedFiles,
  getCurrentBranch,
  getLocalBranches,
  runGit,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format a raw unified diff string with syntax coloring and terminal width clamping.
 */
export function formatDiffSnippet(diffText, options = {}) {
  const { maxLines = 80, maxCols = process.stdout.columns || 80 } = options;

  if (!diffText || !diffText.trim()) {
    return colors.dim('No differences found.');
  }

  const lines = diffText.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rendered = [];
  const limit = Math.min(lines.length, maxLines);

  for (let i = 0; i < limit; i++) {
    const line = lines[i].replace(/\r$/, '');

    let formattedLine = '';
    if (line.startsWith('diff --git')) {
      formattedLine = colors.bold(colors.cyan(line));
    } else if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      formattedLine = colors.dim(line);
    } else if (line.startsWith('@@')) {
      const match = line.match(/^(@@[^@]+@@)(.*)$/);
      if (match) {
        formattedLine = colors.cyan(colors.bold(match[1])) + colors.dim(match[2] || '');
      } else {
        formattedLine = colors.cyan(line);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      formattedLine = colors.green(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      formattedLine = colors.red(line);
    } else {
      formattedLine = colors.dim(line);
    }

    rendered.push(truncateAnsi(formattedLine, maxCols - 1));
  }

  if (lines.length > maxLines) {
    rendered.push(
      colors.yellow(
        `\n... (${lines.length - maxLines} more lines truncated. Run native "git diff" for full output)`
      )
    );
  }

  return rendered.join('\n');
}

/**
 * Print visual diff summary table.
 */
export function printDiffSummary(stats, title = 'Diff Summary') {
  console.log(`\n${colors.bold(title)}: ${colors.cyan(stats.totalFiles)} file(s) changed (+${colors.green(stats.totalAdditions)} additions, -${colors.red(stats.totalDeletions)} deletions)`);
  console.log(colors.dim('----------------------------------------------------------------------'));

  stats.files.forEach((f) => {
    let badge = colors.yellow('[M]');
    if (f.status === 'new') badge = colors.green('[A]');
    else if (f.status === 'deleted') badge = colors.red('[D]');
    else if (f.status === 'renamed') badge = colors.cyan('[R]');

    const adds = colors.green(`+${f.additions}`);
    const dels = colors.red(`-${f.deletions}`);
    const statStr = f.isBinary ? colors.dim('[binary]') : `(${adds} / ${dels})`;

    const renameStr = f.oldPath ? ` ${colors.dim(`(from ${f.oldPath})`)}` : '';
    console.log(`  ${badge} ${f.path.padEnd(36)} ${statStr}${renameStr}`);
  });

  console.log(colors.dim('----------------------------------------------------------------------\n'));
}

/**
 * Main entry point for preva diff / preva git diff.
 */
export async function diffCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // Parse flags
  const isStat = args.includes('--stat');
  const isStagedFlag = args.includes('--staged') || args.includes('--cached');
  const isHeadFlag = args.includes('HEAD');

  // Filter out known flags to find target files or branch ranges
  const filteredArgs = args.filter(
    (a) => a !== '--stat' && a !== '--staged' && a !== '--cached' && a !== 'HEAD' && !a.startsWith('-')
  );

  let targetScope = 'unstaged';
  if (isStagedFlag) targetScope = 'staged';
  else if (isHeadFlag) targetScope = 'head';

  const targetPath = filteredArgs.length > 0 ? filteredArgs[0] : null;

  // Handle direct file target (e.g. preva diff src/index.js)
  if (targetPath && !targetPath.includes('..')) {
    await handleDirectFileDiff(targetPath, targetScope, isStat);
    return;
  }

  // Handle branch range target (e.g. preva diff main..feature or preva diff main)
  if (targetPath && (targetPath.includes('..') || filteredArgs.length > 0)) {
    await handleRangeDiff(filteredArgs[0], isStat);
    return;
  }

  // Handle --stat flag without file target
  if (isStat) {
    const stats = await getDiffStats({ scope: targetScope });
    if (stats.totalFiles === 0) {
      console.log(colors.dim(`\nNo ${targetScope} changes found in working tree.\n`));
      return;
    }
    const label = targetScope === 'staged' ? 'Staged Diff Summary' : (targetScope === 'head' ? 'Uncommitted Diff Summary' : 'Unstaged Diff Summary');
    printDiffSummary(stats, label);
    return;
  }

  // Interactive Diff Explorer
  if (!isInteractive()) {
    // Non-interactive fallback: print unified diff
    const snippet = await getDiffSnippet({ scope: targetScope });
    if (!snippet) {
      console.log(colors.dim(`No ${targetScope} changes found.`));
      return;
    }
    console.log(formatDiffSnippet(snippet));
    return;
  }

  await handleInteractiveDiffExplorer(targetScope);
}

/**
 * Handle direct diff of a single file.
 */
async function handleDirectFileDiff(filePath, scope, isStat) {
  const stats = await getDiffStats({ scope, path: filePath });
  if (stats.totalFiles === 0) {
    console.log(colors.dim(`\nNo ${scope} changes found for: ${filePath}\n`));
    return;
  }

  if (isStat) {
    printDiffSummary(stats, `File Summary: ${filePath}`);
    return;
  }

  const snippet = await getDiffSnippet({ scope, file: filePath });
  console.log(`\n${colors.bold('Diff Preview:')} ${colors.cyan(filePath)} (${scope})`);
  console.log(colors.dim('----------------------------------------------------------------------'));
  console.log(formatDiffSnippet(snippet));
  console.log(colors.dim('----------------------------------------------------------------------\n'));

  if (!isInteractive()) return;

  // Quick action menu for single file
  const actions = [];
  if (scope === 'unstaged') {
    actions.push({
      value: 'stage',
      name: `Stage this file          (git add ${filePath})`,
      description: 'Add changes to staging index',
    });
    actions.push({
      value: 'discard',
      name: `Discard file changes     (git restore ${filePath})`,
      description: 'Permanently revert working tree modifications',
    });
  } else if (scope === 'staged') {
    actions.push({
      value: 'unstage',
      name: `Unstage this file        (git restore --staged ${filePath})`,
      description: 'Remove from staging index',
    });
  }
  actions.push({
    value: 'exit',
    name: 'Exit                     (done)',
    description: 'Close diff preview',
  });

  const choice = await selectPrompt({
    message: `Actions for ${filePath}:`,
    choices: actions,
  });

  if (choice === 'stage') {
    await runGit(['add', filePath]);
    console.log(colors.green(`\nStaged ${filePath}`));
  } else if (choice === 'unstage') {
    await runGit(['restore', '--staged', filePath]);
    console.log(colors.yellow(`\nUnstaged ${filePath}`));
  } else if (choice === 'discard') {
    const confirm = await confirmPrompt({
      message: `Discard all changes in ${filePath}? (Cannot be undone)`,
      defaultValue: false,
    });
    if (confirm) {
      await runGit(['restore', filePath]);
      console.log(colors.yellow(`\nDiscarded changes in ${filePath}`));
    }
  }
}

/**
 * Handle diff of a range or branch comparison.
 */
async function handleRangeDiff(rangeSpec, isStat) {
  const stats = await getDiffStats({ extraArgs: [rangeSpec] });
  if (stats.totalFiles === 0) {
    console.log(colors.dim(`\nNo differences found for range: ${rangeSpec}\n`));
    return;
  }

  if (isStat) {
    printDiffSummary(stats, `Comparison: ${rangeSpec}`);
    return;
  }

  console.log(`\n${colors.bold('Range Comparison:')} ${colors.cyan(rangeSpec)} (${stats.totalFiles} files changed)`);
  printDiffSummary(stats, `Files in ${rangeSpec}`);

  if (!isInteractive()) {
    const snippet = await getDiffSnippet({ extraArgs: [rangeSpec] });
    console.log(formatDiffSnippet(snippet));
    return;
  }

  const choices = stats.files.map((f) => {
    let badge = '[M]';
    if (f.status === 'new') badge = '[A]';
    else if (f.status === 'deleted') badge = '[D]';
    else if (f.status === 'renamed') badge = '[R]';
    const stat = f.isBinary ? '[binary]' : `+${f.additions}/-${f.deletions}`;
    return {
      value: f.path,
      name: `${badge} ${f.path.padEnd(34)} (${stat})`,
      description: `Inspect diff for ${f.path}`,
    };
  });

  choices.push({
    value: '__full__',
    name: 'View full unified diff   (git diff)',
    description: 'Print complete unified diff across all files',
  });
  choices.push({
    value: '__exit__',
    name: 'Exit                     (done)',
    description: 'Close diff viewer',
  });

  const selected = await selectPrompt({
    message: 'Select file to inspect diff:',
    choices,
  });

  if (selected === '__exit__') return;

  if (selected === '__full__') {
    const snippet = await getDiffSnippet({ extraArgs: [rangeSpec] });
    console.log(`\n${colors.bold('Unified Diff:')} ${colors.cyan(rangeSpec)}`);
    console.log(colors.dim('----------------------------------------------------------------------'));
    console.log(formatDiffSnippet(snippet, { maxLines: 200 }));
    console.log(colors.dim('----------------------------------------------------------------------\n'));
    return;
  }

  const fileSnippet = await getDiffSnippet({ extraArgs: [rangeSpec], file: selected });
  console.log(`\n${colors.bold('Diff Preview:')} ${colors.cyan(selected)} (${rangeSpec})`);
  console.log(colors.dim('----------------------------------------------------------------------'));
  console.log(formatDiffSnippet(fileSnippet));
  console.log(colors.dim('----------------------------------------------------------------------\n'));
}

/**
 * Interactive Diff Explorer with scope picker, file selector, and quick actions.
 */
async function handleInteractiveDiffExplorer(initialScope = 'unstaged') {
  let currentScope = initialScope;

  while (true) {
    const [unstagedStats, stagedStats, untrackedFiles] = await Promise.all([
      getDiffStats({ scope: 'unstaged' }),
      getDiffStats({ scope: 'staged' }),
      getUntrackedFiles().catch(() => []),
    ]);

    const hasUnstaged = unstagedStats.totalFiles > 0;
    const hasStaged = stagedStats.totalFiles > 0;
    const hasUntracked = untrackedFiles.length > 0;

    // If completely clean tree
    if (!hasUnstaged && !hasStaged) {
      console.log(`\n${colors.bold('preva diff')} - Visual Git Diff Explorer\n`);
      console.log(colors.dim('Working tree is clean. No unstaged or staged changes found.'));

      if (hasUntracked) {
        console.log(colors.cyan(`Note: ${untrackedFiles.length} untracked file(s) exist. (Use "preva git add" to track them)\n`));
      } else {
        console.log('');
      }

      const cleanChoices = [
        {
          value: 'branch',
          name: 'Compare branches         (git diff <branch>...HEAD)',
          description: 'Compare current branch with another branch',
        },
        {
          value: 'head_commit',
          name: 'Inspect latest commit    (git show HEAD)',
          description: 'View diff of the most recent commit',
        },
        {
          value: 'exit',
          name: 'Exit                     (done)',
          description: 'Close diff explorer',
        },
      ];

      const cleanChoice = await selectPrompt({
        message: 'Diff actions:',
        choices: cleanChoices,
      });

      if (cleanChoice === 'branch') {
        const branchOk = await handleBranchComparisonMenu();
        if (!branchOk) continue;
        return;
      } else if (cleanChoice === 'head_commit') {
        await handleShowLatestCommit();
        return;
      }
      return;
    }

    // Determine current stats based on currentScope
    let activeStats = unstagedStats;
    let scopeLabel = 'Unstaged Changes (git diff)';
    if (currentScope === 'staged') {
      activeStats = stagedStats;
      scopeLabel = 'Staged Changes (git diff --staged)';
    } else if (currentScope === 'head') {
      activeStats = await getDiffStats({ scope: 'head' });
      scopeLabel = 'All Uncommitted Changes (git diff HEAD)';
    }

    // If active scope is empty, auto-switch to whichever has changes
    if (activeStats.totalFiles === 0) {
      if (currentScope === 'unstaged' && hasStaged) {
        currentScope = 'staged';
        continue;
      } else if (currentScope === 'staged' && hasUnstaged) {
        currentScope = 'unstaged';
        continue;
      }
    }

    if (isInteractive()) {
      console.clear();
    }

    console.log(`${colors.bold('preva diff')} - ${colors.cyan(scopeLabel)}`);
    console.log(
      `Summary: ${colors.bold(activeStats.totalFiles)} file(s) changed (+${colors.green(
        activeStats.totalAdditions
      )} additions, -${colors.red(activeStats.totalDeletions)} deletions)`
    );

    if (hasUntracked && currentScope === 'unstaged') {
      console.log(
        colors.dim(`(+ ${untrackedFiles.length} untracked file(s) in workspace. Track with "preva git add")`)
      );
    }
    console.log('');

    // Build interactive menu choices
    const fileChoices = activeStats.files.map((f) => {
      let badge = '[M]';
      if (f.status === 'new') badge = '[A]';
      else if (f.status === 'deleted') badge = '[D]';
      else if (f.status === 'renamed') badge = '[R]';
      const stat = f.isBinary ? '[binary]' : `+${f.additions}/-${f.deletions}`;
      return {
        value: f.path,
        name: `${badge} ${f.path.padEnd(32)} (${stat})`,
        description: `Inspect diff for ${f.path}`,
      };
    });

    fileChoices.push({
      value: '__full__',
      name: `View full diff           (git diff ${currentScope === 'staged' ? '--staged' : ''})`,
      description: 'Display unified diff across all changed files',
    });

    if (currentScope === 'unstaged' && hasStaged) {
      fileChoices.push({
        value: '__switch_staged__',
        name: `Switch to Staged         (git diff --staged) [${stagedStats.totalFiles} files]`,
        description: 'View changes staged for commit',
      });
    } else if (currentScope === 'staged' && hasUnstaged) {
      fileChoices.push({
        value: '__switch_unstaged__',
        name: `Switch to Unstaged       (git diff) [${unstagedStats.totalFiles} files]`,
        description: 'View unstaged working tree changes',
      });
    }

    if (currentScope !== 'head' && (hasUnstaged || hasStaged)) {
      fileChoices.push({
        value: '__switch_head__',
        name: 'View all uncommitted     (git diff HEAD)',
        description: 'View staged and unstaged changes combined',
      });
    }

    fileChoices.push({
      value: '__branch_compare__',
      name: 'Compare branches         (git diff <branch>...HEAD)',
      description: 'Compare current branch with another branch',
    });

    fileChoices.push({
      value: '__exit__',
      name: 'Exit                     (done)',
      description: 'Close diff explorer',
    });

    const selected = await selectPrompt({
      message: 'Select file to inspect diff:',
      choices: fileChoices,
    });

    if (selected === '__exit__') {
      return;
    }

    if (selected === '__switch_staged__') {
      currentScope = 'staged';
      continue;
    }

    if (selected === '__switch_unstaged__') {
      currentScope = 'unstaged';
      continue;
    }

    if (selected === '__switch_head__') {
      currentScope = 'head';
      continue;
    }

    if (selected === '__branch_compare__') {
      await handleBranchComparisonMenu();
      continue;
    }

    if (selected === '__full__') {
      const fullSnippet = await getDiffSnippet({ scope: currentScope });
      console.log(`\n${colors.bold('Unified Diff Preview:')} ${colors.cyan(scopeLabel)}`);
      console.log(colors.dim('----------------------------------------------------------------------'));
      console.log(formatDiffSnippet(fullSnippet, { maxLines: 150 }));
      console.log(colors.dim('----------------------------------------------------------------------\n'));
      continue;
    }

    // Inspect individual file
    const targetFile = activeStats.files.find((f) => f.path === selected);
    await inspectSingleFileInMenu(targetFile || { path: selected, status: 'modified' }, currentScope);
  }
}

/**
 * Single file diff inspector inside interactive loop.
 */
async function inspectSingleFileInMenu(fileObj, scope) {
  if (isInteractive()) {
    console.clear();
  }

  const snippet = await getDiffSnippet({ scope, file: fileObj.path });

  console.log(`${colors.bold('File Diff:')} ${colors.cyan(fileObj.path)} (${scope})`);
  console.log(colors.dim('----------------------------------------------------------------------'));
  console.log(formatDiffSnippet(snippet));
  console.log(colors.dim('----------------------------------------------------------------------\n'));

  const actions = [];
  if (scope === 'unstaged') {
    actions.push({
      value: 'stage',
      name: `Stage this file          (git add ${fileObj.path})`,
      description: 'Stage this file for commit',
    });
    actions.push({
      value: 'discard',
      name: `Discard file changes     (git restore ${fileObj.path})`,
      description: 'Permanently revert changes in this file',
    });
  } else if (scope === 'staged') {
    actions.push({
      value: 'unstage',
      name: `Unstage this file        (git restore --staged ${fileObj.path})`,
      description: 'Unstage this file from index',
    });
  }
  actions.push({
    value: 'back',
    name: 'Back to file list        (return)',
    description: 'Return to file overview',
  });

  const action = await selectPrompt({
    message: `Actions for ${fileObj.path}:`,
    choices: actions,
  });

  if (action === 'stage') {
    try {
      await runGit(['add', fileObj.path]);
      console.log(colors.green(`\nStaged ${fileObj.path}`));
    } catch (err) {
      console.error(colors.red(`Failed to stage ${fileObj.path}: ${err.message}`));
    }
  } else if (action === 'unstage') {
    try {
      await runGit(['restore', '--staged', fileObj.path]);
      console.log(colors.yellow(`\nUnstaged ${fileObj.path}`));
    } catch (err) {
      console.error(colors.red(`Failed to unstage ${fileObj.path}: ${err.message}`));
    }
  } else if (action === 'discard') {
    const confirm = await confirmPrompt({
      message: `Discard all working changes in ${fileObj.path}? (Cannot be undone)`,
      defaultValue: false,
    });
    if (confirm) {
      try {
        await runGit(['restore', fileObj.path]);
        console.log(colors.yellow(`\nDiscarded changes in ${fileObj.path}`));
      } catch (err) {
        console.error(colors.red(`Failed to restore ${fileObj.path}: ${err.message}`));
      }
    }
  }
}

/**
 * Handle branch comparison picker and inspector.
 */
async function handleBranchComparisonMenu() {
  const currentBranch = await getCurrentBranch();
  const branches = await getLocalBranches();
  const otherBranches = branches.filter((b) => !b.isCurrent && b.name !== currentBranch);

  if (otherBranches.length === 0) {
    console.log(colors.yellow('\nNo other local branches found to compare.\n'));
    return false;
  }

  const choices = otherBranches.map((b) => ({
    value: b.name,
    name: `${b.name.padEnd(24)} (${b.date})`,
    description: b.subject || `Compare with ${b.name}`,
  }));

  choices.push({
    value: '__cancel__',
    name: 'Cancel                   (back)',
    description: 'Return to previous menu',
  });

  const targetBranch = await selectPrompt({
    message: `Compare current branch (${currentBranch || 'HEAD'}) against:`,
    choices,
  });

  if (targetBranch === '__cancel__') return false;

  const range = `${targetBranch}...HEAD`;
  await handleRangeDiff(range, false);
  return true;
}

/**
 * Handle displaying the latest commit diff (git show HEAD).
 */
async function handleShowLatestCommit() {
  try {
    const { stdout } = await runGit(['show', '--stat', '--pretty=format:%h %s (%cr by %an)%n', 'HEAD']);
    console.log(`\n${colors.bold('Latest Commit:')}\n${stdout.trim()}`);

    const showDiff = await confirmPrompt({
      message: 'View unified patch for latest commit?',
      defaultValue: false,
    });

    if (showDiff) {
      const { stdout: patch } = await runGit(['show', '-p', 'HEAD']);
      console.log(`\n${colors.bold('Commit Patch (HEAD):')}`);
      console.log(colors.dim('----------------------------------------------------------------------'));
      console.log(formatDiffSnippet(patch, { maxLines: 150 }));
      console.log(colors.dim('----------------------------------------------------------------------\n'));
    }
  } catch (err) {
    console.error(colors.red(`Unable to inspect HEAD commit: ${err.message}`));
  }
}
