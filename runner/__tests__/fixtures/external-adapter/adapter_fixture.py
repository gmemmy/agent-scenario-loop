#!/usr/bin/env python3
import json
import sys


ADAPTER = {
    "name": "asl-python-conformance-fixture",
    "version": "0.1.0",
}

EMPTY_SHA256 = "0" * 64
FIXTURE_NOW = "2026-06-19T12:00:00.000Z"

CAPABILITIES = [
    "prepare",
    "launch",
    "command",
    "truthEvent",
    "evidence",
    "cancel",
    "stop",
    "finalize",
]

seq = 1
state = {
    "prepared": False,
    "launched": False,
    "finalized": False,
    "last_host_seq": 0,
}


def write_message(message):
    global seq
    message["seq"] = seq
    seq += 1
    sys.stdout.write(json.dumps(message, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def base_response(request):
    response = {
        "protocolVersion": request.get("protocolVersion", "1.0"),
        "kind": "response",
        "type": request.get("type"),
        "operationId": request.get("operationId"),
    }
    for key in ("runId", "attemptId"):
        if key in request:
            response[key] = request[key]
    return response


def ok(request, result):
    response = base_response(request)
    response["body"] = {
        "ok": True,
        "result": result,
    }
    write_message(response)


def failure_category(code):
    if code == "deadline_expired":
        return "deadline"
    if code in ["unsupported_action", "unsupported_operation"]:
        return "unsupported"
    if code in ["not_launched", "already_finalized"]:
        return "cleanup"
    if code in ["invalid_json", "invalid_sequence"]:
        return "protocol"
    return "adapter"


def fail(request, code, message, retryable=False, details=None):
    response = base_response(request)
    failure = {
        "category": failure_category(code),
        "code": code,
        "message": message,
        "retryable": retryable,
    }
    if details is not None:
        failure["details"] = details
    response["body"] = {
        "ok": False,
        "failure": failure,
    }
    write_message(response)


def is_expired(request):
    deadline = request.get("deadline")
    return isinstance(deadline, str) and deadline <= FIXTURE_NOW


def fail_if_expired(request):
    if not is_expired(request):
        return False
    fail(
        request,
        "deadline_expired",
        "operation deadline expired before adapter work started",
        True,
        {
            "deadline": request.get("deadline"),
            "clockDomain": "host-monotonic",
        },
    )
    return True


def fail_if_invalid_host_sequence(request):
    seq_value = request.get("seq")
    expected_seq = state["last_host_seq"] + 1
    if seq_value == expected_seq:
        state["last_host_seq"] = seq_value
        return False
    fail(
        request,
        "invalid_sequence",
        "host seq must increase by exactly one",
        False,
        {
            "actualSeq": seq_value,
            "expectedSeq": expected_seq,
        },
    )
    return True


def handle_hello(request):
    ok(request, {
        "adapter": ADAPTER,
        "acceptedProtocolVersion": "1.0",
        "platforms": ["android", "ios"],
        "capabilities": CAPABILITIES,
        "driverActions": ["tap", "assertVisible"],
        "artifactOutputs": ["logs", "screenshot", "truth-events"],
        "clockDomains": ["host-monotonic", "device-log"],
    })


def handle_prepare(request):
    if fail_if_expired(request):
        return
    body = request.get("body", {})
    state["prepared"] = True
    ok(request, {
        "platform": body.get("platform"),
        "target": body.get("target", {}),
        "artifactsRoot": body.get("artifactsRoot", "artifacts/asl/run-001"),
        "adapter": ADAPTER,
    })


def handle_launch(request):
    if fail_if_expired(request):
        return
    if not state["prepared"]:
        fail(request, "not_prepared", "prepare must complete before launch")
        return
    state["launched"] = True
    ok(request, {
        "status": "launched",
        "targetRef": "fixture-target",
        "artifacts": [
            {
                "kind": "logs",
                "path": "raw/launch.txt",
                "contentType": "text/plain",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            }
        ],
    })


def handle_execute_action(request):
    if fail_if_expired(request):
        return
    body = request.get("body", {})
    action = body.get("driverAction")
    if action not in ["tap", "assertVisible"]:
        fail(
            request,
            "unsupported_action",
            "driverAction `{}` is not supported".format(action),
            False,
            {"driverAction": action},
        )
        return
    ok(request, {
        "driverAction": action,
        "status": "completed",
        "raw": {
            "path": "raw/execute-{}.json".format(action),
            "contentType": "application/json",
            "sha256": EMPTY_SHA256,
            "sizeBytes": 0,
        },
    })


def handle_wait_condition(request):
    if fail_if_expired(request):
        return
    body = request.get("body", {})
    ok(request, {
        "condition": body.get("condition"),
        "matched": True,
        "clockDomain": body.get("clockDomain"),
        "truthEvent": {
            "name": "app.ready",
            "observedAt": "2026-06-19T12:00:02.000Z",
            "payload": {
                "screen": "Home",
            },
        },
        "artifacts": [
            {
                "kind": "truth-events",
                "path": "raw/truth-events.jsonl",
                "contentType": "application/x-ndjson",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            }
        ],
    })


def handle_capture_evidence(request):
    if fail_if_expired(request):
        return
    ok(request, {
        "artifacts": [
            {
                "kind": "screenshot",
                "path": "captures/final-screen.png",
                "contentType": "image/png",
                "description": "Deterministic fixture screenshot reference",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            },
            {
                "kind": "logs",
                "path": "raw/device.log",
                "contentType": "text/plain",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            },
        ]
    })


def handle_cancel(request):
    if fail_if_expired(request):
        return
    body = request.get("body", {})
    ok(request, {
        "targetOperationId": body.get("targetOperationId"),
        "status": "not-running",
        "reason": body.get("reason"),
    })


def handle_stop(request):
    if fail_if_expired(request):
        return
    if not state["launched"]:
        fail(
            request,
            "not_launched",
            "stop requires an active launched target",
            False,
            {
                "cleanupStatus": "not-required",
                "operation": "stop",
            },
        )
        return
    state["launched"] = False
    ok(request, {
        "status": "stopped",
        "artifacts": [
            {
                "kind": "logs",
                "path": "raw/stop.txt",
                "contentType": "text/plain",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            }
        ],
    })


def handle_finalize(request):
    if state["finalized"]:
        fail(
            request,
            "already_finalized",
            "adapter has already finalized this attempt",
            False,
            {
                "cleanupStatus": "passed",
                "operation": "finalize",
            },
        )
        return
    state["finalized"] = True
    ok(request, {
        "status": "finalized",
        "adapter": ADAPTER,
        "artifacts": [
            {
                "kind": "manifest",
                "path": "manifest.json",
                "contentType": "application/json",
                "sha256": EMPTY_SHA256,
                "sizeBytes": 0,
            }
        ],
    })


HANDLERS = {
    "hello": handle_hello,
    "prepare": handle_prepare,
    "launch": handle_launch,
    "executeAction": handle_execute_action,
    "waitCondition": handle_wait_condition,
    "captureEvidence": handle_capture_evidence,
    "cancel": handle_cancel,
    "stop": handle_stop,
    "finalize": handle_finalize,
}


for line in sys.stdin:
    if not line.strip():
        continue
    try:
        request = json.loads(line)
    except json.JSONDecodeError as error:
        synthetic = {
            "protocolVersion": "1.0",
            "kind": "request",
            "type": "decodeError",
            "operationId": "decode-error",
        }
        fail(synthetic, "invalid_json", str(error))
        continue

    if fail_if_invalid_host_sequence(request):
        continue

    handler = HANDLERS.get(request.get("type"))
    if handler is None:
        fail(request, "unsupported_operation", "operation `{}` is not supported".format(request.get("type")))
        continue
    handler(request)
