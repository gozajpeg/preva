import { isGitRepo, getChangedFiles, stageFiles, getRepoRoot } from '../utils/git.js';
import { scanFiles } from '../utils/scanner.js';
import { checkboxList } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export async function addCommand(paths = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  const repoRoot = await getRepoRoot().catch(() => process.cwd());
  const changed = await getChangedFiles(paths);

  if (changed.length === 0) {
    console.log(colors.dim('Nothing to stage (working tree clean).'));
    process.exit(0);
  }

  const scanned = scanFiles(changed, repoRoot);

  const choices = scanned.map((file) => ({
    name: file.path,
    value: file.path,
    checked: file.defaultChecked,
    flagged: file.flagged,
    reason: file.reason,
    status: file.status,
  }));

  const selected = await checkboxList({
    message: 'Select files to stage:',
    choices,
  });

  if (selected.length === 0) {
    console.log(colors.yellow('No files selected. Nothing staged.'));
    process.exit(0);
  }

  try {
    await stageFiles(selected);
    const leftUnstaged = changed.length - selected.length;
    const summaryMsg =
      leftUnstaged > 0
        ? ` (${leftUnstaged} left unstaged)`
        : '';
    console.log(`Staged ${colors.bold(selected.length)} file(s)${summaryMsg}.`);
  } catch (err) {
    console.error(colors.red(`Error staging files: ${err.message}`));
    process.exit(1);
  }
}
