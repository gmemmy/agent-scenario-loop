const fsp = require('node:fs/promises');
const path = require('node:path');

const { assertValidJson } = require('./schema-validator');

/**
 * Writes schema-validated JSON with stable formatting.
 *
 * @param {{filePath: string, value: unknown, schema: Record<string, unknown>, label: string}} options
 * @returns {Promise<string>}
 */
async function writeJsonArtifact({ filePath, value, schema, label }) {
  assertValidJson(value, schema, label);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * Writes text artifacts with parent-directory creation.
 *
 * @param {{filePath: string, content: string}} options
 * @returns {Promise<string>}
 */
async function writeTextArtifact({ filePath, content }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
  return filePath;
}

/**
 * Copies a raw evidence artifact with parent-directory creation.
 *
 * @param {{sourcePath: string, filePath: string}} options
 * @returns {Promise<string>}
 */
async function copyRawArtifact({ sourcePath, filePath }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.copyFile(sourcePath, filePath);
  return filePath;
}

/**
 * Creates an artifact writer object that satisfies the artifact-writer port.
 *
 * @returns {{writeJson: typeof writeJsonArtifact, writeText: typeof writeTextArtifact, copyRaw: typeof copyRawArtifact}}
 */
function createArtifactWriter() {
  return {
    writeJson: writeJsonArtifact,
    writeText: writeTextArtifact,
    copyRaw: copyRawArtifact,
  };
}

module.exports = {
  copyRawArtifact,
  createArtifactWriter,
  writeJsonArtifact,
  writeTextArtifact,
};
