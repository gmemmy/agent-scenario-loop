const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  copyRawArtifact,
  createArtifactWriter,
  writeJsonArtifact,
  writeTextArtifact,
} = require('../artifact-writer');
const { ARTIFACT_WRITER_PORT, validatePortImplementation } = require('../ports');
const { SCHEMAS, SchemaValidationError } = require('../schema-validator');

type TestContext = import('node:test').TestContext;

test('writes schema-valid json artifacts with stable formatting', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-artifact-writer-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const filePath = path.join(outputDir, 'health.json');

  const writtenPath = await writeJsonArtifact({
    filePath,
    schema: SCHEMAS.health,
    label: 'Health artifact',
    value: {
      schemaVersion: '1.0.0',
      scenarioId: 'app-startup',
      runId: 'run-1',
      healthStatus: 'passed',
      checks: [{ name: 'planner_compatibility', status: 'passed', source: 'planner' }],
    },
  });

  assert.equal(writtenPath, filePath);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).healthStatus, 'passed');
  assert.match(fs.readFileSync(filePath, 'utf8'), /\n$/u);
});

test('refuses to write invalid json artifacts', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-invalid-artifact-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const filePath = path.join(outputDir, 'health.json');

  await assert.rejects(
    writeJsonArtifact({
      filePath,
      schema: SCHEMAS.health,
      label: 'Health artifact',
      value: {
        schemaVersion: '1.0.0',
        scenarioId: 'app-startup',
        runId: 'run-1',
        healthStatus: 'unknown',
        checks: [],
      },
    }),
    SchemaValidationError,
  );
  assert.equal(fs.existsSync(filePath), false);
});

test('writes text artifacts with parent directories', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-text-artifact-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const filePath = path.join(outputDir, 'nested', 'agent-summary.md');

  await writeTextArtifact({
    filePath,
    content: '# agent summary\n',
  });

  assert.equal(fs.readFileSync(filePath, 'utf8'), '# agent summary\n');
});

test('copies raw artifacts and satisfies the artifact writer port', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-raw-artifact-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const sourcePath = path.join(outputDir, 'source.log');
  const filePath = path.join(outputDir, 'raw', 'device.log');
  await fsp.writeFile(sourcePath, 'device log\n', 'utf8');

  await copyRawArtifact({
    sourcePath,
    filePath,
  });

  assert.equal(fs.readFileSync(filePath, 'utf8'), 'device log\n');
  assert.deepEqual(
    validatePortImplementation({
      name: 'artifact writer',
      implementation: createArtifactWriter(),
      requiredMethods: ARTIFACT_WRITER_PORT,
    }),
    {
      valid: true,
      name: 'artifact writer',
      missingMethods: [],
    },
  );
});
