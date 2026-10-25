import {
  isGitRepo,
  getCurrentBranch,
  getLocalBranches,
  getBranchMergeStatus,
  hasWorkingTreeChanges,
  switchBranch,
  createBranch,
  renameBranch,
  deleteBranch,
} from '../utils/git.js';
import { selectPrompt, inputPrompt, confirmPrompt } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Validate a git branch name against basic git ref rules.
 */
function isValidBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  // Ref rules: cannot start/end with slash or dot, no spaces, no consecutive dots, no special chars
  if (/^[/.]|\.lock$|[/.]$/.test(trimmed)) return false;
  if (/[\s~^:?*[\\]|@{|\.\./.test(trimmed)) return false;
  return true;
}

export async function branchCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const currentBranch = await getCurrentBranch();
  const branches = await getLocalBranches();

  if (branches.length === 0) {
    console.log(colors.yellow('No commits on this repository yet.'));
    console.log(`Create an initial commit first using: ${colors.cyan('preva git add .')} and ${colors.cyan('preva git commit')}\n`);
    process.exit(0);
  }

  // If flags or arguments are passed, handle direct command preview mode
  if (args.length > 0) {
    await handleDirectBranchArgs(args, currentBranch, branches);
    return;
  }

  // Interactive Branch Manager Mode
  await handleInteractiveBranchMenu(currentBranch, branches);
}

/**
 * Interactive menu when preva branch is run without arguments.
 */
async function handleInteractiveBranchMenu(currentBranch, branches) {
  const currentObj = branches.find((b) => b.isCurrent) || branches[0];
  const currentSummary = currentObj
    ? `${colors.yellow(currentObj.hash)} ${currentObj.subject} ${colors.dim(`(${currentObj.date})`)}`
    : '';

  console.log(`\n${colors.bold('Current branch:')} ${colors.green(`* ${currentBranch}`)} ${currentSummary}\n`);

  const menuChoices = [];

  const otherBranches = branches.filter((b) => !b.isCurrent);
  if (otherBranches.length > 0) {
    menuChoices.push({
      value: 'switch',
      name: 'Switch branch   (git switch <branch>)',
      description: 'Checkout existing branch',
    });
  }

  menuChoices.push({
    value: 'create',
    name: 'Create branch   (git switch -c <name>)',
    description: `Create branch off ${currentBranch}`,
  });

  menuChoices.push({
    value: 'rename',
    name: 'Rename branch   (git branch -m / -M)',
    description: 'Rename an existing branch',
  });

  if (otherBranches.length > 0) {
    menuChoices.push({
      value: 'delete',
      name: 'Delete branch   (git branch -d / -D)',
      description: 'Safely inspect and delete',
    });
  }

  const action = await selectPrompt({
    message: 'Select branch action:',
    choices: menuChoices,
  });

  if (action === 'switch') {
    await runSwitchAction(otherBranches);
  } else if (action === 'create') {
    await runCreateAction(currentBranch, branches);
  } else if (action === 'rename') {
    await runRenameAction(currentBranch, branches);
  } else if (action === 'delete') {
    await runDeleteAction(currentBranch, otherBranches);
  }
}

/**
 * Action: Switch to an existing branch.
 */
async function runSwitchAction(otherBranches) {
  const choices = otherBranches.map((b) => ({
    value: b.name,
    name: b.name,
    description: `${b.hash} ${b.subject}`,
  }));

  const target = await selectPrompt({
    message: 'Select branch to switch to:',
    choices,
  });

  const isDirty = await hasWorkingTreeChanges();
  if (isDirty) {
    console.log(colors.yellow('\nNotice: You have uncommitted changes in your working tree.'));
  }

  console.log(`\n${colors.bold('Switch preview:')} Switch to ${colors.cyan(target)}`);

  const proceed = await confirmPrompt({
    message: `Switch to branch '${target}'?`,
    defaultValue: true,
  });

  if (!proceed) {
    console.log(colors.dim('\nSwitch cancelled.'));
    process.exit(130);
  }

  try {
    await switchBranch(target);
    console.log(`\nSwitched to branch '${colors.green(target)}'.`);
  } catch (err) {
    console.error(colors.red(`\nSwitch failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Action: Create a new branch.
 */
async function runCreateAction(currentBranch, existingBranches) {
  const branchName = await inputPrompt({
    message: 'New branch name',
    placeholder: 'e.g. feature-login',
    allowEmpty: false,
  });

  const cleanName = branchName.trim();
  if (!isValidBranchName(cleanName)) {
    console.error(colors.red(`\nError: '${cleanName}' is not a valid git branch name.`));
    process.exit(1);
  }

  if (existingBranches.some((b) => b.name === cleanName)) {
    console.error(colors.red(`\nError: Branch '${cleanName}' already exists.`));
    process.exit(1);
  }

  console.log(`\n${colors.bold('Branch preview:')}`);
  console.log(`  Name: ${colors.green(cleanName)}`);
  console.log(`  Base: ${colors.cyan(currentBranch)}`);

  const proceed = await confirmPrompt({
    message: `Create and switch to branch '${cleanName}'?`,
    defaultValue: true,
  });

  if (!proceed) {
    console.log(colors.dim('\nBranch creation cancelled.'));
    process.exit(130);
  }

  try {
    await createBranch(cleanName, true);
    console.log(`\nCreated and switched to branch '${colors.green(cleanName)}'.`);
  } catch (err) {
    console.error(colors.red(`\nFailed to create branch: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Action: Rename a branch.
 */
async function runRenameAction(currentBranch, existingBranches) {
  let targetBranch = currentBranch;

  if (existingBranches.length > 1) {
    const choices = existingBranches.map((b) => ({
      value: b.name,
      name: b.isCurrent ? `${b.name} (active)` : b.name,
      description: `${b.hash} ${b.subject}`,
    }));

    targetBranch = await selectPrompt({
      message: 'Select branch to rename:',
      choices,
    });
  }

  const newName = await inputPrompt({
    message: `New name for '${targetBranch}'`,
    placeholder: 'e.g. main',
    allowEmpty: false,
  });

  const cleanNewName = newName.trim();
  if (!isValidBranchName(cleanNewName)) {
    console.error(colors.red(`\nError: '${cleanNewName}' is not a valid git branch name.`));
    process.exit(1);
  }

  if (cleanNewName === targetBranch) {
    console.log(colors.dim('\nNew name is the same as current name. Nothing changed.'));
    return;
  }

  const alreadyExists = existingBranches.some((b) => b.name === cleanNewName);
  let forceRename = false;

  if (alreadyExists) {
    console.log(
      colors.yellow(
        `\nWarning: Branch '${cleanNewName}' already exists. Standard rename (-m) will be rejected.`
      )
    );
    const forceConfirm = await confirmPrompt({
      message: `Force rename and overwrite '${cleanNewName}' (-M)?`,
      defaultValue: false,
    });
    if (!forceConfirm) {
      console.log(colors.dim('\nRename cancelled.'));
      return;
    }
    forceRename = true;
  }

  const flagHint = forceRename ? ' (-M)' : ' (-m)';
  console.log(`\n${colors.bold('Rename preview:')} ${colors.yellow(targetBranch)} -> ${colors.green(cleanNewName)}${flagHint}`);

  if (!forceRename) {
    const proceed = await confirmPrompt({
      message: `Rename branch '${targetBranch}' to '${cleanNewName}'?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nRename cancelled.'));
      process.exit(130);
    }
  }

  try {
    const isCurrent = targetBranch === currentBranch;
    await renameBranch(isCurrent ? null : targetBranch, cleanNewName, forceRename);
    console.log(`\nRenamed branch '${colors.yellow(targetBranch)}' to '${colors.green(cleanNewName)}'.`);
  } catch (err) {
    console.error(colors.red(`\nRename failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Action: Delete a branch.
 */
async function runDeleteAction(currentBranch, deleteCandidates) {
  const choices = deleteCandidates.map((b) => ({
    value: b.name,
    name: b.name,
    description: `${b.hash} ${b.subject}`,
  }));

  const target = await selectPrompt({
    message: 'Select branch to delete:',
    choices,
  });

  const { isMerged, unmergedCommits } = await getBranchMergeStatus(target, currentBranch);

  console.log(`\n${colors.bold('Delete preview:')} ${colors.red(target)}`);

  let forceDelete = false;

  if (isMerged) {
    console.log(`  Status: ${colors.green('Fully merged')} into '${currentBranch}'`);
    const proceed = await confirmPrompt({
      message: `Delete merged branch '${target}'?`,
      defaultValue: false,
    });
    if (!proceed) {
      console.log(colors.dim('\nDelete cancelled.'));
      process.exit(130);
    }
  } else {
    forceDelete = true;
    console.log(
      colors.yellow(
        `  Warning: '${target}' has ${colors.bold(unmergedCommits.length)} unmerged commit(s) that will be lost!`
      )
    );
    unmergedCommits.slice(0, 5).forEach((c) => {
      console.log(`    • ${colors.yellow(c.hash)} ${c.message}`);
    });
    if (unmergedCommits.length > 5) {
      console.log(colors.dim(`    ... and ${unmergedCommits.length - 5} more commits`));
    }

    const proceed = await confirmPrompt({
      message: `Force delete unmerged branch '${target}' (-D)?`,
      defaultValue: false,
    });
    if (!proceed) {
      console.log(colors.dim('\nDelete cancelled. No branches were deleted.'));
      process.exit(130);
    }
  }

  try {
    await deleteBranch(target, forceDelete);
    console.log(`\nDeleted branch '${colors.red(target)}'.`);
  } catch (err) {
    console.error(colors.red(`\nDelete failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle direct branch arguments (e.g. preva branch -d foo, preva branch -M main).
 */
async function handleDirectBranchArgs(args, currentBranch, branches) {
  const isDelete = args.includes('-d') || args.includes('-D') || args.includes('--delete');
  const isForceDelete = args.includes('-D');
  const isRename = args.includes('-m') || args.includes('-M') || args.includes('--move');
  const isForceRename = args.includes('-M');
  const isList = args.includes('-a') || args.includes('--all') || args.includes('-r') || args.includes('--remotes') || args.includes('--list');

  // List branches
  if (isList) {
    branches.forEach((b) => {
      const prefix = b.isCurrent ? colors.green('* ') : '  ';
      const name = b.isCurrent ? colors.green(b.name) : b.name;
      console.log(`${prefix}${name.padEnd(20)} ${colors.yellow(b.hash)} ${b.subject} ${colors.dim(`(${b.date})`)}`);
    });
    return;
  }

  // Delete branch
  if (isDelete) {
    const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
    const target = nonFlagArgs[0];
    if (!target) {
      console.error(colors.red('Error: Branch name required for delete.'));
      process.exit(1);
    }

    if (target === currentBranch) {
      console.error(
        colors.red(`Error: Cannot delete the branch you are currently on ('${currentBranch}'). Switch to another branch first.`)
      );
      process.exit(1);
    }

    const { isMerged, unmergedCommits } = await getBranchMergeStatus(target, currentBranch);
    if (!isMerged && !isForceDelete) {
      console.error(
        colors.yellow(
          `Error: The branch '${target}' is not fully merged (${unmergedCommits.length} unmerged commit(s)).\nTo delete anyway, run with -D.`
        )
      );
      process.exit(1);
    }

    const flagName = isForceDelete ? 'force delete (-D)' : 'delete (-d)';
    const proceed = await confirmPrompt({
      message: `Confirm ${flagName} branch '${target}'?`,
      defaultValue: false,
    });

    if (!proceed) {
      console.log(colors.dim('\nDelete cancelled.'));
      process.exit(130);
    }

    try {
      await deleteBranch(target, isForceDelete);
      console.log(`Deleted branch '${colors.red(target)}'.`);
    } catch (err) {
      console.error(colors.red(`Delete failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Rename branch
  if (isRename) {
    const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
    let oldName = currentBranch;
    let newName = null;

    if (nonFlagArgs.length === 1) {
      newName = nonFlagArgs[0];
    } else if (nonFlagArgs.length >= 2) {
      oldName = nonFlagArgs[0];
      newName = nonFlagArgs[1];
    } else {
      console.error(colors.red('Error: New branch name required for rename.'));
      process.exit(1);
    }

    console.log(`\n${colors.bold('Rename preview:')} ${colors.yellow(oldName)} -> ${colors.green(newName)}`);

    const proceed = await confirmPrompt({
      message: `Rename branch '${oldName}' to '${newName}'?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nRename cancelled.'));
      process.exit(130);
    }

    try {
      const isCurrent = oldName === currentBranch;
      await renameBranch(isCurrent ? null : oldName, newName, isForceRename);
      console.log(`Renamed branch '${colors.yellow(oldName)}' to '${colors.green(newName)}'.`);
    } catch (err) {
      console.error(colors.red(`Rename failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Single name passed: create new branch
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  if (nonFlagArgs.length === 1) {
    const newBranch = nonFlagArgs[0];
    if (!isValidBranchName(newBranch)) {
      console.error(colors.red(`Error: '${newBranch}' is not a valid git branch name.`));
      process.exit(1);
    }

    console.log(`\n${colors.bold('Branch preview:')}`);
    console.log(`  Name: ${colors.green(newBranch)}`);
    console.log(`  Base: ${colors.cyan(currentBranch)}`);

    const proceed = await confirmPrompt({
      message: `Create and switch to branch '${newBranch}'?`,
      defaultValue: true,
    });

    if (!proceed) {
      console.log(colors.dim('\nBranch creation cancelled.'));
      process.exit(130);
    }

    try {
      await createBranch(newBranch, true);
      console.log(`Created and switched to branch '${colors.green(newBranch)}'.`);
    } catch (err) {
      console.error(colors.red(`Failed to create branch: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  console.error(colors.red(`Unrecognized branch arguments: ${args.join(' ')}`));
  process.exit(1);
}
