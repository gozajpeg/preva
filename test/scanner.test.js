import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gitignoreToRegex, matchesGitignore, scanFiles } from '../src/utils/scanner.js';

describe('scanner - gitignore pattern matching', () => {
  it('converts extension patterns correctly', () => {
    const { regex } = gitignoreToRegex('*.log');
    assert.strictEqual(matchesGitignore('app.log', [{ regex, isNegated: false }]), true);
    assert.strictEqual(matchesGitignore('logs/server.log', [{ regex, isNegated: false }]), true);
    assert.strictEqual(matchesGitignore('app.js', [{ regex, isNegated: false }]), false);
  });

  it('converts directory patterns correctly', () => {
    const { regex } = gitignoreToRegex('temp/');
    assert.strictEqual(matchesGitignore('temp/file.txt', [{ regex, isNegated: false }]), true);
    assert.strictEqual(matchesGitignore('sub/temp/file.txt', [{ regex, isNegated: false }]), true);
    assert.strictEqual(matchesGitignore('temp.txt', [{ regex, isNegated: false }]), false);
  });

  it('handles negation rules', () => {
    const r1 = gitignoreToRegex('*.log');
    const r2 = gitignoreToRegex('!important.log');
    const patterns = [r1, r2];

    assert.strictEqual(matchesGitignore('debug.log', patterns), true);
    assert.strictEqual(matchesGitignore('important.log', patterns), false);
  });
});

describe('scanner - scanFiles sensitivity flags', () => {
  it('flags sensitive files and unchecks them by default', () => {
    const files = [
      { path: '.env', status: 'new', isTracked: false },
      { path: '.env.local', status: 'new', isTracked: false },
      { path: 'keys/id_rsa', status: 'modified', isTracked: true },
      { path: 'certs/server.pem', status: 'new', isTracked: false },
      { path: 'credentials.json', status: 'new', isTracked: false },
      { path: 'src/index.js', status: 'modified', isTracked: true },
      { path: 'README.md', status: 'modified', isTracked: true },
    ];

    const scanned = scanFiles(files, process.cwd());

    const envFile = scanned.find((f) => f.path === '.env');
    assert.strictEqual(envFile.flagged, true);
    assert.strictEqual(envFile.defaultChecked, false);

    const rsaFile = scanned.find((f) => f.path === 'keys/id_rsa');
    assert.strictEqual(rsaFile.flagged, true);
    assert.strictEqual(rsaFile.defaultChecked, false);

    const credsFile = scanned.find((f) => f.path === 'credentials.json');
    assert.strictEqual(credsFile.flagged, true);
    assert.strictEqual(credsFile.defaultChecked, false);

    const codeFile = scanned.find((f) => f.path === 'src/index.js');
    assert.strictEqual(codeFile.flagged, false);
    assert.strictEqual(codeFile.defaultChecked, true);

    const readmeFile = scanned.find((f) => f.path === 'README.md');
    assert.strictEqual(readmeFile.flagged, false);
    assert.strictEqual(readmeFile.defaultChecked, true);
  });

  it('flags build artifacts and heavy directories', () => {
    const files = [
      { path: 'node_modules/package/index.js', status: 'new', isTracked: false },
      { path: 'dist/bundle.js', status: 'new', isTracked: false },
      { path: 'src/components/Button.js', status: 'modified', isTracked: true },
    ];

    const scanned = scanFiles(files, process.cwd());

    const nm = scanned.find((f) => f.path.startsWith('node_modules'));
    assert.strictEqual(nm.flagged, true);
    assert.strictEqual(nm.defaultChecked, false);

    const dist = scanned.find((f) => f.path.startsWith('dist'));
    assert.strictEqual(dist.flagged, true);
    assert.strictEqual(dist.defaultChecked, false);

    const normal = scanned.find((f) => f.path.startsWith('src'));
    assert.strictEqual(normal.flagged, false);
    assert.strictEqual(normal.defaultChecked, true);
  });
});
