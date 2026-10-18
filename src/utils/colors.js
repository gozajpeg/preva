// Zero-dependency terminal colors supporting NO_COLOR and TTY detection

const isColorSupported =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);

function style(start, end) {
  return (str) => (isColorSupported ? `\x1b[${start}m${str}\x1b[${end}m` : String(str));
}

export const colors = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: style(1, 22),
  dim: style(2, 22),
  italic: style(3, 23),
  underline: style(4, 24),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
  white: style(37, 39),
  gray: style(90, 39),
  bgRed: style(41, 49),
  bgYellow: style(43, 49),
};
