type UsageOutput = {
  write: (message: string) => unknown;
};

/**
 * Returns true when argv asks for CLI help.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function hasHelpFlag(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Writes newline-terminated usage text to the chosen output stream.
 *
 * @param {string[]} lines
 * @param {UsageOutput} [output]
 * @returns {void}
 */
function writeUsage(lines: string[], output: UsageOutput = process.stderr): void {
  output.write(`${lines.join('\n')}\n`);
}

export {
  hasHelpFlag,
  writeUsage,
};

export type {
  UsageOutput,
};
