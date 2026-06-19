# External Adapter Protocol

ASL core is TypeScript, but the adapter contract is language-neutral. An external adapter is an out-of-process executable that exchanges newline-delimited JSON messages over stdin and stdout. The executable can be written in any language and must not depend on ASL TypeScript internals.

This document defines the minimal protocol surface for conformance fixtures and future adapter hosts. JSON Schema and this normative protocol document are the source of truth for portable behavior; built-in TypeScript runners remain implementations of the same contract, not the contract itself. The protocol message schema is published in `schemas/external-adapter-message.schema.json`.

## Transport

- The host starts the adapter as a child process without a shell.
- Each message is one UTF-8 JSON object followed by `\n`.
- stdout is reserved for protocol messages. Diagnostics must go to stderr.
- Requests and responses are correlated by `operationId`.
- `seq` is a monotonically increasing integer within each sender's stream.
- Timestamps use RFC 3339 strings. Timing-sensitive waits must declare their `clockDomain`.
- Paths in artifact references are run-relative unless `uri` is explicitly used.

## Envelope

Every message uses the same envelope:

```json
{
  "protocolVersion": "1.0",
  "seq": 1,
  "operationId": "op-001",
  "kind": "request",
  "type": "hello",
  "runId": "run-001",
  "attemptId": "attempt-001",
  "deadline": "2026-06-19T12:00:05.000Z",
  "body": {}
}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `protocolVersion` | yes | Protocol major/minor string. This document defines `1.0`. |
| `seq` | yes | Sender-local message sequence. |
| `operationId` | yes | Correlates one request with one response. Cancellation targets this value. |
| `kind` | yes | `request`, `response`, or `event`. |
| `type` | yes | Operation or event name. |
| `runId` | request after `hello` | Stable ASL run identifier. |
| `attemptId` | request after `hello` | Stable retry/attempt identifier for the run. |
| `deadline` | request operations | Absolute deadline for bounded work. |
| `body` | yes | Operation-specific payload. |

Responses must echo `protocolVersion`, `operationId`, `runId`, and `attemptId` when those fields were present on the request.

## Hello And Capability Discovery

The first host message must be `hello`. The adapter responds with its identity, supported protocol range, platforms, capabilities, driver actions, artifact outputs, and clock domains.

Request body:

```json
{
  "host": {
    "name": "agent-scenario-loop",
    "version": "0.1.x"
  },
  "platform": "android"
}
```

Response body:

```json
{
  "adapter": {
    "name": "asl-python-conformance-fixture",
    "version": "0.1.0"
  },
  "acceptedProtocolVersion": "1.0",
  "platforms": ["android", "ios"],
  "capabilities": ["prepare", "launch", "command", "truthEvent", "evidence", "cancel", "stop", "finalize"],
  "driverActions": ["tap", "assertVisible"],
  "artifactOutputs": ["logs", "screenshot", "truth-events"],
  "clockDomains": ["host-monotonic", "device-log"]
}
```

If the adapter cannot support the requested protocol or platform, it must return a structured failure response and then exit cleanly or wait for `finalize`.

## Operations

All operation responses use:

```json
{
  "ok": true,
  "result": {}
}
```

or:

```json
{
  "ok": false,
  "failure": {
    "code": "unsupported_action",
    "message": "driverAction `pinch` is not supported",
    "retryable": false,
    "details": {
      "driverAction": "pinch"
    }
  }
}
```

### prepare

Validates target configuration, creates or verifies run directories, and reports setup metadata. The request body should include `platform`, target identifiers, environment assumptions, and an optional `artifactsRoot`.

The response should include normalized target metadata and any adapter-owned artifact directories.

### launch

Launches or verifies the app, device, browser, or other target. The request body should include `platform`, `target`, and optional launch arguments.

The response should include launch status, a target reference when available, and artifact references for raw command output.

### executeAction

Executes one portable driver action. The request body must include `driverAction` and action-specific input. The adapter must reject unknown or unsupported actions with `ok: false`.

### waitCondition

Waits for a truth event, UI condition, log marker, or other bounded condition. The request body must include `condition`, `deadline`, and `clockDomain`.

The response should include matched truth-event data when available. Timing values are not trustworthy verdict inputs unless scenario health passed.

### captureEvidence

Captures logs, screenshots, UI trees, videos, profiler output, or provider signals. The response must return artifact references:

```json
{
  "artifacts": [
    {
      "kind": "screenshot",
      "path": "captures/final-screen.png",
      "contentType": "image/png",
      "description": "Final screen after launch"
    }
  ]
}
```

### cancel

Requests cancellation of an in-flight `operationId`. The body must include `targetOperationId` and a human-readable `reason`. Adapters should make cancellation best effort and respond to the original operation with `code: "cancelled"` if it was interrupted.

### stop

Stops the active app/session/target while preserving evidence produced so far. This is distinct from `finalize`; the adapter may still accept evidence capture or finalization work after stop.

### finalize

Flushes pending protocol output, closes adapter-owned resources, and reports final artifact inventory. After a successful `finalize` response the adapter should exit with code `0`.

## Events

Adapters may emit `event` messages between request responses for truth events, progress, and evidence discovery:

```json
{
  "protocolVersion": "1.0",
  "seq": 4,
  "kind": "event",
  "type": "truthEvent",
  "runId": "run-001",
  "attemptId": "attempt-001",
  "body": {
    "name": "app.ready",
    "clockDomain": "device-log",
    "observedAt": "2026-06-19T12:00:02.000Z",
    "payload": {
      "screen": "Home"
    }
  }
}
```

Events must not replace the response for an operation. The host should still receive one terminal response for every request except when the process exits unexpectedly.

## Conformance Fixture

The fixture under `runner/__tests__/fixtures/external-adapter/` is intentionally small and non-JavaScript. It proves that a conforming adapter can be an external process with no ASL TypeScript imports. Golden transcripts in the same directory define the expected request/response behavior for the success path and a structured failure path.
