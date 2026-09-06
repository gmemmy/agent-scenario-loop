#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  EvidencePackageError,
  materializeEvidencePackage,
} = require('../core/evidence-package') as typeof import('../core/evidence-package');
const { hasHelpFlag, writeUsage } = require('./cli');

function usage(stream: NodeJS.WritableStream): void {
  writeUsage([
    'Usage: asl-evidence-package --request <evidence-package-request.json>',
    '',
    'Copies only explicitly allowlisted, stable evidence files into a new owner-private package directory.',
    'Sensitive paths, private-key markers, symlinks, missing files, unsafe paths, and output collisions fail closed.',
    'Packaging success proves package completeness and integrity only; it does not prove product behavior or release acceptance.',
  ], stream);
}

function parseRequestPath(argv: string[]): string {
  const index = argv.indexOf('--request');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--') || argv.length !== 2 || index !== 0) {
    throw new EvidencePackageError(
      'invalid-request',
      '--request must name exactly one evidence-package request JSON file.',
    );
  }
  return path.resolve(value);
}

function readRequest(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new EvidencePackageError(
      'invalid-request',
      'The evidence-package request is missing or invalid JSON.',
    );
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }
  try {
    const result = await materializeEvidencePackage(readRequest(parseRequestPath(argv)));
    process.stdout.write(`${JSON.stringify({
      artifact: result.manifestPath,
      outputDir: result.outputDir,
      phase: 'evidence-package',
      status: 'complete',
    })}\n`);
  } catch (cause) {
    if (cause instanceof EvidencePackageError && cause.code === 'rejected') {
      process.stdout.write(`${JSON.stringify({
        phase: 'evidence-package',
        rejections: cause.rejections,
        status: 'rejected',
      })}\n`);
      process.exitCode = 1;
      return;
    }
    throw cause;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof EvidencePackageError ? 2 : 1;
  });
}

module.exports = {
  main,
};
