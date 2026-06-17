# Adapter Onboarding

Agent Scenario Loop treats runners as replaceable ports behind stable scenarios and artifacts. Add one adapter at a time: describe its capabilities, prove planner compatibility, run a scenario, and write the standard evidence artifacts.

## Choose The Role

Use a primary runner when the tool owns the scenario lifecycle:

- install or verify the app
- launch the app
- start and stop a profile session
- execute scenario steps
- capture required logs or truth-event evidence
- write health, verdict, manifest, metrics, and summaries

Use an evidence provider when the tool only contributes evidence:

- accessibility inspection
- profiler output
- memory snapshots
- network captures
- screenshots, video, or UI tree snapshots

A scenario should have one primary runner. Evidence providers can satisfy required evidence outputs or optional driver actions when they are active for the selected platform.

## Describe Capabilities

Create a runner manifest under `runner-manifests/` or use the fixtures in `examples/runners/` as a starting point. The shipped [runner and provider target matrix](../examples/runners/README.md) describes which fixtures are bundled adapters, external-tool targets, or project-local provider patterns.

Primary runner shape:

```json
{
  "schemaVersion": "1.0.0",
  "runnerId": "my-android-runner",
  "kind": "primary",
  "platforms": ["android"],
  "capabilities": ["launch", "sessionControl", "command", "logCapture", "artifactWrite"],
  "driverActions": ["tap", "scroll", "assertVisible", "readLogs"],
  "artifactOutputs": ["logs", "signals"],
  "lifecycle": ["prepare", "launch", "startSession", "executeStep", "waitForTruthEvent", "captureEvidence", "stopSession", "finalize"]
}
```

Evidence provider shape:

```json
{
  "schemaVersion": "1.0.0",
  "runnerId": "my-accessibility-provider",
  "kind": "evidenceProvider",
  "platforms": ["ios", "android"],
  "capabilities": ["accessibility"],
  "artifactOutputs": ["accessibility"],
  "lifecycle": ["prepare", "startWindow", "capture", "stopWindow", "finalize"]
}
```

Keep manifests honest. Do not declare a driver action until the adapter can execute it or the provider can produce the required evidence.

## Prove The Plan

Run compatibility before runtime:

```bash
asl-check-plan \
  --scenario scenarios/mobile/app-startup.json \
  --runner runner-manifests/primary-runner.json \
  --provider runner-manifests/evidence-provider.json \
  --platform android \
  --out artifacts/asl/plan/app-startup-android
```

For an initialized app, use the project-level gate:

```bash
asl-validate-project --root . --platform all --out artifacts/asl/project-validation
```

The project-validation artifact gives agents structured `nextActions` for missing files, unsupported platforms, incomplete helper wiring, package-script drift, and planner failures.

## Implement The Port

An adapter should map normalized scenario steps to tool calls:

| Scenario step | Port responsibility |
| --- | --- |
| `launch` | install, launch, or verify the app is open |
| `command` | dispatch an app command or driver gesture |
| `waitForMilestone` | wait for app-owned truth events |
| `captureEvidence` | collect logs, screenshots, UI trees, video, or provider output |

When a normalized step has a `driverAction`, use `dispatchDriverAction` from the package root to call the active driver. It rejects unknown actions and missing driver methods explicitly, so a scenario cannot silently pass through an adapter that lacks the requested capability.

The built-in adb and simctl adapters show the expected boundary:

- `runner/android-adb-driver.ts`: adb-backed tap, scroll, assertion, UI tree, screenshot, record, and log actions
- `runner/ios-simctl-driver.ts`: simctl-backed screenshot and log actions
- `runner/argent.ts`: Argent-backed ASL artifact runner for launch, coordinate-backed gestures, screenshots, and UI descriptions
- `runner/argent-driver.ts`: optional Argent-backed driver adapter without bundling Argent
- `runner/profile-android.ts` and `runner/profile-ios.ts`: profile artifact pipelines that turn raw evidence into health, metrics, verdicts, and summaries

External tools such as agent-device, Argent, XcodeBuildMCP, axe, profilers, and custom scripts should plug in behind the same shape. The tactical tool can change; the scenario and artifact contract should not.

## Preserve Evidence

Every run should leave agent-readable proof:

- `health.json`
- `verdict.json`
- `agent-summary.md`
- `manifest.json`
- `metrics.json`
- `causal-run.json`
- `budget-verdict.json` when budgets exist
- raw evidence under `raw/`
- captures under `captures/`
- provider signals under `signals/`

Do not treat timing as trustworthy unless scenario health passed. If setup fails, write failed health with a concrete next action instead of producing optimistic timing claims.

## Attach Provider Evidence

If a provider already wrote files, attach them during profiling:

```bash
asl-profile-android \
  --config asl.config.json \
  --scenario scenarios/android/app-startup.json \
  --events artifacts/raw/adb-logcat.txt \
  --signal js:artifacts/provider/js-profile.json \
  --signal network:artifacts/provider/network.har \
  --capture screenshot:artifacts/provider/final-screen.png
```

If the provider should run during profiling, declare `providerCommands` in its manifest. Commands run without a shell, preserve stdout/stderr/exit code, and inventory outputs in `manifest.artifacts.evidenceAttachments`. Runtime profiles reject a provider whose `platforms` do not include the selected platform before command execution, preserving the same active-provider semantics used by planner compatibility.

## Acceptance Checklist

- The manifest validates against `schemas/runner-capabilities.schema.json`.
- `asl-check-plan` passes for at least one scenario and platform.
- Failed setup produces failed health and a useful next action.
- Passed runs write the standard artifact set.
- Attached evidence is inventoried with stable run-relative paths.
- Package docs describe whether the adapter is bundled, a fixture target, or a project-local integration.
