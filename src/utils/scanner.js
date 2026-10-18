import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Known sensitive file regex patterns (evaluated against filename and path)
const SENSITIVE_PATTERNS = [
  { pattern: /(^|\/)\.env(\..+)?$/i, reason: 'environment variable file' },
  { pattern: /\.(pem|key|p12|pfx|pkcs12|keystore|jks|p8|ovpn)$/i, reason: 'private key / certificate / VPN profile' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(_.*|\.pub)?$/i, reason: 'SSH key file' },
  { pattern: /(^|\/)(credentials|client_secret|service-?account|serviceAccountKey|google-services).*\.json$/i, reason: 'API credentials / service account' },
  { pattern: /(^|\/)\.(npmrc|pypirc|netrc)$/i, reason: 'package manager / auth token config' },
  { pattern: /(^|\/)local\.settings\.json$/i, reason: 'local secrets file' },
  { pattern: /(^|\/)npm-debug\.log$/i, reason: 'debug log' },
];

// Heavy directories that are usually build artifacts or dependencies
const HEAVY_DIR_PATTERNS = [
  { pattern: /(^|\/)(node_modules|dist|build|target|\.next|\.nuxt|\.venv)\//i, reason: 'heavy build directory / dependencies' },
];

/**
 * Convert a gitignore glob pattern to a standard regular expression.
 */
export function gitignoreToRegex(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith('#')) return null;

  const isNegated = p.startsWith('!');
  if (isNegated) p = p.slice(1).trim();

  // Trailing slash indicates directory only
  const isDirOnly = p.endsWith('/');
  if (isDirOnly) p = p.slice(0, -1);

  // Escape special regex characters except * and ?
  let regexStr = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  if (p.startsWith('/')) {
    regexStr = '^' + regexStr.slice(1);
  } else {
    regexStr = '(^|/)' + regexStr;
  }

  if (isDirOnly) {
    regexStr += '(/|$)';
  } else {
    regexStr += '($|/)';
  }

  try {
    return { regex: new RegExp(regexStr), isNegated };
  } catch {
    return null;
  }
}

/**
 * Read and parse .gitignore patterns from the given root directory.
 */
export function loadGitignorePatterns(rootPath) {
  const gitignorePath = join(rootPath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  try {
    const content = readFileSync(gitignorePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map(gitignoreToRegex)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a file path matches any .gitignore pattern.
 */
export function matchesGitignore(filePath, parsedPatterns) {
  let matched = false;
  for (const { regex, isNegated } of parsedPatterns) {
    if (regex.test(filePath)) {
      matched = !isNegated;
    }
  }
  return matched;
}

/**
 * Scan a list of files and annotate with sensitivity flags and default checked state.
 */
export function scanFiles(files, cwd = process.cwd()) {
  const gitignorePatterns = loadGitignorePatterns(cwd);

  return files.map((file) => {
    const filePath = file.path;

    // 1. Check known sensitive patterns
    for (const { pattern, reason } of SENSITIVE_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          ...file,
          flagged: true,
          reason,
          defaultChecked: false,
        };
      }
    }

    // 2. Check heavy build directories
    for (const { pattern, reason } of HEAVY_DIR_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          ...file,
          flagged: true,
          reason,
          defaultChecked: false,
        };
      }
    }

    // 3. Check tracked files that match .gitignore
    if (file.isTracked && gitignorePatterns.length > 0 && matchesGitignore(filePath, gitignorePatterns)) {
      return {
        ...file,
        flagged: true,
        reason: 'matches .gitignore (tracked)',
        defaultChecked: false,
      };
    }

    // Safe by default
    return {
      ...file,
      flagged: false,
      reason: '',
      defaultChecked: true,
    };
  });
}
