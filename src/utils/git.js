import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

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
    return {
      stdout: stdout.toString().replace(/\r\n/g, '\n'),
      stderr: stderr.toString().replace(/\r\n/g, '\n'),
    };
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

/**
 * Get current active branch name.
 */
export async function getCurrentBranch(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['branch', '--show-current'], cwd);
    const branch = stdout.trim();
    if (branch) return branch;
    const { stdout: abbrev } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const trimmed = abbrev.trim();
    return trimmed === 'HEAD' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Query all local branches with their commit hash, subject, date, and active status.
 */
export async function getLocalBranches(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname:short)%00%(subject)%00%(committerdate:relative)%00%(HEAD)',
        'refs/heads/',
      ],
      cwd
    );
    if (!stdout.trim()) return [];

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('\0');
      const name = parts[0] ? parts[0].trim() : '';
      const hash = parts[1] ? parts[1].trim() : '';
      const subject = parts[2] ? parts[2].trim() : '';
      const date = parts[3] ? parts[3].trim() : '';
      const head = parts[4] ? parts[4].trim() : '';
      return {
        name,
        hash,
        subject,
        date,
        isCurrent: head === '*',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Check if a branch is fully merged into base branch or has unmerged commits.
 */
export async function getBranchMergeStatus(branch, baseBranch = 'main', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['log', `${baseBranch}..${branch}`, '--pretty=format:%h%x09%s'],
      cwd
    );
    if (!stdout.trim()) {
      return { isMerged: true, unmergedCommits: [] };
    }
    const lines = stdout.trim().split('\n').filter(Boolean);
    const unmergedCommits = lines.map((l) => {
      const [hash, message] = l.split('\t');
      return { hash: hash || '', message: message || '' };
    });
    return {
      isMerged: false,
      unmergedCommits,
    };
  } catch {
    return { isMerged: false, unmergedCommits: [] };
  }
}

/**
 * Check if the working tree has uncommitted staged or unstaged changes.
 */
export async function hasWorkingTreeChanges(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['status', '--porcelain=v1'], cwd);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Switch / checkout an existing local branch.
 */
export async function switchBranch(branch, cwd = process.cwd()) {
  try {
    return await runGit(['switch', branch], cwd);
  } catch {
    return await runGit(['checkout', branch], cwd);
  }
}

/**
 * Create a new branch, optionally switching to it.
 */
export async function createBranch(branch, shouldSwitch = false, cwd = process.cwd()) {
  if (shouldSwitch) {
    try {
      return await runGit(['switch', '-c', branch], cwd);
    } catch {
      return await runGit(['checkout', '-b', branch], cwd);
    }
  }
  return await runGit(['branch', branch], cwd);
}

/**
 * Rename a branch safely (-m) or force (-M).
 */
export async function renameBranch(oldName, newName, force = false, cwd = process.cwd()) {
  const flag = force ? '-M' : '-m';
  if (oldName) {
    return await runGit(['branch', flag, oldName, newName], cwd);
  }
  return await runGit(['branch', flag, newName], cwd);
}

/**
 * Delete a branch safely (-d) or force (-D).
 */
export async function deleteBranch(branch, force = false, cwd = process.cwd()) {
  const flag = force ? '-D' : '-d';
  return await runGit(['branch', flag, branch], cwd);
}

/**
 * Query the remote URL for a given remote name.
 */
export async function getRemoteUrl(remote = 'origin', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['remote', 'get-url', remote], cwd);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Validate remote URL format and detect common protocol typos (e.g. gttps://, htps://).
 */
export function validateRemoteUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Remote URL is empty.' };
  }
  const trimmed = url.trim();

  // Known typo schemes
  const typoMatch = trimmed.match(/^([a-zA-Z0-9_-]+)(:\/\/|:\/|\/\/)/);
  if (typoMatch) {
    const scheme = typoMatch[1].toLowerCase();
    if (scheme === 'gttps' || scheme === 'htps' || scheme === 'ttp' || scheme === 'ttps') {
      const fixedUrl = trimmed.replace(/^[a-zA-Z0-9_-]+(:\/\/|:\/|\/\/)/, 'https://');
      return {
        valid: false,
        protocol: scheme,
        suggestion: fixedUrl,
        error: `Malformed protocol '${scheme}://'. Did you mean 'https://'?`,
      };
    }
  }

  const isHttp = /^https?:\/\//i.test(trimmed);
  const isSsh = /^ssh:\/\//i.test(trimmed) || /^[\w.-]+@[\w.-]+:/i.test(trimmed);
  const isGit = /^git:\/\//i.test(trimmed);
  const isFile = /^file:\/\//i.test(trimmed);

  if (isHttp || isSsh || isGit || isFile) {
    return { valid: true, url: trimmed };
  }

  return {
    valid: false,
    url: trimmed,
    error: `Unrecognized remote URL format: '${trimmed}'. Expected https:// or git@host:repo format.`,
  };
}

/**
 * Execute native git reset with passed arguments.
 */
export async function runGitReset(args = [], cwd = process.cwd()) {
  const repoRoot = await getRepoRoot(cwd).catch(() => cwd);
  return runGit(['reset', ...args], repoRoot);
}

/**
 * Execute native git restore with passed arguments.
 */
export async function runGitRestore(args = [], cwd = process.cwd()) {
  const repoRoot = await getRepoRoot(cwd).catch(() => cwd);
  return runGit(['restore', ...args], repoRoot);
}

/**
 * Get unstaged or staged file diff summary (+added, -deleted lines) for preview.
 */
export async function getFileDiffStat(filePath, isStaged = false, cwd = process.cwd()) {
  try {
    const gitArgs = isStaged
      ? ['diff', '--cached', '--numstat', '--', filePath]
      : ['diff', '--numstat', '--', filePath];
    const { stdout } = await runGit(gitArgs, cwd);
    if (!stdout.trim()) return null;
    const [added, deleted] = stdout.trim().split(/\s+/);
    return {
      added: added !== '-' ? parseInt(added, 10) : 0,
      deleted: deleted !== '-' ? parseInt(deleted, 10) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Get a short snippet (up to 15 lines) of file diff for discard preview.
 */
export async function getFileDiffSnippet(filePath, isStaged = false, cwd = process.cwd()) {
  try {
    const gitArgs = isStaged
      ? ['diff', '--cached', '-U1', '--', filePath]
      : ['diff', '-U1', '--', filePath];
    const { stdout } = await runGit(gitArgs, cwd);
    if (!stdout.trim()) return '';
    const lines = stdout.split('\n');
    const contentLines = lines.filter(
      (l) => !l.startsWith('diff --git') && !l.startsWith('index ') && !l.startsWith('--- ') && !l.startsWith('+++ ')
    );
    return contentLines.slice(0, 15).join('\n');
  } catch {
    return '';
  }
}

/**
 * Get all uncommitted files (staged, unstaged, untracked) with status.
 */
export async function getUncommittedFiles(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z', '-uall'], cwd);
    if (!stdout) return [];
    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token.slice(0, 2);
      let filePath = token.slice(3);

      if (code[0] === 'R' || code[0] === 'C') {
        i++; // skip original path
      }

      if (!filePath) continue;
      filePath = normalizePath(filePath);

      const isStaged = code[0] !== ' ' && code[0] !== '?';
      const isUnstaged = code[1] !== ' ' || code === '??';

      files.push({
        code,
        path: filePath,
        isStaged,
        isUnstaged,
      });
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Get the last commit summary (hash, subject, author).
 */
export async function getLastCommit(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['log', '-n', '1', '--pretty=format:%h%x09%s%x09%an'], cwd);
    if (!stdout.trim()) return null;
    const [hash, message, author] = stdout.trim().split('\t');
    return { hash: hash || '', message: message || '', author: author || '' };
  } catch {
    return null;
  }
}

/**
 * Format raw byte size into human-readable string.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes || isNaN(bytes)) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Get all untracked files with their calculated file sizes.
 */
export async function getUntrackedFiles(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z', '-uall'], cwd);
    if (!stdout) return [];
    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token.slice(0, 2);
      if (code !== '??') continue;

      let filePath = token.slice(3);
      if (!filePath) continue;
      filePath = normalizePath(filePath);

      let size = 0;
      let sizeFormatted = '';
      try {
        const absPath = join(cwd, filePath);
        if (existsSync(absPath)) {
          const stats = statSync(absPath);
          size = stats.size;
          sizeFormatted = formatBytes(size);
        }
      } catch {
        size = 0;
        sizeFormatted = '';
      }

      files.push({
        path: filePath,
        size,
        sizeFormatted,
        code: '??',
      });
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Execute native git clean with passed arguments.
 */
export async function runGitClean(args = [], cwd = process.cwd()) {
  const repoRoot = await getRepoRoot(cwd).catch(() => cwd);
  return runGit(['clean', ...args], repoRoot);
}

/**
 * Query list of configured remotes.
 */
export async function getRemotes(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['remote'], cwd);
    return stdout
      .trim()
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Execute native git fetch with passed remote and branch.
 */
export async function runGitFetch(remote = 'origin', branch = '', cwd = process.cwd()) {
  const args = ['fetch', remote];
  if (branch) args.push(branch);
  return runGit(args, cwd);
}

/**
 * Query upstream tracking ref for current branch (e.g. 'origin/main').
 */
export async function getUpstreamRef(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      cwd
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Query incoming commits from upstream ref and calculate divergence (ahead/behind).
 */
export async function getIncomingCommits(cwd = process.cwd(), remote = 'origin', branch = '') {
  let upstreamRef = null;
  if (branch) {
    upstreamRef = `${remote}/${branch}`;
  } else {
    upstreamRef = await getUpstreamRef(cwd);
    if (!upstreamRef) {
      const currentBranch = await getCurrentBranch(cwd);
      try {
        await runGit(['rev-parse', '--verify', `${remote}/${currentBranch}`], cwd);
        upstreamRef = `${remote}/${currentBranch}`;
      } catch {
        upstreamRef = null;
      }
    }
  }

  if (!upstreamRef) {
    return {
      ahead: 0,
      behind: 0,
      upstreamRef: null,
      incomingCommits: [],
    };
  }

  // Get ahead and behind count: HEAD...upstreamRef
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`], cwd);
    const parts = stdout.trim().split(/\s+/);
    ahead = parseInt(parts[0], 10) || 0;
    behind = parseInt(parts[1], 10) || 0;
  } catch {
    ahead = 0;
    behind = 0;
  }

  if (behind === 0) {
    return {
      ahead,
      behind: 0,
      upstreamRef,
      incomingCommits: [],
    };
  }

  // Get list of incoming commits
  try {
    const { stdout } = await runGit(
      ['log', '--pretty=format:%h%x09%s%x09%an%x09%cr', `HEAD..${upstreamRef}`],
      cwd
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    const incomingCommits = lines.map((line) => {
      const [hash, message, author, date] = line.split('\t');
      return {
        hash: hash || '',
        message: message || '',
        author: author || '',
        date: date || '',
      };
    });

    return {
      ahead,
      behind,
      upstreamRef,
      incomingCommits,
    };
  } catch {
    return {
      ahead,
      behind,
      upstreamRef,
      incomingCommits: [],
    };
  }
}

/**
 * Query list of files changed in incoming commits.
 */
export async function getIncomingFiles(cwd = process.cwd(), upstreamRef) {
  if (!upstreamRef) return [];

  try {
    const { stdout } = await runGit(['diff', '--name-status', '-M', '-z', `HEAD..${upstreamRef}`], cwd);
    if (!stdout) return [];

    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token[0];
      let filePath = '';

      if (code === 'R') {
        const oldPath = tokens[++i];
        filePath = tokens[++i];
        files.push({
          path: normalizePath(filePath),
          oldPath: normalizePath(oldPath),
          status: 'renamed',
          code: 'R',
        });
      } else {
        filePath = tokens[++i];
        let status = 'modified';
        if (code === 'A') status = 'new';
        else if (code === 'D') status = 'deleted';
        else if (code === 'M') status = 'modified';

        files.push({
          path: normalizePath(filePath),
          status,
          code,
        });
      }
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Check if any local uncommitted files conflict with incoming changes.
 */
export async function checkPullConflicts(incomingFiles = [], cwd = process.cwd()) {
  if (incomingFiles.length === 0) {
    return { hasConflicts: false, conflictingFiles: [] };
  }

  const uncommitted = await getUncommittedFiles(cwd);
  const uncommittedPaths = new Set(uncommitted.map((f) => f.path));

  const conflictingFiles = incomingFiles
    .map((f) => f.path)
    .filter((p) => uncommittedPaths.has(p));

  return {
    hasConflicts: conflictingFiles.length > 0,
    conflictingFiles,
  };
}

/**
 * Execute native git pull with passed arguments.
 */
export async function runGitPull(args = [], cwd = process.cwd()) {
  return runGit(['pull', ...args], cwd);
}

/**
 * Check if a merge is currently in progress.
 */
export async function isMergeInProgress(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
    return existsSync(join(absGitDir, 'MERGE_HEAD'));
  } catch {
    return false;
  }
}

/**
 * Get merge base commit between two branches or refs.
 */
export async function getMergeBase(branchA, branchB, cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['merge-base', branchA, branchB], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if ancestor is an ancestor of ref.
 */
export async function isAncestor(ancestor, ref, cwd = process.cwd()) {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, ref], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Query incoming commits from targetBranch into currentBranch.
 */
export async function getMergeCommits(targetBranch, currentBranch = 'HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['log', '--pretty=format:%h%x09%s%x09%an%x09%cr', `${currentBranch}..${targetBranch}`],
      cwd
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const [hash, message, author, date] = line.split('\t');
      return {
        hash: hash || '',
        message: message || '',
        author: author || '',
        date: date || '',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Query list of files changed between currentBranch and targetBranch.
 */
export async function getMergeFiles(targetBranch, currentBranch = 'HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['diff', '--name-status', '-M', '-z', `${currentBranch}...${targetBranch}`],
      cwd
    );
    if (!stdout) return [];

    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token[0];
      let filePath = '';

      if (code === 'R') {
        const oldPath = tokens[++i];
        filePath = tokens[++i];
        files.push({
          path: normalizePath(filePath),
          oldPath: normalizePath(oldPath),
          status: 'renamed',
          code: 'R',
        });
      } else {
        filePath = tokens[++i];
        let status = 'modified';
        if (code === 'A') status = 'new';
        else if (code === 'D') status = 'deleted';
        else if (code === 'M') status = 'modified';

        files.push({
          path: normalizePath(filePath),
          status,
          code,
        });
      }
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Check for potential merge conflicts between currentBranch and targetBranch.
 */
export async function checkMergeConflicts(targetBranch, currentBranch = 'HEAD', cwd = process.cwd()) {
  const isDirty = await hasWorkingTreeChanges(cwd);
  const base = await getMergeBase(currentBranch, targetBranch, cwd);

  if (!base) {
    return { hasConflicts: false, conflictingFiles: [], isDirty, base: null };
  }

  try {
    const [currentDiff, targetDiff] = await Promise.all([
      runGit(['diff', '--name-only', base, currentBranch], cwd),
      runGit(['diff', '--name-only', base, targetBranch], cwd),
    ]);

    const currentFiles = new Set(
      currentDiff.stdout
        .trim()
        .split('\n')
        .map((f) => normalizePath(f.trim()))
        .filter(Boolean)
    );
    const targetFiles = targetDiff.stdout
      .trim()
      .split('\n')
      .map((f) => normalizePath(f.trim()))
      .filter(Boolean);

    const conflictingFiles = targetFiles.filter((f) => currentFiles.has(f));

    return {
      hasConflicts: conflictingFiles.length > 0,
      conflictingFiles,
      isDirty,
      base,
    };
  } catch {
    return { hasConflicts: false, conflictingFiles: [], isDirty, base };
  }
}

/**
 * Execute native git merge with passed arguments.
 */
export async function runGitMerge(args = [], cwd = process.cwd()) {
  return runGit(['merge', ...args], cwd);
}

/**
 * Execute native git merge --abort.
 */
export async function runGitMergeAbort(cwd = process.cwd()) {
  return runGit(['merge', '--abort'], cwd);
}

/**
 * Query all saved stashes.
 */
export async function getStashes(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['stash', 'list', '--pretty=format:%gd%x09%cr%x09%gs'],
      cwd
    );
    if (!stdout.trim()) return [];

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line, index) => {
      const [ref, date, message] = line.split('\t');
      return {
        ref: ref || `stash@{${index}}`,
        index,
        date: date || '',
        message: message || '',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Query files modified or untracked in a stash ref.
 */
export async function getStashFiles(stashRef = 'stash@{0}', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['stash', 'show', '--name-status', '-u', '-z', stashRef],
      cwd
    );
    if (!stdout) return [];

    const tokens = stdout.split('\0');
    const files = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const code = token[0];
      let filePath = '';

      if (code === 'R') {
        const oldPath = tokens[++i];
        filePath = tokens[++i];
        files.push({
          path: normalizePath(filePath),
          oldPath: normalizePath(oldPath),
          status: 'renamed',
          code: 'R',
        });
      } else {
        filePath = tokens[++i];
        let status = 'modified';
        if (code === 'A') status = 'new';
        else if (code === 'D') status = 'deleted';
        else if (code === 'M') status = 'modified';

        files.push({
          path: normalizePath(filePath),
          status,
          code,
        });
      }
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Get unified diff snippet of a stash.
 */
export async function getStashDiffSnippet(stashRef = 'stash@{0}', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['stash', 'show', '-p', '-u', stashRef], cwd);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Check if popping/applying a stash will conflict with local uncommitted edits.
 */
export async function checkStashConflicts(stashRef = 'stash@{0}', cwd = process.cwd()) {
  const stashFiles = await getStashFiles(stashRef, cwd);
  if (stashFiles.length === 0) {
    return { hasConflicts: false, conflictingFiles: [] };
  }

  const uncommitted = await getUncommittedFiles(cwd);
  const uncommittedPaths = new Set(uncommitted.map((f) => f.path));

  const conflictingFiles = stashFiles
    .map((f) => f.path)
    .filter((p) => uncommittedPaths.has(p));

  return {
    hasConflicts: conflictingFiles.length > 0,
    conflictingFiles,
  };
}

/**
 * Execute native git stash with passed arguments.
 */
export async function runGitStash(args = [], cwd = process.cwd()) {
  return runGit(['stash', ...args], cwd);
}

/**
 * Query diff statistics (additions, deletions, status) for a scope, range, or file.
 */
export async function getDiffStats(options = {}, cwd = process.cwd()) {
  const { scope = 'unstaged', path = null, base = null, target = null, extraArgs = [] } = options;

  const diffArgs = [];
  if (scope === 'staged') {
    diffArgs.push('--cached');
  } else if (scope === 'head') {
    diffArgs.push('HEAD');
  } else if (scope === 'branch' || scope === 'range') {
    if (base && target) {
      diffArgs.push(`${base}...${target}`);
    } else if (base) {
      diffArgs.push(`${base}...HEAD`);
    }
  }

  if (extraArgs && extraArgs.length > 0) {
    diffArgs.push(...extraArgs);
  }

  const nameArgs = ['diff', '--name-status', '-z', ...diffArgs];
  const numArgs = ['diff', '--numstat', '-z', ...diffArgs];
  if (path) {
    nameArgs.push('--', path);
    numArgs.push('--', path);
  }

  try {
    const [nameResult, numResult] = await Promise.all([
      runGit(nameArgs, cwd).catch(() => ({ stdout: '' })),
      runGit(numArgs, cwd).catch(() => ({ stdout: '' })),
    ]);

    // Parse --name-status -z
    const nameMap = new Map();
    if (nameResult.stdout) {
      const tokens = nameResult.stdout.split('\0');
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const code = token[0];
        let filePath = '';
        let oldPath = null;
        if (code === 'R' || code === 'C') {
          oldPath = tokens[++i];
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
        nameMap.set(filePath, {
          status,
          code,
          oldPath: oldPath ? normalizePath(oldPath) : null,
        });
      }
    }

    // Parse --numstat -z
    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    if (numResult.stdout) {
      const tokens = numResult.stdout.split('\0').filter(Boolean);
      for (const line of tokens) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const addStr = parts[0];
        const delStr = parts[1];
        let filePath = parts.slice(2).join('\t');
        filePath = normalizePath(filePath);

        const isBinary = addStr === '-' && delStr === '-';
        const additions = isBinary ? 0 : parseInt(addStr, 10) || 0;
        const deletions = isBinary ? 0 : parseInt(delStr, 10) || 0;

        totalAdditions += additions;
        totalDeletions += deletions;

        const meta = nameMap.get(filePath) || {
          status: 'modified',
          code: 'M',
          oldPath: null,
        };

        files.push({
          path: filePath,
          status: meta.status,
          code: meta.code,
          oldPath: meta.oldPath,
          additions,
          deletions,
          isBinary,
        });
      }
    }

    return {
      files,
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
    };
  } catch {
    return {
      files: [],
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }
}

/**
 * Get unified diff snippet for a scope, range, or file.
 */
export async function getDiffSnippet(options = {}, cwd = process.cwd()) {
  const { scope = 'unstaged', file = null, base = null, target = null, contextLines = 3, extraArgs = [] } = options;

  const args = ['diff', `-U${contextLines}`];
  if (scope === 'staged') {
    args.push('--cached');
  } else if (scope === 'head') {
    args.push('HEAD');
  } else if (scope === 'branch' || scope === 'range') {
    if (base && target) {
      args.push(`${base}...${target}`);
    } else if (base) {
      args.push(`${base}...HEAD`);
    }
  }

  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  if (file) {
    args.push('--', file);
  }

  try {
    const { stdout } = await runGit(args, cwd);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Execute native git diff with passed arguments.
 */
export async function runGitDiff(args = [], cwd = process.cwd()) {
  return runGit(['diff', ...args], cwd);
}

/**
 * Detect active in-progress Git states (merge, rebase, cherry-pick, revert, bisect).
 */
export async function getRepoState(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);

    if (existsSync(join(absGitDir, 'MERGE_HEAD'))) {
      return { inProgress: true, type: 'merge', label: 'MERGE IN PROGRESS' };
    }
    if (existsSync(join(absGitDir, 'rebase-merge')) || existsSync(join(absGitDir, 'rebase-apply'))) {
      return { inProgress: true, type: 'rebase', label: 'REBASE IN PROGRESS' };
    }
    if (existsSync(join(absGitDir, 'CHERRY_PICK_HEAD'))) {
      return { inProgress: true, type: 'cherry-pick', label: 'CHERRY-PICK IN PROGRESS' };
    }
    if (existsSync(join(absGitDir, 'REVERT_HEAD'))) {
      return { inProgress: true, type: 'revert', label: 'REVERT IN PROGRESS' };
    }
    if (existsSync(join(absGitDir, 'BISECT_LOG'))) {
      return { inProgress: true, type: 'bisect', label: 'BISECT IN PROGRESS' };
    }

    return { inProgress: false, type: null, label: 'Clean' };
  } catch {
    return { inProgress: false, type: null, label: 'Unknown' };
  }
}

/**
 * Query upstream tracking branch name and ahead/behind commit counts.
 */
export async function getUpstreamSyncStatus(cwd = process.cwd()) {
  try {
    const { stdout: upstreamOut } = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd);
    const upstream = upstreamOut.trim();
    if (!upstream) {
      return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 };
    }

    const { stdout: countsOut } = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);
    const parts = countsOut.trim().split(/\s+/);
    const ahead = parseInt(parts[0], 10) || 0;
    const behind = parseInt(parts[1], 10) || 0;

    return {
      hasUpstream: true,
      upstream,
      ahead,
      behind,
    };
  } catch {
    return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 };
  }
}

/**
 * Check if a rebase is currently in progress.
 */
export async function isRebaseInProgress(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
    return existsSync(join(absGitDir, 'rebase-merge')) || existsSync(join(absGitDir, 'rebase-apply'));
  } catch {
    return false;
  }
}

/**
 * Get active rebase progress details, including current step, total steps, onto ref, and conflict files.
 */
export async function getRebaseProgress(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);

    let step = 0;
    let total = 0;
    let headName = '';
    let onto = '';

    const mergeDir = join(absGitDir, 'rebase-merge');
    const applyDir = join(absGitDir, 'rebase-apply');

    if (existsSync(mergeDir)) {
      try {
        step = parseInt(readFileSync(join(mergeDir, 'msgnum'), 'utf8').trim(), 10) || 0;
        total = parseInt(readFileSync(join(mergeDir, 'end'), 'utf8').trim(), 10) || 0;
        headName = readFileSync(join(mergeDir, 'head-name'), 'utf8').trim();
        onto = readFileSync(join(mergeDir, 'onto'), 'utf8').trim().slice(0, 7);
      } catch {}
    } else if (existsSync(applyDir)) {
      try {
        step = parseInt(readFileSync(join(applyDir, 'next'), 'utf8').trim(), 10) || 0;
        total = parseInt(readFileSync(join(applyDir, 'last'), 'utf8').trim(), 10) || 0;
      } catch {}
    } else {
      return { inProgress: false };
    }

    // Query conflicting unmerged files from git status
    const { stdout: statusOut } = await runGit(['status', '--porcelain=v1'], cwd);
    const unmergedFiles = [];
    const lines = statusOut.split('\n');
    for (const l of lines) {
      if (!l) continue;
      const code = l.slice(0, 2);
      if (
        code === 'UU' ||
        code === 'AA' ||
        code === 'DU' ||
        code === 'UD' ||
        code === 'DD' ||
        code === 'AU' ||
        code === 'UA'
      ) {
        unmergedFiles.push(normalizePath(l.slice(3).trim()));
      }
    }

    return {
      inProgress: true,
      step,
      total,
      headName: headName ? headName.replace(/^refs\/heads\//, '') : null,
      onto,
      hasConflicts: unmergedFiles.length > 0,
      conflictingFiles: unmergedFiles,
    };
  } catch {
    return { inProgress: false };
  }
}

/**
 * Get ordered list of commits that will be replayed during rebase.
 */
export async function getRebaseCommits(upstream, branch = 'HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['log', `${upstream}..${branch}`, '--reverse', '--pretty=format:%h%x09%an%x09%cr%x09%s'],
      cwd
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, message] = line.split('\t');
        return {
          hash: hash || '',
          author: author || '',
          date: date || '',
          message: message || '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Query files that will be touched by local commits in the rebase range.
 */
export async function getRebaseFiles(upstream, branch = 'HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['diff', '--name-status', `${upstream}..${branch}`], cwd);
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const code = parts[0] ? parts[0][0] : 'M';
        const path = normalizePath(parts[parts.length - 1] || '');
        let status = 'modified';
        if (code === 'A') status = 'new';
        else if (code === 'D') status = 'deleted';
        else if (code === 'R') status = 'renamed';
        return { path, status, code };
      });
  } catch {
    return [];
  }
}

/**
 * Check for potential merge conflicts between upstream and branch before starting rebase.
 */
export async function checkRebaseConflicts(upstream, branch = 'HEAD', cwd = process.cwd()) {
  const isDirty = await hasWorkingTreeChanges(cwd);
  const base = await getMergeBase(upstream, branch, cwd);
  if (!base) {
    return { hasConflicts: false, conflictingFiles: [], isDirty, base: null };
  }

  try {
    const [upstreamDiff, branchDiff] = await Promise.all([
      runGit(['diff', '--name-only', base, upstream], cwd),
      runGit(['diff', '--name-only', base, branch], cwd),
    ]);

    const upstreamFiles = new Set(
      upstreamDiff.stdout
        .trim()
        .split('\n')
        .map((f) => normalizePath(f.trim()))
        .filter(Boolean)
    );
    const branchFiles = branchDiff.stdout
      .trim()
      .split('\n')
      .map((f) => normalizePath(f.trim()))
      .filter(Boolean);

    const conflictingFiles = branchFiles.filter((f) => upstreamFiles.has(f));

    return {
      hasConflicts: conflictingFiles.length > 0,
      conflictingFiles,
      isDirty,
      base,
    };
  } catch {
    return { hasConflicts: false, conflictingFiles: [], isDirty, base };
  }
}

/**
 * Execute native git rebase with passed arguments.
 */
export async function runGitRebase(args = [], cwd = process.cwd()) {
  return runGit(['rebase', ...args], cwd);
}

/**
 * Execute native git rebase --abort.
 */
export async function runGitRebaseAbort(cwd = process.cwd()) {
  return runGit(['rebase', '--abort'], cwd);
}

/**
 * Execute native git rebase --continue.
 */
export async function runGitRebaseContinue(cwd = process.cwd()) {
  return runGit(['rebase', '--continue'], cwd);
}

/**
 * Execute native git rebase --skip.
 */
export async function runGitRebaseSkip(cwd = process.cwd()) {
  return runGit(['rebase', '--skip'], cwd);
}

/**
 * Query commit history list with metadata (hash, author, date, subject, decorations).
 */
export async function getCommitHistory(options = {}, cwd = process.cwd()) {
  const { maxCount = 20, skip = 0, author = null, grep = null, ref = 'HEAD' } = options;

  const args = [
    'log',
    `-n`,
    String(maxCount),
    `--skip=${skip}`,
    '--pretty=format:%h%x00%H%x00%an%x00%ae%x00%cr%x00%s%x00%d',
  ];
  if (author) {
    args.push(`--author=${author}`);
  }
  if (grep) {
    args.push(`--grep=${grep}`);
  }
  args.push(ref);

  try {
    const { stdout } = await runGit(args, cwd);
    if (!stdout.trim()) return [];

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('\0');
      const hash = parts[0] || '';
      const fullHash = parts[1] || '';
      const author = parts[2] || '';
      const email = parts[3] || '';
      const date = parts[4] || '';
      const subject = parts[5] || '';
      const decorations = parts[6] ? parts[6].trim() : '';

      return {
        hash,
        fullHash,
        author,
        email,
        date,
        subject,
        decorations,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get detailed metadata, changed files, and stats for a specific commit.
 */
export async function getCommitDetails(hash = 'HEAD', cwd = process.cwd()) {
  try {
    const [metaResult, nameResult, numResult] = await Promise.all([
      runGit(['show', '--no-patch', '--pretty=format:%h%x00%H%x00%an%x00%ae%x00%cd%x00%cr%x00%s%x00%B', hash], cwd),
      runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', hash], cwd).catch(() => ({ stdout: '' })),
      runGit(['diff-tree', '--no-commit-id', '--numstat', '-r', '-z', hash], cwd).catch(() => ({ stdout: '' })),
    ]);

    const metaParts = metaResult.stdout.split('\0');
    const commitMeta = {
      hash: metaParts[0] || hash,
      fullHash: metaParts[1] || '',
      author: metaParts[2] || '',
      email: metaParts[3] || '',
      date: metaParts[4] || '',
      relativeDate: metaParts[5] || '',
      subject: metaParts[6] || '',
      message: (metaParts[7] || '').trim(),
    };

    // Parse status codes
    const nameMap = new Map();
    if (nameResult.stdout) {
      const tokens = nameResult.stdout.split('\0');
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const code = token[0];
        let filePath = '';
        let oldPath = null;
        if (code === 'R' || code === 'C') {
          oldPath = tokens[++i];
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
        nameMap.set(filePath, { status, code, oldPath: oldPath ? normalizePath(oldPath) : null });
      }
    }

    // Parse additions / deletions
    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    if (numResult.stdout) {
      const tokens = numResult.stdout.split('\0').filter(Boolean);
      for (const line of tokens) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const addStr = parts[0];
        const delStr = parts[1];
        let filePath = parts.slice(2).join('\t');
        filePath = normalizePath(filePath);

        const isBinary = addStr === '-' && delStr === '-';
        const additions = isBinary ? 0 : parseInt(addStr, 10) || 0;
        const deletions = isBinary ? 0 : parseInt(delStr, 10) || 0;

        totalAdditions += additions;
        totalDeletions += deletions;

        const meta = nameMap.get(filePath) || { status: 'modified', code: 'M', oldPath: null };
        files.push({
          path: filePath,
          status: meta.status,
          code: meta.code,
          oldPath: meta.oldPath,
          additions,
          deletions,
          isBinary,
        });
      }
    }

    return {
      ...commitMeta,
      files,
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
    };
  } catch {
    return null;
  }
}

/**
 * Get unified patch snippet for a commit.
 */
export async function getCommitPatch(hash = 'HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['show', '-p', hash], cwd);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Execute native git log with passed arguments.
 */
export async function runGitLog(args = [], cwd = process.cwd()) {
  return runGit(['log', ...args], cwd);
}

/**
 * Check if a cherry-pick operation is currently in progress.
 */
export async function isCherryPickInProgress(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
    return existsSync(join(absGitDir, 'CHERRY_PICK_HEAD'));
  } catch {
    return false;
  }
}

/**
 * Get active cherry-pick progress details, commit hash, and unmerged files.
 */
export async function getCherryPickProgress(cwd = process.cwd()) {
  try {
    const inProgress = await isCherryPickInProgress(cwd);
    if (!inProgress) {
      return { inProgress: false };
    }

    const { stdout: headOut } = await runGit(['rev-parse', '--short', 'CHERRY_PICK_HEAD'], cwd);
    const hash = headOut.trim();
    const details = await getCommitDetails(hash, cwd);

    const { stdout: statusOut } = await runGit(['status', '--porcelain=v1'], cwd);
    const conflictingFiles = [];
    for (const l of statusOut.split('\n')) {
      if (!l) continue;
      const code = l.slice(0, 2);
      if (['UU', 'AA', 'DU', 'UD', 'DD', 'AU', 'UA'].includes(code)) {
        conflictingFiles.push(normalizePath(l.slice(3).trim()));
      }
    }

    return {
      inProgress: true,
      hash,
      details,
      hasConflicts: conflictingFiles.length > 0,
      conflictingFiles,
    };
  } catch {
    return { inProgress: false };
  }
}

/**
 * Check for potential merge conflicts and working tree dirt before cherry-picking.
 */
export async function checkCherryPickConflicts(commitRef, cwd = process.cwd()) {
  const isDirty = await hasWorkingTreeChanges(cwd);

  try {
    // 1. Files modified by the target commit
    const { stdout: commitFilesOut } = await runGit(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitRef],
      cwd
    );
    const commitFiles = commitFilesOut.split('\0').map((f) => normalizePath(f.trim())).filter(Boolean);

    // 2. Check if any commit files have uncommitted working tree modifications
    const dirtyConflictingFiles = [];
    if (isDirty) {
      const { stdout: statusOut } = await runGit(['status', '--porcelain=v1', '-z', '-uall'], cwd);
      const dirtyFiles = new Set(
        statusOut
          .split('\0')
          .filter(Boolean)
          .map((entry) => normalizePath(entry.slice(3).trim()))
      );
      for (const cf of commitFiles) {
        if (dirtyFiles.has(cf)) {
          dirtyConflictingFiles.push(cf);
        }
      }
    }

    // 3. Check 3-way divergence conflicts against HEAD
    let base = null;
    let branchConflictingFiles = [];
    try {
      base = await getMergeBase(commitRef, 'HEAD', cwd);
      if (base) {
        const { stdout: headDiffOut } = await runGit(['diff', '--name-only', '-z', base, 'HEAD'], cwd);
        const headFiles = new Set(
          headDiffOut
            .split('\0')
            .map((f) => normalizePath(f.trim()))
            .filter(Boolean)
        );
        branchConflictingFiles = commitFiles.filter((f) => headFiles.has(f));
      }
    } catch {}

    const allConflicts = Array.from(new Set([...dirtyConflictingFiles, ...branchConflictingFiles]));

    return {
      hasConflicts: allConflicts.length > 0,
      conflictingFiles: allConflicts,
      dirtyConflictingFiles,
      branchConflictingFiles,
      isDirty,
      commitFiles,
    };
  } catch {
    return {
      hasConflicts: false,
      conflictingFiles: [],
      dirtyConflictingFiles: [],
      branchConflictingFiles: [],
      isDirty,
      commitFiles: [],
    };
  }
}

/**
 * Query recent commits from other branches not currently reachable from HEAD.
 */
export async function getRecentCommitsOtherBranches(limit = 25, cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      [
        'log',
        '--branches',
        '--not',
        'HEAD',
        `-n`,
        String(limit),
        '--pretty=format:%h%x00%H%x00%an%x00%cr%x00%s%x00%d',
      ],
      cwd
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, fullHash, author, date, subject, decorations] = line.split('\0');
        return {
          hash: hash || '',
          fullHash: fullHash || '',
          author: author || '',
          date: date || '',
          subject: subject || '',
          decorations: decorations ? decorations.trim() : '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Execute native git cherry-pick with passed arguments.
 */
export async function runGitCherryPick(args = [], cwd = process.cwd()) {
  return runGit(['cherry-pick', ...args], cwd);
}

/**
 * Execute native git cherry-pick --abort.
 */
export async function runGitCherryPickAbort(cwd = process.cwd()) {
  return runGit(['cherry-pick', '--abort'], cwd);
}

/**
 * Execute native git cherry-pick --continue.
 */
export async function runGitCherryPickContinue(cwd = process.cwd()) {
  return runGit(['cherry-pick', '--continue'], cwd);
}

/**
 * Execute native git cherry-pick --skip.
 */
export async function runGitCherryPickSkip(cwd = process.cwd()) {
  return runGit(['cherry-pick', '--skip'], cwd);
}

/**
 * Query repository tags with metadata (name, commit, type, author, date, subject, body).
 */
export async function getTags(options = {}, cwd = process.cwd()) {
  const { pattern = null, sort = '-creatordate' } = options;
  const fmt =
    '%(refname:short)%00%(objectname:short)%00%(*objectname:short)%00%(objecttype)%00%(taggername)%00%(authorname)%00%(creatordate:relative)%00%(subject)%00%(contents:body)';

  const args = ['tag', '-l', `--sort=${sort}`, `--format=${fmt}`];
  if (pattern) {
    args.push(pattern);
  }

  try {
    const { stdout } = await runGit(args, cwd);
    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [
          name,
          objectHash,
          derefHash,
          objectType,
          taggerName,
          authorName,
          relativeDate,
          subject,
          body,
        ] = line.split('\0');

        const isAnnotated = objectType === 'tag';
        const commitHash = derefHash || objectHash || '';
        const author = taggerName || authorName || '';

        return {
          name: name || '',
          tagHash: objectHash || '',
          commitHash,
          isAnnotated,
          type: isAnnotated ? 'annotated' : 'lightweight',
          author,
          date: relativeDate || '',
          subject: subject || '',
          body: body ? body.trim() : '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Create a new git tag (annotated or lightweight).
 */
export async function createTag(name, options = {}, cwd = process.cwd()) {
  const { annotated = false, message = '', target = 'HEAD', force = false } = options;
  const args = ['tag'];

  if (force) {
    args.push('-f');
  }

  if (annotated || message) {
    args.push('-a', name, '-m', message || name);
  } else {
    args.push(name);
  }

  if (target && target !== 'HEAD') {
    args.push(target);
  }

  return runGit(args, cwd);
}

/**
 * Delete a local git tag.
 */
export async function deleteTag(name, cwd = process.cwd()) {
  return runGit(['tag', '-d', name], cwd);
}

/**
 * Delete a remote git tag.
 */
export async function deleteRemoteTag(name, remote = 'origin', cwd = process.cwd()) {
  return runGit(['push', remote, '--delete', name], cwd);
}

/**
 * Push a specific tag to remote.
 */
export async function pushTag(name, remote = 'origin', cwd = process.cwd()) {
  return runGit(['push', remote, name], cwd);
}

/**
 * Execute native git tag with passed arguments.
 */
export async function runGitTag(args = [], cwd = process.cwd()) {
  return runGit(['tag', ...args], cwd);
}

/**
 * Extract repository name from a Git URL or filesystem path.
 */
export function extractRepoNameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const clean = url.trim().replace(/\/+$/, '');
  const match = clean.match(/[/\\:]([^/\\:]+?)(\.git)?$/);
  if (match && match[1]) {
    return match[1].replace(/\.git$/, '');
  }
  return 'repository';
}

/**
 * Inspect target directory status before clone to prevent non-empty collision errors.
 */
export function checkTargetDirectory(dirPath, cwd = process.cwd()) {
  const absPath = isAbsolute(dirPath) ? dirPath : resolve(cwd, dirPath);
  if (!existsSync(absPath)) {
    return { exists: false, isDirectory: false, isEmpty: true, fileCount: 0, absPath };
  }

  try {
    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      return { exists: true, isDirectory: false, isEmpty: false, fileCount: 1, absPath };
    }

    const files = readdirSync(absPath);
    return {
      exists: true,
      isDirectory: true,
      isEmpty: files.length === 0,
      fileCount: files.length,
      absPath,
    };
  } catch {
    return { exists: true, isDirectory: false, isEmpty: false, fileCount: 1, absPath };
  }
}

/**
 * Suggest a non-colliding directory name if target directory already exists and is non-empty.
 */
export function suggestAlternativeDirectory(baseDir, cwd = process.cwd()) {
  let counter = 1;
  let candidate = `${baseDir}-${counter}`;
  while (existsSync(resolve(cwd, candidate))) {
    counter++;
    candidate = `${baseDir}-${counter}`;
  }
  return candidate;
}

/**
 * Detect project framework/ecosystem post-clone to suggest relevant commands.
 */
export function detectProjectTech(targetPath) {
  const hints = [];
  try {
    if (existsSync(join(targetPath, 'package.json'))) {
      hints.push({ tech: 'Node.js', command: 'npm install' });
    }
    if (existsSync(join(targetPath, 'Cargo.toml'))) {
      hints.push({ tech: 'Rust', command: 'cargo build' });
    }
    if (existsSync(join(targetPath, 'go.mod'))) {
      hints.push({ tech: 'Go', command: 'go build' });
    }
    if (
      existsSync(join(targetPath, 'requirements.txt')) ||
      existsSync(join(targetPath, 'pyproject.toml'))
    ) {
      hints.push({ tech: 'Python', command: 'pip install -r requirements.txt' });
    }
    if (existsSync(join(targetPath, 'pom.xml'))) {
      hints.push({ tech: 'Java (Maven)', command: 'mvn compile' });
    }
    if (existsSync(join(targetPath, 'build.gradle'))) {
      hints.push({ tech: 'Java/Kotlin (Gradle)', command: './gradlew build' });
    }
  } catch {}
  return hints;
}

/**
 * Execute native git clone with passed arguments.
 */
export async function runGitClone(args = [], cwd = process.cwd()) {
  return runGit(['clone', ...args], cwd);
}

/**
 * Detect if a git revert is currently paused due to conflicts.
 */
export async function isRevertInProgress(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], cwd);
    const gitDir = stdout.trim();
    const absGitDir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
    return existsSync(join(absGitDir, 'REVERT_HEAD'));
  } catch {
    return false;
  }
}

/**
 * Get active revert progress details, commit hash, and unmerged files.
 */
export async function getRevertProgress(cwd = process.cwd()) {
  try {
    const inProgress = await isRevertInProgress(cwd);
    if (!inProgress) {
      return { inProgress: false };
    }

    const { stdout: headOut } = await runGit(['rev-parse', '--short', 'REVERT_HEAD'], cwd);
    const hash = headOut.trim();
    const details = await getCommitDetails(hash, cwd);

    const { stdout: statusOut } = await runGit(['status', '--porcelain=v1'], cwd);
    const conflictingFiles = [];
    for (const l of statusOut.split('\n')) {
      if (!l) continue;
      const code = l.slice(0, 2);
      if (['UU', 'AA', 'DU', 'UD', 'DD', 'AU', 'UA'].includes(code)) {
        conflictingFiles.push(normalizePath(l.slice(3).trim()));
      }
    }

    return {
      inProgress: true,
      hash,
      details,
      hasConflicts: conflictingFiles.length > 0,
      conflictingFiles,
    };
  } catch {
    return { inProgress: false };
  }
}

/**
 * Check if a commit is a merge commit (has multiple parent commits).
 */
export async function getCommitParents(commitRef, cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['rev-list', '--parents', '-n', '1', commitRef], cwd);
    const parts = stdout.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { isMerge: false, parents: [] };
    const [hash, ...parents] = parts;
    return {
      isMerge: parents.length > 1,
      hash,
      parents,
      parentCount: parents.length,
    };
  } catch {
    return { isMerge: false, parents: [], parentCount: 0 };
  }
}

/**
 * Check for potential merge conflicts, touched files, and dirty workspace before reverting.
 */
export async function checkRevertConflicts(commitRef, cwd = process.cwd()) {
  const isDirty = await hasWorkingTreeChanges(cwd);

  try {
    // 1. Files modified by the target commit
    const { stdout: commitFilesOut } = await runGit(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitRef],
      cwd
    );
    const commitFiles = commitFilesOut.split('\0').map((f) => normalizePath(f.trim())).filter(Boolean);

    // 2. Check if any commit files have uncommitted working tree modifications
    const dirtyConflictingFiles = [];
    if (isDirty) {
      const { stdout: statusOut } = await runGit(['status', '--porcelain=v1', '-z', '-uall'], cwd);
      const dirtyFiles = new Set(
        statusOut
          .split('\0')
          .filter(Boolean)
          .map((entry) => normalizePath(entry.slice(3).trim()))
      );
      for (const cf of commitFiles) {
        if (dirtyFiles.has(cf)) {
          dirtyConflictingFiles.push(cf);
        }
      }
    }

    // 3. Check subsequent changes on HEAD touching the same files
    let subsequentConflictingFiles = [];
    try {
      const { stdout: rangeOut } = await runGit(['diff', '--name-only', '-z', `${commitRef}..HEAD`], cwd);
      const modifiedSince = new Set(
        rangeOut
          .split('\0')
          .map((f) => normalizePath(f.trim()))
          .filter(Boolean)
      );
      subsequentConflictingFiles = commitFiles.filter((f) => modifiedSince.has(f));
    } catch {}

    const allConflicts = Array.from(new Set([...dirtyConflictingFiles, ...subsequentConflictingFiles]));

    return {
      hasConflicts: allConflicts.length > 0,
      conflictingFiles: allConflicts,
      dirtyConflictingFiles,
      subsequentConflictingFiles,
      isDirty,
      commitFiles,
    };
  } catch {
    return {
      hasConflicts: false,
      conflictingFiles: [],
      dirtyConflictingFiles: [],
      subsequentConflictingFiles: [],
      isDirty,
      commitFiles: [],
    };
  }
}

/**
 * Execute native git revert with passed arguments.
 */
export async function runGitRevert(args = [], cwd = process.cwd()) {
  return runGit(['revert', ...args], cwd);
}

/**
 * Execute native git revert --abort.
 */
export async function runGitRevertAbort(cwd = process.cwd()) {
  return runGit(['revert', '--abort'], cwd);
}

/**
 * Execute native git revert --continue.
 */
export async function runGitRevertContinue(cwd = process.cwd()) {
  return runGit(['revert', '--continue'], cwd);
}

/**
 * Execute native git revert --skip.
 */
export async function runGitRevertSkip(cwd = process.cwd()) {
  return runGit(['revert', '--skip'], cwd);
}

/**
 * Detect URL protocol label (HTTPS, SSH, FILE, GIT, or OTHER).
 */
export function getUrlProtocolLabel(url) {
  if (!url || typeof url !== 'string') return 'UNKNOWN';
  const u = url.trim();
  if (/^https:\/\//i.test(u)) return 'HTTPS';
  if (/^http:\/\//i.test(u)) return 'HTTP';
  if (/^ssh:\/\//i.test(u) || /^[\w.-]+@[\w.-]+:/i.test(u)) return 'SSH';
  if (/^file:\/\//i.test(u) || /^[a-zA-Z]:\\/i.test(u) || u.startsWith('/')) return 'FILE';
  if (/^git:\/\//i.test(u)) return 'GIT';
  return 'OTHER';
}

/**
 * Query all configured remotes with fetch and push URLs.
 */
export async function getConfiguredRemotes(cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['remote', '-v'], cwd);
    if (!stdout.trim()) return [];

    const remoteMap = new Map();
    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
      if (!match) continue;
      const [, name, url, type] = match;

      if (!remoteMap.has(name)) {
        remoteMap.set(name, {
          name,
          fetchUrl: '',
          pushUrl: '',
          protocol: getUrlProtocolLabel(url),
          isAsymmetric: false,
        });
      }

      const item = remoteMap.get(name);
      if (type === 'fetch') {
        item.fetchUrl = url;
        item.protocol = getUrlProtocolLabel(url);
      } else if (type === 'push') {
        item.pushUrl = url;
      }
    }

    for (const item of remoteMap.values()) {
      if (!item.pushUrl && item.fetchUrl) {
        item.pushUrl = item.fetchUrl;
      }
      if (!item.fetchUrl && item.pushUrl) {
        item.fetchUrl = item.pushUrl;
        item.protocol = getUrlProtocolLabel(item.pushUrl);
      }
      item.isAsymmetric = Boolean(item.fetchUrl && item.pushUrl && item.fetchUrl !== item.pushUrl);
    }

    return Array.from(remoteMap.values());
  } catch {
    return [];
  }
}

/**
 * Query local branches tracking a specific remote.
 */
export async function getBranchesTrackingRemote(remoteName, cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(
      ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)', 'refs/heads/'],
      cwd
    );
    if (!stdout.trim()) return [];

    const tracking = [];
    const prefix = `${remoteName}/`;

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const [localBranch, upstream] = line.split('\0');
      if (upstream && upstream.startsWith(prefix)) {
        tracking.push({
          localBranch,
          remoteBranch: upstream,
        });
      }
    }

    return tracking;
  } catch {
    return [];
  }
}

/**
 * Preview stale remote-tracking branches that would be pruned.
 */
export async function getPrunePreview(remoteName, cwd = process.cwd()) {
  try {
    const { stdout } = await runGit(['remote', 'prune', '--dry-run', remoteName], cwd);
    if (!stdout.trim()) return [];

    const staleBranches = [];
    for (const line of stdout.trim().split('\n')) {
      const match = line.match(/\[would prune\]\s+(\S+)/);
      if (match && match[1]) {
        staleBranches.push(match[1]);
      }
    }
    return staleBranches;
  } catch {
    return [];
  }
}

/**
 * Test connectivity and latency to a remote repository.
 */
export async function testRemoteConnection(remoteName, cwd = process.cwd()) {
  const start = Date.now();
  try {
    await runGit(['ls-remote', '--heads', remoteName], cwd);
    const latencyMs = Date.now() - start;
    return { reachable: true, latencyMs };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

/**
 * Execute native git remote with passed arguments.
 */
export async function runGitRemote(args = [], cwd = process.cwd()) {
  return runGit(['remote', ...args], cwd);
}

/**
 * Add a new remote to repository.
 */
export async function addRemote(name, url, cwd = process.cwd()) {
  return runGit(['remote', 'add', name, url], cwd);
}

/**
 * Remove an existing remote from repository.
 */
export async function removeRemote(name, cwd = process.cwd()) {
  return runGit(['remote', 'remove', name], cwd);
}

/**
 * Rename an existing remote.
 */
export async function renameRemote(oldName, newName, cwd = process.cwd()) {
  return runGit(['remote', 'rename', oldName, newName], cwd);
}

/**
 * Change URL of an existing remote.
 */
export async function setRemoteUrl(name, url, isPushOnly = false, cwd = process.cwd()) {
  const args = ['remote', 'set-url'];
  if (isPushOnly) {
    args.push('--push');
  }
  args.push(name, url);
  return runGit(args, cwd);
}

/**
 * Prune stale remote tracking branches.
 */
export async function pruneRemote(name, cwd = process.cwd()) {
  return runGit(['remote', 'prune', name], cwd);
}

/**
 * Inspect target directory status before git init to detect existing repositories and nested git structures.
 */
export async function checkInitTarget(targetPath = process.cwd(), cwd = process.cwd()) {
  const absPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const exists = existsSync(absPath);
  const isDirectRepo = exists && existsSync(join(absPath, '.git'));
  const hasGitignore = exists && existsSync(join(absPath, '.gitignore'));

  let isNestedRepo = false;
  let parentRepoPath = null;

  if (exists && !isDirectRepo) {
    try {
      const { stdout } = await runGit(['rev-parse', '--show-toplevel'], absPath);
      const topLevel = stdout.trim();
      if (topLevel && normalizePath(topLevel) !== normalizePath(absPath)) {
        isNestedRepo = true;
        parentRepoPath = topLevel;
      }
    } catch {
      // Not in any repository
    }
  }

  return {
    absPath,
    exists,
    isDirectRepo,
    isNestedRepo,
    parentRepoPath,
    hasGitignore,
  };
}

/**
 * Generate a smart, protective .gitignore based on universal security rules and detected project technologies.
 */
export function generateGitignoreContent(techHints = []) {
  const sections = [];

  // 1. Universal Security & Secrets (always included)
  sections.push(
    '# Secrets, Private Keys & Environment Configurations\n' +
      '.env\n' +
      '.env.*\n' +
      '*.key\n' +
      '*.pem\n' +
      '*.p12\n' +
      '*.p8\n' +
      '*.keystore\n' +
      'credentials.json\n' +
      'id_rsa*\n' +
      '*.ovpn'
  );

  // 2. OS & System Artifacts
  sections.push(
    '# Operating System Artifacts\n' +
      '.DS_Store\n' +
      'Thumbs.db\n' +
      'desktop.ini\n' +
      '*.tmp\n' +
      '*.bak'
  );

  // 3. IDEs & Editors
  sections.push(
    '# IDE & Editor Directories\n' +
      '.vscode/\n' +
      '.idea/\n' +
      '*.swp\n' +
      '*.swo'
  );

  // 4. Detected Technologies
  const techs = new Set((techHints || []).map((h) => h.tech));

  if (techs.has('Node.js')) {
    sections.push(
      '# Node.js\n' +
        'node_modules/\n' +
        'npm-debug.log*\n' +
        'yarn-debug.log*\n' +
        'yarn-error.log*\n' +
        'pnpm-debug.log*\n' +
        'dist/\n' +
        'build/\n' +
        '.npm'
    );
  }

  if (techs.has('Python')) {
    sections.push(
      '# Python\n' +
        '__pycache__/\n' +
        '*.py[cod]\n' +
        '*$py.class\n' +
        '.venv/\n' +
        'venv/\n' +
        'env/\n' +
        'dist/\n' +
        'build/\n' +
        '*.egg-info/'
    );
  }

  if (techs.has('Rust')) {
    sections.push(
      '# Rust\n' +
        'target/\n' +
        '**/*.rs.bk'
    );
  }

  if (techs.has('Go')) {
    sections.push(
      '# Go\n' +
        'bin/\n' +
        '*.exe\n' +
        '*.exe~\n' +
        '*.dll\n' +
        '*.so\n' +
        '*.dylib'
    );
  }

  return sections.join('\n\n') + '\n';
}

/**
 * Execute native git init with passed arguments.
 */
export async function runGitInit(args = [], cwd = process.cwd()) {
  return runGit(['init', ...args], cwd);
}



