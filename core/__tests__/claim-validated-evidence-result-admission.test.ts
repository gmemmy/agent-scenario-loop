const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,
  inspectScenarioClaimValidatedEvidenceResultAdmission,
} = require('../claim-validated-evidence-result-admission');
const { SCHEMAS, validateJson } = require('../schema-validator');

const SUBJECT_SHA = 'a'.repeat(64);
const REPORT_SHA = 'b'.repeat(64);
const CLAIM_HASH = 'c'.repeat(64);
const RUN_HASH = 'd'.repeat(64);
const PRODUCER_SHA = 'e'.repeat(64);

function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    status: 'identity_admitted',
    contractVersion: '1.0.0',
    reasonCodes: [],
    nextAction: 'evaluate_validated_evidence_report',
    candidateId: 'candidates/logs-1',
    runIdentityHash: RUN_HASH,
    claimId: 'claims/first-usable',
    claimHash: CLAIM_HASH,
    assertionId: 'assertions/logs-present',
    assertionKind: 'validatedEvidence',
    artifactKind: 'logs',
    validationContract: 'contracts/device-log-v1',
    subjectArtifact: {
      path: 'artifacts/subject.log',
      sha256: SUBJECT_SHA,
      byteLength: 12,
    },
    reportArtifact: {
      path: 'artifacts/report.json',
      sha256: REPORT_SHA,
      byteLength: 24,
    },
    ...overrides,
  };
}

function resultRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    resultId: 'results/validator-1',
    assertionId: 'assertions/logs-present',
    validationContract: 'contracts/device-log-v1',
    validator: {
      producerId: 'validators/log-schema',
      producerVersion: '1.0.0',
      producerSha256: PRODUCER_SHA,
    },
    subject: {
      path: 'artifacts/subject.log',
      sha256: SUBJECT_SHA,
    },
    report: {
      path: 'artifacts/report.json',
      sha256: REPORT_SHA,
    },
    status: 'passed',
    reasonCode: 'validation_passed',
    ...overrides,
  };
}

function encodeResult(record: unknown): { bytes: Uint8Array; sha256: string } {
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
  return { bytes, sha256: hashBytes(bytes) };
}

function admitInput(record: Record<string, unknown> = resultRecord(), extra: Record<string, unknown> = {}) {
  const encoded = encodeResult(record);
  return {
    validatedEvidence: envelope(),
    result: {
      path: 'artifacts/validator-result.json',
      sha256: encoded.sha256,
    },
    resultBytes: encoded.bytes,
    ...extra,
  };
}

test('admits an exact-byte passed validator result as identity evidence only', () => {
  const input = admitInput();
  const result = inspectScenarioClaimValidatedEvidenceResultAdmission(input);

  assert.equal(result.status, 'admitted');
  assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION);
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.nextAction, 'treat_validator_result_as_identity_evidence_only');
  assert.equal(result.validatorResultStatus, 'passed');
  assert.equal(result.validatorReasonCode, 'validation_passed');
  assert.equal(result.assertionKind, 'validatedEvidence');
  assert.equal(result.resultId, 'results/validator-1');
  assert.equal(result.resultArtifact.path, 'artifacts/validator-result.json');
});

test('admits failed and not_evaluable closed vocabularies', () => {
  const failed = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(resultRecord({ status: 'failed', reasonCode: 'validation_failed' })),
  );
  assert.equal(failed.status, 'admitted');
  assert.equal(failed.validatorResultStatus, 'failed');
  assert.equal(failed.nextAction, 'treat_validator_result_as_identity_evidence_only');

  for (const reasonCode of ['validator_unavailable', 'result_incomplete', 'contract_not_evaluable']) {
    const notEvaluable = inspectScenarioClaimValidatedEvidenceResultAdmission(
      admitInput(resultRecord({ status: 'not_evaluable', reasonCode })),
    );
    assert.equal(notEvaluable.status, 'admitted', reasonCode);
    assert.equal(notEvaluable.validatorResultStatus, 'not_evaluable');
    assert.equal(notEvaluable.validatorReasonCode, reasonCode);
    assert.equal(notEvaluable.nextAction, 'treat_validator_result_as_identity_evidence_only');
  }
});

test('rejects malformed caller input as outside_contract', () => {
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(null).status, 'outside_contract');
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission([]).status, 'outside_contract');
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission({}).status, 'outside_contract');
  const extra = {
    ...admitInput(),
    extra: true,
  };
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(extra).status, 'outside_contract');
});

test('rejects non-identity-admitted upstream envelopes as outside_contract', () => {
  const input = admitInput();
  input.validatedEvidence = envelope({ status: 'report_blocked' });
  const result = inspectScenarioClaimValidatedEvidenceResultAdmission(input);
  assert.equal(result.status, 'outside_contract');
  assert.equal(result.reasonCodes[0], 'validated_evidence_not_identity_admitted');
});

test('blocks hash mismatch, invalid bytes, utf8, and json', () => {
  const hashed = admitInput();
  hashed.result = { ...hashed.result, sha256: 'f'.repeat(64) };
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(hashed).reasonCodes[0], 'result_hash_mismatch');

  const invalidBytes: unknown = {
    ...admitInput(),
    resultBytes: [1, 2, 3],
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(invalidBytes).reasonCodes[0],
    'result_bytes_invalid',
  );

  const utf8 = admitInput();
  utf8.resultBytes = new Uint8Array([0xff, 0xfe, 0xfd]);
  utf8.result = { path: 'artifacts/validator-result.json', sha256: hashBytes(utf8.resultBytes) };
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(utf8).reasonCodes[0], 'result_utf8_invalid');

  const notJson = new TextEncoder().encode('not-json');
  const jsonInvalid = {
    validatedEvidence: envelope(),
    result: { path: 'artifacts/validator-result.json', sha256: hashBytes(notJson) },
    resultBytes: notJson,
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(jsonInvalid).reasonCodes[0],
    'result_json_invalid',
  );
});

test('blocks schema-invalid records including incompatible status/reason and not_applicable', () => {
  const incompatible = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(resultRecord({ status: 'passed', reasonCode: 'validation_failed' })),
  );
  assert.equal(incompatible.status, 'blocked');
  assert.equal(incompatible.reasonCodes[0], 'result_schema_invalid');

  const notApplicable = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(resultRecord({ status: 'not_applicable', reasonCode: 'validation_passed' })),
  );
  assert.equal(notApplicable.reasonCodes[0], 'result_schema_invalid');
});

test('blocks identity mismatches and path/hash collisions', () => {
  const assertion = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(resultRecord({ assertionId: 'assertions/other' })),
  );
  assert.equal(assertion.reasonCodes[0], 'assertion_identity_mismatch');

  const contract = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(resultRecord({ validationContract: 'contracts/other' })),
  );
  assert.equal(contract.reasonCodes[0], 'validation_contract_mismatch');

  const subject = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(
      resultRecord({
        subject: { path: 'artifacts/other.log', sha256: SUBJECT_SHA },
      }),
    ),
  );
  assert.equal(subject.reasonCodes[0], 'subject_identity_mismatch');

  const report = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(
      resultRecord({
        report: { path: 'artifacts/other-report.json', sha256: REPORT_SHA },
      }),
    ),
  );
  assert.equal(report.reasonCodes[0], 'report_identity_mismatch');

  const encoded = encodeResult(resultRecord());
  const pathCollision = {
    validatedEvidence: envelope(),
    result: { path: 'artifacts/subject.log', sha256: encoded.sha256 },
    resultBytes: encoded.bytes,
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(pathCollision).reasonCodes[0],
    'result_identity_collision',
  );

  const subjectHashCollision = {
    validatedEvidence: envelope({
      subjectArtifact: {
        path: 'artifacts/subject.log',
        sha256: encoded.sha256,
        byteLength: 12,
      },
    }),
    result: { path: 'artifacts/validator-result.json', sha256: encoded.sha256 },
    resultBytes: encoded.bytes,
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(subjectHashCollision).reasonCodes[0],
    'result_identity_collision',
  );

  const reportHashCollision = {
    validatedEvidence: envelope({
      reportArtifact: {
        path: 'artifacts/report.json',
        sha256: encoded.sha256,
        byteLength: 24,
      },
    }),
    result: { path: 'artifacts/validator-result.json', sha256: encoded.sha256 },
    resultBytes: encoded.bytes,
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(reportHashCollision).reasonCodes[0],
    'result_identity_collision',
  );
});

test('snapshots non-zero-offset Buffer views and isolates mutations', () => {
  const encoded = encodeResult(resultRecord());
  const padded = Buffer.concat([Buffer.from([0x00, 0x00]), Buffer.from(encoded.bytes)]);
  const view = padded.subarray(2);
  const input = {
    validatedEvidence: envelope(),
    result: { path: 'artifacts/validator-result.json', sha256: encoded.sha256 },
    resultBytes: view,
  };
  const admitted = inspectScenarioClaimValidatedEvidenceResultAdmission(input);
  assert.equal(admitted.status, 'admitted');
  view.fill(0);
  const mutatedView = inspectScenarioClaimValidatedEvidenceResultAdmission(input);
  assert.equal(mutatedView.status, 'blocked');
  assert.equal(mutatedView.reasonCodes[0], 'result_hash_mismatch');
  const again = inspectScenarioClaimValidatedEvidenceResultAdmission({
    validatedEvidence: envelope(),
    result: { path: 'artifacts/validator-result.json', sha256: encoded.sha256 },
    resultBytes: encoded.bytes,
  });
  assert.equal(again.status, 'admitted');
  assert.throws(() => {
    admitted.resultId = 'mutated';
  }, TypeError);
  assert.equal(admitted.resultId, 'results/validator-1');
  assert.equal(again.resultId, 'results/validator-1');
});

test('rejects hostile proxy, accessor, and spoofed inputs', () => {
  const encoded = encodeResult(resultRecord());
  const proxy = new Proxy(
    {
      validatedEvidence: envelope(),
      result: { path: 'artifacts/validator-result.json', sha256: encoded.sha256 },
      resultBytes: encoded.bytes,
    },
    {
      get() {
        throw new Error('hostile');
      },
    },
  );
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(proxy).status, 'outside_contract');

  const accessor = {};
  Object.defineProperty(accessor, 'validatedEvidence', {
    enumerable: true,
    get() {
      throw new Error('accessor');
    },
  });
  Object.defineProperty(accessor, 'result', { enumerable: true, value: { path: 'a', sha256: SUBJECT_SHA } });
  Object.defineProperty(accessor, 'resultBytes', { enumerable: true, value: encoded.bytes });
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(accessor).status, 'outside_contract');
});

test('rejects traversal, Windows, UNC, backslash, dot, empty, and file URI result paths', () => {
  for (const pathValue of [
    '../artifacts/result.json',
    '/tmp/result.json',
    'C:\\temp\\result.json',
    '\\\\unc\\share\\result.json',
    'artifacts\\result.json',
    'file:artifacts/result.json',
    'FILE://artifacts/result.json',
    '.',
    '..',
    './artifacts/result.json',
    'artifacts/./result.json',
    'artifacts/../result.json',
    'artifacts/result.json/',
    'artifacts//result.json',
    'C:/temp/result.json',
    '//unc/share/result.json',
    'artifacts/result.json\u0000hidden',
    'artifacts/result.json\n',
    'artifacts/result.json ',
    ' artifacts/result.json',
    '',
  ]) {
    const encoded = encodeResult(resultRecord());
    const input = {
      validatedEvidence: envelope(),
      result: { path: pathValue, sha256: encoded.sha256 },
      resultBytes: encoded.bytes,
    };
    const result = inspectScenarioClaimValidatedEvidenceResultAdmission(input);
    assert.equal(result.status, 'outside_contract', pathValue);
  }
});

test('schema matrix accepts legal records and rejects extra keys and host paths', () => {
  const accepted = resultRecord({
    evidenceReferences: [{ path: 'artifacts/extra.json', sha256: '1'.repeat(64) }],
  });
  assert.equal(validateJson(accepted, SCHEMAS.validatedEvidenceResult, 'accepted').valid, true);

  const extra = resultRecord({ claimSupport: true });
  assert.equal(validateJson(extra, SCHEMAS.validatedEvidenceResult, 'extra').valid, false);

  const hostPath = resultRecord({
    subject: { path: '/tmp/subject.log', sha256: SUBJECT_SHA },
  });
  assert.equal(validateJson(hostPath, SCHEMAS.validatedEvidenceResult, 'host').valid, false);

  const backslash = resultRecord({
    report: { path: 'artifacts\\report.json', sha256: REPORT_SHA },
  });
  assert.equal(validateJson(backslash, SCHEMAS.validatedEvidenceResult, 'backslash').valid, false);
});

test('classifies malformed validator records as schema invalid, not identity mismatch', () => {
  const cases = [
    resultRecord({ validator: { producerId: 'validators/log-schema' } }),
    resultRecord({ validator: null }),
    resultRecord({
      validator: {
        producerId: 'validators/log-schema',
        producerVersion: '1.0.0',
        producerSha256: PRODUCER_SHA,
        extra: true,
      },
    }),
    resultRecord({
      validator: {
        producerId: 'validators/log-schema',
        producerVersion: '1.0.0',
        producerSha256: PRODUCER_SHA.toUpperCase(),
      },
    }),
  ];
  for (const record of cases) {
    const result = inspectScenarioClaimValidatedEvidenceResultAdmission(admitInput(record));
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasonCodes[0], 'result_schema_invalid');
    assert.notEqual(result.reasonCodes[0], 'validator_identity_mismatch');
  }
});

test('rejects padded, control-bearing, and malformed hash identities', () => {
  const padded = admitInput();
  padded.validatedEvidence = envelope({ assertionId: ' assertions/logs-present' });
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(padded).status, 'outside_contract');

  const control = admitInput();
  control.validatedEvidence = envelope({ claimId: 'claims/first-usable\u0007' });
  assert.equal(inspectScenarioClaimValidatedEvidenceResultAdmission(control).status, 'outside_contract');

  const encoded = encodeResult(resultRecord());
  const uppercaseHash = {
    validatedEvidence: envelope(),
    result: {
      path: 'artifacts/validator-result.json',
      sha256: encoded.sha256.toUpperCase(),
    },
    resultBytes: encoded.bytes,
  };
  assert.equal(
    inspectScenarioClaimValidatedEvidenceResultAdmission(uppercaseHash).status,
    'outside_contract',
  );
});

test('admits evidenceReferences and rejects noncanonical reference paths', () => {
  const admitted = inspectScenarioClaimValidatedEvidenceResultAdmission(
    admitInput(
      resultRecord({
        evidenceReferences: [
          { path: 'artifacts/extra.json', sha256: '1'.repeat(64) },
          { path: 'artifacts/extra-plain.json', sha256: '2'.repeat(64) },
        ],
      }),
    ),
  );
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.evidenceReferences.length, 2);
  assert.equal(admitted.evidenceReferences[0].path, 'artifacts/extra.json');
  assert.equal(admitted.evidenceReferences[0].sha256, '1'.repeat(64));
  assert.equal(admitted.nextAction, 'treat_validator_result_as_identity_evidence_only');
  assert.throws(() => {
    admitted.evidenceReferences[0].path = 'mutated';
  }, TypeError);

  for (const pathValue of [
    '../artifacts/extra.json',
    'artifacts/extra.json/',
    'artifacts/./extra.json',
    '.',
    '..',
    'artifacts//extra.json',
    'file:artifacts/extra.json',
    'C:/artifacts/extra.json',
  ]) {
    const result = inspectScenarioClaimValidatedEvidenceResultAdmission(
      admitInput(
        resultRecord({
          evidenceReferences: [{ path: pathValue, sha256: '1'.repeat(64) }],
        }),
      ),
    );
    assert.equal(result.status, 'blocked', pathValue);
    assert.equal(result.reasonCodes[0], 'result_schema_invalid', pathValue);
  }
});
