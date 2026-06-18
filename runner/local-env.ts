const fs = require('node:fs');
const path = require('node:path');

type LocalEnvLoadOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fileName?: string;
  override?: boolean;
};

type LoadedLocalEnvFile = {
  filePath: string;
  keys: string[];
};

const LOCAL_ENV_FILE_NAME = '.asl.local.env';
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Finds the nearest ASL local env file from a working directory upward.
 *
 * @param {string} cwd
 * @param {string} fileName
 * @returns {string | null}
 */
function findNearestLocalEnvFile(
  cwd: string = process.cwd(),
  fileName: string = LOCAL_ENV_FILE_NAME,
): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, fileName);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Missing local env files are expected on CI and fresh installs.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Removes matching single or double quotes from an env file value.
 *
 * @param {string} value
 * @returns {string}
 */
function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parses one simple KEY=value line from an ASL local env file.
 *
 * @param {string} line
 * @returns {{key: string, value: string} | null}
 */
function parseLocalEnvLine(line: string): {key: string; value: string} | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const exportPrefix = 'export ';
  const assignment = trimmed.startsWith(exportPrefix)
    ? trimmed.slice(exportPrefix.length).trim()
    : trimmed;
  const equalsIndex = assignment.indexOf('=');
  if (equalsIndex <= 0) {
    return null;
  }

  const key = assignment.slice(0, equalsIndex).trim();
  if (!ENV_KEY_PATTERN.test(key)) {
    return null;
  }

  return {
    key,
    value: unquoteEnvValue(assignment.slice(equalsIndex + 1)),
  };
}

/**
 * Loads `.asl.local.env` into the provided environment without overriding explicit values.
 *
 * @param {LocalEnvLoadOptions} options
 * @returns {LoadedLocalEnvFile | null}
 */
function loadAslLocalEnv({
  cwd = process.cwd(),
  env = process.env,
  fileName = LOCAL_ENV_FILE_NAME,
  override = false,
}: LocalEnvLoadOptions = {}): LoadedLocalEnvFile | null {
  const filePath = findNearestLocalEnvFile(cwd, fileName);
  if (!filePath) {
    return null;
  }

  const keys: string[] = [];
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseLocalEnvLine(line);
    if (!parsed) {
      continue;
    }
    if (!override && Object.prototype.hasOwnProperty.call(env, parsed.key)) {
      continue;
    }
    env[parsed.key] = parsed.value;
    keys.push(parsed.key);
  }

  return { filePath, keys };
}

/**
 * Reads the first non-empty environment value for a list of supported names.
 *
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function readEnvValue(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Reads a CLI value first, then falls back to environment names.
 *
 * @param {unknown} value
 * @param {string[]} envNames
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function readStringArgOrEnv(
  value: unknown,
  envNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : readEnvValue(envNames, env);
}

/**
 * Returns true when a CLI flag or environment value enables an option.
 *
 * @param {unknown} value
 * @param {string[]} envNames
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function readBooleanArgOrEnv(
  value: unknown,
  envNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value === true || value === 'true' || value === '1') {
    return true;
  }
  const envValue = readEnvValue(envNames, env);
  return envValue === '1' || envValue === 'true' || envValue === 'yes';
}

export {
  LOCAL_ENV_FILE_NAME,
  findNearestLocalEnvFile,
  loadAslLocalEnv,
  parseLocalEnvLine,
  readBooleanArgOrEnv,
  readEnvValue,
  readStringArgOrEnv,
};

export type {
  LoadedLocalEnvFile,
  LocalEnvLoadOptions,
};
