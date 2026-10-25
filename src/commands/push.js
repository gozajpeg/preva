import {
  isGitRepo,
  getUnpushedCommits,
  getUnpushedFiles,
  pushCommits,
  getRemoteUrl,
  validateRemoteUrl,
} from '../utils/git.js';
import { scanFiles } from '../utils/scanner.js';
import { confirmPrompt, truncateAnsi } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

/**
 * Format and render push preview with terminal column clamping.
 */
export function renderPushPreview(commits, scannedFiles, flaggedFiles, targetName, remoteUrl, options = {}) {
  const { maxCols = Math.max(20, (process.stdout.columns || 80) - 2) } = options;
  const lines = [];
  const line = (t = '') => lines.push(truncateAnsi(t, maxCols));

  line(`\n${colors.bold('Unpushed Commits')} (${colors.cyan(commits.length)}):`);
  commits.slice(0, 10).forEach((c) => {
    line(`  • ${colors.yellow(c.hash)} ${c.message} ${colors.dim(`(${c.author})`)}`);
  });
  if (commits.length > 10) {
    line(colors.dim(`  ... and ${commits.length - 10} more commits`));
  }

  line(`\n${colors.bold('Files leaving your machine')} (${colors.cyan(scannedFiles.length)}):`);
  scannedFiles.slice(0, 20).forEach((f) => {
    let statusBadge = colors.cyan('M');
    if (f.status === 'new') statusBadge = colors.green('A');
    else if (f.status === 'deleted') statusBadge = colors.red('D');
    else if (f.status === 'renamed') statusBadge = colors.yellow('R');

    let flagBadge = '';
    if (f.flagged) {
      flagBadge = colors.yellow(`  [FLAGGED: ${f.reason || 'sensitive'}]`);
    }

    line(`  • ${statusBadge} ${f.path}${flagBadge}`);
  });
  if (scannedFiles.length > 20) {
    line(colors.dim(`  ... and ${scannedFiles.length - 20} more files`));
  }

  line('');

  if (flaggedFiles.length > 0) {
    line(
      colors.yellow(
        `Notice: ${colors.bold(flaggedFiles.length)} flagged file(s) detected in unpushed commits.`
      )
    );
  }

  const urlSuffix = remoteUrl ? ` -> ${colors.dim(remoteUrl)}` : '';
  line(`${colors.bold('Destination:')} ${colors.cyan(targetName)}${urlSuffix}\n`);

  return lines.join('\n');
}

export async function pushCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // Parse remote and branch if provided (ignoring flags like -u, --force, etc.)
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  const remote = nonFlagArgs[0] || null;
  const branch = nonFlagArgs[1] || null;

  const { commits, upstreamRef, noCommits } = await getUnpushedCommits(process.cwd(), remote, branch);

  if (noCommits) {
    console.log(colors.yellow('No commits on current branch yet. Create a commit first with git commit.'));
    process.exit(0);
  }

  if (commits.length === 0) {
    console.log(colors.dim('Everything up-to-date. No commits to push.'));
    process.exit(0);
  }

  // Inspect and validate target remote URL
  const targetRemote = remote || (upstreamRef ? upstreamRef.split('/')[0] : 'origin');
  const remoteUrl = await getRemoteUrl(targetRemote);

  if (remoteUrl) {
    const check = validateRemoteUrl(remoteUrl);
    if (!check.valid) {
      console.error(colors.red(`\nError: ${check.error}`));
      if (check.suggestion) {
        console.error(colors.yellow('\nTo fix your remote URL run:'));
        console.error(`  ${colors.cyan(`git remote set-url ${targetRemote} ${check.suggestion}`)}\n`);
      }
      process.exit(1);
    }
  }

  const unpushedFiles = await getUnpushedFiles(process.cwd(), upstreamRef, commits);
  const scannedFiles = scanFiles(unpushedFiles);
  const flaggedFiles = scannedFiles.filter((f) => f.flagged);

  const targetName = remote && branch ? `${remote}/${branch}` : upstreamRef || 'remote';

  console.log(renderPushPreview(commits, scannedFiles, flaggedFiles, targetName, remoteUrl));

  const shouldDefaultNo = flaggedFiles.length > 0;

  const proceed = await confirmPrompt({
    message: `Push ${commits.length} commit(s) to ${targetName}?`,
    defaultValue: !shouldDefaultNo,
  });

  if (!proceed) {
    console.log(colors.dim('\nPush cancelled. No commits or files were pushed.'));
    if (flaggedFiles.length > 0) {
      console.log(`\n${colors.bold('To uncommit and adjust before pushing:')}`);
      console.log(`   ${colors.cyan('git reset --soft HEAD~1')}`);
      console.log(`   ${colors.cyan('preva git add .')}`);
      console.log(`   ${colors.cyan('git commit -m "your message"')}\n`);
    }
    process.exit(130);
  }

  try {
    await pushCommits(args);
  } catch (err) {
    console.error(colors.red(`Push failed: ${err.message}`));
    process.exit(1);
  }
}

