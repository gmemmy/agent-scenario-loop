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

Long-press and native-preview proof is opt-in. A scenario can require `driverAction: "longPress"` and `uiContext: "nativePreview"` for platform-owned previews or preview menus, but adapters should declare those only when they can actually perform the long press and observe or capture the native preview surface. Unsupported preview surfaces should return unsupported evidence or fail planner compatibility; do not downgrade them into tap or normal app-UI assertions.

Richer UI actions are also opt-in. Driver manifests may declare actions such as `swipe`, `drag`, `pinch`, `rotate`, `customGesture`, `typeText`, `pressKey`, `pressButton`, or `runSequence` when the backing tool supports them and the adapter can preserve clear evidence. A fixed `runSequence` is appropriate only when all steps are known before execution; if a later step depends on observing the result of an earlier step, expose separate actions and assertions instead.

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

The project-validation artifact gives agents structured `nextActions` for missing files, unsupported platforms, incomplete helper wiring, invalid required config, package-script drift, and planner failures. Omitted optional package drivers are preserved as warnings so teams can declare only the runner lanes they intend to support.

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
- `runner/argent.ts`: Argent-backed ASL artifact runner for launch, coordinate-backed gestures, screenshot requests, and UI descriptions
- `runner/argent-driver.ts`: optional Argent-backed driver adapter without bundling Argent
- `runner/profile-android.ts` and `runner/profile-ios.ts`: profile artifact pipelines that turn raw evidence into health, metrics, verdicts, and summaries

External tools such as agent-device, Argent, XcodeBuildMCP, axe, profilers, and custom scripts should plug in behind the same shape. The tactical tool can change; the scenario and artifact contract should not.

Prefer capability-based orchestration over forcing one tool to own every surface. Use adb and simctl as the primary live profile capture lanes for app launch, logs, screenshots, profile-session truth, and causal timelines. Attach heavier or tool-specific diagnostics after the active profile window through provider commands or rehydration. Agent Device is a good fit for Android snapshots and cross-platform network/performance evidence when its session is bound to the target. Argent is a good fit for iOS accessibility descriptions when `describe` can return AXRuntime evidence; native hierarchy, video, trace, React DevTools, and long profiler captures should be explicit heavy lanes until a runner/provider maps them into stable ASL artifacts.

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

If the provider should run during profile artifact assembly, declare `providerCommands` in its manifest. Profile runners execute provider commands after the selected platform evidence source is available, including live `--adb-capture` / `--simctl-capture` runs and later `--adb-artifacts` / `--simctl-artifacts` rehydration runs. Use `phase: "afterCapture"` for diagnostics collected from an existing capture sidecar; use `phase: "postRun"` for evidence that should be understood as post-profile enrichment. The legacy `capture` phase is accepted as an after-capture alias. `prepare`, `startWindow`, `stopWindow`, and `finalize` are reserved lifecycle phases; current profile runners fail them with a classified unsupported-phase health check instead of pretending to schedule them around the active loop. Commands run without a shell, preserve stdout/stderr/exit code, and inventory outputs in `manifest.artifacts.evidenceAttachments`. Provider command outputs may set `required: true` so the matching diagnostic inventory entry is required when the provider successfully captures that output; scenario-authored required artifacts and capabilities remain canonical too. Provider command outputs may also set `redactionStatus` to `redacted`, `not-redacted`, or `unknown`; omit it when the provider has not inspected the artifact for sensitive data. The runner mirrors that declaration into `redactionPolicy.authority: "provider-declared"` and otherwise defaults attachment privacy authority to ASL's conservative copy policy. Runtime profiles reject a provider whose `platforms` do not include the selected platform before command execution, preserving the same active-provider semantics used by planner compatibility.

## Acceptance Checklist

- The manifest validates against `schemas/runner-capabilities.schema.json`.
- `asl-check-plan` passes for at least one scenario and platform.
- Failed setup produces failed health and a useful next action.
- Passed runs write the standard artifact set.
- Attached evidence is inventoried with stable run-relative paths.
- Package docs describe whether the adapter is bundled, a fixture target, or a project-local integration.

## Read next

- [Consumer App Rehearsal](consumer-rehearsal.md) for adopting the package inside an existing app
