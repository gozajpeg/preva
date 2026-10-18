import { readFileSync } from 'node:fs';
import { addCommand } from './commands/add.js';
import { commitCommand } from './commands/commit.js';
import { pushCommand } from './commands/push.js';
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
${colors.bold('preva')} - Interactive Git Staging, Commit & Push Preview Guard

${colors.bold('USAGE:')}
  ${colors.cyan('preva git add')} [paths...]          Review and select files before staging
  ${colors.cyan('preva git commit')} [args...]        Interactive Conventional Commit generator
  ${colors.cyan('preva git push')} [remote] [branch]  Preview commits and files before pushing
  ${colors.cyan('preva')} --version                   Show version
  ${colors.cyan('preva')} --help                      Show this help message

${colors.bold('EXAMPLES:')}
  $ preva git add .
  $ preva git commit
  $ preva git push origin main

${colors.dim('Zero external dependencies. Pure Node.js.')}
`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
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

  console.error(
    colors.red(`Unknown command: ${argv.join(' ')}\nRun "${colors.cyan('preva --help')}" for usage instructions.`)
  );
  process.exit(1);
}
