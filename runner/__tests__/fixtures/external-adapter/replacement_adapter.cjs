const readline = require('node:readline');

const EMPTY_SHA256 = '0'.repeat(64);
const FIXTURE_NOW = '2026-06-19T12:00:00.000Z';
const REQUEST_TYPES = new Set([
  'hello', 'prepare', 'launch', 'executeAction', 'waitCondition', 'captureEvidence', 'stop', 'finalize',
]);
let seq = 0;
const state = { finalized: false, helloCompleted: false, lastHostSeq: 0, launched: false, prepared: false };

function artifact(kind, path, contentType) {
  return { ...(kind ? { kind } : {}), path, contentType, sha256: EMPTY_SHA256, sizeBytes: 0 };
}

function write(request, body) {
  process.stdout.write(`${JSON.stringify({
    protocolVersion: '1.0',
    seq: ++seq,
    operationId: request.operationId,
    kind: 'response',
    type: request.type,
    ...(isNonEmptyString(request.runId) && isNonEmptyString(request.attemptId)
      ? { runId: request.runId, attemptId: request.attemptId }
      : {}),
    body,
  })}\n`);
}

function respond(request, result) {
  write(request, { ok: true, result });
}

function fail(request, category, code, message, retryable = false) {
  write(request, {
    ok: false,
    failure: { category, code, message, retryable },
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function canCorrelate(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && isNonEmptyString(value.operationId)
    && REQUEST_TYPES.has(value.type);
}

function isValidRequest(request) {
  const body = request.body;
  const allowedKeys = new Set([
    'protocolVersion', 'seq', 'operationId', 'kind', 'type', 'runId', 'attemptId', 'deadline', 'body',
  ]);
  if (
    request.kind !== 'request'
    || !isNonEmptyString(request.operationId)
    || !isNonEmptyString(request.type)
    || !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(request).some((key) => !allowedKeys.has(key))
  ) {
    return false;
  }
  if (request.type === 'hello') {
    return hasOnlyKeys(body, ['host', 'platform'])
      && isNonEmptyRecord(body.host)
      && hasOnlyKeys(body.host, ['name', 'version'])
      && isNonEmptyString(body.host.name)
      && isNonEmptyString(body.host.version)
      && isNonEmptyString(body.platform);
  }
  if (!isNonEmptyString(request.runId) || !isNonEmptyString(request.attemptId)) return false;
  switch (request.type) {
    case 'prepare':
      return isNonEmptyString(body.platform)
        && isNonEmptyRecord(body.target)
        && (body.artifactsRoot === undefined || isNonEmptyString(body.artifactsRoot));
    case 'launch':
      return isNonEmptyString(body.platform) && isNonEmptyRecord(body.target);
    case 'executeAction':
      return isNonEmptyString(body.driverAction)
        && (body.selector === undefined || isNonEmptyRecord(body.selector));
    case 'waitCondition':
      return isNonEmptyString(body.clockDomain) && isNonEmptyRecord(body.condition);
    case 'captureEvidence':
      return hasOnlyKeys(body, ['kinds'])
        && Array.isArray(body.kinds)
        && body.kinds.length > 0
        && body.kinds.every(isNonEmptyString);
    case 'stop':
    case 'finalize':
      return Object.keys(body).length === 0;
    default:
      return false;
  }
}

function handle(request) {
  const body = request.body ?? {};
  const expectedSeq = state.lastHostSeq + 1;
  if (request.seq !== expectedSeq) {
    fail(request, 'protocol', 'invalid_sequence', 'host seq must increase by exactly one');
    return;
  }
  state.lastHostSeq = request.seq;
  if (request.protocolVersion !== '1.0') {
    fail(request, 'protocol', 'unsupported_protocol', 'replacement fixture supports protocol 1.0');
    return;
  }
  if (typeof request.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(request.deadline)) {
    fail(request, 'protocol', 'invalid_deadline', 'request deadline must be an RFC 3339 timestamp');
    return;
  }
  if (request.deadline <= FIXTURE_NOW) {
    fail(request, 'deadline', 'deadline_expired', 'operation deadline expired before adapter work started', true);
    return;
  }
  if (!isValidRequest(request)) {
    fail(request, 'protocol', 'invalid_request', 'request does not match the external adapter protocol');
    return;
  }
  if (!state.helloCompleted && request.type !== 'hello') {
    fail(request, 'protocol', 'hello_required', 'the first host message must be hello');
    return;
  }
  if (state.helloCompleted && request.type === 'hello') {
    fail(request, 'protocol', 'hello_already_completed', 'hello capability negotiation has already completed');
    return;
  }
  if (state.finalized) {
    fail(request, 'cleanup', 'already_finalized', 'adapter has already finalized this attempt');
    return;
  }
  switch (request.type) {
    case 'hello':
      if (body.platform !== 'android') {
        fail(request, 'unsupported', 'unsupported_platform', 'replacement fixture supports only android');
        return;
      }
      respond(request, {
        adapter: { name: 'asl-node-replacement-fixture', version: '0.1.0' },
        acceptedProtocolVersion: '1.0',
        platforms: ['android'],
        capabilities: ['prepare', 'launch', 'command', 'truthEvent', 'evidence', 'stop', 'finalize'],
        driverActions: ['tap'],
        artifactOutputs: ['logs', 'screenshot'],
        clockDomains: ['device-log'],
      });
      state.helloCompleted = true;
      return;
    case 'prepare':
      if (body.platform !== 'android') {
        fail(request, 'unsupported', 'unsupported_platform', 'replacement fixture supports only android');
        return;
      }
      state.prepared = true;
      respond(request, {
        adapter: { name: 'asl-node-replacement-fixture', version: '0.1.0' },
        platform: 'android',
        target: body.target,
        artifactsRoot: body.artifactsRoot,
      });
      return;
    case 'launch':
      if (body.platform !== 'android') {
        fail(request, 'unsupported', 'unsupported_platform', 'replacement fixture supports only android');
        return;
      }
      if (!state.prepared) {
        fail(request, 'cleanup', 'not_prepared', 'prepare must complete before launch');
        return;
      }
      state.launched = true;
      respond(request, {
        status: 'launched',
        targetRef: 'node-fixture-target',
        artifacts: [artifact('logs', 'node/launch.txt', 'text/plain')],
      });
      return;
    case 'executeAction':
      if (body.driverAction !== 'tap') {
        fail(request, 'unsupported', 'unsupported_action', 'replacement fixture supports only tap');
        return;
      }
      respond(request, {
        driverAction: 'tap',
        status: 'completed',
        raw: artifact(undefined, 'node/tap.json', 'application/json'),
      });
      return;
    case 'waitCondition':
      if (body.clockDomain !== 'device-log' || body.condition?.truthEvent !== 'app.ready') {
        fail(request, 'unsupported', 'unsupported_condition', 'replacement fixture supports only app.ready on device-log');
        return;
      }
      respond(request, {
        condition: { truthEvent: 'app.ready' },
        matched: true,
        clockDomain: 'device-log',
        truthEvent: {
          name: 'app.ready',
          observedAt: '2026-06-19T12:00:02.000Z',
          payload: { screen: 'Home' },
        },
        artifacts: [artifact('truth-events', 'node/truth-events.jsonl', 'application/x-ndjson')],
      });
      return;
    case 'captureEvidence':
      if (!body.kinds?.includes('screenshot')) {
        fail(request, 'unsupported', 'unsupported_evidence', 'replacement fixture requires screenshot evidence');
        return;
      }
      respond(request, {
        artifacts: [
          artifact('screenshot', 'node/final-screen.png', 'image/png'),
          artifact('logs', 'node/device.log', 'text/plain'),
        ],
      });
      return;
    case 'stop':
      if (!state.launched) {
        fail(request, 'cleanup', 'not_launched', 'stop requires an active launched target');
        return;
      }
      state.launched = false;
      respond(request, {
        status: 'stopped',
        artifacts: [artifact('logs', 'node/stop.txt', 'text/plain')],
      });
      return;
    case 'finalize':
      state.finalized = true;
      respond(request, {
        status: 'finalized',
        adapter: { name: 'asl-node-replacement-fixture', version: '0.1.0' },
        artifacts: [artifact('manifest', 'node/manifest.json', 'application/json')],
      });
      return;
    default:
      fail(request, 'unsupported', 'unsupported_operation', `unsupported operation ${request.type}`);
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write('invalid adapter input\n');
    process.exitCode = 1;
    input.close();
    return;
  }
  if (!canCorrelate(request)) {
    process.stderr.write('invalid adapter input\n');
    process.exitCode = 1;
    input.close();
    return;
  }
  handle(request);
});
