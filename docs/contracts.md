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
- `cycles`: repeat count, warmup count, failure policy, and optional setup/body step ids for repeated journeys
- `budgets`: product thresholds evaluated only after scenario health passes
- `steps`: runner-facing launch, command, wait, gesture, and capture actions
- `selector`: optional app target on a step, such as a test id, accessibility id, label, text, resource id, or xpath
- `uiContext`: optional UI ownership requirement on a step; UI driver actions default to `app`
- `artifacts`: required and optional evidence outputs, including provider-backed diagnostics such as accessibility, memory, network, profiler, and native performance evidence

The scenario contract is intentionally runner-neutral. Runners can map steps to adb, XcodeBuildMCP, agent-device, accessibility tools, profilers, or custom scripts while preserving the same journey, milestones, budgets, and expected events.

For repeated mobile command scenarios, `cycles.setupStepIds` names leading setup commands that run once before measured cycle work, while `cycles.bodyStepIds` names the first repeated body commands when inference would be ambiguous. Built-in profile-session runners also infer a setup prefix conservatively: leading readiness commands or leading commands before the first measured milestone command run once, and the remaining command body repeats for `cycles.iterations`. Wait gates remain strict; ASL does not synthesize missing app-owned truth events.

Runner capabilities describe ownership, such as launch, session control, command execution, log capture, artifact writing, or profiler support. Driver actions describe the concrete operations an adapter can perform inside a run. UI contexts describe which surface the runner or provider can own: `app`, `systemDialog`, `notificationShade`, `externalBrowser`, `webView`, `shareSheet`, `picker`, or `otherApp`. UI and capture driver actions default to `app` when a step omits `uiContext`; a scenario must opt into system or external contexts explicitly. A runner may be able to own a scenario lifecycle without supporting every driver action or UI context; the planner fails when a required step declares a `driverAction` or `uiContext` that the selected runner or an active provider does not declare.

Planner compatibility artifacts and planner-derived `health.json` include a `downgradePolicy` block with `mode: "no-silent-downgrade"`. Required capability, driver-action, UI-context, or artifact gaps are recorded as `unsupported`; optional gaps are recorded as warnings. `allowedSubstitutions` and `substitutions` are explicit arrays, so future semantic downgrades must be visible in artifacts instead of being inferred from a passed plan.

`buildScenarioExecutionPlan()` turns the same scenario steps into a deterministic adapter-facing work list. Each normalized step records the scenario step id, original kind, required flag, optional driver action, and the runner port method that owns it: `launch`, `executeStep`, `waitForTruthEvent`, or `captureEvidence`.

Android adb capture routes normalized steps with `driverAction: "tap"`, `"scroll"`, `"assertVisible"`, `"inspectTree"`, `"screenshot"`, or `"readLogs"` through the adb driver adapter. `adapterOptions.androidAdb` carries action-specific metadata: coordinate fields for tap and scroll, `durationMs` for scroll, `logcatLines` for bounded logs, `waitMs` for capture timing, and `rawFileName` for evidence filename overrides. `assertVisible` requires a portable selector and verifies it against a UIAutomator tree dump, preserving that XML as raw evidence. Log capture keeps `raw/adb-logcat.txt` as the default profile input.

When Android adb `tap` or `scroll` steps provide a portable selector instead of coordinates, the runner captures `uiautomator dump` output, resolves supported selector kinds against node bounds, and derives adb input coordinates before executing the action. Built-in Android selector resolution supports `testId`, `resourceId`, `accessibilityId`, `accessibilityLabel`, and `text`; `xpath` stays available for external runners with native selector engines.

I/O from iOS simctl capture routes through the simctl driver adapter. `readLogs` preserves bounded simulator logs under `raw/ios-simctl-log.txt`. A scenario step with `driverAction: "screenshot"` or `artifact: "screenshot"` requests a screenshot capture, defaulting to `captures/ios-screenshot.png`. The profile manifest records the resulting capture path in `artifacts.captures.screenshots`, and capture metadata records any supported simulator screenshot options the runner used.

Manifest artifact paths are evidence claims. Optional diagnostics such as `captures.video`, `captures.uiTree`, `raw.deviceLog`, JS/memory/network signals, accessibility exports, and profiler files appear as paths only when the file was produced or intentionally referenced as a sidecar dependency. Every profile manifest also includes `artifacts.diagnostics`, an inventory of common diagnostic surfaces with `kind`, `status`, `required`, optional `path`, and a `reason`/`nextAction` when evidence was unavailable or not requested.

Planner compatibility also validates the adapter metadata that built-in runners require. Android adb `tap` steps need either `adapterOptions.androidAdb.x/y` or a portable selector; Android adb `scroll` steps need either `startX/startY/endX/endY` or a portable selector; iOS simctl command metadata needs non-empty command strings and positive integer waits/repeat counts. Argent `tap` steps need `adapterOptions.argent.x/y`, Argent `scroll` steps need `adapterOptions.argent.startX/startY/endX/endY`, and Argent `assertVisible` steps need a portable selector. These failures become `invalid_adapter_options` health checks before runtime execution starts.

Adapter-target fixtures such as `agent-device-android`, `agent-device-ios`, `argent-ios`, `argent-android`, `argent-react-profiler-provider`, and `axe-accessibility-provider` describe where external tools can plug into the same contract. They are schema-checked and planner-tested capability manifests. The bundled `agent-device` capture runner implements the portable interaction subset for iOS and Android; broader agent-device surfaces such as React DevTools, traces, network, and performance still need explicit adapters or provider attachments before they become part of the stable artifact contract. The bundled Argent runner implements launch, coordinate-backed gestures, screenshot requests, and description-backed visibility proof for portable selector match modes while keeping React profiler output in a separate Android evidence-provider lane. Argent command-surface checks prove the configured tools exist; runtime health still owns whether the selected device backend produced screenshot evidence. Required screenshot failures fail health, and optional screenshot failures are preserved as warnings. Active evidence providers can satisfy required evidence artifacts and provider-owned driver actions such as `collectPerfSignals`; providers outside the selected platform do not contribute to the match. When those tools write files independently, attached provider evidence lands in the stable manifest and artifact layout. The `script-accessibility-provider`, `script-profiler-provider`, `script-memory-provider`, `script-native-performance-provider`, and `script-network-provider` examples show provider-command wrappers for project-local tools without making those tools package dependencies.

Profiler evidence is a first-class artifact kind, but ASL does not pretend every profiler tool has the same native format. JSON profiler outputs should satisfy [schemas/profiler.schema.json](../schemas/profiler.schema.json), including provider, platform, run, scenario, tool/completeness metadata, and at least one useful content surface such as samples, metrics, events, traces, a profile object, summary, or referenced attachments. Lifecycle-backed profilers should also declare whether evidence came from passive report ingestion, an explicit session, inline capture, `afterCapture`, `postRun`, or rehydration; whether the target device/app binding was verified; whether capture perturbed timing; and whether the output is comparable or diagnostic-only. Native traces, CPU profiles, flamegraphs, React DevTools exports, and recordings can still be attached as profiler evidence through provider outputs, but agents should treat them as preserved evidence until a provider also emits structured metrics that ASL can compare or summarize.

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

`causal-run.json` preserves app-emitted timeline events through the public causal phase/status vocabulary. If an app emits richer phase or status values, ASL writes schema-valid top-level values and preserves the originals as timeline metadata. Timeline metadata also preserves scalar correlation fields such as `iteration`, `sequence`, `queueId`, `commandId`, `operationId`, `attemptId`, and `clockDomain` when the app emits them. Profile-session command acknowledgements are included as ASL-owned timeline entries with command status, result, source, sequence, queue, wait, and command ID metadata, so agents can inspect runtime ordering without treating command transport as product truth. Repeated runs include `iterationSummary` so agents can distinguish complete, partial, failed, and timeout iteration evidence without scraping raw logs. Scenarios without budget thresholds still produce schema-valid causal artifacts with an empty `budgets` object.

`manifest.attempt` records the run attempt identity and terminal semantics independently of prose summaries. It includes an `attemptId`, `attemptNumber`, `maxAttempts`, optional retry lineage, terminal state, failure classification, cleanup outcome, and whether preserved partial artifacts are valid for diagnosis. Retry attempts must identify the prior attempt and retry reason. A failed attempt can therefore keep usable raw evidence without implying that product verdict, timing, or comparison claims are trustworthy.

`manifest.provenance.cohort` records product-neutral compatibility inputs for comparing runs. Profile runners populate known fields such as `appId`, `platform`, `runnerName`, `runnerVersion`, `commandTransport`, and active provider IDs; richer callers can add app/build version, build mode, OS version, device class, feature flags, and seed identity. ASL derives `manifest.provenance.cohortHash` from the normalized cohort. Latest-trusted comparison requires the same cohort hash when the current run records one, so old artifacts remain comparable only when the current artifact has not opted into cohort-aware selection.

`manifest.attempt.terminalState` uses a terminal vocabulary of `passed`, `failed`, `timeout`, `cancelled`, `aborted`, `inconclusive`, `unsupported`, `skipped`, and `unhealthy`. Attempt construction rejects misleading terminal combinations: passed attempts must end as `passed`, failed attempts must use a failure terminal state, timeout/cancelled/aborted attempts must preserve valid partial artifact paths, and cleanup statuses such as `passed`, `failed`, or `partial` must include a cleanup message. `manifest.environment` records product-neutral lifecycle and environment preconditions and postconditions. Each field is an assertion object with a `value` and `evidence` state. Generated profile artifacts default to `value: "unknown"` and `evidence: "not-asserted"` unless the runner can prove more. The dedicated `lifecyclePhase` assertion supports `cold-launch`, `warm-launch`, `hot-launch`, `resume`, `foreground`, `background`, `force-stop`, `process-death`, `scene-recreation`, `activity-recreation`, `os-reclaim`, `reboot`, and `relaunch`. This preserves what the runner did not prove instead of letting agents infer installed state, app data state, auth state, route, foreground state, permissions, locale, timezone, theme, font scale, orientation, network, animations, cleanup, data, or artifact completeness from surrounding logs.

Profile `agent-summary.md` files include an `attempt` section when the run has a manifest attempt block, including terminal state, cleanup state, partial-artifact validity, and retry lineage. Latest-trusted baseline selection treats attempt-aware runs as baseline-trusted only when health and verdict passed, the attempt is a clean first attempt, cleanup did not fail or remain partial, and partial artifacts are not marked valid diagnostic fragments. Older artifacts without `manifest.attempt` remain legacy-trusted when health and verdict passed, but new attempt-aware runs cannot hide retry laundering behind a green final verdict.

Profile runners assert only environment facts they own. Every completed profile manifest records ASL-controlled artifact completeness and cleanup postconditions. Live adb/simctl capture paths also assert runner-controlled foreground state, explicit lifecycle preconditions, and foreground postconditions. Use `--lifecycle-phase <phase>` when a runner can prove a non-cold precondition such as `warm-launch` or `resume`; log-ingest and preexisting artifact ingestion keep those fields `unknown/not-asserted`. Lifecycle assertions are not product milestones: a runner proving `lifecyclePhase: "resume"` does not synthesize `app_resumed` or any other app truth event. Resume readiness must still be emitted by the consuming app when a scenario waits for it.

Aggregate live proof commands write `live-proof.json` and `agent-summary.md` under `_live-proof/<run-id>`. The live-proof artifact points to preflight evidence, every scenario run, optional interaction proofs from tools such as agent-device or Argent, optional skipped interaction proof declarations, and optional latest-trusted comparison outputs, giving agents one stable entrypoint after a proof run. Preflight, profile, and interaction pointers include health and verdict status from the linked run artifacts, so agents can see what passed before opening deeper evidence. Interaction proof pointers also include sidecar screenshot capture inventory when the sidecar produced screenshots, plus `warnings` when optional sidecar checks failed without invalidating the required proof. If profile health or verdict fails, requested sidecars are not executed; they are recorded in `skippedInteractionProofs` with a reason and next action so agent feedback stays explicit without mixing runner evidence into an untrusted timing run. The aggregate artifact records `status`, `comparisonStatus`, `comparisonCounts`, optional per-comparison `metricSummary` counts/highlights, and a `nextAction` hint so agents can distinguish failed proof gates, regressions, mixed metric movement, missing baselines, inconclusive comparisons, partial sidecar evidence, and clean summaries without scraping prose.

Platform-set proof commands write `live-proof-set.json` and `agent-summary.md` under the caller-provided proof-set output directory. The proof-set artifact records required platforms, present platforms, missing platforms, each linked `live-proof.json`, failed proof reasons, regression-gate reasons, and a next action. This gives agents one stable Android-plus-iOS gate after the per-platform live proofs have written their own aggregate evidence.

Provider or custom-script evidence attachments are copied into stable run folders and inventoried in `manifest.artifacts.evidenceAttachments`. Each inventory entry records the evidence channel, kind, run-relative path, source filename, byte size, sha256 hash, completeness status, corruption status, redaction status, and transformations; it does not preserve local absolute source paths.

Native performance evidence uses the `nativePerformance` kind. This is separate from `profiler`: use it for platform-native frame, render, memory, and trace summaries such as Android Perfetto, trace-processor output, `gfxinfo`/framestats, `meminfo`, logcat-derived render signals, iOS Instruments, MetricKit, or simulator-derived native summaries. A provider can mark `nativePerformance` output as required, and the profile manifest will preserve it as a required diagnostic when captured. JSON native-performance outputs are validated against ASL's native-performance evidence schema, so they must include provider, platform, run, scenario, and at least one content surface such as summary, metrics, frames, memory, events, traces, or attachments. Raw traces should remain attached evidence while structured summaries carry the claim-ready facts, provenance, and comparability status.

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

Milestone budget interval semantics are explicit:

- `toMilestone` without `fromMilestone` measures elapsed time from the run or session clock origin to the matching milestone occurrence.
- `fromMilestone` plus `toMilestone` measures the interval between the two app-owned truth events for each iteration.
- repeated transition, gesture, open, close, scroll, or handoff budgets should use both milestones when the intended number is transition duration rather than cumulative elapsed time.

This distinction is visible in `metrics.json`: elapsed milestone-only runs populate `durationsMs` with milestone timestamps, while interval runs populate `durationsMs` with `to - from` values. Timing still remains untrusted unless `health.json` passes.

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
- provider-backed native performance evidence inventory through declared `nativePerformance` outputs
- trusted baseline/current comparison after scenario health passes, with millisecond timing noise treated as unchanged inside a small mobile-safe tolerance and opposite metric directions surfaced as `mixed`
- latest trusted prior-run comparison from an artifact root

Not yet shipped as supported public features:

- generic consuming-app installation or build orchestration
- broad semantic UI workflow driving beyond the shipped portable driver-action subset
- memory, network, or accessibility evidence capture from built-in drivers
- built-in Perfetto, gfxinfo, meminfo, Instruments, MetricKit, or trace-processor capture
- Computer Use flows
- product-specific scenarios

## Command guidance

Contracts defines the schemas, artifact fields, runner surfaces, and trust policy. Runnable walkthroughs live in [Live Proofs](live-proofs.md):

- [plan checks](live-proofs.md#plan-check)
- [Android adb preflight and profile capture](live-proofs.md#platform-preflight-and-profile-capture)
- [iOS simctl profile capture](live-proofs.md#platform-preflight-and-profile-capture)
- [fixture loop](live-proofs.md#fixture-loop)
- [explicit and latest-trusted comparison](live-proofs.md#comparison)
- [generic Android and iOS live proof](live-proofs.md#generic-mobile-proof)

## Read next

- [Scenario Authoring](authoring.md) for writing portable scenarios against these contracts
