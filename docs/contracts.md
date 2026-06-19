# Contracts

This package ships the scenario, runner, and artifact contracts that make Agent Scenario Loop useful while live runners are added behind stable interfaces.

The package is intentionally contract-first: adopt the scenario and artifact shape once, then add or swap runner loops without rewriting your scenarios.

See [Architecture](architecture.md) for the TypeScript-first implementation and language-neutral contract boundary.

## What ships today

- [app/profile-session.ts](../app/profile-session.ts): thin React Native integration for session control, truth events, and signal attachments
- [core/agent-summary.ts](../core/agent-summary.ts): agent-facing summary builder for health, verdict, and comparison state
- [core/artifact-layout.ts](../core/artifact-layout.ts): canonical artifact path contract for one run directory
- [core/artifact-writer.ts](../core/artifact-writer.ts): schema-enforcing writers for stable JSON/text artifacts
- [core/comparison.ts](../core/comparison.ts): comparison artifact builder for trusted before/after run folders
- [core/artifact-contract.ts](../core/artifact-contract.ts): artifact builders for manifest, metrics, causal run, budget verdict, and summary
- [core/evidence-interpreter.ts](../core/evidence-interpreter.ts): evidence interpretation helpers that gate timing claims on scenario health
- [core/execution-plan.ts](../core/execution-plan.ts): scenario-step normalizer that maps portable steps to runner port methods before adapter execution
- [core/planner.ts](../core/planner.ts): compatibility checks between scenario requirements, primary runner capabilities, and evidence providers
- [core/ports.ts](../core/ports.ts): ports-and-adapters method surfaces for runners, drivers, providers, writers, and interpreters
- [core/run-index.ts](../core/run-index.ts): read-only artifact root index for finding trusted prior runs
- [core/schema-validator.ts](../core/schema-validator.ts): dependency-free validation for the JSON Schema subset used by the public contracts
- [runner/profile-android.ts](../runner/profile-android.ts): Android profile runner that can ingest profile-event logs directly, read adb artifact folders, or own a bounded adb capture window before writing the full artifact set
- [runner/ios-simctl.ts](../runner/ios-simctl.ts): iOS simulator capture runner for launch, profile-session storage seeding, profile-session deep links, bounded logs, stored profile-event collection, lifecycle crash detection, host crash-report attachment, and raw simctl evidence
- [runner/profile-ios.ts](../runner/profile-ios.ts): iOS profile runner that can ingest profile-event logs directly, read simctl artifact folders, or own a bounded simctl capture window before writing the full artifact set
- [runner/android-adb.ts](../runner/android-adb.ts): Android adb readiness preflight, optional package launch, ordered driver actions, and bounded logcat capture that write runner health and raw adb evidence
- [runner/android-adb-driver.ts](../runner/android-adb-driver.ts): adb-backed Android driver adapter for tap, scroll, UI tree, screenshot, and log capture plus Android-specific lifecycle helpers
- [runner/agent-device.ts](../runner/agent-device.ts): agent-device capture runner for portable app open, visibility, screenshot, and supported driver actions without bundling agent-device
- [runner/argent.ts](../runner/argent.ts): Argent capture runner for launch, coordinate-backed gestures, screenshot requests, and description-backed visibility proof without bundling Argent
- [runner/argent-driver.ts](../runner/argent-driver.ts): optional Argent adapter for normalized gestures, app launch, screenshot requests, and UI descriptions without making Argent a package dependency
- [runner/ios-simctl-driver.ts](../runner/ios-simctl-driver.ts): simctl-backed iOS driver adapter for screenshot and log capture plus explicit iOS lifecycle helpers
- [runner/live-android.ts](../runner/live-android.ts): generic Android live proof for one portable scenario with adb preflight, profile-session capture, optional agent-device and Argent sidecars, optional comparison, and aggregate proof writing
- [runner/live-ios.ts](../runner/live-ios.ts): generic iOS live proof for one portable scenario with simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, optional comparison, and aggregate proof writing
- [runner/example-android-live.ts](../runner/example-android-live.ts): packaged Android example live proof for adb preflight plus canonical startup, open-close, and scroll-settle scenarios
- [runner/example-ios-live.ts](../runner/example-ios-live.ts): packaged iOS example live proof for simctl preflight plus canonical startup, open-close, and scroll-settle scenarios
- [runner/host-doctor.ts](../runner/host-doctor.ts): aggregate host/device preflight for adb, simctl, agent-device, and Argent command availability before live proof starts
- [runner/live-proof.ts](../runner/live-proof.ts): live-proof artifact reader for validation, status formatting, and optional regression gating
- [runner/validate-project.ts](../runner/validate-project.ts): initialized project validator for app helper presence, package-script snippets, app `package.json` script merge and direct-bin drift, required config fields, scenario manifests, runner manifests, and planner compatibility
- [runner/demo-loop.ts](../runner/demo-loop.ts): fixture loop that proves preflight, profile history, and latest-trusted comparison without a simulator
- [examples/event-logs](../examples/event-logs): deterministic profile-event logs for the fixture loop
- [examples/mobile-app](../examples/mobile-app): neutral Expo dogfood app with scenario manifests and profile-event evidence fixtures
- [examples/scenarios/ios](../examples/scenarios/ios): iOS profile scenario manifests for the current log-ingest runner
- [examples/scenarios/mobile](../examples/scenarios/mobile): canonical portable scenario fixtures
- [examples/runners](../examples/runners): primary runner, evidence-provider, and adapter-target capability fixtures
- [schemas](../schemas): JSON Schemas for current artifacts plus the scenario and runner capability contracts

## Public app contract

App-side, your app exposes:

- session control: `startProfileSession`, `stopProfileSession`, `applyProfileSessionUrl`
- truth events: `emitProfileEvent`
- signal attachments: `storeProfileSignal`

The app integration is intentionally thin. The application emits truth; runners and providers collect evidence around it.

## Public scenario contract

Portable scenario manifests describe the durable app behavior before choosing a runner:

- `journey`: human-readable intent, actor, start state, and end state
- `platforms`: supported runtime targets
- `requiredCapabilities` and `optionalCapabilities`: runner capability requirements
- `steps[].driverAction`: optional concrete driver operation required by a step, such as `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, `record`, `readLogs`, or `collectPerfSignals`
- `comparisonLane`: optional default baseline lane for latest-trusted comparisons
- `truthEvents`: app-owned milestone events keyed by stable milestone id
- `milestones`: inspectable milestone list with event names, phases, timeouts, and descriptions
- `expectedEvents`: event names the runner or log ingest should expect to observe
- `cycles`: repeat count, warmup count, and failure policy for repeated journeys
- `budgets`: product thresholds evaluated only after scenario health passes
- `steps`: runner-facing launch, command, wait, gesture, and capture actions
- `selector`: optional app target on a step, such as a test id, accessibility id, label, text, resource id, or xpath
- `artifacts`: required and optional evidence outputs

The scenario contract is intentionally runner-neutral. Runners can map steps to adb, XcodeBuildMCP, agent-device, accessibility tools, profilers, or custom scripts while preserving the same journey, milestones, budgets, and expected events.

Runner capabilities describe ownership, such as launch, session control, command execution, log capture, artifact writing, or profiler support. Driver actions describe the concrete operations an adapter can perform inside a run. A runner may be able to own a scenario lifecycle without supporting every driver action; the planner fails only when a required step declares a `driverAction` that the selected runner or an active provider does not declare in `driverActions`.

`buildScenarioExecutionPlan()` turns the same scenario steps into a deterministic adapter-facing work list. Each normalized step records the scenario step id, original kind, required flag, optional driver action, and the runner port method that owns it: `launch`, `executeStep`, `waitForTruthEvent`, or `captureEvidence`.

Android adb capture routes normalized steps with `driverAction: "tap"`, `"scroll"`, `"assertVisible"`, `"inspectTree"`, `"screenshot"`, or `"readLogs"` through the adb driver adapter. `adapterOptions.androidAdb` carries action-specific metadata: coordinate fields for tap and scroll, `durationMs` for scroll, `logcatLines` for bounded logs, `waitMs` for capture timing, and `rawFileName` for evidence filename overrides. `assertVisible` requires a portable selector and verifies it against a UIAutomator tree dump, preserving that XML as raw evidence. Log capture keeps `raw/adb-logcat.txt` as the default profile input.

When Android adb `tap` or `scroll` steps provide a portable selector instead of coordinates, the runner captures `uiautomator dump` output, resolves supported selector kinds against node bounds, and derives adb input coordinates before executing the action. Built-in Android selector resolution supports `testId`, `resourceId`, `accessibilityId`, `accessibilityLabel`, and `text`; `xpath` stays available for external runners with native selector engines.

I/O from iOS simctl capture routes through the simctl driver adapter. `readLogs` preserves bounded simulator logs under `raw/ios-simctl-log.txt`. A scenario step with `driverAction: "screenshot"` or `artifact: "screenshot"` requests a screenshot capture, defaulting to `captures/ios-screenshot.png`; when `--screenshot-type`, `--screenshot-display`, or `--screenshot-mask` are supplied to `asl-ios-simctl`, the command passes those supported `simctl io screenshot` options and records them in capture metadata. The profile manifest records the resulting capture path in `artifacts.captures.screenshots`.

Planner compatibility also validates the adapter metadata that built-in runners require. Android adb `tap` steps need either `adapterOptions.androidAdb.x/y` or a portable selector; Android adb `scroll` steps need either `startX/startY/endX/endY` or a portable selector; iOS simctl command metadata needs non-empty command strings and positive integer waits/repeat counts. Argent `tap` steps need `adapterOptions.argent.x/y`, Argent `scroll` steps need `adapterOptions.argent.startX/startY/endX/endY`, and Argent `assertVisible` steps need a portable selector. These failures become `invalid_adapter_options` health checks before runtime execution starts.

Adapter-target fixtures such as `agent-device-android`, `agent-device-ios`, `argent-ios`, `argent-android`, `argent-react-profiler-provider`, and `axe-accessibility-provider` describe where external tools can plug into the same contract. They are schema-checked and planner-tested capability manifests. The bundled `agent-device` capture runner implements the portable interaction subset for iOS and Android; broader agent-device surfaces such as React DevTools, traces, network, and performance still need explicit adapters or provider attachments before they become part of the stable artifact contract. The bundled Argent runner implements launch, coordinate-backed gestures, screenshot requests, and description-backed visibility proof for portable selector match modes while keeping React profiler output in a separate Android evidence-provider lane. Argent command-surface checks prove the configured tools exist; runtime health still owns whether the selected device backend produced screenshot evidence. Required screenshot failures fail health, and optional screenshot failures are preserved as warnings. Active evidence providers can satisfy required evidence artifacts and provider-owned driver actions such as `collectPerfSignals`; providers outside the selected platform do not contribute to the match. When those tools write files independently, profile CLIs can attach the files with `--signal <js|memory|network>:<path>` or `--capture <screenshot|video|uiTree>:<path>` so provider evidence lands in the stable manifest and artifact layout. The `script-accessibility-provider`, `script-profiler-provider`, `script-memory-provider`, and `script-network-provider` examples show provider-command wrappers for project-local tools without making those tools package dependencies.

## Public artifact layout

Every run should produce a stable artifact folder.

Core artifacts:

- `health.json`: whether the scenario execution was valid enough to interpret
- `verdict.json`: budget outcome for product behavior, or `not_evaluated` before evidence is collected
- `comparison.json`: optional before/after result against a trusted baseline
- `live-proof.json`: aggregate proof summary for a multi-scenario live run
- `live-proof-set.json`: aggregate platform-set proof summary across Android and iOS live-proof artifacts
- `agent-summary.md`: agent-readable health gate and next-action summary
- `planner-compatibility.json`: optional preflight detail from runner/provider matching
- `project-validation.json`: project-level validation result for initialized app scaffolds, including helper readiness, config readiness, scenario candidate directories, discovered scenario paths, declared `drivers.supported` readiness, package-supported driver classification, external target driver classification, custom driver declarations, package-script snippet readiness, app `package.json` script merge and direct-bin drift readiness, non-failing setup warnings, and structured next actions

Profile runner artifacts:

- `manifest.json`
- `metrics.json`
- `budget-verdict.json`
- `causal-run.json`
- `summary.md`

`manifest.json`, `metrics.json`, `budget-verdict.json`, and `causal-run.json` are schema-checked before the runner writes them. This keeps profile artifacts stable across fixture logs, adb-captured logs, and future runner adapters.

`manifest.attempt` records the run attempt identity and terminal semantics independently of prose summaries. It includes an `attemptId`, terminal state, failure classification, cleanup outcome, and whether preserved partial artifacts are valid for diagnosis. A failed attempt can therefore keep usable raw evidence without implying that product verdict, timing, or comparison claims are trustworthy.

`manifest.attempt.terminalState` uses a terminal vocabulary of `passed`, `failed`, `timeout`, `cancelled`, `aborted`, `inconclusive`, `unsupported`, `skipped`, and `unhealthy`. `manifest.environment` records product-neutral lifecycle and environment preconditions and postconditions. Each field is an assertion object with a `value` and `evidence` state. Generated profile artifacts default to `value: "unknown"` and `evidence: "not-asserted"` unless the runner can prove more. The dedicated `lifecyclePhase` assertion supports `cold-launch`, `warm-launch`, `hot-launch`, `foreground`, `background`, `force-stop`, `process-death`, `scene-recreation`, `activity-recreation`, `os-reclaim`, `reboot`, and `relaunch`. This preserves what the runner did not prove instead of letting agents infer installed state, app data state, auth state, route, foreground state, permissions, locale, timezone, theme, font scale, orientation, network, animations, cleanup, data, or artifact completeness from surrounding logs.

Aggregate live proof commands write `live-proof.json` and `agent-summary.md` under `_live-proof/<run-id>`. The live-proof artifact points to preflight evidence, every scenario run, optional interaction proofs from tools such as agent-device or Argent, optional skipped interaction proof declarations, and optional latest-trusted comparison outputs, giving agents one stable entrypoint after a proof run. Preflight, profile, and interaction pointers include health and verdict status from the linked run artifacts, so agents can see what passed before opening deeper evidence. Interaction proof pointers also include sidecar screenshot capture inventory when the sidecar produced screenshots, plus `warnings` when optional sidecar checks failed without invalidating the required proof. If profile health or verdict fails, requested sidecars are not executed; they are recorded in `skippedInteractionProofs` with a reason and next action so agent feedback stays explicit without mixing runner evidence into an untrusted timing run. The aggregate artifact records `status`, `comparisonStatus`, `comparisonCounts`, optional per-comparison `metricSummary` counts/highlights, and a `nextAction` hint so agents can distinguish failed proof gates, regressions, mixed metric movement, missing baselines, inconclusive comparisons, partial sidecar evidence, and clean summaries without scraping prose.

Platform-set proof commands write `live-proof-set.json` and `agent-summary.md` under the caller-provided proof-set output directory. The proof-set artifact records required platforms, present platforms, missing platforms, each linked `live-proof.json`, failed proof reasons, regression-gate reasons, and a next action. This gives agents one stable Android-plus-iOS gate after the per-platform live proofs have written their own aggregate evidence.

Provider or custom-script evidence attached with `--signal` or `--capture` is copied into stable run folders and inventoried in `manifest.artifacts.evidenceAttachments`. Each inventory entry records the evidence channel, kind, run-relative path, source filename, byte size, and sha256 hash; it does not preserve local absolute source paths.

Evidence folders:

- `raw/`
- `captures/`
- optional `signals/js`
- optional `signals/memory`
- optional `signals/network`

The artifact contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, `comparison.json` records before/after baseline comparison, and `agent-summary.md` gives agents the health gate before they touch code.

Failed or warning health checks may include scalar `metadata.nextActionCode` and `metadata.nextAction` fields. These are stable, agent-readable recovery hints for runner setup failures such as missing adb, an unbooted simulator, an uninstalled app package, or an unresolved selector. Host-bound availability checks may also include `metadata.failureClass` values such as `host_access`, `timeout`, `missing_binary`, or `command_surface` so agents can distinguish sandbox or daemon access from a broken runner command. The summary builder renders those hints in `agent-summary.md`, but they do not make timing evidence trustworthy unless scenario health passes.

The current profile runner writes health, verdict, agent summary, metrics, causal-run, and budget-verdict artifacts.

Budgets are supported but optional for adoption.

`buildRunIndex()` can scan an artifact root after runs complete. It indexes folders that contain both `health.json` and `verdict.json`, marks a run trusted only when health and verdict both passed, and lets agents find the latest trusted prior run for a scenario without relying on terminal history.

## Supported Runner Surface

The package currently supports:

- scenario/runner compatibility planning through `check-plan`
- fixture profile loops through committed profile-event logs
- Android adb readiness checks
- Android bounded logcat capture
- Android package launch plus bounded logcat capture
- Android adb driver adapter with scenario-routed `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, and `readLogs`
- Android adb screenrecord capture through scenario-routed `record` driver actions
- Android profile artifact generation from explicit event logs, prior adb artifacts, or an owned `--adb-capture` window
- iOS bounded simulator log capture and stored app truth-event collection through simctl
- iOS simulator app launch plus storage-backed profile-session and command seeding
- iOS profile artifact generation from explicit event logs, prior simctl artifacts, or an owned `--simctl-capture` window
- generic Android and iOS live proof runners for one portable scenario, including preflight, profile capture, optional agent-device and Argent sidecars, optional latest-trusted comparison, and aggregate `live-proof.json`
- agent-device and Argent capture runners that write ASL health, verdict, raw transcripts, and capture artifacts without making those tools package dependencies
- evidence-provider command execution through `--provider <manifest>`, with declared outputs inventoried as stable evidence attachments and nonzero exits written as failed health gates
- trusted baseline/current comparison after scenario health passes, with millisecond timing noise treated as unchanged inside a small mobile-safe tolerance and opposite metric directions surfaced as `mixed`
- latest trusted prior-run comparison from an artifact root

Not yet shipped as supported public features:

- generic consuming-app installation or build orchestration
- broad semantic UI workflow driving beyond the shipped portable driver-action subset
- memory, network, or accessibility evidence capture from built-in drivers
- Computer Use flows
- product-specific scenarios

## Preflight planning

Use `check-plan` to validate a scenario, runner manifest, and optional evidence-provider manifests before execution:

```bash
pnpm check-plan -- --scenario examples/scenarios/mobile/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

This validates the input manifests, writes schema-checked `health.json` and `verdict.json`, writes `agent-summary.md`, and includes the raw planner match in `planner-compatibility.json`.

## Android adb readiness

Use `android:preflight` to verify adb and connected-device readiness before adding live Android scenario execution:

```bash
pnpm android:preflight -- --package com.example.app --out artifacts/android-adb-preflight
```

The command writes:

- `health.json`
- `verdict.json`
- `agent-summary.md`
- `raw/adb-version.txt`
- `raw/adb-devices.txt`
- `raw/android-metadata.json`

If adb, a connected online device, or an optional package check fails, health fails and the verdict remains `inconclusive`.

Add `--capture-logcat --logcat-lines <count>` to write `raw/adb-logcat.txt` in the same artifact folder. Add `--react-native-debug-host <host:port>` with `--package <name>` for React Native development builds that need adb reverse plus the app `debug_http_host` preference before launch; the runner writes `raw/adb-react-native-reverse.txt` and `raw/adb-react-native-debug-host.txt`. Add `--clear-logcat --launch --wait-ms <ms>` with `--package <name>` to clear logs, launch the package, wait for a bounded capture window, and then collect logcat evidence. If requested capture-window setup or logcat capture fails, scenario health fails because timing and event evidence would be incomplete.

Use that captured logcat evidence directly with Android profiling:

```bash
pnpm profile:android -- --config core/config-template.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-artifacts artifacts/android-adb-preflight --run-id android-run-1
```

Or let Android profiling own the adb capture window before it writes profile artifacts:

```bash
pnpm profile:android -- --config core/config-template.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-capture --react-native-debug-host localhost:8097 --clear-logcat --launch --run-id android-run-1
```

## iOS simulator capture

Use `profile:ios --simctl-capture` when the example app or a consuming app is already installed on a booted simulator:

```bash
pnpm profile:ios -- --config core/config-template.json --scenario examples/mobile-app/scenarios/ios/app-startup.json --simctl-capture --profile-session --profile-session-storage --launch --run-id ios-run-1
```

The command writes a separate simctl capture folder under the selected output root, seeds the app-owned profile session into native AsyncStorage before launch, then collects stored app profile events after the capture window. Command scenarios seed the scenario command queue through the same storage contract before launch. When `raw/ios-profile-events.log` exists, the iOS profile runner ingests that stored truth-event log; otherwise it falls back to `raw/ios-simctl-log.txt`.

For profile-session capture on Android or iOS, omitting `--wait-ms` lets ASL derive the final evidence window from scenario execution waits and cycle count. Explicit `--wait-ms` remains authoritative when a consuming app has a known startup or logging delay that the scenario cannot express.

Scenario command targets live in `adapterOptions.iosSimctl.commands`, while the app handles them through `registerProfileCommandTargetHandler`. The iOS proof does not depend on unified logs carrying JavaScript console output; it depends on app-owned stored profile events.

## Historical comparison

Use `compare` to build `comparison.json` from two completed run folders:

```bash
pnpm compare -- --baseline artifacts/runs/app-startup/baseline --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current --fail-on-regression
```

The comparison gate is intentionally strict. If either run failed scenario health, or if the scenario ids do not match, the comparison is `inconclusive`. Numeric budget checks are compared only after that health gate passes. `comparison.json` includes `comparisonBasis` with the baseline/current run ids and run directories, giving agents artifact-local provenance instead of forcing them to infer it from folder names.

Use `compare:latest` when an artifact root contains run history and the agent should compare the current run against the newest trusted prior run for the same scenario:

```bash
pnpm compare:latest -- --root artifacts/runs --scenario app-startup --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current --fail-on-regression
```

The latest-trusted command excludes the exact current run directory from baseline selection. Baseline trust requires passed health and passed verdict. Current runs must pass scenario health before the command will compare timing or budget evidence. If the current manifest declares `comparisonLane`, baseline selection is scoped to trusted prior runs with the same lane; if the current manifest has no lane, selection stays within unlabeled trusted prior runs. Profile manifests also include `scenarioHash`, a stable fingerprint of the normalized scenario contract. When the current run has that hash, latest-trusted selection only compares against trusted prior runs with the same hash; legacy runs without the hash remain comparable only to legacy current runs. This keeps proof modes such as plain live proof and live proof plus agent-device sidecar from comparing against each other, and it keeps migrated scenario definitions from poisoning before/after verdicts. Latest-trusted artifacts set `comparisonBasis.strategy` to `latest_trusted_prior` and record selection counts for inspected, trusted, trusted-prior, lane-comparable, and scenario-contract-comparable candidates.

## Fixture loop

Use `demo:loop` to run the current contract without a simulator:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The fixture loop writes:

- `preflight/app-startup/health.json`
- `preflight/app-startup/verdict.json`
- `preflight/app-startup/agent-summary.md`
- `profile-runs/app-startup/demo-baseline/*`
- `profile-runs/app-startup/demo-current/*`
- `profile-runs/app-startup/demo-current/comparison.json`

This is not a replacement for live device proof. It is a stable contract check that keeps the evidence loop reproducible through trusted prior-run selection while iOS or Android runtime setup is unavailable.

## Read next

- [README](../README.md) for the shortest path through the project
- [Concepts](concepts.md) for the broader product framing
- [Adapter Onboarding](adapters.md) for adding runners and evidence providers
- [Consumer App Rehearsal](consumer-rehearsal.md) for adopting the package in an existing app
- [Runner docs](../runner/README.md) for current runner behavior and limits
