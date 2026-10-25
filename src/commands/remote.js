import {
  isGitRepo,
  getConfiguredRemotes,
  getBranchesTrackingRemote,
  getPrunePreview,
  testRemoteConnection,
  runGitRemote,
  addRemote,
  removeRemote,
  renameRemote,
  setRemoteUrl,
  pruneRemote,
  validateRemoteUrl,
  getUrlProtocolLabel,
} from '../utils/git.js';
import { selectPrompt, confirmPrompt, inputPrompt, truncateAnsi, isInteractive } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render configured remotes table.
 */
export function renderRemotesTable(remotes = [], options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2), verbose = false } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  const title = `preva remote - Configured Repository Remotes (${remotes.length} remote(s))`;
  line(colors.bold(title));
  line(colors.dim('----------------------------------------------------------------------'));

  if (remotes.length === 0) {
    line(colors.yellow('  No remotes configured in this repository.'));
    line(colors.dim('  Add a remote using: preva git remote add <name> <url>'));
    line(colors.dim('----------------------------------------------------------------------\n'));
    return lines.join('\n');
  }

  // Header row
  const nameHeader = 'NAME'.padEnd(14);
  const protoHeader = 'PROTOCOL'.padEnd(10);
  const urlHeader = 'URL / ENDPOINT';
  line(colors.dim(`  ${nameHeader} ${protoHeader} ${urlHeader}`));

  remotes.forEach((r) => {
    let protoColor = colors.cyan;
    if (r.protocol === 'SSH') protoColor = colors.green;
    else if (r.protocol === 'FILE') protoColor = colors.yellow;

    const protoBadge = protoColor(`[${r.protocol}]`).padEnd(10);
    const nameStr = colors.bold(r.name.padEnd(14));

    if (!r.isAsymmetric) {
      line(`  ${nameStr} ${protoBadge} ${r.fetchUrl || r.pushUrl}`);
    } else {
      line(`  ${nameStr} ${protoBadge} ${colors.dim('(fetch)')} ${r.fetchUrl}`);
      line(`  ${''.padEnd(14)} ${''.padEnd(10)} ${colors.dim('(push) ')} ${colors.yellow(r.pushUrl)}`);
    }
  });

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Format and render detailed inspection of a specific remote.
 */
export function renderRemoteDetails(remote, trackingBranches = [], options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`${colors.bold('preva remote')} - ${colors.cyan(`Remote Details: ${remote.name}`)}`);
  line(colors.dim('----------------------------------------------------------------------'));
  line(`  ${colors.bold('Remote Name:')}      ${colors.bold(remote.name)}`);
  line(`  ${colors.bold('Protocol:')}         ${colors.cyan(remote.protocol)}`);
  line(`  ${colors.bold('Fetch URL:')}        ${remote.fetchUrl || colors.dim('(none)')}`);
  line(`  ${colors.bold('Push URL:')}         ${remote.pushUrl || colors.dim('(none)')}`);

  if (remote.isAsymmetric) {
    line(`  ${colors.yellow('[!] Note:')}           Fetch and push URLs are configured differently.`);
  }

  line(`\n  ${colors.bold('Tracking Branches')} (${colors.cyan(trackingBranches.length)} local branch(es)):`);
  if (trackingBranches.length === 0) {
    line(colors.dim('    No local branches are currently configured to track this remote.'));
  } else {
    trackingBranches.forEach((tb) => {
      line(`    * ${colors.green(tb.localBranch)} -> ${colors.dim(tb.remoteBranch)}`);
    });
  }

  line(colors.dim('----------------------------------------------------------------------\n'));
  return lines.join('\n');
}

/**
 * Main entry point for preva remote / preva git remote.
 */
export async function remoteCommand(args = []) {
  if (!(await isGitRepo())) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const subCommand = args[0] || null;

  // Handle direct subcommands
  if (subCommand === 'add') {
    await handleAddRemote(args.slice(1));
    return;
  }
  if (subCommand === 'remove' || subCommand === 'rm') {
    await handleRemoveRemote(args.slice(1));
    return;
  }
  if (subCommand === 'rename') {
    await handleRenameRemote(args.slice(1));
    return;
  }
  if (subCommand === 'set-url') {
    await handleSetUrlRemote(args.slice(1));
    return;
  }
  if (subCommand === 'prune') {
    await handlePruneRemote(args.slice(1));
    return;
  }
  if (subCommand === 'show') {
    await handleShowRemote(args.slice(1));
    return;
  }

  // Display remotes table
  const remotes = await getConfiguredRemotes();
  console.log(renderRemotesTable(remotes, { verbose: args.includes('-v') || args.includes('--verbose') }));

  if (!isInteractive()) {
    return;
  }

  // Interactive menu
  await handleInteractiveRemoteMenu(remotes);
}

/**
 * Handle "git remote add <name> <url>".
 */
async function handleAddRemote(args = []) {
  let name = args[0] || null;
  let url = args[1] || null;

  if (!name || !url) {
    if (!isInteractive()) {
      console.error(colors.red('Error: Remote name and URL required (e.g. "preva git remote add <name> <url>").'));
      process.exit(1);
    }

    if (!name) {
      name = await inputPrompt({
        message: 'Enter remote name (e.g. origin, upstream):',
        defaultValue: 'origin',
        allowEmpty: false,
      });
      if (!name) return;
    }

    if (!url) {
      url = await inputPrompt({
        message: `Enter remote URL for "${name}":`,
        placeholder: 'https://github.com/owner/repo.git or git@github.com:owner/repo.git',
        allowEmpty: false,
      });
      if (!url) return;
    }
  }

  name = name.trim();
  url = url.trim();

  // Check collision with existing remotes
  const existingRemotes = await getConfiguredRemotes();
  if (existingRemotes.some((r) => r.name === name)) {
    console.error(colors.red(`Error: Remote "${name}" already exists.`));
    process.exit(1);
  }

  // Validate URL format
  const validation = validateRemoteUrl(url);
  if (!validation.valid) {
    console.warn(colors.yellow(`\n[!] Warning: ${validation.error}`));
    if (validation.suggestion) {
      console.log(`    Suggested format: ${colors.cyan(validation.suggestion)}`);
    }
    if (isInteractive()) {
      const proceed = await confirmPrompt({
        message: 'Add remote anyway?',
        defaultValue: false,
      });
      if (!proceed) {
        console.log(colors.yellow('Remote add cancelled.'));
        return;
      }
    }
  }

  const protocol = getUrlProtocolLabel(url);

  console.log(`\n${colors.bold('Add Remote Preview:')}`);
  console.log(`  Name:     ${colors.bold(name)}`);
  console.log(`  URL:      ${colors.cyan(url)}`);
  console.log(`  Protocol: ${colors.green(`[${protocol}]`)}`);
  console.log(`  Command:  ${colors.dim(`git remote add ${name} ${url}`)}\n`);

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Add remote "${name}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('Remote add cancelled.'));
      return;
    }
  }

  try {
    await addRemote(name, url);
    console.log(colors.green(`✔ Remote "${name}" added successfully!`));
  } catch (err) {
    console.error(colors.red(`Failed to add remote: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "git remote remove <name>" / "git remote rm <name>".
 */
async function handleRemoveRemote(args = []) {
  let name = args[0] || null;

  if (!name) {
    const remotes = await getConfiguredRemotes();
    if (remotes.length === 0) {
      console.log(colors.yellow('No remotes available to remove.'));
      return;
    }

    if (!isInteractive()) {
      console.error(colors.red('Error: Remote name required (e.g. "preva git remote remove <name>").'));
      process.exit(1);
    }

    name = await selectPrompt({
      message: 'Select remote to remove:',
      choices: remotes.map((r) => ({
        value: r.name,
        name: `${r.name.padEnd(14)} (${r.fetchUrl})`,
        description: `Remove remote ${r.name}`,
      })),
    });
    if (!name) return;
  }

  name = name.trim();
  const tracking = await getBranchesTrackingRemote(name);

  console.log(`\n${colors.bold('Remove Remote Safeguard:')}`);
  console.log(`  Target Remote: ${colors.bold(colors.red(name))}`);
  if (tracking.length > 0) {
    console.log(
      `  ${colors.yellow('[!] Warning:')} ${tracking.length} local branch(es) currently track this remote:`
    );
    tracking.forEach((t) => {
      console.log(`    * ${colors.green(t.localBranch)} tracks ${colors.dim(t.remoteBranch)}`);
    });
    console.log(colors.dim('  Removing this remote will delete remote-tracking references.'));
  }
  console.log(`  Command: ${colors.dim(`git remote remove ${name}`)}\n`);

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Permanently remove remote "${name}"?`,
      defaultValue: false,
    });
    if (!confirm) {
      console.log(colors.yellow('Remote removal cancelled.'));
      return;
    }
  }

  try {
    await removeRemote(name);
    console.log(colors.green(`✔ Remote "${name}" removed cleanly.`));
  } catch (err) {
    console.error(colors.red(`Failed to remove remote: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "git remote rename <old> <new>".
 */
async function handleRenameRemote(args = []) {
  let oldName = args[0] || null;
  let newName = args[1] || null;

  const remotes = await getConfiguredRemotes();
  if (remotes.length === 0) {
    console.log(colors.yellow('No remotes available to rename.'));
    return;
  }

  if (!oldName) {
    if (!isInteractive()) {
      console.error(colors.red('Error: Old and new remote names required (e.g. "preva git remote rename <old> <new>").'));
      process.exit(1);
    }

    oldName = await selectPrompt({
      message: 'Select remote to rename:',
      choices: remotes.map((r) => ({
        value: r.name,
        name: `${r.name.padEnd(14)} (${r.fetchUrl})`,
        description: `Rename remote ${r.name}`,
      })),
    });
    if (!oldName) return;
  }

  if (!newName) {
    if (!isInteractive()) {
      console.error(colors.red('Error: New remote name required.'));
      process.exit(1);
    }

    newName = await inputPrompt({
      message: `Enter new name for remote "${oldName}":`,
      allowEmpty: false,
    });
    if (!newName) return;
  }

  oldName = oldName.trim();
  newName = newName.trim();

  if (remotes.some((r) => r.name === newName)) {
    console.error(colors.red(`Error: Remote "${newName}" already exists.`));
    process.exit(1);
  }

  const tracking = await getBranchesTrackingRemote(oldName);

  console.log(`\n${colors.bold('Rename Remote Preview:')}`);
  console.log(`  Current Name: ${colors.yellow(oldName)}`);
  console.log(`  New Name:     ${colors.green(newName)}`);
  if (tracking.length > 0) {
    console.log(`  Tracking Branches: ${tracking.length} branch(es) will be updated to track ${newName}/...`);
  }
  console.log(`  Command:      ${colors.dim(`git remote rename ${oldName} ${newName}`)}\n`);

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Rename remote from "${oldName}" to "${newName}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('Rename cancelled.'));
      return;
    }
  }

  try {
    await renameRemote(oldName, newName);
    console.log(colors.green(`✔ Remote "${oldName}" renamed to "${newName}".`));
  } catch (err) {
    console.error(colors.red(`Failed to rename remote: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "git remote set-url [--push] <name> <newUrl>".
 */
async function handleSetUrlRemote(args = []) {
  let isPushOnly = false;
  const filteredArgs = [];
  for (const a of args) {
    if (a === '--push') isPushOnly = true;
    else filteredArgs.push(a);
  }

  let name = filteredArgs[0] || null;
  let newUrl = filteredArgs[1] || null;

  const remotes = await getConfiguredRemotes();
  if (remotes.length === 0) {
    console.log(colors.yellow('No remotes available to update.'));
    return;
  }

  if (!name) {
    if (!isInteractive()) {
      console.error(colors.red('Error: Remote name and URL required (e.g. "preva git remote set-url <name> <newUrl>").'));
      process.exit(1);
    }

    name = await selectPrompt({
      message: 'Select remote to update URL:',
      choices: remotes.map((r) => ({
        value: r.name,
        name: `${r.name.padEnd(14)} (${r.fetchUrl})`,
        description: `Update URL for ${r.name}`,
      })),
    });
    if (!name) return;
  }

  const existing = remotes.find((r) => r.name === name);
  const currentUrl = existing ? (isPushOnly ? existing.pushUrl : existing.fetchUrl) : '';

  if (!newUrl) {
    if (!isInteractive()) {
      console.error(colors.red('Error: New URL required.'));
      process.exit(1);
    }

    newUrl = await inputPrompt({
      message: `Enter new ${isPushOnly ? 'push ' : ''}URL for "${name}":`,
      defaultValue: currentUrl,
      placeholder: currentUrl,
      allowEmpty: false,
    });
    if (!newUrl) return;
  }

  newUrl = newUrl.trim();
  const validation = validateRemoteUrl(newUrl);
  if (!validation.valid) {
    console.warn(colors.yellow(`\n[!] Warning: ${validation.error}`));
    if (isInteractive()) {
      const proceed = await confirmPrompt({
        message: 'Set URL anyway?',
        defaultValue: false,
      });
      if (!proceed) {
        console.log(colors.yellow('URL change cancelled.'));
        return;
      }
    }
  }

  console.log(`\n${colors.bold('Update Remote URL Preview:')}`);
  console.log(`  Remote:      ${colors.bold(name)}`);
  console.log(`  Target:      ${isPushOnly ? 'Push URL only' : 'Fetch & Push URL'}`);
  console.log(`  Current URL: ${colors.dim(currentUrl)}`);
  console.log(`  New URL:     ${colors.cyan(newUrl)}`);
  console.log(`  Command:     ${colors.dim(`git remote set-url ${isPushOnly ? '--push ' : ''}${name} ${newUrl}`)}\n`);

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Update URL for remote "${name}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('URL update cancelled.'));
      return;
    }
  }

  try {
    await setRemoteUrl(name, newUrl, isPushOnly);
    console.log(colors.green(`✔ Remote "${name}" URL updated successfully!`));
  } catch (err) {
    console.error(colors.red(`Failed to update URL: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "git remote prune <name>".
 */
async function handlePruneRemote(args = []) {
  let name = args[0] || null;
  const remotes = await getConfiguredRemotes();
  if (remotes.length === 0) {
    console.log(colors.yellow('No remotes available to prune.'));
    return;
  }

  if (!name) {
    if (!isInteractive()) {
      console.error(colors.red('Error: Remote name required (e.g. "preva git remote prune <name>").'));
      process.exit(1);
    }

    name = await selectPrompt({
      message: 'Select remote to prune stale tracking branches:',
      choices: remotes.map((r) => ({
        value: r.name,
        name: `${r.name.padEnd(14)} (${r.fetchUrl})`,
        description: `Prune stale tracking branches from ${r.name}`,
      })),
    });
    if (!name) return;
  }

  name = name.trim();
  console.log(colors.cyan(`Checking for stale branches on "${name}"...`));
  const staleBranches = await getPrunePreview(name);

  if (staleBranches.length === 0) {
    console.log(colors.green(`✔ Remote "${name}" is up-to-date. No stale branches to prune.`));
    return;
  }

  console.log(`\n${colors.bold('Prune Stale Branches Preview:')}`);
  console.log(`  The following ${colors.yellow(staleBranches.length)} remote-tracking branches will be deleted:`);
  staleBranches.forEach((b) => {
    console.log(`    ${colors.red('*')} ${b}`);
  });
  console.log(`  Command: ${colors.dim(`git remote prune ${name}`)}\n`);

  if (isInteractive()) {
    const confirm = await confirmPrompt({
      message: `Prune ${staleBranches.length} stale branch(es) from "${name}"?`,
      defaultValue: true,
    });
    if (!confirm) {
      console.log(colors.yellow('Prune cancelled.'));
      return;
    }
  }

  try {
    await pruneRemote(name);
    console.log(colors.green(`✔ Pruned ${staleBranches.length} stale remote-tracking branch(es) from "${name}".`));
  } catch (err) {
    console.error(colors.red(`Failed to prune remote: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle "git remote show <name>".
 */
async function handleShowRemote(args = []) {
  let name = args[0] || 'origin';
  const remotes = await getConfiguredRemotes();
  const remote = remotes.find((r) => r.name === name) || {
    name,
    fetchUrl: '',
    pushUrl: '',
    protocol: 'UNKNOWN',
    isAsymmetric: false,
  };

  const tracking = await getBranchesTrackingRemote(name);
  console.log(renderRemoteDetails(remote, tracking));

  if (isInteractive()) {
    const testConn = await confirmPrompt({
      message: `Test connection to "${name}"?`,
      defaultValue: false,
    });
    if (testConn) {
      console.log(colors.cyan(`Testing connection to ${remote.fetchUrl || name}...`));
      const res = await testRemoteConnection(name);
      if (res.reachable) {
        console.log(colors.green(`✔ Connected successfully in ${res.latencyMs}ms.`));
      } else {
        console.warn(colors.yellow(`[!] Connection check failed or timed out: ${res.error}`));
      }
    }
  }
}

/**
 * Interactive menu when preva remote is called without arguments.
 */
async function handleInteractiveRemoteMenu(remotes) {
  if (remotes.length === 0) {
    const doAdd = await confirmPrompt({
      message: 'Would you like to add a remote repository now?',
      defaultValue: true,
    });
    if (doAdd) {
      await handleAddRemote();
    }
    return;
  }

  const choice = await selectPrompt({
    message: 'Remote action:',
    choices: [
      {
        value: 'show',
        name: 'Inspect Remote Details   (show URLs and tracking branches)',
        description: 'View detailed configuration of a remote',
      },
      {
        value: 'add',
        name: 'Add New Remote           (git remote add <name> <url>)',
        description: 'Connect repository to a new remote URL',
      },
      {
        value: 'set-url',
        name: 'Change Remote URL        (git remote set-url <name> <url>)',
        description: 'Edit fetch or push URL of an existing remote',
      },
      {
        value: 'rename',
        name: 'Rename Remote            (git remote rename <old> <new>)',
        description: 'Rename remote and update tracking branch references',
      },
      {
        value: 'prune',
        name: 'Prune Stale Branches     (git remote prune <name>)',
        description: 'Remove local references to deleted remote branches',
      },
      {
        value: 'remove',
        name: 'Remove Remote            (git remote remove <name>)',
        description: 'Delete a remote configuration safely',
      },
      {
        value: 'exit',
        name: 'Exit',
        description: 'Close remote manager',
      },
    ],
  });

  if (choice === 'show') {
    const selected = await selectPrompt({
      message: 'Select remote to inspect:',
      choices: remotes.map((r) => ({
        value: r.name,
        name: `${r.name.padEnd(14)} (${r.fetchUrl})`,
        description: `Inspect ${r.name}`,
      })),
    });
    if (selected) await handleShowRemote([selected]);
  } else if (choice === 'add') {
    await handleAddRemote();
  } else if (choice === 'set-url') {
    await handleSetUrlRemote();
  } else if (choice === 'rename') {
    await handleRenameRemote();
  } else if (choice === 'prune') {
    await handlePruneRemote();
  } else if (choice === 'remove') {
    await handleRemoveRemote();
  }
}
