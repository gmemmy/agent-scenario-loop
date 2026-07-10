# Public API

Agent Scenario Loop keeps its public surface small: the root package exports stable core contracts, while runner subpaths expose executable adapters for teams that want to compose the proof loop from code.

## Root Package

Import core contracts from `agent-scenario-loop`:

```js
const {
  buildAgentSummaryMarkdown,
  buildScenarioExecutionPlan,
  buildRunIndex,
  buildAndroidNativePerformanceEvidence,
  compareRunDirectories,
  createArtifactLayout,
  dispatchDriverAction,
  evaluateRunnerCompatibility,
  validateJson,
} = require('agent-scenario-loop');
```

The root package is for stable, runner-neutral behavior:

- artifact layout and artifact writers
- profile-event parsing, metrics, manifests, causal runs, budget verdicts, and summaries
- scenario execution-plan normalization, including resolved cadence pacing metadata
- scenario/runner/provider compatibility checks
- port validation and driver dispatch helpers
- typed port contracts for primary runners, drivers, evidence providers, artifact writers, and interpreters
- evidence interpretation gates
- run indexing and lane-aware latest-trusted comparison selection
- comparison artifacts
- aggregate live-proof artifacts
- schema validation
- Android native-performance evidence normalization from provider-captured `gfxinfo`, framestats, `meminfo`, and trace-processor summaries
- iOS native-performance evidence normalization from provider-captured Instruments, xctrace, MetricKit, simctl, or native-trace summaries, including parser helpers for common xctrace and MetricKit text summaries

Use `dispatchDriverAction()` when a runner has already normalized a scenario step and needs to call the active stable built-in `DriverPort` implementation without binding to adb, simctl, agent-device, Argent, or another concrete tool. The shared port recognizes the same portable driver-action vocabulary as scenario manifests, including richer primitives such as `drag`, `rotateGesture`, `customGesture`, and `runSequence`. A driver still has to implement and declare each action explicitly; unsupported actions fail as missing methods instead of silently downgrading.

Use `buildAndroidNativePerformanceEvidence()` inside project-local provider scripts after they capture Android `dumpsys gfxinfo`, `dumpsys gfxinfo framestats`, `dumpsys meminfo`, or a structured trace-processor summary. The helper parses headline frame, per-frame framestats, jank, render, memory, CPU, scheduling, and trace-window fields into a schema-valid `nativePerformance` envelope while keeping comparability `diagnostic-only` until a separate baseline policy proves the run is comparable. Raw Perfetto traces and trace-processor outputs should be attached through the `attachments` option; the helper records them as diagnostic sources without claiming release comparability. Providers can also pass `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, and `completenessStatus` overrides when a native lane timed out, failed, was unsupported, ambiguous, incomplete, or intentionally not requested, so the artifact preserves provider-owned capture status and claim boundaries instead of implying every listed lane was captured or comparable. These overrides still pass through the native-performance schema; `sufficient-for-comparison` is rejected unless the evidence is complete, comparable, and bound to a verified target.

The initialized provider script accepts `--gfxinfo`, `--framestats`, `--meminfo`, and `--trace-processor-summary` for Android inputs. The trace-processor value must point at a JSON object whose fields match the helper summary input, such as frame counts, deadline misses, CPU milliseconds, scheduling delay, trace id, and window start/end times.

Use `buildIosNativePerformanceEvidence()` inside project-local provider scripts after they capture iOS Instruments, xctrace, MetricKit, simctl, or native-trace summaries. The helper normalizes frame, hitch, memory, CPU, scheduling, thermal, battery, and trace-window fields into the same `nativePerformance` contract while preserving provider ownership of capture, export, and time-window binding. Providers can pass structured summary objects directly, or use `parseIosXctraceSummaryText()` and `parseIosMetricKitSummaryText()` to normalize common text/export summaries before building the evidence envelope. The same `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, and `completenessStatus` override inputs are available for iOS sources such as Instruments, xctrace, MetricKit, simctl, and native-trace lanes. Comparable claims still require an explicit provider policy, complete capture, and verified target binding.

## Runner Subpaths

Runner subpaths are public when a consuming project needs to compose a workflow without shelling out to the installed binaries:

| Subpath | Purpose |
| --- | --- |
| `agent-scenario-loop/runner/agent-device` | agent-device capture runner that executes scenario-declared portable driver actions and writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/android-adb` | Android adb readiness, launch, profile-session control, driver actions including tap, long press, key press, scroll, swipe, assertions, screenshots, recording, and logcat capture |
| `agent-scenario-loop/runner/android-adb-driver` | adb-backed `tap`, `longPress`, `pressKey`, `scroll`, `swipe`, `assertVisible`, `inspectTree`, `screenshot`, `record`, and `readLogs` driver adapter |
| `agent-scenario-loop/runner/agent-device-driver` | agent-device-backed portable action adapter for `tap`, `longPress`, `typeText`, `fill`, `focus`, `scroll`, `swipe`, `rotate`, `pressKey`, `pressButton`, iOS `pinch`, `assertVisible`, `inspectTree`, `screenshot`, `readLogs`, app open/close, and alert helpers |
| `agent-scenario-loop/runner/argent` | Argent capture runner that executes launch and coordinate-backed portable driver actions, then writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/argent-driver` | Argent-backed optional adapter for launch, URL open, normalized tap/long-press/drag/pinch/rotate-gesture/scroll/swipe inputs, screenshot requests, and UI descriptions without bundling Argent |
| `agent-scenario-loop/runner/check-plan` | scenario/runner/provider compatibility artifact generation |
| `agent-scenario-loop/runner/compare` | direct baseline/current comparison |
| `agent-scenario-loop/runner/compare-latest` | latest trusted prior-run comparison |
| `agent-scenario-loop/runner/demo-loop` | fixture-only loop proof |
| `agent-scenario-loop/runner/example-android-live` | packaged Android example live proof |
| `agent-scenario-loop/runner/example-ios-live` | packaged iOS example live proof |
| `agent-scenario-loop/runner/host-doctor` | aggregate host/device preflight for adb, simctl, agent-device, and Argent availability before live proof |
| `agent-scenario-loop/runner/init-project` | template scaffold command for consuming app layouts |
| `agent-scenario-loop/runner/ios-simctl` | iOS simctl readiness, storage-backed session control, stored event capture, lifecycle crash detection, and host crash-report attachment |
| `agent-scenario-loop/runner/ios-simctl-driver` | simctl-backed `screenshot` and `readLogs` driver adapter |
| `agent-scenario-loop/runner/live-android` | generic one-scenario Android live proof runner with adb preflight, profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-ios` | generic one-scenario iOS live proof runner with simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-proof` | aggregate live-proof artifact validation, multi-artifact platform-set checks, durable `live-proof-set.json` writing, formatting, failed-proof gating, and regression gating |
| `agent-scenario-loop/runner/profile-android` | Android profile artifact pipeline |
| `agent-scenario-loop/runner/profile-ios` | iOS profile artifact pipeline |
| `agent-scenario-loop/runner/validate-project` | project-level validation for initialized consumer app scaffolds |

Installed binaries mirror those runner entrypoints for CLI use.

## Shipped Fixtures

The package intentionally ships schemas and examples:

- `agent-scenario-loop/schemas/*`
- `agent-scenario-loop/examples/*`
- `agent-scenario-loop/templates/*`

These are public fixtures and contract references. Templates are safe starting points to copy into a consuming app and adapt. The optional `templates/skills/agent-scenario-loop/` folder gives repository-scoped agents ASL operating guidance without making the skill part of ASL runtime truth.

For concrete runner and evidence-provider integration steps, see [Adapter Onboarding](adapters.md).

## App Helper

`agent-scenario-loop/app/profile-session` is shipped as React Native source with a package-owned declaration file. Apps can copy `app/profile-session.ts` into their own codebase or re-export the package subpath from an app-local helper module. The runtime target remains source because it depends on app-side React Native modules, app bundling, and platform storage behavior; the `types` condition points at `app/profile-session.d.ts` so consumer TypeScript does not need to parse the implementation file from `node_modules`.

The intended integration is:

1. Copy `app/profile-session.ts` into the app, or re-export `agent-scenario-loop/app/profile-session` from an app-local helper.
2. Wire `useProfileSessionBootstrap()` once near the app root.
3. Emit app-owned truth events with `emitProfileEvent()`.
4. Register optional command targets with `registerProfileCommandTargetHandler()`.

## Stability Rule

If a function, binary, schema, or example path is listed here, package smoke should verify that it is present in the packed tarball. If a new public entrypoint is added, update this document and the smoke expectations in the same change.
