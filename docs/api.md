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
  classifyNativePerformanceComparisonReadiness,
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
- comparison artifacts, including `comparison.json` schemaVersion `1.1.0` with optional native-performance comparison truth
- local historical evaluation structural types and semantic validation for consumer-produced `historical-evaluation.json`
- aggregate live-proof artifacts
- schema validation
- Android native-performance evidence normalization from provider-captured `gfxinfo`, framestats, `meminfo`, and trace-processor summaries
- iOS native-performance evidence normalization from provider-captured Instruments, xctrace, MetricKit, simctl, or native-trace summaries, including parser helpers for common xctrace and MetricKit text summaries
- shared Android/iOS native-performance comparison-readiness classification from captured source, bounded window, observed target, completeness, comparability, and claim evidence

TypeScript consumers can import `HistoricalEvaluationArtifact`, the explicitly named `UnvalidatedHistoricalEvaluationArtifact`, and the branded `ValidatedHistoricalEvaluationArtifact` from the package root. `HistoricalEvaluationArtifact` is an unvalidated structural alias; TypeScript cannot prove schema refinements or cross-record integrity. Call `validateHistoricalEvaluationArtifact(unknown)` to run both the strict schema and semantic integrity checks before accepting the branded result. The schema is shipped at `agent-scenario-loop/schemas/historical-evaluation.schema.json` and registered as `SCHEMAS.historicalEvaluation`. This V1 surface remains consumer-produced and local-only; it does not export an evaluator, selector, reader, writer, or CLI command, and it does not alter `comparison.json` or process exit behavior.

Use `dispatchDriverAction()` when a runner has already normalized a scenario step and needs to call the active stable built-in `DriverPort` implementation without binding to adb, simctl, agent-device, Argent, or another concrete tool. The shared port recognizes the same portable driver-action vocabulary as scenario manifests, including richer primitives such as `drag`, `rotateGesture`, `customGesture`, and `runSequence`. A driver still has to implement and declare each action explicitly; unsupported actions fail as missing methods instead of silently downgrading.

Use `buildAndroidNativePerformanceEvidence()` inside project-local provider scripts after they capture Android `dumpsys gfxinfo`, `dumpsys gfxinfo framestats`, `dumpsys meminfo`, or a structured trace-processor summary. The helper parses headline frame, per-frame framestats, jank, render, memory, CPU, scheduling, and trace-window fields into a schema-valid `nativePerformance` envelope while keeping comparability `diagnostic-only` until a separate baseline policy proves the run is comparable. Raw Perfetto traces and trace-processor outputs should be attached through the `attachments` option; the helper records them as diagnostic sources without claiming release comparability. Providers can also pass `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, `completenessStatus`, `comparisonPolicy`, and `comparisonMetrics` overrides when a native lane timed out, failed, was unsupported, ambiguous, incomplete, or intentionally not requested, so the artifact preserves provider-owned capture status and claim boundaries instead of implying every listed lane was captured or comparable. Live `agent-scenario-loop/runner/profile-android` runs can now bracket the active adb capture loop with provider `startWindow` and `stopWindow` commands, then stage raw run evidence before `afterCapture` normalization and `finalize`; fixture/event-log and `--adb-artifacts` runs still fail closed for those live-window phases. When a selected provider declares native-performance outputs, the live runner also stages `raw/native-performance-request.json` before `startWindow` so the provider can recover the exact requested app/target identity and the runner-owned active-loop policy before it starts capture; the runner also records the staged request hash in immutable provider command args so later phases can fail closed on drift. Those live runners also write the package-owned active-loop record at `raw/runner-active-loop-window.json`, and trusted target binding must copy that exact `startedAt`/`endedAt`/`durationMs` window instead of minting provider-local timestamps. Provider command placeholders now include `{appId}`, `{packageName}`, `{providerId}`, `{serial}`, `{targetId}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}` for Android window capture, and control phases may declare `outputs: []` when they manage session state rather than writing evidence immediately. When a provider wants comparison-ready truth, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` if it needs the hash-bound requested identity/window contract, write the observed target-binding record to `raw/providers/<providerId>/target-binding.json`, and preserve runner command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files. After `afterCapture` records the owning target-binding hash, later `finalize` work must stay in separate command records instead of mutating `target-binding.json` in place. Supplying app and device ids records the requested identity but no longer verifies it by itself; a provider must explicitly attach observed matching target proof before comparison classification can pass. Trusted native comparison additionally requires schemaVersion `1.1.0` plus a structured same-condition policy and metric-descriptor contract; older `1.0.0` envelopes remain readable for diagnosis but do not become comparison-ready on their own.
Keep policy/tool/source/build/environment inputs provider-owned by passing them through provider command args/env (for example `ASL_NATIVE_PERFORMANCE_POLICY_ID`, `ASL_NATIVE_PROVIDER_TOOL_VERSION`, `ASL_NATIVE_PERFORMANCE_TARGET_BUILD_MODE`, and `ASL_NATIVE_PERFORMANCE_ENVIRONMENT_JSON`) rather than extending the runner-owned request file.

The initialized provider script accepts `--gfxinfo`, `--framestats`, `--meminfo`, and `--trace-processor-summary` for Android inputs. The trace-processor value must point at a JSON object whose fields match the helper summary input, such as frame counts, deadline misses, CPU milliseconds, scheduling delay, trace id, and window start/end times.

Use `buildIosNativePerformanceEvidence()` inside project-local provider scripts after they capture iOS Instruments, xctrace, MetricKit, simctl, or native-trace summaries. The helper normalizes frame, hitch, memory, CPU, scheduling, thermal, battery, and trace-window fields into the same `nativePerformance` contract while preserving provider ownership of capture, export, and time-window binding. Providers can pass structured summary objects directly, or use `parseIosXctraceSummaryText()` and `parseIosMetricKitSummaryText()` to normalize common text/export summaries before building the evidence envelope. The same `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, `completenessStatus`, `comparisonPolicy`, and `comparisonMetrics` override inputs are available for iOS sources such as Instruments, xctrace, MetricKit, simctl, and native-trace lanes. Live `agent-scenario-loop/runner/profile-ios` runs can now bracket the active simctl capture loop with provider `startWindow` and `stopWindow` commands, then stage raw run evidence before `afterCapture` normalization and `finalize`; fixture/event-log and `--simctl-artifacts` runs still fail closed for those live-window phases. When a selected provider declares native-performance outputs, the live runner also stages `raw/native-performance-request.json` before `startWindow` so the provider can recover the exact requested app/target identity and the runner-owned active-loop policy before it starts capture; the runner also records the staged request hash in immutable provider command args so later phases can fail closed on drift. Those live runners also write the package-owned active-loop record at `raw/runner-active-loop-window.json`, and trusted target binding must copy that exact `startedAt`/`endedAt`/`durationMs` window instead of minting provider-local timestamps. Provider command placeholders now include `{appId}`, `{bundleId}`, `{providerId}`, `{targetId}`, `{udid}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}` for iOS window capture, and control phases may declare `outputs: []` when they manage session state rather than writing evidence immediately. Provider-owned capture sessions can also override `captureMode` and `lifecycle`; use this to preserve bounded start/end/duration facts and mark profiling perturbation truthfully. When a provider wants comparison-ready truth, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` if it needs the hash-bound requested identity/window contract, write the observed target-binding record to `raw/providers/<providerId>/target-binding.json`, and preserve runner command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files. After `afterCapture` records the owning target-binding hash, later `finalize` work must stay in separate command records instead of mutating `target-binding.json` in place. As on Android, bundle and device ids remain unverified until the provider attaches observed matching target proof. Trusted native comparison additionally requires schemaVersion `1.1.0` plus the structured same-condition policy and metric-descriptor contract; older `1.0.0` envelopes remain readable for diagnosis but do not satisfy comparison readiness by themselves.

Use `classifyNativePerformanceComparisonReadiness(evidence, context)` before treating either platform's envelope as comparison evidence. The caller-owned context supplies the current platform/provider/run/scenario identity, the run-relative path of the native-performance envelope, an `evidencePathExists` resolver for durable run artifacts, a `readEvidenceJson` resolver for run-contained JSON such as `raw/providers/<providerId>/target-binding.json`, and a `readEvidenceSha256` resolver that returns the current SHA-256 for any durable run-relative artifact the classifier needs to hash-check. This keeps filesystem ownership outside the contract helper while still letting the helper prove that target-binding command records, staged raw artifacts, and the final bound attachment all agree on exact bytes. It returns `comparison-ready` only when identity matches, the native-performance envelope and at least one captured source are durable inside the run, the artifact has complete evidence, a comparison claim with supporting evidence, an explicit comparable policy, schemaVersion `1.1.0` with structured `comparisonPolicy` and `comparisonMetrics`, a real capture timestamp and clock domain, at least one recognized numeric frame, memory, CPU, scheduling, GPU, I/O, network, thermal, or battery measurement, a consistent bounded lifecycle or trace window, and durable observed target proof matching the declared app and device. That observed proof must validate against the package target-binding schema, preserve exact requested and observed identities, preserve an `activeLoop` window for trusted same-condition capture, exactly match the runner-owned `raw/runner-active-loop-window.json` record for `startedAt`, `endedAt`, and `durationMs`, carry `captureArtifacts` entries that name the raw active-window artifacts used by the normalized evidence, and point back to immutable provider command records whose `startWindow` or `stopWindow` `outputs[]` entries carry matching `runRelativePath` and SHA-256 values for those same surfaced artifact paths. Timestamp, sequence, and capture-window metadata do not count as measurements, and after-capture normalization alone does not make a run comparison-ready. Otherwise it returns `diagnostic-only` with stable missing-evidence reasons. Structural schema validity is intentionally preserved so incomplete provider output remains available for diagnosis rather than disappearing behind a validation failure.

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
| `agent-scenario-loop/runner/ios-simctl-driver` | simctl-backed `screenshot`, bounded `record`, and `readLogs` driver adapter; finalized video is exposed only after MP4/QuickTime validation |
| `agent-scenario-loop/runner/live-android` | generic one-scenario Android live proof runner with adb preflight, profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-ios` | generic one-scenario iOS live proof runner with simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-proof` | aggregate live-proof artifact validation, multi-artifact platform-set checks, durable `live-proof-set.json` writing, formatting, failed-proof gating, and regression gating |
| `agent-scenario-loop/runner/profile-android` | Android profile artifact pipeline |
| `agent-scenario-loop/runner/profile-ios` | iOS profile artifact pipeline |
| `agent-scenario-loop/runner/resource-lease` | deterministic lease inspect/acquire/heartbeat/release helpers using operation guards, atomic heartbeat replacement, tombstone-verified release retention, explicit durability evidence, and canonical mobile-target, TCP-port, provider, and hashed lease-path identity helpers |
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

`agent-scenario-loop/app/profile-session` is shipped as React Native source with a package-owned declaration file. Apps can copy `app/profile-session.ts` into their own codebase or re-export the package subpath from an app-local helper module. The `react-native` runtime condition points at `app/profile-session.ts` because the helper depends on app-side React Native modules, app bundling, and platform storage behavior; the `types` condition points at `app/profile-session.d.ts` so consumer TypeScript does not need to parse the implementation file from `node_modules`.

The intended integration is:

1. Copy `app/profile-session.ts` into the app, or re-export `agent-scenario-loop/app/profile-session` from an app-local helper.
2. Wire `useProfileSessionBootstrap()` once near the app root.
3. Emit app-owned truth events with `emitProfileEvent()`.
4. Register optional command targets with `registerProfileCommandTargetHandler()`.

## Stability Rule

If a function, binary, schema, or example path is listed here, package smoke should verify that it is present in the packed tarball. If a new public entrypoint is added, update this document and the smoke expectations in the same change.
