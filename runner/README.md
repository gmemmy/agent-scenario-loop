# Runner

The runner owns host execution. It is the boundary between scenario contracts and whichever tool actually drives the device or captures evidence.

The package ships nineteen public runner entrypoints. Package scripts build them into `dist/` before execution:

- `agent-device.ts`: executes scenario-declared portable driver actions through the external `agent-device` CLI, then writes ASL health, verdict, raw command transcripts, and capture artifacts.
- `android-adb.ts`: checks adb availability, connected Android device readiness, optional package installation, optional React Native debug-host setup, optional package launch, ordered adb driver actions, bounded logcat output, and raw adb evidence.
- `argent.ts`: executes scenario-declared launch and Argent-compatible portable driver actions through the external Argent CLI, then writes ASL health, verdict, raw command transcripts, and any screenshot captures Argent produced.
- `check-plan.ts`: validates a scenario manifest, primary runner capability manifest, and optional evidence-provider manifests, then writes schema-checked `health.json`, `verdict.json`, `agent-summary.md`, and `planner-compatibility.json` before execution.
- `compare.ts`: reads two completed run directories, validates `health.json` and `verdict.json`, then writes or prints a schema-checked `comparison.json`, including trusted native-performance comparison truth when the same-condition contract is proven.
- `compare-latest.ts`: scans an artifact root for the newest trusted prior run for a scenario, rejects unhealthy current runs, then writes or prints a schema-checked `comparison.json`, including trusted native-performance comparison truth when available.
- `demo-loop.ts`: runs the fixture preflight, profile history, and latest-trusted comparison without requiring a simulator.
- `example-android-live.ts`: runs the packaged example Android live proof with adb preflight and the canonical startup, open-close, and scroll-settle scenarios.
- `example-ios-live.ts`: runs the packaged example iOS live proof with simctl preflight and the canonical startup, open-close, and scroll-settle scenarios.
- `host-doctor.ts`: runs aggregate host/device preflight checks for adb, simctl, agent-device, and Argent, then writes ASL health and verdict artifacts before live proof starts.
- `init-project.ts`: copies package templates into a conventional consuming app layout without overwriting existing files by default.
- `ios-simctl.ts`: checks iOS simulator readiness, optional app installation, optional app launch, profile-session storage seeding, storage-backed command seeding, profile-session deep links, bounded simulator logs, stored profile-event collection, lifecycle crash detection, host crash-report attachment, raw simctl evidence, and whole-capture liveness publication when simctl work stalls after output setup.
- `live-android.ts`: runs one generic Android scenario through adb preflight, profile-session capture, optional agent-device and Argent sidecars, optional latest-trusted comparison, and aggregate live-proof writing.
- `live-ios.ts`: runs one generic iOS scenario through simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, optional latest-trusted comparison, and aggregate live-proof writing.
- `live-proof.ts`: validates aggregate `live-proof.json` artifacts, prints their status and next action, and can fail on regressions.
- `profile-android.ts`: reads project config and an Android scenario manifest, then profiles explicit event logs, prior adb artifacts, or an owned adb capture window. During profile-session capture, Android-specific command metadata takes precedence; otherwise it derives command steps from `buildScenarioExecutionPlan()`.
- `profile-ios.ts`: reads project config and an iOS scenario manifest, then profiles explicit event logs, prior simctl artifacts, or an owned simctl capture window. During profile-session capture, iOS-specific command metadata takes precedence; otherwise it derives command steps from `buildScenarioExecutionPlan()`.
- `resource-lease.ts`: deterministic lease inspect/acquire/heartbeat/release helpers that coordinate with operation guards, use atomic heartbeat replacement, preserve tombstone-verified release outcomes, and expose explicit acquisition/release durability status for bounded resource arbitration.
- `validate-project.ts`: validates initialized project config, scenario manifests, runner manifests, and planner compatibility before runtime proof.

The package also exports small adapter modules for device drivers. `runner/android-adb-driver` exposes adb-backed `tap`, `scroll`, `swipe`, `assertVisible`, `inspectTree`, `screenshot`, `record`, and `readLogs` driver actions, and keeps Android-specific helpers such as log clearing, package launch, and deep-link execution behind explicit method names. `runner/ios-simctl-driver` exposes simctl-backed `screenshot` and `readLogs` evidence actions while keeping launch, terminate, and deep-link helpers explicit. The iOS screenshot action supports the synchronous `simctl io screenshot` options for image type, display, and mask. `runner/agent-device-driver` maps portable actions to the external `agent-device` CLI for iOS or Android, including coordinate-backed `focus`, orientation rotation, app open/close, and alert helpers, without making agent-device a package dependency. `runner/argent` wraps Argent as an ASL artifact-writing runner, while `runner/argent-driver` maps Argent's optional CLI/MCP-backed tool surface to coordinate-backed gestures, launch, screenshot requests, and UI descriptions without making Argent a package dependency. Planner compatibility fails early when Argent gesture steps omit required coordinate metadata or visibility assertions omit portable selectors.

Profile runners normalize scenario steps through `buildScenarioExecutionPlan()` before dispatching adapter-owned driver actions. Android adb owns selector-backed gestures, assertions, UI tree capture, logs, screenshots, and video recording. iOS simctl owns simulator screenshots, logs, launch helpers, deep links, lifecycle checks, and profile-session evidence collection. Agent-device and Argent can attach external interaction proof without changing the scenario contract.

Those deeper orchestration capabilities land behind the same artifact contract. Primary runners own one run lifecycle. Evidence providers attach optional or required evidence through a smaller provider interface. Provider manifests can declare no-shell commands and output files; profile runners preserve those outputs through `artifacts.evidenceAttachments` without bundling the provider tool. Tools such as axe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and log collectors plug in as adapters, so scenarios and artifacts stay stable while tactical tools change underneath.

Runner manifests separate `capabilities` from `driverActions`. Capabilities say the runner can own parts of the lifecycle or evidence contract. Driver actions say the underlying adapter can perform concrete operations such as `tap`, `longPress`, `drag`, `typeText`, `fill`, `focus`, `scroll`, `swipe`, `pinch`, `rotate`, `rotateGesture`, `pressKey`, `pressButton`, `assertVisible`, `inspectTree`, `screenshot`, `record`, `readLogs`, or `collectPerfSignals`. `check-plan` fails before execution when a required scenario step declares a `driverAction` no active runner or provider supports.

`examples/runners` includes adapter-target manifests for `agent-device`, Argent, XcodeBuildMCP, and axe-style accessibility evidence, plus `script-*` provider manifests for accessibility, profiler, memory, native performance, and network evidence. These fixtures let the planner prove capability matching and command-output inventory. For agent-device, the shipped driver adapter covers the portable interaction subset, including target-backed `longPress`, target-backed `pressButton`, target-backed `fill`, coordinate-backed `focus`, supported-key `pressKey`, focused-field `typeText`, coordinate-backed `swipe`, orientation `rotate`, and iOS `pinch` with explicit scale, while broader tool surfaces still stay behind explicit future adapters or provider attachments. When an installed Agent Device exposes `capabilities --json`, `asl-agent-device --check` uses that target inventory for driver command checks, records the raw probe source, and writes a normalized ASL capability/driver-action inventory in raw availability evidence; older installs fall back to help-output command discovery. For Argent, the shipped runner covers launch, coordinate-backed tap, long-press, drag, pinch, rotate-gesture, scroll, and swipe inputs, screenshot requests, and UI descriptions for `exact`, `contains`, and `regex` selector matches, while React profiler output first lands as provider evidence under `signals/js` unless a future adapter maps it into a stable ASL artifact. Direct `asl-agent-device --check --out <dir>` and `asl-argent --check --out <dir>` runs write `health.json`, `verdict.json`, `agent-summary.md`, and raw availability JSON, so command-surface proof can be preserved before live proof starts.

After planning passes, `buildScenarioExecutionPlan()` normalizes scenario steps into the adapter-facing work list. It preserves app commands and milestones, records required versus optional steps, maps step kinds to the runner port method that owns execution, and carries resolved cadence settle windows when the scenario declares pacing policy.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.

## Capability Map

Use runner entrypoints by responsibility:

| Responsibility | Entrypoints |
| --- | --- |
| Plan and project validation | `check-plan.ts`, `validate-project.ts`, `init-project.ts` |
| Deterministic fixture proof | `demo-loop.ts` |
| Raw platform capture | `android-adb.ts`, `ios-simctl.ts` |
| Profile artifact writing | `profile-android.ts`, `profile-ios.ts` |
| Aggregate live proof | `live-android.ts`, `live-ios.ts`, `live-proof.ts` |
| External interaction proof | `agent-device.ts`, `argent.ts` |
| Baseline comparison | `compare.ts`, `compare-latest.ts` |
| Packaged example proof | `example-android-live.ts`, `example-ios-live.ts` |
| Host readiness | `host-doctor.ts` |

Use adapter modules by tool surface:

| Adapter | Current supported surface | Boundary |
| --- | --- | --- |
| `android-adb-driver` | `tap`, `scroll`, `swipe`, `assertVisible`, `inspectTree`, `screenshot`, `record`, `readLogs` | Android-only adb driver actions plus explicit launch, deep-link, and log helpers |
| `ios-simctl-driver` | `screenshot`, `readLogs` | iOS simulator evidence actions plus explicit launch, terminate, and deep-link helpers |
| `agent-device-driver` | portable app open/close, alert helpers, gestures, screenshots, and supported assertions | Shells out to `agent-device`; does not bundle the tool |
| `argent-driver` | coordinate-backed gestures, launch, screenshot requests, and UI descriptions | Shells out to Argent; does not bundle the tool |
| `argent` | ASL artifact-writing runner for Argent proof | Wraps Argent command-surface checks and scenario execution as health/verdict artifacts |
| provider commands | declared command outputs, signals, captures, and raw provider files | Project-local scripts run without a shell and are inventoried as evidence attachments |

## Operational Docs

This file maps runner capabilities. It intentionally does not duplicate the live-proof runbook.

- For command recipes, host-specific `.asl.local.env` usage, adb and simctl capture windows, generic live proof commands, sidecar ordering, and live-proof gating, read [Live Proofs](../docs/live-proofs.md).
- For `health.json`, `verdict.json`, `manifest.json`, `comparison.json`, artifact fields, evidence attachments, `comparisonLane`, `scenarioHash`, and baseline semantics, read [Contracts](../docs/contracts.md).
- For adding or classifying a runner, external tool target, or provider command, read [Adapter Onboarding](../docs/adapters.md).
- For consumer-app setup before live device work, read [Consumer App Rehearsal](../docs/consumer-rehearsal.md).

Runner limits remain the same: the package does not boot or control simulators, provide generic consuming-app install or build orchestration, drive broad semantic UI workflows beyond supported driver actions, or capture memory, network, or accessibility evidence from built-in drivers. `resource-lease.ts` is also not yet wired into built-in Android or iOS runners; it is a reusable helper surface for higher-level orchestration. Lease durability semantics are explicit at that boundary: publication hard-link failures are fail-closed before ownership, post-publication directory-sync failures are surfaced as untrusted acquisition/release evidence, and scoped helpers can skip protected work when acquisition durability is untrusted. Those capabilities belong in external adapters or provider commands that preserve the same ASL artifact contract.
