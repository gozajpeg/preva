import { isGitRepo, getStagedFiles, commitStaged } from '../utils/git.js';
import { selectPrompt, inputPrompt, confirmPrompt } from '../utils/ui.js';
import { colors } from '../utils/colors.js';

export const COMMIT_TYPES = [
  { value: 'feat', name: 'feat:     A new feature' },
  { value: 'fix', name: 'fix:      A bug fix' },
  { value: 'docs', name: 'docs:     Documentation only changes' },
  { value: 'style', name: 'style:    Changes that do not affect code logic (formatting, white-space)' },
  { value: 'refactor', name: 'refactor: A code change that neither fixes a bug nor adds a feature' },
  { value: 'perf', name: 'perf:     A code change that improves performance' },
  { value: 'test', name: 'test:     Adding missing tests or correcting existing tests' },
  { value: 'build', name: 'build:    Changes affecting build system or external dependencies' },
  { value: 'ci', name: 'ci:       Changes to CI configuration files and scripts' },
  { value: 'chore', name: 'chore:    Other changes that do not modify src or test files' },
  { value: 'revert', name: 'revert:   Reverts a previous commit' },
];

/**
 * Format type, optional scope, and message into Conventional Commit standard.
 * Adheres strictly to Conventional Commits v1.0.0 and @commitlint/config-conventional:
 * - <type>(<scope>): <message>
 * - lowercase scope
 * - no trailing period
 * - optional breaking change '!' indicator before colon
 */
export function formatCommitMessage(type, scope, message, isBreaking = false) {
  const cleanScope = scope ? scope.trim().toLowerCase() : '';
  let cleanMsg = message ? message.trim() : '';
  if (cleanMsg.endsWith('.')) {
    cleanMsg = cleanMsg.slice(0, -1).trim();
  }
  const bang = isBreaking ? '!' : '';
  if (cleanScope) {
    return `${type}(${cleanScope})${bang}: ${cleanMsg}`;
  }
  return `${type}${bang}: ${cleanMsg}`;
}

export async function commitCommand(args = []) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(colors.red('Error: Not a git repository (or any of the parent directories).'));
    process.exit(1);
  }

  // If user already passed a commit message via -m or --message, execute git commit directly
  const hasMsgFlag = args.includes('-m') || args.includes('--message');
  if (hasMsgFlag) {
    try {
      const { stdout } = await commitStaged('', args);
      console.log(stdout.trim());
      return;
    } catch (err) {
      console.error(colors.red(`Commit failed: ${err.message}`));
      process.exit(1);
    }
  }

  // Check if staged changes exist
  const staged = await getStagedFiles();
  const hasOverrideFlags =
    args.includes('-a') ||
    args.includes('--all') ||
    args.includes('--allow-empty') ||
    args.includes('--amend');

  if (staged.length === 0 && !hasOverrideFlags) {
    console.log(colors.yellow('No staged changes to commit.'));
    console.log(`Stage changes first using: ${colors.cyan('preva git add .')}\n`);
    process.exit(0);
  }

  // Show staged files summary
  if (staged.length > 0) {
    console.log(`\n${colors.bold('Staged changes')} (${colors.cyan(staged.length)}):`);
    staged.slice(0, 10).forEach((f) => {
      let badge = colors.cyan('M');
      if (f.status === 'new') badge = colors.green('A');
      else if (f.status === 'deleted') badge = colors.red('D');
      else if (f.status === 'renamed') badge = colors.yellow('R');
      console.log(`  • ${badge} ${f.path}`);
    });
    if (staged.length > 10) {
      console.log(colors.dim(`  ... and ${staged.length - 10} more files`));
    }
    console.log('');
  }

  // 1. Select Conventional Commit Type
  const type = await selectPrompt({
    message: 'Select commit type:',
    choices: COMMIT_TYPES,
  });

  // 2. Input Scope (optional)
  const scope = await inputPrompt({
    message: 'Scope (optional, e.g. auth, api, ui)',
    placeholder: 'press enter to skip',
    allowEmpty: true,
  });

  // 3. Input Commit Message Description
  const message = await inputPrompt({
    message: 'Commit message',
    placeholder: 'imperative, e.g. add user login',
    allowEmpty: false,
  });

  // 4. Breaking change check
  const isBreaking = await confirmPrompt({
    message: 'Is this a breaking change?',
    defaultValue: false,
  });

  const fullMessage = formatCommitMessage(type, scope, message, isBreaking);

  // 5. Preview and Confirm
  console.log(`\n${colors.bold('Commit preview:')} ${colors.green(fullMessage)}`);

  const proceed = await confirmPrompt({
    message: 'Create this commit?',
    defaultValue: true,
  });

  if (!proceed) {
    console.log(colors.dim('\nCommit cancelled. Nothing committed.'));
    process.exit(130);
  }

  try {
    const { stdout } = await commitStaged(fullMessage, args);
    console.log(`\n${stdout.trim()}`);
  } catch (err) {
    console.error(colors.red(`Commit failed: ${err.message}`));
    process.exit(1);
  }
}
