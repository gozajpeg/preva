import { isGitRepo, getUnpushedCommits, getUnpushedFiles, pushCommits } from '../utils/git.js';
import { scanFiles } from '../utils/scanner.js';
import { confirmPrompt } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

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

  const unpushedFiles = await getUnpushedFiles(process.cwd(), upstreamRef, commits);
  const scannedFiles = scanFiles(unpushedFiles);
  const flaggedFiles = scannedFiles.filter((f) => f.flagged);

  // 1. Commits preview
  console.log(`\n${colors.bold('Unpushed Commits')} (${colors.cyan(commits.length)}):`);
  commits.slice(0, 10).forEach((c) => {
    console.log(`  • ${colors.yellow(c.hash)} ${c.message} ${colors.dim(`(${c.author})`)}`);
  });
  if (commits.length > 10) {
    console.log(colors.dim(`  ... and ${commits.length - 10} more commits`));
  }

  // 2. Files preview
  console.log(`\n${colors.bold('Files leaving your machine')} (${colors.cyan(scannedFiles.length)}):`);
  scannedFiles.slice(0, 20).forEach((f) => {
    let statusBadge = colors.cyan('M');
    if (f.status === 'new') statusBadge = colors.green('A');
    else if (f.status === 'deleted') statusBadge = colors.red('D');
    else if (f.status === 'renamed') statusBadge = colors.yellow('R');

    let flagBadge = '';
    if (f.flagged) {
      flagBadge = colors.yellow(`  [FLAGGED: ${f.reason || 'sensitive'}]`);
    }

    console.log(`  • ${statusBadge} ${f.path}${flagBadge}`);
  });
  if (scannedFiles.length > 20) {
    console.log(colors.dim(`  ... and ${scannedFiles.length - 20} more files`));
  }

  console.log('');

  // 3. Flagged warning
  if (flaggedFiles.length > 0) {
    console.log(
      colors.yellow(
        `Notice: ${colors.bold(flaggedFiles.length)} flagged file(s) detected in unpushed commits.`
      )
    );
  }

  const targetName = remote && branch ? `${remote}/${branch}` : upstreamRef || 'remote';
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
