#!/usr/bin/env node

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assembleCiEvidencePack } = require('../core/ci-evidence-pack-assembler');
const { parseCiEvidencePackBytes } = require('../core/ci-evidence-pack');
const { readCiEvidencePublicationReceipt } = require('../core/ci-evidence-publication-receipt');
const {
  evaluateCiEvidencePublicationSummary,
  renderCiEvidencePublicationSummary,
} = require('../core/ci-evidence-publication-summary');
const { hasHelpFlag, writeUsage } = require('./cli');

import type { CiEvidencePack, CiEvidencePackBuildInput } from '../core/ci-evidence-pack';
import type { CiEvidencePublicationReceipt } from '../core/ci-evidence-publication-receipt';
import type { CiEvidencePublicationSummaryEvaluation } from '../core/ci-evidence-publication-summary';

export const usage = [
  'Usage: asl-ci-evidence-pack <subcommand> [options]',
  '',
  'Subcommands:',
  '  assemble --request <request.json>',
  '  summarize --pack <ci-evidence-pack.json> --receipt <ci-evidence-publication-receipt.json> [--out <ci-evidence-publication-summary.md>]',
  '',
  'Consumes existing artifacts and writes a CI evidence pack or publication summary.',
  '',
  'Exit codes:',
  '  0  current assemble gate passed, or publication evidence evaluation passed',
  '  1  evidence, publication, or I/O failure',
  '  2  usage or request shape failure',
];

export class CiEvidencePackCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CiEvidencePackCliError';
    this.exitCode = exitCode;
  }
}

export type AssembleCliArgs = {
  readonly command: 'assemble';
  readonly requestPath: string;
};

export type SummarizeCliArgs = {
  readonly command: 'summarize';
  readonly packPath: string;
  readonly receiptPath: string;
  readonly outPath?: string;
};

export type HelpCliArgs = {
  readonly command: 'help';
};

export type CiEvidencePackCliArgs = AssembleCliArgs | SummarizeCliArgs | HelpCliArgs;

export type CiEvidencePackAssembleRequest = {
  readonly artifactRoot: string;
  readonly outDir: string;
  readonly input: CiEvidencePackBuildInput;
};

export type CliIo = {
  stdout: { write: (chunk: string | Uint8Array) => unknown };
  stderr: { write: (chunk: string | Uint8Array) => unknown };
};

export type FileSystemPort = {
  readFileSync: (filePath: string) => Buffer;
  writeFileSync: (filePath: string, contents: string | Uint8Array) => void;
  mkdirSync: (dirPath: string, options?: { recursive: boolean }) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (filePath: string) => void;
  existsSync?: (filePath: string) => boolean;
  realpathSync?: (filePath: string) => string;
};

const defaultFs: FileSystemPort = {
  readFileSync: (filePath) => fs.readFileSync(filePath),
  writeFileSync: (filePath, contents) => {
    fs.writeFileSync(filePath, contents);
  },
  mkdirSync: (dirPath, options) => {
    fs.mkdirSync(dirPath, options);
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
  unlinkSync: (filePath) => {
    fs.unlinkSync(filePath);
  },
  existsSync: (filePath) => fs.existsSync(filePath),
  realpathSync: (filePath) => fs.realpathSync(filePath),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFlagValue(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new CiEvidencePackCliError(`Missing value for ${flag}`, 2);
  }
  if (next.trim().length === 0) {
    throw new CiEvidencePackCliError(`${flag} must be a nonempty string`, 2);
  }
  return { value: next, nextIndex: index + 2 };
}

export function parseCiEvidencePackCliArgs(argv: string[]): CiEvidencePackCliArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    throw new CiEvidencePackCliError('Missing subcommand', 2);
  }

  const subcommand = args[0];
  if (subcommand === undefined) {
    throw new CiEvidencePackCliError('Missing subcommand', 2);
  }
  if (subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'assemble' && subcommand !== 'summarize') {
    if (subcommand.startsWith('-')) {
      throw new CiEvidencePackCliError(`Unknown flag ${subcommand}`, 2);
    }
    throw new CiEvidencePackCliError(`Unknown subcommand ${subcommand}`, 2);
  }

  const rest = args.slice(1);
  if (hasHelpFlag(rest)) {
    return { command: 'help' };
  }

  const seen = new Set<string>();
  let requestPath: string | undefined;
  let packPath: string | undefined;
  let receiptPath: string | undefined;
  let outPath: string | undefined;

  for (let index = 1; index < args.length; ) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith('-')) {
      throw new CiEvidencePackCliError(`Unexpected positional argument ${token}`, 2);
    }
    if (seen.has(token)) {
      throw new CiEvidencePackCliError(`Duplicate flag ${token}`, 2);
    }
    seen.add(token);

    if (subcommand === 'assemble') {
      if (token !== '--request') {
        throw new CiEvidencePackCliError(`Unknown flag ${token}`, 2);
      }
      const parsed = requireFlagValue(args, index, token);
      requestPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === '--pack') {
      const parsed = requireFlagValue(args, index, token);
      packPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (token === '--receipt') {
      const parsed = requireFlagValue(args, index, token);
      receiptPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (token === '--out') {
      const parsed = requireFlagValue(args, index, token);
      outPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw new CiEvidencePackCliError(`Unknown flag ${token}`, 2);
  }

  if (subcommand === 'assemble') {
    if (requestPath === undefined) {
      throw new CiEvidencePackCliError('Missing --request', 2);
    }
    return { command: 'assemble', requestPath };
  }
  if (packPath === undefined) {
    throw new CiEvidencePackCliError('Missing --pack', 2);
  }
  if (receiptPath === undefined) {
    throw new CiEvidencePackCliError('Missing --receipt', 2);
  }
  if (outPath === undefined) {
    return { command: 'summarize', packPath, receiptPath };
  }
  return { command: 'summarize', packPath, receiptPath, outPath };
}

function decodeUtf8Fatal(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CiEvidencePackCliError(`Invalid UTF-8 in ${label}`, 2);
  }
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CiEvidencePackCliError(`${label} must be a nonempty string`, 2);
  }
  return value;
}

export function readCiEvidencePackAssembleRequest(
  filePath: string,
  fileSystem: FileSystemPort = defaultFs,
): CiEvidencePackAssembleRequest {
  let bytes: Buffer;
  try {
    bytes = fileSystem.readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePackCliError(`Failed to read assemble request: ${message}`, 1);
  }

  const text = decodeUtf8Fatal(bytes, 'assemble request');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CiEvidencePackCliError('Assemble request is not valid JSON', 2);
  }
  if (!isPlainObject(parsed)) {
    throw new CiEvidencePackCliError('Assemble request must be a plain object', 2);
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 3 || keys[0] !== 'artifactRoot' || keys[1] !== 'input' || keys[2] !== 'outDir') {
    throw new CiEvidencePackCliError('Assemble request must have exactly artifactRoot, outDir, and input', 2);
  }

  const artifactRoot = requireNonemptyString(parsed.artifactRoot, 'artifactRoot');
  const outDir = requireNonemptyString(parsed.outDir, 'outDir');
  const input = parsed.input;
  if (!isPlainObject(input)) {
    throw new CiEvidencePackCliError('input must be a plain object', 2);
  }

  const requiredInputKeys = [
    'schemaVersion',
    'packId',
    'createdAt',
    'source',
    'liveProofSet',
    'requiredPlatforms',
    'requiredEvidenceKinds',
    'platforms',
    'attempts',
    'evidence',
    'verdicts',
    'comparisonStatus',
    'completeness',
    'assembly',
    'summary',
    'nextAction',
  ];
  const inputKeys = Object.keys(input);
  const expectedKeySet = new Set(requiredInputKeys);
  if (inputKeys.length !== requiredInputKeys.length || inputKeys.some((key) => !expectedKeySet.has(key))) {
    throw new CiEvidencePackCliError(
      'input must have exactly schemaVersion, packId, createdAt, source, liveProofSet, requiredPlatforms, requiredEvidenceKinds, platforms, attempts, evidence, verdicts, comparisonStatus, completeness, assembly, summary, nextAction',
      2,
    );
  }

  assertClosedOwnKeys(input.source, ['expectedSha', 'observedSha', 'status'], 'source');
  assertClosedOwnKeys(
    input.liveProofSet,
    ['relativePath', 'sha256', 'byteSize', 'runId', 'status'],
    'liveProofSet',
  );
  assertClosedOwnKeys(input.completeness, ['status', 'reasons'], 'completeness');
  assertClosedOwnKeys(input.assembly, ['status', 'reasons'], 'assembly');
  assertObjectArrayEntries(input.platforms, 'platforms');
  for (const [index, platform] of asUnknownArray(input.platforms).entries()) {
    assertClosedOwnKeys(
      platform,
      ['platform', 'authorityStatus', 'evaluationStatus', 'selectedAttemptId'],
      `platforms[${index}]`,
    );
  }
  assertObjectArrayEntries(input.attempts, 'attempts');
  for (const [index, attempt] of asUnknownArray(input.attempts).entries()) {
    assertClosedOwnKeys(
      attempt,
      [
        'attemptId',
        'platform',
        'scenarioId',
        'runId',
        'status',
        'attemptNumber',
        'maxAttempts',
        'startedAt',
        'endedAt',
        'predecessorAttemptId',
        'evidenceIds',
      ],
      `attempts[${index}]`,
    );
  }
  assertObjectArrayEntries(input.evidence, 'evidence');
  for (const [index, evidence] of asUnknownArray(input.evidence).entries()) {
    if (!isPlainObject(evidence)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(evidence, 'relativePath')) {
      assertClosedOwnKeys(
        evidence,
        ['evidenceId', 'attemptId', 'platform', 'kind', 'status', 'relativePath', 'sha256', 'byteSize'],
        `evidence[${index}]`,
      );
    } else {
      assertClosedOwnKeys(
        evidence,
        ['evidenceId', 'attemptId', 'platform', 'kind', 'status', 'reason'],
        `evidence[${index}]`,
      );
    }
  }
  assertObjectArrayEntries(input.verdicts, 'verdicts');
  for (const [index, verdict] of asUnknownArray(input.verdicts).entries()) {
    assertClosedOwnKeys(
      verdict,
      ['scenarioId', 'runId', 'platform', 'status', 'evidenceId'],
      `verdicts[${index}]`,
    );
  }

  return {
    artifactRoot,
    outDir,
    input: input as CiEvidencePackBuildInput,
  };
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assertObjectArrayEntries(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new CiEvidencePackCliError(`${label} must be an array`, 2);
  }
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      throw new CiEvidencePackCliError(`${label}[${index}] must be a plain object`, 2);
    }
  }
}

function assertClosedOwnKeys(value: unknown, expectedKeys: readonly string[], label: string): void {
  if (!isPlainObject(value)) {
    throw new CiEvidencePackCliError(`${label} must be a plain object`, 2);
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new CiEvidencePackCliError(`${label} has unknown key ${key}`, 2);
    }
  }
}

function isCiEvidencePackAssembleSuccess(pack: CiEvidencePack): boolean {
  return (
    pack.source.status === 'current' &&
    pack.liveProofSet.status === 'passed' &&
    pack.completeness.status === 'complete' &&
    pack.assembly.status === 'succeeded' &&
    pack.mechanismStatus === 'succeeded' &&
    pack.twoPlatformClaim.status === 'passed'
  );
}

export function writeFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  fileSystem: FileSystemPort = defaultFs,
): void {
  const resolved = path.resolve(targetPath);
  const directory = path.dirname(resolved);
  fileSystem.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.ci-evidence-pack.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fileSystem.writeFileSync(tempPath, contents);
    fileSystem.renameSync(tempPath, resolved);
  } catch (error) {
    try {
      fileSystem.unlinkSync(tempPath);
    } catch {
      // best-effort temp cleanup
    }
    throw error;
  }
}

function writeStdoutLine(io: CliIo, payload: unknown): void {
  io.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printError(io: CliIo, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr.write(`${message}\n`);
}

function cliErrorCode(error: unknown, fallback: number): number {
  if (error instanceof CiEvidencePackCliError) {
    return error.exitCode;
  }
  return fallback;
}

export async function runCiEvidencePackAssemble(
  requestPath: string,
  io: CliIo,
  fileSystem: FileSystemPort = defaultFs,
): Promise<number> {
  let request: CiEvidencePackAssembleRequest;
  try {
    request = readCiEvidencePackAssembleRequest(requestPath, fileSystem);
  } catch (error) {
    printError(io, error);
    return cliErrorCode(error, 1);
  }

  const artifactRoot = path.resolve(request.artifactRoot);
  const canonicalPath = path.resolve(request.outDir, 'ci-evidence-pack.json');

  let pack: CiEvidencePack;
  try {
    pack = assembleCiEvidencePack(request.input, { artifactRoot });
  } catch (error) {
    printError(io, error);
    return 1;
  }

  const serialized = `${JSON.stringify(pack, null, 2)}\n`;
  try {
    writeFileAtomically(canonicalPath, serialized, fileSystem);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  const assemblePassed = isCiEvidencePackAssembleSuccess(pack);
  writeStdoutLine(io, {
    phase: 'assemble',
    artifact: canonicalPath,
    publicationAttempted: false,
    gateStatus: assemblePassed ? 'passed' : 'failed',
    mechanismStatus: pack.mechanismStatus,
    twoPlatformClaimStatus: pack.twoPlatformClaim.status,
  });

  return assemblePassed ? 0 : 1;
}

function hasSummarizeAliasResolution(
  fileSystem: FileSystemPort,
): fileSystem is FileSystemPort & {
  existsSync: (filePath: string) => boolean;
  realpathSync: (filePath: string) => string;
} {
  return fileSystem.existsSync !== undefined && fileSystem.realpathSync !== undefined;
}

function aliasResolutionError(filePath: string): CiEvidencePackCliError {
  return new CiEvidencePackCliError(
    `path ${filePath} could not be resolved for summarize alias protection`,
    2,
  );
}

function resolveExistingPath(filePath: string, fileSystem: FileSystemPort): string | undefined {
  if (!hasSummarizeAliasResolution(fileSystem)) {
    return undefined;
  }
  let exists: boolean;
  try {
    exists = fileSystem.existsSync(filePath);
  } catch {
    throw aliasResolutionError(filePath);
  }
  if (!exists) {
    return undefined;
  }
  try {
    return fileSystem.realpathSync(filePath);
  } catch {
    throw aliasResolutionError(filePath);
  }
}

function resolveExistingPathForAliasGuard(
  filePath: string,
  fileSystem: FileSystemPort,
): string | undefined | CiEvidencePackCliError {
  try {
    return resolveExistingPath(filePath, fileSystem);
  } catch (error) {
    if (error instanceof CiEvidencePackCliError) {
      return error;
    }
    return aliasResolutionError(filePath);
  }
}

function detectProtectedSummarizeOutCollision(
  outPath: string,
  packPath: string,
  receiptPath: string,
  fileSystem: FileSystemPort,
): CiEvidencePackCliError | undefined {
  const resolvedOut = resolveExistingPathForAliasGuard(outPath, fileSystem);
  if (resolvedOut instanceof CiEvidencePackCliError) {
    return resolvedOut;
  }
  const resolvedPack = resolveExistingPathForAliasGuard(packPath, fileSystem);
  if (resolvedPack instanceof CiEvidencePackCliError) {
    return resolvedPack;
  }
  const resolvedReceipt = resolveExistingPathForAliasGuard(receiptPath, fileSystem);
  if (resolvedReceipt instanceof CiEvidencePackCliError) {
    return resolvedReceipt;
  }

  if (resolvedOut !== undefined && resolvedPack !== undefined && resolvedOut === resolvedPack) {
    return new CiEvidencePackCliError(
      `summarize --out must not overwrite the bound pack at ${outPath}`,
      2,
    );
  }
  if (resolvedOut !== undefined && resolvedReceipt !== undefined && resolvedOut === resolvedReceipt) {
    return new CiEvidencePackCliError(
      `summarize --out must not overwrite the bound receipt at ${outPath}`,
      2,
    );
  }
  return undefined;
}

export async function runCiEvidencePackSummarize(
  args: SummarizeCliArgs,
  io: CliIo,
  fileSystem: FileSystemPort = defaultFs,
): Promise<number> {
  const packPath = path.resolve(args.packPath);
  const receiptPath = path.resolve(args.receiptPath);
  const outPath = path.resolve(
    args.outPath ?? path.join(path.dirname(packPath), 'ci-evidence-publication-summary.md'),
  );

  if (outPath === packPath) {
    printError(
      io,
      new CiEvidencePackCliError(`summarize --out must not overwrite the bound pack at ${outPath}`, 2),
    );
    return 2;
  }
  if (outPath === receiptPath) {
    printError(
      io,
      new CiEvidencePackCliError(`summarize --out must not overwrite the bound receipt at ${outPath}`, 2),
    );
    return 2;
  }

  const protectedCollision = detectProtectedSummarizeOutCollision(outPath, packPath, receiptPath, fileSystem);
  if (protectedCollision !== undefined) {
    printError(io, protectedCollision);
    return 2;
  }

  let exactPackBytes: Buffer;
  try {
    exactPackBytes = fileSystem.readFileSync(packPath);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  let pack: CiEvidencePack;
  try {
    pack = parseCiEvidencePackBytes(exactPackBytes);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  let receipt: CiEvidencePublicationReceipt;
  try {
    receipt = readCiEvidencePublicationReceipt(receiptPath, exactPackBytes);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  let markdown: string;
  let evaluation: CiEvidencePublicationSummaryEvaluation;
  try {
    markdown = renderCiEvidencePublicationSummary(pack, receipt, exactPackBytes);
    evaluation = evaluateCiEvidencePublicationSummary(pack, receipt, exactPackBytes);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  try {
    writeFileAtomically(outPath, markdown, fileSystem);
  } catch (error) {
    printError(io, error);
    return 1;
  }

  writeStdoutLine(io, {
    phase: 'summarize',
    artifact: outPath,
    gateStatus: evaluation.status,
  });

  return evaluation.status === 'passed' ? 0 : 1;
}

export async function runCiEvidencePackCli(
  argv: string[] = process.argv,
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  fileSystem: FileSystemPort = defaultFs,
): Promise<number> {
  let parsed: CiEvidencePackCliArgs;
  try {
    parsed = parseCiEvidencePackCliArgs(argv);
  } catch (error) {
    writeUsage(usage, io.stderr);
    printError(io, error);
    return 2;
  }

  switch (parsed.command) {
    case 'help':
      writeUsage(usage, io.stdout);
      return 0;
    case 'assemble':
      return runCiEvidencePackAssemble(parsed.requestPath, io, fileSystem);
    case 'summarize':
      return runCiEvidencePackSummarize(parsed, io, fileSystem);
    default: {
      const exhaustive: never = parsed;
      const command = String((exhaustive as { command?: unknown }).command ?? 'unknown');
      writeUsage(usage, io.stderr);
      printError(io, new CiEvidencePackCliError(`Unknown subcommand ${command}`, 2));
      return 2;
    }
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  return runCiEvidencePackCli(argv);
}

if (require.main === module) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
