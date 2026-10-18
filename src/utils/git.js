import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Execute a git command safely with argument array (no shell expansion).
 */
export async function runGit(args, cwd = process.cwd()) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 15 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = new Error(error.stderr ? error.stderr.toString().trim() : error.message);
    err.code = error.code;
    throw err;
  }
}

/**
 * Check if the current directory is inside a git working tree.
 */
export async function isGitRepo(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Get the repository root directory.
 */
export async function getRepoRoot(cwd = process.cwd()) {
  const { stdout } = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return stdout.trim();
}

/**
 * Normalize Windows path backslashes to POSIX slashes.
 */
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Parse porcelain v1 null-delimited status output.
 */
export function parsePorcelainStatus(output) {
  if (!output) return [];

  const tokens = output.split('\0');
  const files = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    const statusCode = token.slice(0, 2);
    let filePath = token.slice(3);

    // If renamed or copied, the next token is the original path
    if (statusCode[0] === 'R' || statusCode[0] === 'C') {
      i++; // Skip the original path
    }

    if (!filePath) continue;

    filePath = normalizePath(filePath);
    const stagedStatus = statusCode[0];
    const workTreeStatus = statusCode[1];

    let status = 'modified';
    let isTracked = true;

    if (statusCode === '??') {
      status = 'new';
      isTracked = false;
    } else if (workTreeStatus === 'D' || stagedStatus === 'D') {
      status = 'deleted';
    } else if (workTreeStatus === 'A' || stagedStatus === 'A') {
      status = 'new';
    } else if (stagedStatus === 'R') {
      status = 'renamed';
    } else {
      status = 'modified';
    }

    // Only include files that have unstaged changes or are untracked
    // (i.e. files that can be staged by git add)
    const canBeStaged = workTreeStatus !== ' ' || statusCode === '??';

    if (canBeStaged) {
      files.push({
        path: filePath,
        status,
        isTracked,
        statusCode,
      });
    }
  }

  return files;
}

/**
 * Get all files available to be staged.
 */
export async function getChangedFiles(paths = [], cwd = process.cwd()) {
  const args = ['status', '--porcelain=v1', '-z', '-uall'];
  if (paths.length > 0) {
    args.push('--', ...paths);
  }

  const { stdout } = await runGit(args, cwd);
  return parsePorcelainStatus(stdout);
}

/**
 * Get all files currently staged in the index.
 */
export async function getStagedFiles(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['diff', '--cached', '--name-status', '-M', '-z'], cwd);
    if (!stdout) return [];
    const tokens = stdout.split('\0');
    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      const code = token[0];
      let filePath = '';
      if (code === 'R' || code === 'C') {
        i++;
        filePath = tokens[++i];
      } else {
        filePath = tokens[++i];
      }
      if (!filePath) continue;
      filePath = normalizePath(filePath);
      let status = 'modified';
      if (code === 'A') status = 'new';
      else if (code === 'D') status = 'deleted';
      else if (code === 'R') status = 'renamed';
      files.push({ path: filePath, status, code });
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Execute native git commit with message and extra arguments.
 */
export async function commitStaged(message, extraArgs = [], cwd = process.cwd()) {
  const repoRoot = await getRepoRoot(cwd).catch(() => cwd);
  const args = ['commit', '-m', message, ...extraArgs];
  return runGit(args, repoRoot);
}

/**
 * Query unpushed commits between upstream (or remote) and HEAD.
 */
export async function getUnpushedCommits(cwd = process.cwd(), remote, branch) {
  // Check if HEAD has any commits (not unborn)
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], cwd);
  } catch {
    return { commits: [], upstreamRef: null, noCommits: true };
  }

  let upstreamRef = null;

  if (remote && branch) {
    const candidateRef = `${remote}/${branch}`;
    try {
      await runGit(['rev-parse', '--verify', candidateRef], cwd);
      upstreamRef = candidateRef;
    } catch {
      upstreamRef = null;
    }
  } else if (remote && !branch) {
    try {
      const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      const currentBranch = stdout.trim();
      if (currentBranch && currentBranch !== 'HEAD') {
        const candidateRef = `${remote}/${currentBranch}`;
        try {
          await runGit(['rev-parse', '--verify', candidateRef], cwd);
          upstreamRef = candidateRef;
        } catch {
          upstreamRef = null;
        }
      }
    } catch {
      upstreamRef = null;
    }
  } else {
    // Try to get current tracking upstream
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        cwd
      );
      upstreamRef = stdout.trim();
    } catch {
      upstreamRef = null;
    }
  }

  let gitArgs = [];
  if (upstreamRef) {
    gitArgs = ['log', '--pretty=format:%h%x09%s%x09%an', `${upstreamRef}..HEAD`];
  } else {
    // Fallback: branch has no upstream or remote ref doesn't exist yet
    try {
      const remoteArg = remote ? [`--remotes=${remote}`] : ['--remotes'];
      // Note: HEAD must be BEFORE --not so that HEAD is NOT negated!
      gitArgs = ['log', '--pretty=format:%h%x09%s%x09%an', 'HEAD', '--not', ...remoteArg];
      const testRun = await runGit(gitArgs, cwd);
      if (!testRun.stdout.trim()) {
        // Check if any remotes exist at all
        const remotesList = await runGit(['remote'], cwd).catch(() => ({ stdout: '' }));
        if (!remotesList.stdout.trim()) {
          // No remotes exist at all: all commits on HEAD are unpushed
          gitArgs = ['log', '--pretty=format:%h%x09%s%x09%an', 'HEAD'];
        }
      }
    } catch {
      gitArgs = ['log', '-n', '10', '--pretty=format:%h%x09%s%x09%an', 'HEAD'];
    }
  }

  try {
    const { stdout } = await runGit(gitArgs, cwd);
    const lines = stdout.trim().split('\n').filter(Boolean);

    const commits = lines.map((line) => {
      const [hash, message, author] = line.split('\t');
      return {
        hash: hash || '',
        message: message || '',
        author: author || '',
      };
    });

    return { commits, upstreamRef };
  } catch {
    return { commits: [], upstreamRef: null };
  }
}

/**
 * Query files added, modified, or deleted across unpushed commits.
 */
export async function getUnpushedFiles(cwd = process.cwd(), upstreamRef, commits = []) {
  let gitArgs = [];

  if (upstreamRef) {
    gitArgs = ['diff', '--name-status', '-M', '-z', `${upstreamRef}...HEAD`];
  } else if (commits.length > 0) {
    const oldestHash = commits[commits.length - 1].hash;
    let hasParent = true;
    try {
      await runGit(['rev-parse', '--verify', `${oldestHash}^`], cwd);
    } catch {
      hasParent = false;
    }
    const base = hasParent ? `${oldestHash}^` : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    gitArgs = ['diff', '--name-status', '-M', '-z', base, 'HEAD'];
  } else {
    try {
      gitArgs = ['diff-tree', '--no-commit-id', '--name-status', '-M', '-z', '-r', 'HEAD'];
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await runGit(gitArgs, cwd);
    if (!stdout) return [];

    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token[0]; // 'M', 'A', 'D', 'R', etc.
      let filePath = '';

      if (code === 'R' || code === 'C') {
        // Token is e.g. 'R100', next token is old path, following is new path
        i++; // skip old path
        filePath = tokens[++i];
      } else {
        filePath = tokens[++i];
      }

      if (!filePath) continue;

      filePath = normalizePath(filePath);

      let status = 'modified';
      if (code === 'A') status = 'new';
      else if (code === 'D') status = 'deleted';
      else if (code === 'R') status = 'renamed';

      files.push({
        status,
        path: filePath,
        code,
      });
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Execute native git add for specified file paths.
 */
export async function stageFiles(files, cwd = process.cwd()) {
  if (files.length === 0) return;
  const repoRoot = await getRepoRoot(cwd).catch(() => cwd);
  await runGit(['add', '--', ...files], repoRoot);
}

/**
 * Execute native git push with passed arguments in inherited stdio.
 */
export function pushCommits(args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['push', ...args], {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git push exited with code ${code}`));
    });
  });
}
