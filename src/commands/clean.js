import {
  isGitRepo,
  runGitClean,
  getUntrackedFiles,
  formatBytes,
} from '../utils/git.js';
import { scanFiles } from '../utils/scanner.js';
import { confirmPrompt, checkboxList } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export async function cleanCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // If flags or arguments are passed, handle direct command preview mode
  if (args.length > 0) {
    await handleDirectCleanArgs(args);
    return;
  }

  // Interactive Clean Menu
  await handleInteractiveClean();
}

/**
 * Handle direct clean arguments (e.g. preva clean -f, preva clean -fd, preva clean -n).
 */
async function handleDirectCleanArgs(args) {
  const isDryRun = args.includes('-n') || args.includes('--dry-run');

  // Dry run (-n) simply runs git clean -n
  if (isDryRun) {
    try {
      const { stdout } = await runGitClean(args);
      if (stdout.trim()) {
        console.log(`\n${colors.bold('Dry run preview (nothing deleted):')}`);
        console.log(stdout.trim());
      } else {
        console.log(colors.dim('\nNothing to clean.'));
      }
    } catch (err) {
      console.error(colors.red(`\nClean failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  const untracked = await getUntrackedFiles();
  const scanned = scanFiles(untracked);
  const flagged = scanned.filter((f) => f.flagged);

  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  const targetFiles = nonFlagArgs.length > 0 ? scanned.filter((f) => nonFlagArgs.includes(f.path)) : scanned;

  if (targetFiles.length === 0) {
    console.log(colors.dim('\nNothing to clean. Working tree has no matching untracked files.\n'));
    return;
  }

  const totalBytes = targetFiles.reduce((acc, f) => acc + (f.size || 0), 0);
  const sizeHint = totalBytes > 0 ? ` (total: ${formatBytes(totalBytes)})` : '';

  console.log(`\n${colors.bold('Clean Preview:')} ${colors.red('PERMANENTLY DELETE UNTRACKED FILES')} (git clean)`);
  console.log(colors.yellow('----------------------------------------------------------------------'));
  console.log(colors.red('WARNING: Untracked files are NOT in git history and will be PERMANENTLY ERASED:'));

  targetFiles.slice(0, 20).forEach((f) => {
    const sizeBadge = f.sizeFormatted ? ` (${f.sizeFormatted})` : '';
    const flagBadge = f.flagged ? colors.yellow(`  [FLAGGED: ${f.reason || 'sensitive'}]`) : '';
    console.log(`  • ${colors.red(f.path)}${colors.dim(sizeBadge)}${flagBadge}`);
  });
  if (targetFiles.length > 20) {
    console.log(colors.dim(`  ... and ${targetFiles.length - 20} more files`));
  }

  if (flagged.length > 0) {
    console.log(colors.yellow(`\nNotice: ${colors.bold(flagged.length)} sensitive or config file(s) detected!`));
  }
  console.log(colors.yellow('----------------------------------------------------------------------\n'));

  const proceed = await confirmPrompt({
    message: `PERMANENTLY delete ${targetFiles.length} untracked file(s)${sizeHint}?`,
    defaultValue: false,
  });

  if (!proceed) {
    console.log(colors.dim('\nClean cancelled. No files were deleted.'));
    process.exit(130);
  }

  // Ensure -f is present for native git clean
  const execArgs = args.includes('-f') || args.includes('--force') ? args : ['-f', ...args];

  try {
    const { stdout } = await runGitClean(execArgs);
    if (stdout.trim()) console.log(stdout.trim());
    console.log(`\n${colors.green('Clean complete.')} Deleted ${targetFiles.length} untracked file(s).`);
  } catch (err) {
    console.error(colors.red(`\nClean failed: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Interactive checklist to select untracked files to delete.
 */
async function handleInteractiveClean() {
  const untracked = await getUntrackedFiles();

  if (untracked.length === 0) {
    console.log(colors.dim('\nNothing to clean. Working tree has no untracked files.\n'));
    return;
  }

  const scanned = scanFiles(untracked);

  console.log(`\n${colors.bold('preva clean')} - Untracked File Safety Guard\n`);

  const choices = scanned.map((f) => {
    const sizeBadge = f.sizeFormatted ? ` (${f.sizeFormatted})` : '';
    return {
      name: `${f.path}${sizeBadge}`,
      value: f.path,
      checked: false, // Safety first: files start unchecked!
      flagged: f.flagged,
      reason: f.reason,
    };
  });

  const selected = await checkboxList({
    message: 'Select untracked files to delete:',
    choices,
  });

  if (selected.length === 0) {
    console.log(colors.dim('\nNo files selected. Nothing deleted.'));
    return;
  }

  const selectedObjs = scanned.filter((f) => selected.includes(f.path));
  const totalBytes = selectedObjs.reduce((acc, f) => acc + (f.size || 0), 0);
  const sizeHint = totalBytes > 0 ? ` (total: ${formatBytes(totalBytes)})` : '';

  console.log(`\n${colors.bold('Delete Preview:')} ${colors.red(`${selected.length} file(s)`)}${sizeHint}`);
  selected.slice(0, 15).forEach((path) => {
    console.log(`  • ${colors.red(path)}`);
  });
  if (selected.length > 15) {
    console.log(colors.dim(`  ... and ${selected.length - 15} more files`));
  }

  const proceed = await confirmPrompt({
    message: `PERMANENTLY delete ${selected.length} untracked file(s)?`,
    defaultValue: false,
  });

  if (!proceed) {
    console.log(colors.dim('\nClean cancelled. No files were deleted.'));
    process.exit(130);
  }

  try {
    await runGitClean(['-f', '--', ...selected]);
    console.log(`\n${colors.green('Clean complete.')} Deleted ${selected.length} untracked file(s).`);
  } catch (err) {
    console.error(colors.red(`\nClean failed: ${err.message}`));
    process.exit(1);
  }
}
