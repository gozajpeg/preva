import * as readline from 'node:readline';
import { colors } from './colors.js';

/**
 * Check if the current process is in an interactive terminal.
 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Interactive Multi-Select Checkbox Prompt using native Node readline & raw mode.
 */
export function checkboxList({ message, choices, pageSize = 15 }) {
  if (!isInteractive()) {
    throw new Error(
      'Interactive prompt unavailable in non-interactive environment (no TTY).\nRun with an interactive terminal to use preva preview.'
    );
  }

  return new Promise((resolve) => {
    const items = choices.map((c) => ({
      name: c.name || c.path,
      value: c.value !== undefined ? c.value : c.path,
      checked: Boolean(c.checked),
      flagged: Boolean(c.flagged),
      reason: c.reason || '',
      status: c.status || '',
    }));

    let cursor = 0;
    let pageOffset = 0;
    let renderedLineCount = 0;

    // Save previous raw mode state
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    function cleanup() {
      // Show cursor
      process.stdout.write('\x1b[?25h');
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(Boolean(wasRaw));
      }
      process.stdin.pause();
    }

    function render(firstTime = false) {
      // Clear previous lines
      if (!firstTime && renderedLineCount > 0) {
        process.stdout.write(`\x1b[${renderedLineCount}A`);
      }

      const outputLines = [];

      // Header
      outputLines.push(
        `${colors.green('?')} ${colors.bold(message)} ${colors.dim(
          '(<space> toggle, <a> toggle all, <enter> confirm)'
        )}`
      );

      // Adjust pagination window
      if (cursor < pageOffset) {
        pageOffset = cursor;
      } else if (cursor >= pageOffset + pageSize) {
        pageOffset = cursor - pageSize + 1;
      }

      const visibleItems = items.slice(pageOffset, pageOffset + pageSize);

      visibleItems.forEach((item, index) => {
        const actualIndex = pageOffset + index;
        const isCurrent = actualIndex === cursor;
        const pointer = isCurrent ? colors.cyan('❯ ') : '  ';
        const checkbox = item.checked ? colors.green('[x] ') : colors.gray('[ ] ');

        let statusText = '';
        if (item.status === 'new') statusText = colors.green(' (new)');
        else if (item.status === 'deleted') statusText = colors.red(' (deleted)');
        else if (item.status === 'renamed') statusText = colors.yellow(' (renamed)');
        else if (item.status) statusText = colors.cyan(` (${item.status})`);

        let flagNotice = '';
        if (item.flagged) {
          flagNotice = colors.yellow(` [flagged: ${item.reason || 'sensitive'}]`);
        }

        const nameText = isCurrent ? colors.bold(item.name) : item.name;
        outputLines.push(`${pointer}${checkbox}${nameText}${statusText}${flagNotice}`);
      });

      // Pagination indicators
      const remainingBelow = items.length - (pageOffset + pageSize);
      const remainingAbove = pageOffset;
      if (items.length > pageSize) {
        const hints = [];
        if (remainingAbove > 0) hints.push(`▲ ${remainingAbove} above`);
        if (remainingBelow > 0) hints.push(`▼ ${remainingBelow} below`);
        outputLines.push(colors.dim(`  (${hints.join(' | ')})`));
      }

      renderedLineCount = outputLines.length;
      process.stdout.write(outputLines.map((line) => `\x1b[2K\r${line}`).join('\n') + '\n');
    }

    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = cursor > 0 ? cursor - 1 : items.length - 1;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = cursor < items.length - 1 ? cursor + 1 : 0;
        render();
      } else if (key.name === 'space') {
        items[cursor].checked = !items[cursor].checked;
        render();
      } else if (str === 'a' || str === 'A') {
        const hasUnchecked = items.some((i) => !i.checked);
        items.forEach((i) => {
          i.checked = hasUnchecked;
        });
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const selected = items.filter((i) => i.checked).map((i) => i.value);
        resolve(selected);
      }
    }

    process.stdin.on('keypress', onKeypress);
    render(true);
  });
}

/**
 * Interactive Yes/No Confirmation Prompt.
 */
export function confirmPrompt({ message, defaultValue = false }) {
  if (!isInteractive()) {
    throw new Error(
      'Interactive prompt unavailable in non-interactive environment (no TTY).\nRun with an interactive terminal to use preva preview.'
    );
  }

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const hint = defaultValue ? '[Y/n]' : '[y/N]';
    process.stdout.write(`${colors.green('?')} ${colors.bold(message)} ${colors.cyan(hint)}: `);

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(Boolean(wasRaw));
      }
      process.stdin.pause();
    }

    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }

      let answer = defaultValue;
      let char = '';

      if (key.name === 'y' || str === 'y' || str === 'Y') {
        answer = true;
        char = 'y';
      } else if (key.name === 'n' || str === 'n' || str === 'N') {
        answer = false;
        char = 'n';
      } else if (key.name === 'return' || key.name === 'enter') {
        answer = defaultValue;
        char = defaultValue ? 'y' : 'n';
      } else {
        return; // Ignore other keys
      }

      cleanup();
      process.stdout.write(`${char}\n`);
      resolve(answer);
    }

    process.stdin.on('keypress', onKeypress);
  });
}

/**
 * Interactive Single-Select Prompt using native Node readline & raw mode.
 */
export function selectPrompt({ message, choices, pageSize = 12 }) {
  if (!isInteractive()) {
    throw new Error(
      'Interactive prompt unavailable in non-interactive environment (no TTY).\nRun with an interactive terminal to use preva preview.'
    );
  }

  return new Promise((resolve) => {
    const items = choices.map((c) => {
      if (typeof c === 'string') {
        return { name: c, value: c, description: '' };
      }
      return {
        name: c.name || c.value,
        value: c.value,
        description: c.description || '',
      };
    });

    let cursor = 0;
    let pageOffset = 0;
    let renderedLineCount = 0;

    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    function cleanup() {
      process.stdout.write('\x1b[?25h');
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(Boolean(wasRaw));
      }
      process.stdin.pause();
    }

    function render(firstTime = false) {
      if (!firstTime && renderedLineCount > 0) {
        process.stdout.write(`\x1b[${renderedLineCount}A`);
      }

      const outputLines = [];
      outputLines.push(
        `${colors.green('?')} ${colors.bold(message)} ${colors.dim('(Use arrow keys, <enter> to select)')}`
      );

      if (cursor < pageOffset) {
        pageOffset = cursor;
      } else if (cursor >= pageOffset + pageSize) {
        pageOffset = cursor - pageSize + 1;
      }

      const visibleItems = items.slice(pageOffset, pageOffset + pageSize);

      visibleItems.forEach((item, index) => {
        const actualIndex = pageOffset + index;
        const isCurrent = actualIndex === cursor;
        const pointer = isCurrent ? colors.cyan('❯ ') : '  ';
        const nameText = isCurrent ? colors.bold(colors.cyan(item.name)) : item.name;
        const descText = item.description ? ` ${colors.dim(`- ${item.description}`)}` : '';
        outputLines.push(`${pointer}${nameText}${descText}`);
      });

      const remainingBelow = items.length - (pageOffset + pageSize);
      const remainingAbove = pageOffset;
      if (items.length > pageSize) {
        const hints = [];
        if (remainingAbove > 0) hints.push(`▲ ${remainingAbove} above`);
        if (remainingBelow > 0) hints.push(`▼ ${remainingBelow} below`);
        outputLines.push(colors.dim(`  (${hints.join(' | ')})`));
      }

      renderedLineCount = outputLines.length;
      process.stdout.write(outputLines.map((line) => `\x1b[2K\r${line}`).join('\n') + '\n');
    }

    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = cursor > 0 ? cursor - 1 : items.length - 1;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = cursor < items.length - 1 ? cursor + 1 : 0;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(items[cursor].value);
      }
    }

    process.stdin.on('keypress', onKeypress);
    render(true);
  });
}

/**
 * Text Input Prompt using native Node readline interface.
 */
export function inputPrompt({ message, defaultValue = '', placeholder = '', allowEmpty = true }) {
  if (!isInteractive()) {
    throw new Error('Interactive prompt unavailable in non-interactive environment (no TTY).');
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const hint = placeholder ? ` ${colors.dim(`(${placeholder})`)}` : '';
    const defaultHint = defaultValue ? ` ${colors.dim(`[${defaultValue}]`)}` : '';
    const promptText = `${colors.green('?')} ${colors.bold(message)}${hint}${defaultHint}: `;

    function ask() {
      rl.question(promptText, (answer) => {
        const val = answer.trim() || defaultValue;
        if (!allowEmpty && !val) {
          console.log(colors.yellow('  This field is required. Please enter a value.'));
          ask();
          return;
        }
        rl.close();
        resolve(val);
      });
    }

    ask();
  });
}
