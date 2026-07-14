type ExclusiveProcessTarget = {
  label: string;
  pattern: string;
};

type ProcessMatch = {
  command: string;
  pid: number;
};

/**
 * Parses `ps` output into process records.
 *
 * @param {string} stdout
 * @returns {ProcessMatch[]}
 */
function parseProcessList(stdout: string): ProcessMatch[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/u.exec(line);
      if (!match) {
        return null;
      }
      return {
        command: match[2] ?? '',
        pid: Number(match[1]),
      };
    })
    .filter((match): match is ProcessMatch => (
      !!match &&
      Number.isInteger(match.pid) &&
      match.pid > 0 &&
      Boolean(match.command)
    ));
}

type CommandSegment = {
  separator: string;
  text: string;
};

/**
 * Strips one matching pair of surrounding quotes.
 *
 * @param {string} value
 * @returns {string}
 */
function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Returns a lowercase executable basename from a token.
 *
 * @param {string} token
 * @returns {string}
 */
function executableBaseName(token: string): string {
  const normalized = stripSurroundingQuotes(token).trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

/**
 * Splits a shell command by control separators while respecting quotes.
 *
 * @param {string} command
 * @returns {CommandSegment[]}
 */
function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let buffer = '';
  let separator = '';
  let quote: '"' | '\'' | null = null;
  let index = 0;
  while (index < command.length) {
    const character = command[index] ?? '';
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      buffer += character;
      index += 1;
      continue;
    }
    if (character === '"' || character === '\'') {
      quote = character;
      buffer += character;
      index += 1;
      continue;
    }
    const next = command[index + 1] ?? '';
    const isDoubleSeparator = (character === '&' && next === '&') || (character === '|' && next === '|');
    const isSingleSeparator = character === ';' || character === '|';
    if (isDoubleSeparator || isSingleSeparator) {
      segments.push({
        separator,
        text: buffer,
      });
      separator = isDoubleSeparator ? `${character}${next}` : character;
      buffer = '';
      index += isDoubleSeparator ? 2 : 1;
      continue;
    }
    buffer += character;
    index += 1;
  }
  segments.push({
    separator,
    text: buffer,
  });
  return segments;
}

/**
 * Finds shell-like tokens while keeping quoted groups intact.
 *
 * @param {string} commandSegment
 * @returns {string[]}
 */
function tokenizeCommandSegment(commandSegment: string): string[] {
  return commandSegment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
}

const MAX_HOST_DOCTOR_PARSE_DEPTH = 3;
const SHELL_EXECUTABLES = new Set(['bash', 'sh', 'zsh']);
const PNPM_EXECUTABLES = new Set(['pnpm', 'pnpm.exe']);
const NODE_EXECUTABLES = new Set(['node', 'node.exe']);

/**
 * Returns whether a token is a shell-style environment assignment.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isEnvironmentAssignmentToken(token: string): boolean {
  const normalized = stripSurroundingQuotes(token).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(normalized);
}

/**
 * Returns whether a shell flag token carries the `-c` command marker.
 *
 * @param {string} token
 * @returns {boolean}
 */
function shellFlagContainsCommand(token: string): boolean {
  const normalized = stripSurroundingQuotes(token).trim().toLowerCase();
  if (!normalized.startsWith('-') || normalized === '-') {
    return false;
  }
  if (normalized === '--command') {
    return true;
  }
  if (normalized.startsWith('--')) {
    return false;
  }
  return normalized.slice(1).includes('c');
}

/**
 * Returns whether the token is fully wrapped in one quote style.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isFullyQuotedToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '"' && last === '"') || (first === '\'' && last === '\'');
}

/**
 * Reads the command-position token index for one tokenized command.
 *
 * @param {{tokens: string[], startIndex: number}} options
 * @returns {number}
 */
function readCommandTokenIndex({
  tokens,
  startIndex = 0,
}: {
  tokens: string[];
  startIndex: number;
}): number {
  let index = startIndex;
  while (index < tokens.length && isEnvironmentAssignmentToken(tokens[index] ?? '')) {
    index += 1;
  }
  return index;
}

/**
 * Reads command-position invocation details from one command segment.
 *
 * @param {{depth?: number, tokens: string[]}} options
 * @returns {{baseName: string, index: number, tokens: string[]}}
 */
function readCommandInvocation({
  depth = 0,
  tokens,
}: {
  depth?: number;
  tokens: string[];
}): {baseName: string; index: number; tokens: string[]} {
  const commandIndex = readCommandTokenIndex({
    tokens,
    startIndex: 0,
  });
  if (commandIndex >= tokens.length) {
    return { baseName: '', index: -1, tokens };
  }
  const commandBaseName = executableBaseName(tokens[commandIndex] ?? '');
  if (!SHELL_EXECUTABLES.has(commandBaseName)) {
    return {
      baseName: commandBaseName,
      index: commandIndex,
      tokens,
    };
  }

  let shellIndex = commandIndex + 1;
  let sawCommandFlag = false;
  while (shellIndex < tokens.length) {
    const token = stripSurroundingQuotes(tokens[shellIndex] ?? '').trim();
    if (!token.startsWith('-') || token === '-') {
      break;
    }
    if (shellFlagContainsCommand(token)) {
      sawCommandFlag = true;
    }
    shellIndex += 1;
  }
  if (!sawCommandFlag || shellIndex >= tokens.length) {
    return { baseName: '', index: -1, tokens };
  }

  const shellCommandToken = tokens[shellIndex] ?? '';
  if (!isFullyQuotedToken(shellCommandToken)) {
    return {
      baseName: executableBaseName(shellCommandToken),
      index: shellIndex,
      tokens,
    };
  }
  if (depth >= MAX_HOST_DOCTOR_PARSE_DEPTH) {
    return {
      baseName: executableBaseName(shellCommandToken),
      index: shellIndex,
      tokens,
    };
  }
  const shellCommandText = stripSurroundingQuotes(shellCommandToken);
  const nestedTokens = tokenizeCommandSegment(shellCommandText);
  if (nestedTokens.length === 0) {
    return { baseName: '', index: -1, tokens };
  }
  return readCommandInvocation({
    depth: depth + 1,
    tokens: nestedTokens,
  });
}

/**
 * Checks whether a segment includes a supported host-doctor invocation shape.
 *
 * Supported forms:
 * - `asl-host-doctor`
 * - `pnpm asl-host-doctor`
 * - `pnpm exec asl-host-doctor`
 * - `node <path>/host-doctor.js`
 *
 * @param {string} commandSegment
 * @returns {boolean}
 */
function hasHostDoctorInvocation(commandSegment: string): boolean {
  const invocation = readCommandInvocation({
    tokens: tokenizeCommandSegment(commandSegment),
  });
  const invocationTokens = invocation.tokens;
  if (invocation.baseName === 'asl-host-doctor') {
    return true;
  }
  if (NODE_EXECUTABLES.has(invocation.baseName)) {
    const scriptBaseName = executableBaseName(invocationTokens[invocation.index + 1] ?? '');
    return scriptBaseName === 'host-doctor.js';
  }
  if (!PNPM_EXECUTABLES.has(invocation.baseName)) {
    return false;
  }
  const firstTokenAfterPnpm = executableBaseName(invocationTokens[invocation.index + 1] ?? '');
  if (firstTokenAfterPnpm === 'asl-host-doctor') {
    return true;
  }
  if (firstTokenAfterPnpm === 'exec') {
    return executableBaseName(invocationTokens[invocation.index + 2] ?? '') === 'asl-host-doctor';
  }
  return false;
}

/**
 * Removes the exact configured matcher argument from one carrier value.
 *
 * @param {{matcherArgument: string, value: string}} options
 * @returns {string}
 */
function stripMatcherFromCarrierValue({
  matcherArgument,
  value,
}: {
  matcherArgument: string;
  value: string;
}): {removed: boolean; value: string} {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return { removed: false, value };
  }
  const startsWithQuote = trimmedValue.startsWith('"') || trimmedValue.startsWith('\'');
  const endsWithMatchingQuote = (
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith('\'') && trimmedValue.endsWith('\''))
  );
  const unquotedValue = startsWithQuote && endsWithMatchingQuote
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedMatcherArgument = matcherArgument.toLowerCase();
  let removed = false;
  const sanitized = unquotedValue
    .split(',')
    .map((item) => item.trim())
    .filter((item) => {
      if (item.length === 0) {
        return false;
      }
      if (item.toLowerCase() !== normalizedMatcherArgument) {
        return true;
      }
      removed = true;
      return false;
    })
    .join(',');
  if (startsWithQuote && endsWithMatchingQuote) {
    return {
      removed,
      value: `${trimmedValue[0] ?? '"'}${sanitized}${trimmedValue[trimmedValue.length - 1] ?? '"'}`,
    };
  }
  return { removed, value: sanitized };
}

/**
 * Removes matcher echoes from host-doctor configuration carriers only.
 *
 * @param {{command: string, matcherArgument: string}} options
 * @returns {string}
 */
function stripHostDoctorExclusiveConfigurationEcho({
  command,
  matcherArgument,
}: {
  command: string;
  matcherArgument: string;
}): string {
  if (!matcherArgument.trim()) {
    return command;
  }
  const optionCarrierPattern = new RegExp(
    `(--exclusive-process(?:\\s+|=)(?:"[^"]*"|'[^']*'|\\S*))`,
    'giu',
  );
  const envCarrierPattern = new RegExp(
    `(ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES=(?:"[^"]*"|'[^']*'|\\S*))`,
    'giu',
  );
  let removedAny = false;
  const stripCarrier = (carrier: string, prefixPattern: RegExp): string => {
    const prefixMatch = carrier.match(prefixPattern);
    if (!prefixMatch) {
      return carrier;
    }
    const prefix = prefixMatch[0] ?? '';
    const value = carrier.slice(prefix.length);
    const stripped = stripMatcherFromCarrierValue({
      matcherArgument,
      value,
    });
    if (!stripped.removed) {
      return carrier;
    }
    removedAny = true;
    return `${prefix}${stripped.value}`;
  };
  const optionPrefixPattern = /^--exclusive-process(?:\s+|=)/u;
  const envPrefixPattern = /^ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES=/u;
  const sanitizedCommand = splitCommandSegments(command)
    .map((segment) => {
      if (!hasHostDoctorInvocation(segment.text)) {
        return `${segment.separator}${segment.text}`;
      }
      const sanitizedText = segment.text
        .replace(optionCarrierPattern, (carrier) => stripCarrier(carrier, optionPrefixPattern))
        .replace(envCarrierPattern, (carrier) => stripCarrier(carrier, envPrefixPattern));
      return `${segment.separator}${sanitizedText}`;
    })
    .join('');
  return removedAny ? sanitizedCommand : command;
}

/**
 * Finds running commands that genuinely match an exclusive-process pattern.
 *
 * The matcher ignores the current process id and suppresses only exact
 * host-doctor configuration echoes carried by `--exclusive-process` or
 * `ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES`.
 *
 * @param {{currentPid?: number, processListText: string, target: ExclusiveProcessTarget}} options
 * @returns {ProcessMatch[]}
 */
function findExclusiveProcessMatches({
  currentPid = process.pid,
  processListText,
  target,
}: {
  currentPid?: number;
  processListText: string;
  target: ExclusiveProcessTarget;
}): ProcessMatch[] {
  const pattern = target.pattern.toLowerCase();
  const matcherArgument = `${target.label}:${target.pattern}`;
  return parseProcessList(processListText)
    .filter((processInfo) => (
      processInfo.pid !== currentPid &&
      stripHostDoctorExclusiveConfigurationEcho({
        command: processInfo.command,
        matcherArgument,
      }).toLowerCase().includes(pattern)
    ));
}

export {
  findExclusiveProcessMatches,
};

export type {
  ExclusiveProcessTarget,
  ProcessMatch,
};
