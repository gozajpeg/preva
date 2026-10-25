import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripAnsi, truncateAnsi } from '../src/utils/ui.js';
import { colors } from '../src/utils/colors.js';

describe('UI ANSI string utilities and terminal width safety', () => {
  it('strips basic ANSI escape sequences', () => {
    const raw = 'Hello world';
    const colored = `${colors.green('Hello')} ${colors.bold('world')}`;
    assert.strictEqual(stripAnsi(raw), 'Hello world');
    assert.strictEqual(stripAnsi(colored), 'Hello world');
  });

  it('handles empty or non-string inputs safely', () => {
    assert.strictEqual(stripAnsi(''), '');
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
  });

  it('does not truncate strings shorter than maxCols', () => {
    const short = 'Short text';
    assert.strictEqual(truncateAnsi(short, 20), short);
    const colored = colors.cyan(short);
    assert.strictEqual(truncateAnsi(colored, 20), colored);
  });

  it('truncates plain string exceeding maxCols with ellipsis', () => {
    const text = '123456789012345'; // 15 chars
    const truncated = truncateAnsi(text, 10);
    assert.strictEqual(stripAnsi(truncated).length, 10);
    assert.strictEqual(truncated, '1234567...');
  });

  it('truncates colored string without breaking ANSI escape codes', () => {
    const text = '\x1b[32mabcdefghij\x1b[39m\x1b[33mklmnopqrst\x1b[39m'; // 20 chars visual
    const truncated = truncateAnsi(text, 12);
    assert.strictEqual(stripAnsi(truncated).length, 12);
    assert.ok(truncated.endsWith('...\x1b[0m'));
    assert.ok(truncated.startsWith('\x1b[32m'));
  });

  it('handles edge case where maxCols is smaller than ellipsis length', () => {
    const text = 'Hello world';
    const truncated = truncateAnsi(text, 2);
    assert.ok(stripAnsi(truncated).length <= 3);
  });

  it('strips private mode cursor sequences and compound codes', () => {
    const hidden = '\x1b[?25lHidden\x1b[?25h';
    assert.strictEqual(stripAnsi(hidden), 'Hidden');
    const compound = '\x1b[1;32;40mStyled\x1b[0m';
    assert.strictEqual(stripAnsi(compound), 'Styled');
  });

  it('frame rendering does not emit trailing newline to avoid off-by-one terminal scrolling', () => {
    const lines = ['Line 1', 'Line 2', 'Line 3'];
    const rendered = lines.map((line) => `\x1b[2K\r${line}`).join('\n');
    assert.ok(!rendered.endsWith('\n'), 'Rendered prompt frame must NOT end with trailing newline');
  });

  it('sanitizes carriage returns and converts newlines into spaces to guarantee single row per item', () => {
    const multiline = 'Subject line\r\nSecond line\nThird line\r';
    const sanitized = truncateAnsi(multiline, 100);
    assert.strictEqual(sanitized.includes('\r'), false, 'Must not contain carriage returns');
    assert.strictEqual(sanitized.includes('\n'), false, 'Must not contain newlines');
    assert.strictEqual(sanitized, 'Subject line Second line Third line');
  });
});
