import { readFileSync } from 'node:fs';
import { addCommand } from './commands/add.js';
import { commitCommand } from './commands/commit.js';
import { pushCommand } from './commands/push.js';
import { branchCommand } from './commands/branch.js';
import { resetCommand } from './commands/reset.js';
import { restoreCommand } from './commands/restore.js';
import { cleanCommand } from './commands/clean.js';
import { pullCommand } from './commands/pull.js';
import { mergeCommand } from './commands/merge.js';
import { stashCommand } from './commands/stash.js';
import { diffCommand } from './commands/diff.js';
import { statusCommand } from './commands/status.js';
import { rebaseCommand } from './commands/rebase.js';
import { logCommand } from './commands/log.js';
import { cherryPickCommand } from './commands/cherry-pick.js';
import { tagCommand } from './commands/tag.js';
import { cloneCommand } from './commands/clone.js';
import { revertCommand } from './commands/revert.js';
import { remoteCommand } from './commands/remote.js';
import { initCommand } from './commands/init.js';
import { colors } from './utils/colors.js';

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

function printHelp() {
  console.log(`
${colors.bold('preva')} - Interactive Git Safety, Staging & Preview Guard

${colors.bold('USAGE:')}
  ${colors.cyan('preva git add')} [paths...]          Review and select files before staging
  ${colors.cyan('preva git commit')} [args...]        Interactive Conventional Commit generator
  ${colors.cyan('preva git push')} [remote] [branch]  Preview commits and files before pushing
  ${colors.cyan('preva git pull')} [remote] [branch]  Preview incoming commits, diffs & conflicts
  ${colors.cyan('preva git merge')} [branch]          Pre-merge commit, diff and conflict inspector
  ${colors.cyan('preva git branch')} [args...]        Interactive branch manager and preview guard
  ${colors.cyan('preva git stash')} [args...]         Safe stash inspector and destructive drop guard
  ${colors.cyan('preva git restore')} [args...]       Safe unstage (--staged) and discard preview guard
  ${colors.cyan('preva git reset')} [args...]         Safe commit unwrap (--soft) and reset guard
  ${colors.cyan('preva git clean')} [args...]         Untracked file deletion preview guard
  ${colors.cyan('preva git diff')} [args...]          Interactive visual diff explorer and file inspector
  ${colors.cyan('preva git status')} [args...]        Repository health dashboard and smart action hub
  ${colors.cyan('preva git rebase')} [args...]        Pre-rebase commit and conflict inspector, auto-stash guard
  ${colors.cyan('preva git log')} [args...]           Visual commit history browser and commit inspector
  ${colors.cyan('preva git cherry-pick')} [commit]    Pre-cherry-pick commit preview and conflict guard
  ${colors.cyan('preva git tag')} [args...]           Visual tag browser, creator and deletion guard
  ${colors.cyan('preva git clone')} [args...]         Pre-clone review and directory collision guard
  ${colors.cyan('preva git revert')} [commit]         Pre-revert safety preview, merge guard and recovery hub
  ${colors.cyan('preva git remote')} [args...]        Visual remote explorer, health dashboard and guard
  ${colors.cyan('preva git init')} [directory]        Repository initialization guard and smart gitignore setup
  ${colors.cyan('preva undo')}                        Interactive undo helper
  ${colors.cyan('preva')} --version                   Show version
  ${colors.cyan('preva')} --help                      Show this help message

${colors.bold('EXAMPLES:')}
  $ preva git add .
  $ preva git commit
  $ preva git push origin main
  $ preva git pull
  $ preva git merge feature-auth
  $ preva git branch
  $ preva git stash
  $ preva git reset --soft HEAD~1
  $ preva git restore --staged src/app.js
  $ preva git diff
  $ preva git status
  $ preva git rebase main
  $ preva git log
  $ preva git cherry-pick 76e69c1
  $ preva git tag
  $ preva git clone https://github.com/owner/repo.git
  $ preva git revert 76e69c1
  $ preva git remote -v
  $ preva git init
  $ preva git clean

${colors.dim('Zero external dependencies. Pure Node.js.')}
`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v' || argv.includes('--version')) {
    console.log(getVersion());
    return;
  }

  const [first, second, ...rest] = argv;

  // Handle "git add" or shorthand "add"
  if (first === 'git' && second === 'add') {
    await addCommand(rest);
    return;
  }
  if (first === 'add') {
    await addCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git commit" or shorthand "commit"
  if (first === 'git' && second === 'commit') {
    await commitCommand(rest);
    return;
  }
  if (first === 'commit') {
    await commitCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git push" or shorthand "push"
  if (first === 'git' && second === 'push') {
    await pushCommand(rest);
    return;
  }
  if (first === 'push') {
    await pushCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git pull" or shorthand "pull"
  if (first === 'git' && second === 'pull') {
    await pullCommand(rest);
    return;
  }
  if (first === 'pull') {
    await pullCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git merge" or shorthand "merge"
  if (first === 'git' && second === 'merge') {
    await mergeCommand(rest);
    return;
  }
  if (first === 'merge') {
    await mergeCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git branch", "switch", "checkout" or shorthand
  if (first === 'git' && (second === 'branch' || second === 'switch' || second === 'checkout')) {
    await branchCommand(rest);
    return;
  }
  if (first === 'branch' || first === 'switch' || first === 'checkout') {
    await branchCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git restore" or shorthand "restore"
  if (first === 'git' && second === 'restore') {
    await restoreCommand(rest);
    return;
  }
  if (first === 'restore') {
    await restoreCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git reset", "git undo", shorthand "reset", or alias "undo"
  if (first === 'git' && (second === 'reset' || second === 'undo')) {
    await resetCommand(rest);
    return;
  }
  if (first === 'reset' || first === 'undo') {
    await resetCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git clean" or shorthand "clean"
  if (first === 'git' && second === 'clean') {
    await cleanCommand(rest);
    return;
  }
  if (first === 'clean') {
    await cleanCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git stash" or shorthand "stash"
  if (first === 'git' && second === 'stash') {
    await stashCommand(rest);
    return;
  }
  if (first === 'stash') {
    await stashCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git diff" or shorthand "diff"
  if (first === 'git' && second === 'diff') {
    await diffCommand(rest);
    return;
  }
  if (first === 'diff') {
    await diffCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git status" or shorthand "status"
  if (first === 'git' && second === 'status') {
    await statusCommand(rest);
    return;
  }
  if (first === 'status') {
    await statusCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git rebase" or shorthand "rebase"
  if (first === 'git' && second === 'rebase') {
    await rebaseCommand(rest);
    return;
  }
  if (first === 'rebase') {
    await rebaseCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git log" or shorthand "log"
  if (first === 'git' && second === 'log') {
    await logCommand(rest);
    return;
  }
  if (first === 'log') {
    await logCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git cherry-pick" or shorthand "cherry-pick"
  if (first === 'git' && second === 'cherry-pick') {
    await cherryPickCommand(rest);
    return;
  }
  if (first === 'cherry-pick') {
    await cherryPickCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git tag" or shorthand "tag"
  if (first === 'git' && second === 'tag') {
    await tagCommand(rest);
    return;
  }
  if (first === 'tag') {
    await tagCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git clone" or shorthand "clone"
  if (first === 'git' && second === 'clone') {
    await cloneCommand(rest);
    return;
  }
  if (first === 'clone') {
    await cloneCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git revert" or shorthand "revert"
  if (first === 'git' && second === 'revert') {
    await revertCommand(rest);
    return;
  }
  if (first === 'revert') {
    await revertCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git remote" or shorthand "remote"
  if (first === 'git' && second === 'remote') {
    await remoteCommand(rest);
    return;
  }
  if (first === 'remote') {
    await remoteCommand([second, ...rest].filter(Boolean));
    return;
  }

  // Handle "git init" or shorthand "init"
  if (first === 'git' && second === 'init') {
    await initCommand(rest);
    return;
  }
  if (first === 'init') {
    await initCommand([second, ...rest].filter(Boolean));
    return;
  }

  console.error(
    colors.red(`Unknown command: ${argv.join(' ')}\nRun "${colors.cyan('preva --help')}" for usage instructions.`)
  );
  process.exit(1);
}


