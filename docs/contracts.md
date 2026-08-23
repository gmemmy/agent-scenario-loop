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
- [core/quick-proof.ts](../core/quick-proof.ts): bounded setup coordinator for
  operation-specific capability discovery, scoped authorization and lease
  propagation, one retry per adapter path, deterministic fallback before
  product work, and setup-only friction evidence
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
- [runner/ios-simctl-driver.ts](../runner/ios-simctl-driver.ts): simctl-backed iOS driver adapter for screenshot, bounded video recording with MP4/QuickTime `ftyp` validation, and log capture plus explicit iOS lifecycle helpers
- [runner/live-android.ts](../runner/live-android.ts): generic Android live proof for one portable scenario with adb preflight, profile-session capture, optional agent-device and Argent sidecars, optional comparison, and aggregate proof writing
- [runner/live-ios.ts](../runner/live-ios.ts): generic iOS live proof for one portable scenario with simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, optional comparison, and aggregate proof writing
- [runner/example-android-live.ts](../runner/example-android-live.ts): packaged Android example live proof for adb preflight plus canonical startup, open-close, and scroll-settle scenarios
- [runner/example-ios-live.ts](../runner/example-ios-live.ts): packaged iOS example live proof for simctl preflight plus canonical startup, open-close, and scroll-settle scenarios
- [runner/host-doctor.ts](../runner/host-doctor.ts): aggregate host/device preflight for adb, simctl, agent-device, and Argent command availability before live proof starts
- [runner/live-proof.ts](../runner/live-proof.ts): live-proof artifact reader for validation, status formatting, and optional regression gating
- [runner/resource-lease.ts](../runner/resource-lease.ts): deterministic inspect/acquire/heartbeat/release lease helpers for bounded same-host resource arbitration
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
- `metadata`: optional product-owned coverage context; `metadata.coverage`
  records behavior-contract taxonomy without changing runner behavior
- `platforms`: supported runtime targets
- `requiredCapabilities` and `optionalCapabilities`: runner capability requirements
- `steps[].driverAction`: optional concrete driver operation required by a step, such as `tap`, `longPress`, `scroll`, `swipe`, `drag`, `pinch`, `rotate`, `typeText`, `fill`, `focus`, `pressKey`, `pressButton`, `assertVisible`, `inspectTree`, `screenshot`, `record`, `readLogs`, `collectPerfSignals`, `customGesture`, or `runSequence`
- `comparisonLane`: optional default baseline lane for latest-trusted comparisons
- `acceptedBaselineScenarioHashes`: optional directional allowlist of prior
  scenario contract hashes that remain valid baselines for the same scenario id
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

Scenario metadata is descriptive scenario context, not execution policy. ASL
validates `metadata.coverage` as the sanctioned behavior coverage namespace,
projects its standardized fields into `project-validation.json` plan entries as
`scenarioCoverage`, writes a `coverageInventory` summary grouped by coverage
field and platform, and preserves the full metadata object in profile
`run-plan.json` as `scenarioMetadata`. Missing or partial coverage metadata is
reported as warning-grade inventory gaps; it does not fail project validation
unless the scenario itself is schema-invalid. Coverage metadata participates in
the profile `scenarioHash` because it is part of the declared scenario contract.
Health, verdict, budget, command delivery, and comparison logic do not interpret
coverage fields.

For repeated mobile command scenarios, `cycles.setupStepIds` names leading setup commands that run once before measured cycle work, while `cycles.bodyStepIds` names the first repeated body commands when inference would be ambiguous. Built-in profile-session runners also infer a setup prefix conservatively: leading readiness commands or leading commands before the first measured milestone command run once, and the remaining command body repeats for `cycles.iterations`. Wait gates remain strict; ASL does not synthesize missing app-owned truth events. When app truth events include command correlation such as `queueId` and `sequence`, the profile-session helper uses that correlation before releasing a waiting command gate. A wait milestone declared by an explicit `cycles.setupStepIds` wait step is carried in the command envelope as `unscopedMilestones`; it may release from a queue-less truth event only when `scenario` and `runId` still match. A truth event with a different queue or sequence never releases that setup gate, and command-result milestones still require their command correlation.
`cycles.stopOnFailure` is fail-fast by default: when a milestone wait times out,
the timed-out command is skipped and remaining queued commands are skipped with
reason `prior-command-failure` within that command's exact scenario, run, and
queue. Independent queues remain runnable. Set `cycles.stopOnFailure: false`
to continue.
The same `waitTimeoutMs` also bounds a sequenced command waiting for its
`dependsOnMilestones` prerequisites; absent or invalid values use the existing
30-second milestone-gate default. An unmet dependency records
`dependency-milestone-timeout` with `dependency-timeout-stop` or
`dependency-timeout-continue` and the missing dependency names. Fail-fast mode
then records later commands in the same `scenario` + `runId` + `queueId` as
`prior-command-failure`; commands owned by another logical queue remain runnable.
Queue ownership is symmetric: a command without `queueId` is owned only by the
queue-less event/command stream and does not match an explicitly named queue.
Later-command classification uses sequence, timestamp, then stable command id
rather than storage seed position.
Continue mode skips only the blocked command. Replacing the active session clears
the prior in-memory queue. A bootstrap unmount suspends a storage-backed dependency
gate and a remount resumes its original wall-clock deadline from the unchanged
stored command; deep-link-only work is not retained across unmount. In-flight
storage reads are generation-guarded, so unmount or a newer session replacement
cannot enqueue commands from an older stored snapshot after an asynchronous read.
Storage-backed helper authority is session-scoped and recoverable across a full
JavaScript module reload. Bounded in-memory event history is diagnostic only;
dependency facts derived from committed truth events, committed lifecycle
entries, and committed terminal command identities remain complete for the
active logical session. The iOS storage runner reads those authoritative chunks
when collecting or finalizing evidence, including no-command and interrupted
runs, and fails closed on corrupt or foreign-session authority instead of using
a stale compatibility array. Legacy active-session storage without `startedAt` is
normalized once with the bootstrap time and persists that identity before
authority recovery, so later reloads use the same session boundary. A durably
delivered but nonterminal command resumes only its pending readiness or settle
phase after reload and is not dispatched again. A received-only command remains
replayable: the unavoidable at-least-once boundary is a process failure after an
app handler is invoked and returns but before the helper durably records the
delivered lifecycle row. ASL does not infer completion of asynchronous app-side
effects from that synchronous return. Storage corruption, missing authority chunks, quota
failure, or write failure stops command processing and makes the run untrusted;
the helper best-effort records an internal failed-authority tombstone and removes the stored session
and command queue so stale work cannot normally revive after reload. If the
storage engine rejects both that tombstone and the removals, durable recovery is
not possible and the consumer must clear or repair app storage before rerunning.
For storage-backed iOS captures with queued commands, the simctl sidecar observes
same-scenario, same-run session entries during the bounded capture window. It may
close the window early only after every expected sequence has an explicit
terminal status. A successful queue requires terminal completion for every
sequence; a fail-fast queue additionally requires a canonical milestone-timeout
or dependency-timeout stop entry and matching `prior-command-failure` skips for
the remaining commands in that logical queue. Completion records must match the
exact seeded command identities, including generated `id`, normalized `commandId`,
`queueId`, and `sequence` where present. Duplicate expected identities and mixed,
wrong-queue, wrong-run, wrong-scenario, malformed, or partial evidence never
shorten the window. Early fail-fast closeout finalizes
requested video, preserves the completion observation, and publishes failed
health with an inconclusive verdict through the normal artifact path.

Runner capabilities describe ownership, such as launch, session control, command execution, log capture, artifact writing, or profiler support. Driver actions describe the concrete operations an adapter can perform inside a run. UI contexts describe which surface the runner or provider can own: `app`, `systemDialog`, `notificationShade`, `externalBrowser`, `webView`, `shareSheet`, `picker`, or `otherApp`. UI and capture driver actions default to `app` when a step omits `uiContext`; a scenario must opt into system or external contexts explicitly. A runner may be able to own a scenario lifecycle without supporting every driver action or UI context; the planner fails when a required step declares a `driverAction` or `uiContext` that the selected runner or an active provider does not declare. `tap`, `longPress`, `drag`, `pressButton`, and `pressKey` are separate input contracts even when one adapter maps them to related low-level commands; scenario truth must still prove the intended result. `rotate` is a device-orientation input contract, not proof that the app relaid out, preserved state, or kept the expected surface usable.

Rich gesture actions are input contracts, not proof of the resulting surface. For example, `longPress` names a held press input. It can be used for app-owned menus, text selection, drag handles, reorder mode, context menus, or other platform-owned affordances. Trusted proof still needs app-owned truth events, UI context ownership, assertions, screenshots, or provider evidence that the expected surface appeared or that the action was unsupported.

The generic names are still bounded contracts. `customGesture` requires a runner-specific gesture name plus complete declared input under adapter metadata; artifacts must record the command transcript, target binding, timeout, and unsupported/failed reason. `runSequence` means an atomic, predetermined input sequence with no branching or mid-sequence observation. If later actions depend on UI discovered during the run, use separate scenario steps and observable gates instead.

Planner compatibility artifacts and planner-derived `health.json` include a `downgradePolicy` block with `mode: "no-silent-downgrade"`. Required capability, driver-action, UI-context, or artifact gaps are recorded as `unsupported`; optional gaps are recorded as warnings. `allowedSubstitutions` and `substitutions` are explicit arrays, so future semantic downgrades must be visible in artifacts instead of being inferred from a passed plan.

Planner-derived health also records `matched.manifestVersions` for the selected primary runner and active evidence-provider manifests. Each entry includes the runner or provider id, manifest kind, and schema version that participated in compatibility planning, so agents can see runner/provider manifest skew before treating runtime evidence as comparable.

`buildScenarioExecutionPlan()` turns the same scenario steps into a deterministic adapter-facing work list. Each normalized step records the scenario step id, original kind, required flag, optional driver action, and the runner port method that owns it: `launch`, `executeStep`, `waitForTruthEvent`, or `captureEvidence`. When a scenario declares `cadence`, normalized steps also preserve the resolved settle window and whether it came from the step override, scenario kind default, or scenario default. Cadence is pacing metadata for runner command release and capture-window budgeting; it is not product truth and does not replace app-owned milestones. Command `timeoutMs` remains a correctness deadline and is not converted into pacing waits. When an ordered command also waits for a milestone, its cadence is a minimum window from command release: continuation waits for both readiness and the minimum settle boundary, without adding the full cadence again after a slower milestone.

Normalized scenario step ids are unique before cycle expansion. A cycle may repeat one identified source step, but two source steps cannot share an id because platform policy alignment uses that identity rather than command text or adapter array position. Derived profile capture windows use the larger of minimum settle and bounded readiness for a gated command, matching the overlapping runtime state machine instead of summing both waits.

Profile-command readiness waits are always bounded. A missing or non-positive
milestone timeout resolves to 30,000 ms in profile runners and the app helper. Platform
command lists align to the portable command plan only by stable command id.
Every adapter command must declare `id` or `commandId`; labels and command text
are never identity fallbacks. Extra, omitted, or mismatched platform commands
fail planning instead of inheriting another command's policy by array position.

Command-scoped readiness events must match the command's declared run,
scenario, queue, and sequence. The app helper passes the full command envelope
to registered target handlers so consuming apps can emit correlated app-owned
milestones; an event that omits required correlation cannot release the gate.

Android adb capture routes normalized steps with `driverAction: "tap"`, `"longPress"`, `"pressKey"`, `"scroll"`, `"swipe"`, `"assertVisible"`, `"inspectTree"`, `"screenshot"`, or `"readLogs"` through the adb driver adapter. `adapterOptions.androidAdb` carries action-specific metadata: coordinate fields or portable selectors for tap and long-press actions, `key` for portable key presses, coordinate fields for scroll and swipe, `durationMs` for long press, scroll, and swipe, `logcatLines` for bounded logs, `waitMs` for explicit pre-action delay or capture timing, and `rawFileName` for evidence filename overrides. `assertVisible` requires a portable selector and polls UIAutomator until the step `timeoutMs` expires, preserving the final XML as raw evidence plus poll metadata in health and raw Android metadata. Log capture keeps `raw/adb-logcat.txt` as the default profile input. Richer action names such as `pinch`, `rotate`, `typeText`, or `fill` are valid scenario vocabulary, but adb manifests must not declare them until the adapter maps those actions to bounded commands and evidence.

When Android adb seeds a storage-backed profile-session, the sidecar records whether the app emitted a same-run profile-session start before final log capture. No-command scenarios such as startup and resume use `android_profile_session_start_wait` with `android_profile_session_start_observed`, `android_profile_session_start_wait_exhausted`, or `android_profile_session_start_reconciled_from_final_log`, and `raw/android-metadata.json` records the wait details as `profileSessionStartWait`. Command-backed scenarios keep `android_profile_session_completion_wait` and `profileSessionCompletionWait` for terminal command evidence, using `android_profile_session_completion_reconciled_from_final_log` when the early wait exhausted but the final bounded logcat artifact contains same-run terminal command evidence. Reconciled sidecar observations preserve `initialObservation` plus `reconciledRawPath` so agents can see both the early sidecar state and the later evidence. Profile artifact health may also add `android_profile_session_sidecar_observation` with `android_profile_session_completion_reconciled_from_profile_evidence` when final same-run profile-session entries reached terminal status, or `android_profile_session_delivery_reconciled_from_profile_evidence` when final trusted profile evidence saw every expected command delivered even though the sidecar completion wait exhausted. These checks explain control/session readiness; profile health still owns whether app truth is complete enough for timing or product claims.

Android adb whole-capture watchdog failures use `android_adb_runner_liveness_timeout` and stop pending runner sleep/poll loops before publishing the failed sidecar. When a selected device is still known, the sidecar also attempts a bounded `raw/adb-runner-watchdog-logcat.txt` snapshot and records it under `raw/android-metadata.json.runnerFailure.watchdogLogcat`; this log is diagnostic context for startup/session delivery ownership, not trusted product evidence.

When Android adb `tap`, `longPress`, or `scroll` steps provide a portable selector instead of coordinates, the runner captures `uiautomator dump` output, resolves supported selector kinds against node bounds, and derives adb input coordinates before executing the action. Built-in Android selector resolution supports `testId`, `resourceId`, `accessibilityId`, `accessibilityLabel`, and `text`; `xpath` stays available for external runners with native selector engines.

I/O from iOS simctl capture routes through the simctl driver adapter. `readLogs` preserves bounded simulator logs under `raw/ios-simctl-log.txt`. A scenario step with `driverAction: "screenshot"` or `artifact: "screenshot"` requests a screenshot capture, defaulting to `captures/ios-screenshot.png`. The profile manifest records the resulting capture path in `artifacts.captures.screenshots`, and capture metadata records any supported simulator screenshot options the runner used. A scenario step with `driverAction: "record"` or `artifact: "video"` starts bounded `simctl io <udid> recordVideo` capture before scenario controls, preserves separate stdout/stderr plus exit signal metadata, and validates the finalized file using MP4/QuickTime `ftyp` brands before exposing `captures.video`.

iOS simctl capture writes `raw/ios-simctl-capture-started.json` before the first xcrun command and arms a whole-capture watchdog derived from declared waits and command overhead. If the capture body stops before normal finalization, ASL still writes sidecar `health.json`, `verdict.json`, `agent-summary.md`, `raw/ios-metadata.json`, and a runner failure raw artifact. Watchdog failures use health code `ios_simctl_runner_liveness_timeout` with next action `inspect_ios_simctl_runner_timeout`, so agents can distinguish runner publication/liveness from app-owned truth or product performance.

When iOS simctl seeds a storage-backed profile-session, the sidecar records a bounded `ios_profile_session_start_wait` before entering the longer capture window. `raw/ios-metadata.json` records the wait as `profileSessionStartWait`, and `raw/ios-profile-session-start-wait.json` stores the raw observation. If the wait exhausts with `ios_profile_session_start_wait_exhausted`, treat the run as a dev-client app-bundle or command-channel readiness failure: the target app may be installed or opened, but ASL did not observe same-run app truth from the loaded JavaScript surface. The failed health check includes scalar readiness metadata such as `failureClass`, `readinessDetail`, command count, dev-client deep-link status, foreground ownership, expected evidence, pending phase, storage keys, `readinessRawPath`, and a runtime-environment next-action hint; `raw/ios-profile-session-readiness.json` and `raw/ios-metadata.json.profileSessionReadiness` preserve the full context for agents diagnosing why the app bundle or command channel did not start. `readinessDetail` distinguishes a foreground-owned dev client with a missing command channel from a non-foreground, unknown-foreground, or non-dev-client missing-start path. When start evidence is missing, ASL also records `raw/ios-profile-session-start-app-info.txt` when foreground state can be inspected.

Manifest artifact paths are evidence claims. Optional diagnostics such as `captures.video`, `captures.uiTree`, `raw.deviceLog`, JS/memory/network signals, accessibility exports, and profiler files appear as paths only when the file was produced or intentionally referenced as a sidecar dependency. Every profile manifest also includes `artifacts.diagnostics`, an inventory of common diagnostic surfaces with `kind`, `status`, `required`, `requested`, optional `path`, and a `reason`/`nextAction` when evidence was unavailable or not requested. The `requested` flag is true when the scenario, provider, or runner asked for the surface; it remains false for merely optional unrequested surfaces, even when the inventory lists them for completeness. Generated diagnostic entries also include `availability` so agents can distinguish `captured`, `captured-diagnostic-only`, `required-missing`, `requested-missing`, `not-requested`, `unsupported`, `provider-blocked`, and `environment-blocked` surfaces without parsing prose. Newer entries add `sufficiency.status` with the closed vocabulary `satisfies-required-diagnostic`, `optional-preserved-evidence`, `diagnostic-only`, `provider-blocked`, `unsupported`, `required-missing`, `requested-missing`, `not-requested`, and `environment-blocked`, plus a short reason for that per-output interpretation. `captured-diagnostic-only` and `sufficiency.status: "diagnostic-only"` mean useful evidence was preserved for diagnosis but cannot satisfy a required diagnostic claim; examples include evidence from a provider whose command still failed or native-performance evidence whose envelope is not complete, comparable, comparison-sufficient, and target-verified. Older artifacts may omit `requested`, `availability`, or `sufficiency`; readers should then fall back to `status` and `required`.

Evidence interpretation keeps next-action metadata attached to failed health checks. When a health check includes `metadata.nextActionCode` or `metadata.nextAction`, agent recommendations should point at that structured follow-up before falling back to generic health-check repair. A recognized `metadata.nextActionOwner` is authoritative for that check; absent or unknown owner values fall back to product-neutral check classification. Failed health checks own next-action classification before warning-only checks, and mixed failed owners use the deterministic recovery rank `runtime_environment`, `asl_runner`, explicit `app_truth`, unresolved app-truth/scenario boundary, `scenario_contract`, `provider_tooling`, then `product_optimization`. When a failed ownerless `truth_events_incomplete` check cannot distinguish app truth emission from scenario contract milestone or iteration mapping, `agent-summary.md` reports owner `unresolved` and directs the consumer to inspect both boundaries instead of asserting a resolved owner. `unresolved` is a routing sentinel, not an additional resolved execution-owner vocabulary value. Concrete runtime, runner, or explicit app-truth failures outrank it; it outranks scenario-contract, provider, or optimization work because the unresolved failure may belong to the earlier app-truth boundary. Warnings remain visible but must not mask a concrete provider, runtime, app-truth, scenario-contract, or runner failure. Owner selection is a recommendation for the next bounded lane, not authority to execute it. This keeps blockers distinct without turning unhealthy artifacts into optimization claims or granting ASL control over downstream work.

Planner compatibility also validates the adapter metadata that built-in runners require. Android adb `tap` and `longPress` steps need either `adapterOptions.androidAdb.x/y` or a portable selector; Android adb `pressKey` steps need `adapterOptions.androidAdb.key` set to one of `back`, `systemBack`, `appBack`, `home`, `appSwitcher`, or `keyboardDismiss`; Android adb `scroll` steps need either `startX/startY/endX/endY` or a portable selector; Android adb `swipe` steps need explicit `startX/startY/endX/endY`; iOS simctl command metadata needs non-empty command strings and positive integer waits/repeat counts. Agent-device `tap`, `longPress`, `fill`, and `pressButton` steps need a selector, `adapterOptions.agentDevice.ref`, or `adapterOptions.agentDevice.x/y`; agent-device `focus` steps need numeric `adapterOptions.agentDevice.x/y`; agent-device `pressKey` steps need `adapterOptions.agentDevice.key` set to one of `back`, `systemBack`, `appBack`, `home`, `appSwitcher`, or `keyboardDismiss`; agent-device `typeText` and `fill` steps need non-empty `adapterOptions.agentDevice.text`; agent-device iOS `pinch` steps need numeric `adapterOptions.agentDevice.scale` and may include center `x/y`; agent-device `rotate` steps need `adapterOptions.agentDevice.orientation` set to `portrait`, `portrait-upside-down`, `landscape-left`, or `landscape-right`; and agent-device `swipe` steps need explicit `adapterOptions.agentDevice.startX/startY/endX/endY`. Argent `tap` and `longPress` steps need `adapterOptions.argent.x/y`; Argent `drag`, `scroll`, and `swipe` steps need `adapterOptions.argent.startX/startY/endX/endY`; Argent `pinch` steps need `adapterOptions.argent.centerX/centerY/startDistance/endDistance`; Argent `rotateGesture` steps need `adapterOptions.argent.centerX/centerY/radius/startAngle/endAngle`; and Argent `assertVisible` steps need a portable selector. These failures become `invalid_adapter_options` health checks before runtime execution starts. Argent may expose more tool commands than the built-in adapter declares; ASL should add them only after the adapter can preserve action transcripts, target binding, and unsupported states.

Adapter-target fixtures such as `agent-device-android`, `agent-device-ios`, `argent-ios`, `argent-android`, `argent-react-profiler-provider`, and `axe-accessibility-provider` describe where external tools can plug into the same contract. They are schema-checked and planner-tested capability manifests. The bundled `agent-device` capture runner implements the portable interaction subset for iOS and Android; broader agent-device surfaces such as React DevTools, traces, network, and performance still need explicit adapters or provider attachments before they become part of the stable artifact contract. The bundled Argent runner implements launch, coordinate-backed gestures, screenshot requests, and description-backed visibility proof for portable selector match modes while keeping React profiler output in a separate Android evidence-provider lane. Argent command-surface checks prove the configured tools exist; runtime health still owns whether the selected device backend produced screenshot evidence. Required screenshot failures fail health, and optional screenshot failures are preserved as warnings. Active evidence providers can satisfy required evidence artifacts and provider-owned driver actions such as `collectPerfSignals`; providers outside the selected platform do not contribute to the match. When those tools write files independently, attached provider evidence lands in the stable manifest and artifact layout. The `script-accessibility-provider`, `script-profiler-provider`, `script-memory-provider`, `script-native-performance-provider`, and `script-network-provider` examples show provider-command wrappers for project-local tools without making those tools package dependencies.

Profiler evidence is a first-class artifact kind, but ASL does not pretend every profiler tool has the same native format. JSON profiler outputs should satisfy [schemas/profiler.schema.json](../schemas/profiler.schema.json), including provider, platform, run, scenario, tool/completeness metadata, and at least one useful content surface such as samples, metrics, events, traces, a profile object, summary, or referenced attachments. Lifecycle-backed profilers should also declare whether evidence came from passive report ingestion, an explicit session, inline capture, `afterCapture`, `postRun`, or rehydration; whether the target device/app binding was verified; whether capture perturbed timing; and whether the output is comparable or diagnostic-only. Native traces, CPU profiles, flamegraphs, React DevTools exports, and recordings can still be attached as profiler evidence through provider outputs, but agents should treat them as preserved evidence until a provider also emits structured metrics that ASL can compare or summarize.

Native-performance evidence is separate from profiler evidence. It covers platform-native frame, render, memory, and trace summaries such as Perfetto, trace-processor output, `gfxinfo`/framestats, `meminfo`, Instruments, xctrace, MetricKit, and log-derived render signals. Diagnostic-only native-performance evidence can be partial or post-run. Comparable native-performance evidence is a stronger artifact claim: the structured JSON must identify the tool, use a known capture mode, mark completeness as complete, match the current platform/provider/run/scenario, remain durable inside the run, and preserve a durable captured source, finite performance samples, a consistent bounded window, comparable policy, sufficient claim, and durable observed target proof for the measured device and app. Providers can also emit `diagnosticSources` so captured, missing, unsupported, failed, or unverified native lanes are explicit. This keeps raw diagnostics useful while preventing an agent from treating an unbound or partial native trace as release-quality performance evidence.

Live `asl-profile-android --adb-capture` and `asl-profile-ios --simctl-capture` runs can now bracket provider-owned native trace sessions around the active scenario loop. `startWindow` runs before the runner-owned capture window starts, `stopWindow` runs immediately after that window closes, `afterCapture` runs only after raw run evidence is staged into the final profile folder, `postRun` remains post-profile enrichment, and `finalize` remains cleanup. The legacy `capture` phase is still accepted as an `afterCapture` alias. Fixture/event-log runs and rehydrated `--adb-artifacts` or `--simctl-artifacts` runs remain post-capture-only and fail closed for live-window phases instead of pretending they overlapped the measured interaction window. A provider command may declare optional `platforms: ["android"]`, `platforms: ["ios"]`, or both, but those values must be a subset of the provider manifest platforms; omitting the field inherits every platform supported by the provider manifest. Inapplicable commands are absent from run-plan demand, execution records, output inventory, and failures. In an aggregate multi-platform plan, a command output contributes compatibility only when the command applies to every effective platform; per-platform plans continue to use the commands applicable to that selected platform. Top-level `artifactOutputs` remain provider-wide compatibility declarations, while applicable command outputs add platform-specific demand. Live-window phases require exact target identity from the runner, may use `outputs: []` for control-only commands, and reject declared outputs unless the command creates the file or changes its content hash; touching unchanged bytes remains stale evidence. Evidence-provider manifests may also declare top-level `exclusiveResources` starting at schemaVersion `1.1.0`. This field is reserved for `kind: "evidenceProvider"` manifests, remains unavailable to `1.0.0` manifests, and describes provider-owned exclusivity claims rather than runner-owned mobile-target leases. V1 is intentionally narrow: claims may describe the provider identity itself (`kind: "provider"`, including `providerId: "self"`) or an explicit TCP port (`kind: "tcpPort"`), and `target: "selected-target"` may narrow provider claims only when the runner has already resolved the exact target identity. Redeclaring the runner-owned mobile target, inventing generic host namespaces, or depending on placeholder DSLs outside these closed shapes is invalid. The runner acquires provider-owned claims only after read-only preflight and after the runner-owned mobile-target lease is already trusted, then before the first mutable provider phase for that provider. Multiple entering claims acquire all-or-nothing in canonical resource-id order, roll back in reverse order on partial contention, and heartbeat while held; loss of ownership, untrusted acquisition, or untrusted release fails the run while preserving any valid partial diagnostics. The runner writes the path-scrubbed lease journal to `raw/provider-resource-leases.json`, blocks mutable provider work when acquisition is not trusted, and keeps host-doctor exclusive-process checks advisory rather than authoritative ownership proof. When a selected provider declares native-performance outputs, the live runner also stages `raw/native-performance-request.json` before `startWindow`; that request records the exact requested app/target identity plus the runner-owned `activeLoop` window policy pointing at `raw/runner-active-loop-window.json`, and its staged bytes are hash-bound through the immutable provider command records. Live adb/simctl runners also write the package-owned window record to `raw/runner-active-loop-window.json` before `afterCapture`, so trusted target binding can prove it is describing the same active scenario window the runner actually measured. The runner preserves immutable provider command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files, and exposes `{providerId}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}` placeholders so a provider can bind downstream truth to those records without guessing local filenames. Runner-owned command provenance is trusted only when the completed record is `completed`, has exit code zero, was not timed out or signalled, preserves exact executable and ordered argv identity from the started record, and still hashes the declared fresh output bytes. When a provider writes `raw/providers/<providerId>/target-binding.json` for trusted native comparison, `afterCapture` owns that durable attachment hash; `finalize` may add cleanup records under `raw/provider-commands/` but must not rewrite the target-binding file after the owning command hash has been recorded.
The staged request file stays runner-owned and minimal: app/target/run/scenario identity plus the `activeLoop` window pointer only. Provider-owned policy, tool/version, source selection, build mode, and environment cohort inputs belong on provider command args/env, not on `raw/native-performance-request.json`.

The root package exports `buildAndroidNativePerformanceEvidence()` for project-local Android providers that already captured `dumpsys gfxinfo`, `dumpsys gfxinfo framestats`, `dumpsys meminfo`, or structured trace-processor summary data. It turns those summaries into schema-valid `nativePerformance` evidence with parsed frame, jank, render, memory, CPU, scheduling, and trace-window fields, target-binding metadata when supplied, raw attachments when supplied, source inventory, and conservative `diagnostic-only` comparability. Providers may pass `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, and `completenessStatus` overrides to preserve source statuses and claim boundaries such as `timeout`, `failed`, `unsupported`, `not-requested`, `ambiguous`, `mismatch`, or `captured-not-comparable` without bypassing the helper. The helper is still normalization rather than tool orchestration. The generated provider's Android scaffold resets `gfxinfo` in `startWindow`, captures target serial/package/process plus `gfxinfo`, framestats, and `meminfo` as direct `stopWindow` outputs, and reads only those preserved files during `afterCapture`. It emits `captureArtifacts` only when the runner's started/completed stop records preserve exact ordered argv, completed zero-exit/no-timeout/no-signal state, fresh output status, and matching hashes; otherwise the raw evidence remains diagnostic-only.

The root package also exports `buildIosNativePerformanceEvidence()` for project-local iOS providers that already captured Instruments, xctrace, MetricKit, simctl, or native-trace summaries. It uses the same artifact contract and source-inventory override semantics as Android while preserving iOS capture/export ownership with the provider. Provider-owned recording sessions can override `captureMode` and `lifecycle` so bounded start/end/duration facts and timing perturbation remain explicit instead of inheriting the helper's non-perturbing after-capture default. The helper can surface frame and hitch metrics, CPU and scheduling metrics, memory footprint, thermal and battery signals, raw trace attachments, and trace-window metadata, but it remains diagnostic-only until a comparable capture lane proves target binding, completeness, and baseline compatibility. Live iOS runners can now supply that bounded capture window to provider commands that start/stop xctrace or other no-shell iOS tooling around the active scenario loop.

Provider `targetBinding` is a claim boundary, not decoration. Use `verified` only when the provider proved the requested device/app target, `unverified` when it lacks target proof, `ambiguous` when more than one runtime could own the evidence, and `mismatch` when the observed target differs from the requested target. App and device ids state identity but do not prove observation. Native-performance comparison readiness requires a matching `candidateTargets` observation with a run-relative `evidencePath`; that evidence path now points to a package-owned target-binding attachment, typically `raw/providers/<providerId>/target-binding.json`, validated against `schemas/native-target-binding.schema.json`. Trusted target-binding records must preserve provider/platform/run/scenario identity, requested app id and target id, observed target id, observed process pid and name, a bounded `activeLoop` window, `captureArtifacts` entries naming the raw active-window artifacts used by the normalized evidence, and `sourceCommands` entries that point back to immutable provider command records. That `activeLoop` window must exactly match the package-owned `raw/runner-active-loop-window.json` record for `startedAt`, `endedAt`, and `durationMs`; a provider-authored window that only falls inside the command timestamps is not sufficient. Each `captureArtifacts[].path` must be surfaced by the native-performance envelope and must match a hashed `outputs[]` entry from a `startWindow` or `stopWindow` command record whose `runRelativePath` equals that same surfaced artifact path; after-capture normalization can interpret that raw capture, but it cannot stand in for the capture itself. Those `sourceCommands` must validate against the current `target-binding.json` bytes, so any later cleanup must stay append-only in separate command records rather than mutating the bound attachment in place. Android verified records must also preserve `observedAppId`. iOS verified records must also preserve `observedTargetPlatform` and `observedTemplate`. Profiler and native-performance JSON can still include expected, conflicting, or unknown candidates so agents can see exactly why evidence is diagnostic-only. Aggregate live-proof and proof-set native-performance rollups may preserve compact target-binding detail counts so readers can see whether ambiguous or mismatched evidence came from expected, observed, provider, manifest, trace, or other provider-supplied binding context before opening each raw evidence file.

## Claim-complete contract foundation

Scenario and verdict schemaVersion `1.1.0` define the additive public vocabulary
for claim-complete proof. Existing `1.0.0` scenarios and verdicts remain valid
legacy diagnostic contracts. ASL does not infer claims from their milestones,
budgets, descriptions, or attached evidence, and a legacy scenario cannot add a
`claims` field to imply otherwise.

A scenario `1.1.0` declaration requires a complete `journey` shape, a
non-empty `claims` array containing at least one `mandatory` claim, a
`safety` declaration, and an explicit `dependencies` inventory. The journey
names its actor, start and end state, phases, terminal invariants, and recovery
contract. Every phase, terminal invariant, and recovery variant declares
`coverageKind: "product"` or `coverageKind: "recovery"`; this identifies the
part of the authored journey it belongs to and does not establish runtime
authority. Each claim has a stable ID, a `mandatory` or `supplemental` role,
pre-runtime platform and optional variant applicability, explicit phase or
terminal-invariant closure references, and a flat conjunction of assertions.
The supported assertion families are app or provider event occurrence and
ordering, terminal-state equality, bounded count, bounded absence, and
validated evidence presence. Nested Boolean claim expressions and evaluator
scripts are not part of this contract.

The static `safety` declaration classifies the scenario as `read_only`,
`local_mutation`, `reversible_backend_mutation`, or `destructive` and names the
operations the author permits the scenario to request. Mutating declarations
bind mutation identity and terminal reconciliation to existing assertion IDs.
Local mutation requires rollback or cleanup truth, reversible backend mutation
requires rollback truth, and destructive work requires cleanup truth. Runtime
grants and human approval do not belong in this static declaration.

Every assertion names its authority role, producer, evidence selector,
required identity strength, and completeness. The closed authority roles are
`app`, `runner`, `adapter`, `provider`, and `comparator`. Evidence presence
proves only that the named evidence obligation was produced and validated; it
does not prove the product behavior depicted or measured by that evidence.
Absence and bounded-count assertions require a named observation window and a
complete source. Generic screenshots, videos, UI trees, and logs remain
corroborative unless a separate named validated comparator contract supplies
the declared authority.

`buildScenarioClaimHash()` returns the canonical SHA-256 identity of the full
claim definition. Object-key order does not affect the hash; authored array
order does, including arrays whose schema also requires unique entries. Object
keys use locale-independent code-unit ordering. The hash identifies the exact claim contract used by a result and
does not by itself establish semantic admissibility, evidence trust, or product
success.

Verdict `1.1.0` assertion results repeat the assertion kind and its exact
kind-specific authored expectation instead of reducing every assertion to a
generic scalar. Event occurrence records the expected event and matched
evidence identity. Event order records the two evidence identities and the
normalized `before` or `after` relation without introducing cross-clock
timestamps. Terminal state records path and value. Bounded count and absence
record the complete authored observation window plus a non-negative integer
count. Validated evidence records the artifact kind, validation contract,
matched evidence identity, and whether that artifact obligation passed or
failed; it does not evaluate the behavior depicted by the artifact.

Every assertion result includes `evidenceReferences`, `rejectedEvidence`, and
`missingProof`. Supported and rejected results require referenced evidence;
rejected results also require at least one authoritative contradiction.
Not-evaluable results require `observed: null` and at least one missing-proof
reason. They may also preserve evidence references or `rejectedEvidence`
entries that explain which candidate inputs were inadmissible; those entries
are diagnostic inventory and do not change the terminal status to `rejected`.
Supported results cannot carry rejected-evidence or missing-proof inventory.
Point-authority event occurrence has no rejected form because an event not
observed at a point cannot prove bounded absence. These are structural reader
contracts only. Schema validation does not reconcile repeated expectations
with a scenario, compare terminal values, apply count bounds, or establish
evidence authority; the later claim reconciler and evaluator own those
semantics.

`inspectScenarioClaimVerdictReduction(scenario, selection, candidateVerdict)`
is a reader-side inventory and arithmetic inspection. Applicable claims are
selected before runtime from the exact platform and optional variant; excluded
claims remain visible in inspection inventory but must not appear as result
rows. The inspector requires exact claim ID, role, canonical hash, assertion
ID, assertion kind, and authored expectation correspondence. It returns no
verdict object and marks every output `inventory_reduction_only`; structural
coherence does not admit the caller's evidence or establish product truth.

For passed health, a claim reduces to supported only when every assertion is
supported, rejected when at least one assertion is rejected, and not-evaluable
otherwise. Rejection outranks a not-evaluable sibling only after health passes.
Failed or partial health requires every applicable claim and assertion result
to already be not-evaluable with `health_gate_failed`; the inspector never
synthesizes replacement records. Any rejected mandatory claim reduces the
journey to failed, otherwise any not-evaluable mandatory claim reduces it to
inconclusive, and only all-supported mandatory claims reduce it to passed.
Supplemental outcomes remain visible but do not gate the journey. This
inspection does not choose a canonical reason or next-action owner when
multiple not-evaluable causes exist.

`buildScenarioClaimCompleteContractHash()` returns the canonical SHA-256
identity of the entire closed, schema-valid scenario `1.1.0` document. It uses
the same deterministic JSON rules as claim hashing: object keys use
locale-independent code-unit order, authored arrays preserve order, and
non-JSON, cyclic, non-plain, or non-finite input is rejected. V1 intentionally
includes every supplied scenario field rather than maintaining a second
hand-picked semantic subset. Consequently, descriptive, operational, journey,
claim, dependency, safety, capability, cadence, and artifact-demand edits all invalidate
the identity. This is conservative approval churn, not a claim that every
field has equal product meaning.

Scenario `1.1.0` dependencies are authored, hash-bound prerequisites rather
than mutable setup state. Every scenario declares the top-level array, including
an explicit empty array when no prerequisites exist. A `journey_entry`
dependency gates the journey. A `claim_scoped` dependency gates a non-empty set
of named claims. Each dependency has exact platform and optional variant
applicability plus one predicate from the closed claim-assertion vocabulary.
Dependency IDs are unique, claim references resolve, and dependency
applicability cannot be broader than the scenario or any referenced claim.

`inspectScenarioClaimDependencies(scenario, selection)` is a pure structural
reader. It reports `complete`, `incomplete`, or `outside_contract`, preserves
the applicable dependency IDs in authored order, and emits deterministic checks
for schema, selected platform, identity, references, applicability, and selected
inventory. It does not observe predicates, admit execution, or produce runtime
health or claim results.

A `scenario-claim-approval` `1.0.0` record is a caller-owned sidecar
attestation. It names one approval ID, scenario ID, complete scenario hash,
exact platform and optional variant, the closed decision `approved`, an audit
timestamp, and an opaque approver reference. It has no expiry, credential,
role, signature, runtime authorization, evidence, verdict, proof-tier, or
publication field. `inspectScenarioClaimApproval()` reports `bound` only when
that exact identity and selection still match, `invalidated` for drift, and
`outside_contract` for malformed or unsupported input. Every result is marked
`exact_hash_attestation_only`. ASL does not authenticate the approver, infer
authority, establish freshness, admit runtime work, evaluate evidence, or
promote product truth from this record. Runtime authorization and mutable
boundary revalidation remain separate later gates.

A `scenario-claim-authorization-grant` `1.0.0` record is a separate,
credential-free run authorization input. It binds one grant ID to the exact
scenario ID and complete scenario hash, selected platform and optional variant,
declared safety class, goal, target resource, operation set, delegation chain,
and UTC expiry. Mutating grants additionally bind the authored mutation
identity; read-only grants cannot carry one. Target resource is mandatory and
the scenario safety operations, requested operations, and granted operations
must be exactly the same set. Reordering does not change that set, while a
missing or additional operation fails compatibility.

`inspectScenarioClaimAuthorization()` is a pure reader over the scenario,
selection, explicit request, caller-supplied time, and grant. It reports
`compatible`, `incompatible`, or `outside_contract` through a deterministic
check ledger. The exact expiry boundary is expired. A compatible result means
only that the supplied authorization record matches the inspected contract at
that caller-supplied time. It does not authenticate the delegation chain,
acquire the target, revalidate at a mutable boundary, compose final admission,
or permit scenario `1.1.0` execution. The shipped quick-proof authorization
coordinator remains a separate runtime contract until a later integration
slice can preserve its existing optional-target and subset behavior explicitly.

`inspectScenarioClaimAdmission(input)` is the final pure pre-runtime composer
for scenario `1.1.0`. It first validates the closed platform and optional
variant selection, claim-complete scenario schema, selected platform, and full
scenario hash. Only then does it collect semantic closure, assertion and
dependency-predicate authority, static safety, scoped authorization, exact-hash
approval, and dependency integrity in that fixed order. Every owner inspection
remains intact; the composer adds only an ordered gate index, the first blocking
gate, and the complete blocking-gate inventory.

Results are `outside_contract` when scenario or selection identity cannot enter
the contract, `blocked` when any owner inspection is not successful, and
`admitted` only when closure is `closed`, authority and authorization are
`compatible`, safety and dependencies are `complete`, and approval is `bound`.
After schema and selection pass, all owner readers run so a later valid gate
cannot hide an earlier failure and multiple failures remain diagnosable.
Selected-platform authority absence is blocking and never retroactive
non-applicability. Dependency-predicate capability and dependency inventory
integrity remain separate required gates.

Admission here means only that the supplied static contract, catalog, grant,
approval, and exact selection are mutually coherent. The composer performs no
filesystem, process, target, adapter, provider, credential, clock, network, or
artifact work. It does not acquire a resource, revalidate a mutable boundary,
evaluate evidence, emit health or verdict truth, certify a baseline, or enable
scenario `1.1.0` execution. Current execution entries continue to reject that
schema version before side effects.

`buildScenarioClaimEvidenceRunIdentityHash(runIdentity)` canonically binds one
closed evidence context before semantic evaluation. The identity includes the
exact scenario hash and selected platform or variant, run and attempt, source
and package, target and installed app, runner, adapter, transport, app-helper
payload, environment cohort, and a non-empty producer inventory. Producer
entries are unique by role and producer ID and are sorted only in the normalized
copy used for hashing. Identity strings cannot smuggle absolute local paths,
file URIs, backslashes, or parent traversal into the public binding.

`inspectScenarioClaimEvidenceCandidateIdentity(input)` is the first pure
evidence-plane reader after admission. It locates one applicable authored
assertion and binds one candidate to the exact run identity, claim hash,
assertion kind, admitted authority declaration, producer version and hash,
evidence selector, required strength and completeness, and the assertion's
artifact-validation or observation-window contract. Strength and completeness
match exactly in this V1 reader; a candidate cannot self-promote by declaring a
stronger value. The authority catalog is not accepted again as mutable input:
the reader uses the declaration selected by the admission inspection.

Results are `outside_contract` for malformed or foundationally unbound input,
`blocked` for one or more identity, authority, evidence, capture, or cleanup
failures, and `eligible` only when all five ordered gates match. The whole
input envelope is untrusted: `null`, arrays, primitives, missing required
fields, extra keys, non-string closed vocabularies, unsafe evidence paths, and
extra-key admitted authority checks fail closed as `outside_contract` rather
than throwing. Evidence paths use the same safe identity-string rules as other
identity fields. Admitted authority checks require exactly the base and
subject-specific keys produced by claim authority inspection. Capture marked
partial, missing, or rejected and cleanup marked incomplete remain explicit
blockers. Evidence path and SHA-256 are structural candidate identity in this
slice; there is no filesystem comparator, freshness check, or artifact writer.
Private and redacted evidence can remain locally eligible because publication
and disclosure policy are separate contracts.

An `eligible` result exposes `eligibleCandidate` as a newly assembled closed
union, never the caller object. Nested observation-window data is deep-copied.
The projection always records produced capture, copied evidence path and SHA,
the complete matched authority identity, and cleanup `finalized` or
`not_required`. `validatedEvidence` may carry artifact kind and validation
contract only; `boundedCount` and `absence` may carry the observation window
only; event-occurrence, event-order, and terminal-state projections carry
neither. Blocked and `outside_contract` results omit the projection.

Neither candidate eligibility nor raw-observation admission is semantic
support or rejection. These readers do not compare observed product values,
count events, prove absence, validate the
artifact, or emit an assertion result.

`inspectScenarioClaimRawObservationAdmission(input)` is the next pure
evidence-plane boundary for JSON-native observations. It accepts only the
eligible projection from the candidate-identity reader plus exact artifact
bytes. SHA-256 is recomputed over those bytes and must match before fatal UTF-8
decoding or JSON parsing. ASL does not reinterpret that hash as a canonical
JavaScript-object hash. The five admitted observation kinds are event
occurrence, event order, terminal state, bounded count, and absence. Their
objects and nested records are closed; occurrence order is preserved; empty
arrays remain observable input rather than being converted into a conclusion.
Bounded-count and absence windows must exactly match the eligible candidate.

The reader returns `outside_contract` for malformed input or a non-eligible
candidate projection, `blocked` for byte, decoding, JSON, shape, kind, or
window failures, `unsupported` for `validatedEvidence`, and `admitted` only
for an exact byte-bound closed observation. `validatedEvidence` remains
unsupported on this JSON-native observation route because opaque validator
reports are a different evidence path; artifact presence cannot stand in for
that report. Use the validated-evidence readers below instead of treating
report identity as undefined. `not_applicable` is not a runtime result here.
An admitted observation is an in-process reader view, never health, semantic
support or rejection, a product verdict, or a persisted proof artifact. This
slice performs no file I/O, runtime execution, result evaluation, verdict
reduction, or publication.

`inspectScenarioClaimJsonNativePointInterpretation(assertionInput, admittedInput)`
is the pure post-admission assertion interpreter for JSON-native
`eventOccurrence`, `eventOrder`, and `terminalState` claims. Input must be a
matching admitted raw-observation result plus the exact assertion. Outputs are
`outside_contract` or `interpreted` with one `ClaimAssertionResult`. Trust is
`admitted_observation_interpretation_only`. Admitted bytes may be interpreted,
but artifact presence alone is not semantic support. Duplicate, missing,
conflicting, or ambiguous point evidence remains `rejected` or `not_evaluable`
according to the interpreter. `supported`, `rejected`, and `not_evaluable` are
assertion-level semantics only, not health, claim result, journey verdict,
baseline, certification, publication, or runtime acceptance. `not_applicable`
is not a runtime result here. This slice does not enable scenario 1.1.0
execution.

`inspectScenarioClaimJsonNativeWindowedInterpretation(assertionInput, admittedInput)`
is the pure post-admission assertion interpreter for JSON-native `boundedCount`
and `absence` claims. Input must be a matching admitted raw-observation result
plus the exact assertion. The admitted observation is a prerequisite: this
slice does not admit artifacts, and an admitted artifact alone is not semantic
support or product behavior. Inclusive window bounds apply. Bounds, observation
counts, and admitted artifact `byteLength` must be non-negative values accepted
by `Number.isSafeInteger`; unsafe integers are `outside_contract`.
Interpretation requires a complete window; count zero is not absence proof
without that complete authority. Candidate-identity admission already binds
assertion authority (role, producer, selector, required strength, and
completeness). This interpreter does not rematch those fields.
Unrepresentable `WindowedClaimAuthority`, including `point` completeness, is
`input_invalid`. The rejected reason `authoritative_evidence_rejected` is the
closed assertion-result vocabulary when an admitted observation fails the
inclusive bound or absence check; it does not recast observed strength as
product authority. JSON-native point and windowed inspectors return either
`outside_contract` or `interpreted`. Only `interpreted` contains one
`ClaimAssertionResult`; `outside_contract` contains `reasonCodes` and no
result. Interpreted assertion results are `supported`, `rejected`, or
`not_evaluable`. `not_applicable` is excluded at runtime. Trust is
`admitted_observation_interpretation_only`. `supported`, `rejected`, and
`not_evaluable` are assertion-level semantics only, not health, claim result,
journey verdict, baseline, certification, publication, or runtime acceptance.
Candidate reconciliation, health, `ClaimResult`, verdict, runtime, artifact
writes, and publication remain separate. `not_applicable` is not a runtime
result here. This slice does not enable scenario 1.1.0 execution.

`buildClaimCompleteVerdict(input)` is the public claim-complete verdict
builder for scenario `1.1.0`. Input is one scenario, a pre-runtime
platform/optional variant selection with applicable and excluded claim IDs,
`healthStatus`, a run ID, and one reconciled `ClaimResult` per applicable
claim. Applicability is pre-runtime only: runtime never retroactively emits
`not_applicable`. Supplemental results remain visible and do not gate
mandatory journey status. Failed or partial health does not throw: it produces
an inconclusive candidate and projects every claim/assertion to
`health_gate_failed`. Artifact presence is not semantic support. Malformed,
incoherent, sparse, or foreign input, no applicable mandatory claim, an
unsupported assertion kind, invalid output schema, or a rejected reduction
inspection throw and fail closed. The builder returns a frozen candidate or
throws; it does not return a structured fail-closed result. It does not admit
evidence, execute scenarios, write artifacts, publish verdicts, establish
product truth, or enable current runners to execute `1.1.0`.

`inspectScenarioClaimValidatedEvidenceReportIdentity(input)` is the pure
evidence-plane boundary for a distinct closed validator or comparator report
identity. It accepts only an eligible `validatedEvidence` candidate
projection plus a closed run-relative report identity and exact report bytes.
Report SHA-256 is recomputed before any semantic interpretation. Subject and
report path or SHA collisions fail closed. Results are `outside_contract`,
`blocked`, or `admitted`. Admitted report identity proves only that the
report path and bytes match the declared identity; it is not validator
semantics, depicted-behavior evaluation, or product truth.

`inspectScenarioClaimValidatedEvidenceAdmission(input)` composes that
report-identity check after binding exact subject bytes. It first parses one
stable eligible candidate projection, binds those subject bytes to
`candidate.evidence.sha256` before caller report fields are read, then
delegates report identity, byte, and collision checks to the report-identity
reader. Results are `outside_contract`, `subject_blocked`, `report_blocked`,
or `identity_admitted`. `identity_admitted` proves only exact subject and
distinct report identities and bytes. It does not parse or execute
`validationContract`, decide support or rejection, evaluate depicted or
measured behavior, create a `ClaimAssertionResult`, health, verdict,
baseline, comparison, or publication authority, or perform filesystem,
runtime, device, runner, provider, network, artifact-write, or publication
side effects.

`inspectScenarioClaimValidatedEvidenceResultAdmission(input)` is the pure
evidence-plane identity admission reader for one closed validator-result
artifact. It accepts only `{ validatedEvidence, result, resultBytes }`: an
eligible identity-admitted candidate projection, a closed run-relative result
identity, and the exact result bytes. Those bytes must parse as a
`validatedEvidenceResult` payload against
`agent-scenario-loop/schemas/validated-evidence-result.schema.json`
(`SCHEMAS.validatedEvidenceResult`). Result SHA-256 is recomputed from those
bytes before any semantic interpretation. Subject, report, and result path or
SHA collisions fail closed. `resultId` is any schema-valid stable safe
identifier; it is not a required literal and is separate from the result
artifact path. Exact matching applies to `assertionId`, `validationContract`,
subject identity, and report identity. The `validator` tuple in the exact
result bytes is schema-validated and preserved; this reader has no
independent expected producer declaration to compare against. Outcomes are
`outside_contract`, `blocked`, or `admitted`. `passed`, `failed`, and
`not_evaluable` are validator vocabulary on the result payload only. A
passing validator result remains identity evidence only: it is not a
`ClaimAssertionResult`, product support, health, verdict, baseline,
comparison, or publication authority. Admitted result identity proves only
that the result path and bytes match the declared identity; it does not
parse or execute `validationContract`, evaluate depicted or measured
behavior, create assertion or claim results, or perform filesystem, runtime,
device, runner, provider, network, artifact-write, or publication side
effects. This slice does not enable scenario `1.1.0` execution.

Candidate eligibility is not semantic support or rejection. This reader does
not compare observed product values, count events, prove absence, validate the
depicted behavior in media, reconcile sibling candidates, emit assertion
results, produce health or verdict artifacts, certify a baseline, or enable
scenario `1.1.0` execution. `eligible` remains only admissibility for a future
evaluator; it is not product truth, health, verdict, proof, publication,
freshness, certification, or runtime acceptance. A later evaluator must
preserve these boundaries and cannot reinterpret `eligible` as product success.

`inspectScenarioClaimClosure(scenario, selection)` performs the pure structural
closure inspection for one exact platform and optional variant. It reports
`closed`, `not_closed`, or `outside_contract` with deterministic checks and
blocking reasons. Closure requires unique journey, recovery-variant, claim, and
assertion IDs with no phase, terminal-invariant, or recovery-variant collisions;
resolved closure references; and applicable mandatory-claim coverage for every
authored phase and terminal invariant. Supplemental claims do not close
mandatory journey truth, and platform- or variant-scoped claims are never
combined across selections. Required recovery needs an explicit recovery
variant and at least one recovery-owned phase or terminal invariant; recovery
marked `not_required` forbids both. `closed` means only that the authored claim
graph covers the authored journey. It does not mean admitted, executable,
supported, approved, evaluated, passed, stable, or certified.

`inspectScenarioClaimSafety(scenario, selection)` performs a pure static safety
inspection for one exact platform and optional variant. It reports `complete`,
`incomplete`, or `outside_contract`. A mutating safety contract is complete only
when every referenced assertion has exactly one applicable claim owner, that
owner is mandatory, and every reconciliation invariant exists in the authored
journey. `complete` does not grant authority, prove that safeguards are
available, or admit runtime work. Runtime authorization, resource ownership,
and mutable-boundary revalidation remain separate gates.

An authority-capabilities `1.0.0` declaration is a separate, product-neutral
catalog entry for one named `app`, `runner`, `adapter`, `provider`, or
`comparator` producer. It declares the exact platforms, assertion kinds,
evidence selectors, maximum identity strength, and maximum completeness that
producer can supply. A declaration supporting `validatedEvidence` also names
its artifact kinds and validation contracts. Scenario assertions name the
producer they require; the scenario cannot declare or prove that producer's
capability itself. Authority declarations are not runner manifests, and ASL
does not infer semantic authority from generic runner capabilities or artifact
outputs.

`inspectScenarioClaimAuthority(scenario, selection, declarations)` performs a
pure pre-runtime compatibility check for every applicable mandatory and
supplemental assertion and every applicable dependency predicate. Matching is
exact for role, producer ID, platform,
assertion kind, and evidence selector. Declared identity strength and
completeness must meet or exceed the assertion requirement; validated evidence
must also match its artifact kind and validation contract. Results are
`compatible`, `incompatible`, or `outside_contract` with deterministic checks,
blocking reasons, and next action. Overlapping declarations for the same named
producer and selected platform are a catalog error. Disjoint platform
declarations are allowed. An in-contract platform with no compatible path is
`incompatible`, never retroactively non-applicable.

Authority checks discriminate `claim_assertion` from `dependency_predicate`.
Claim checks identify their claim role and assertion. Dependency checks identify
the dependency kind and predicate, include claim IDs only for `claim_scoped`
dependencies, and never manufacture claim identity for `journey_entry` rows.

Authority compatibility remains only one conjunctive admission fact. It does
not establish safety, authorization, human approval, runtime availability,
evaluation, product success, or proof-tier identity. Declarations in this
foundation are caller-supplied and unsigned; exact declaration identity and
human approval belong to a later gate. When no claim assertion or dependency
predicate applies to an exact selection, authority inspection is vacuously
compatible because structural closure and dependency integrity remain separate
required gates.

Verdict schemaVersion `1.1.0` requires compact `claimResults`. Claim and
assertion statuses are `supported`, `rejected`, or `not_evaluable` with closed
reason codes, normalized expected and observed values, run-relative evidence
references using forward-slash artifact paths, missing-proof inventory, and
product-neutral next-action routing. Absolute paths, drive-qualified paths,
backslashes, and parent traversal are rejected.
`not_evaluated` is legal only for legacy verdict `1.0.0`; `not_applicable` is
not a runtime claim-result status. Applicability is resolved before runtime. If
a selected platform or adapter cannot supply an expected authority path,
health becomes unsupported and affected requested claims become
`not_evaluable`, never retroactively non-applicable.

This foundation is reader-only. Schema acceptance, closure inspection,
dependency inspection, authority-capability inspection, safety inspection,
authorization compatibility, exact-hash approval, and final admission
composition prove pre-runtime contract facts, not runtime availability or
product truth. Mutable-boundary revalidation, resource ownership, claim
evaluation, stress aggregation, and verdict generation remain separate future
gates. Current runners continue to emit legacy verdicts only for legacy
scenarios. Planning or profiling a scenario `1.1.0` fails before runtime and
does not emit a legacy verdict. A consumer must not hand-author a
`1.1.0` passing verdict and treat schema validity as ASL evaluation.

## Public artifact layout

Every run should produce a stable artifact folder.

Core artifacts:

- `health.json`: whether the scenario execution was valid enough to interpret
- `verdict.json`: legacy budget outcome or `not_evaluated` state in `1.0.0`, or compact claim results once a claim evaluator produces `1.1.0`
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

`summary.md` is an agent-readable index over the same artifacts, not a separate truth source. Its top-level status, health, verdict, and terminal-state lines must honor `health.json` and `verdict.json` before iteration accounting, metrics status, or manifest attempt status. When profile commands or required truth fail or stay partial but iteration accounting still completes, the summary reports the health-gated status and terminal state while preserving the raw manifest and attempt states as metadata.

`metrics.json` includes `measurementPolicy` for the profile's own sample set. It records expected iterations, valid latency samples, warmup samples, excluded outliers, and a confidence level. `multi_sample` means the latency samples cover the expected measured iterations and include at least three samples. `single_run` is useful smoke evidence but should not drive fine-grained performance ratchets; latest-trusted directional timing movement between two passing single-run checks remains `low_confidence` whether it looks faster or slower. `insufficient` means some expected latency samples are missing. `unmeasurable` means the profile produced no latency samples, usually because the scenario proved completion milestones without interval anchors. This policy does not replace health or verdict; it tells agents how much timing confidence the metrics can support after those gates are considered.

`budget-verdict.json` separates the budget status from the claim status. A passed health gate can still produce a partial budget evaluation when latency checks are unmeasurable or missing interval anchors. In that case the budget verdict remains `status: "partial"` and sets `claimStatus: "diagnostic_only"` with a reason, so agents can inspect the evidence without treating it as a trusted product-performance claim.

`causal-run.json` preserves app-emitted timeline events through the public causal phase/status vocabulary. If an app emits richer phase or status values, ASL writes schema-valid top-level values and preserves the originals as timeline metadata. Timeline metadata also preserves scalar correlation fields such as `iteration`, `sequence`, `queueId`, `commandId`, `operationId`, `attemptId`, and `clockDomain` when the app emits them. Profile-session command acknowledgements are included as ASL-owned timeline entries with command status, result, source, sequence, queue, wait, command ID metadata, and cadence/readiness overlap scalars (`minimumSettleMs`, `plannedSettleMs`, `maxReadinessWaitMs`, `readinessWaitMs`, `actualWaitMs`, `settleOverlapSavedMs`, `timeoutAvoided`, `continuationReason`) so agents can inspect runtime ordering and pacing outcomes without treating command transport as product truth. `actualWaitMs` is recorded at the continuation boundary, not when readiness first arrives. A stable-readiness claim still requires an app-owned milestone whose event contract asserts stability; elapsed cadence alone is perceptual pacing, not product truth. Repeated runs include `iterationSummary` so agents can distinguish complete, partial, failed, and timeout iteration evidence without scraping raw logs. Scenarios without budget thresholds still produce schema-valid causal artifacts with an empty `budgets` object.

`manifest.attempt` records the run attempt identity and terminal semantics independently of prose summaries. It includes an `attemptId`, `attemptNumber`, `maxAttempts`, optional retry lineage, terminal state, failure classification, cleanup outcome, and whether preserved partial artifacts are valid for diagnosis. Retry attempts must identify the prior attempt and retry reason. A failed attempt can therefore keep usable raw evidence without implying that product verdict, timing, or comparison claims are trustworthy.

`manifest.provenance.cohort` records product-neutral compatibility inputs for comparing runs. Profile runners populate known fields such as `appId`, `platform`, `runnerName`, `runnerVersion`, `commandTransport`, and active provider IDs; richer callers can add app/build version, build mode, OS version, device class, feature flags, and seed identity. ASL derives `manifest.provenance.cohortHash` from the normalized cohort. Latest-trusted comparison requires the same cohort hash when the current run records one, so old artifacts remain comparable only when the current artifact has not opted into cohort-aware selection.

`manifest.attempt.terminalState` uses a terminal vocabulary of `passed`, `failed`, `timeout`, `cancelled`, `aborted`, `inconclusive`, `unsupported`, `skipped`, and `unhealthy`. Attempt construction rejects misleading terminal combinations: passed attempts must end as `passed`, failed attempts must use a failure terminal state, timeout/cancelled/aborted attempts must preserve valid partial artifact paths, and cleanup statuses such as `passed`, `failed`, or `partial` must include a cleanup message. `manifest.environment` records product-neutral lifecycle and environment preconditions and postconditions. Each field is an assertion object with a `value` and `evidence` state. Generated profile artifacts default to `value: "unknown"` and `evidence: "not-asserted"` unless the runner can prove more. The dedicated `lifecyclePhase` assertion supports `cold-launch`, `warm-launch`, `hot-launch`, `resume`, `foreground`, `background`, `force-stop`, `process-death`, `scene-recreation`, `activity-recreation`, `os-reclaim`, `reboot`, and `relaunch`. This preserves what the runner did not prove instead of letting agents infer installed state, app data state, auth state, route, foreground state, permissions, locale, timezone, theme, font scale, orientation, network, animations, cleanup, data, or artifact completeness from surrounding logs.

Profile `agent-summary.md` files include an `attempt` section when the run has a manifest attempt block, including terminal state, cleanup state, partial-artifact validity, and retry lineage. Latest-trusted baseline selection treats attempt-aware runs as baseline-trusted only when health and verdict passed, the attempt is a clean first attempt, cleanup did not fail or remain partial, and partial artifacts are not marked valid diagnostic fragments. Older artifacts without `manifest.attempt` remain legacy-trusted when health and verdict passed, but new attempt-aware runs cannot hide retry laundering behind a green final verdict.

Profile runners assert only environment facts they own. Every completed profile manifest records ASL-controlled artifact completeness and cleanup postconditions. Live adb/simctl capture paths also assert runner-controlled foreground state, explicit lifecycle preconditions, and foreground postconditions. Use `--lifecycle-phase <phase>` when a runner can prove a non-cold precondition such as `warm-launch` or `resume`; log-ingest and preexisting artifact ingestion keep those fields `unknown/not-asserted`. Lifecycle assertions are not product milestones: a runner proving `lifecyclePhase: "resume"` does not synthesize `app_resumed` or any other app truth event. Resume readiness must still be emitted by the consuming app when a scenario waits for it.

Aggregate live proof commands write `live-proof.json` and `agent-summary.md` under `_live-proof/<run-id>`. The live-proof artifact points to preflight evidence, every scenario run, optional interaction proofs from tools such as agent-device or Argent, optional skipped interaction proof declarations, and optional latest-trusted comparison outputs, giving agents one stable entrypoint after a proof run. Preflight, profile, and interaction pointers include health and verdict status from the linked run artifacts, so agents can see what passed before opening deeper evidence. Interaction proof pointers also include sidecar screenshot capture inventory when the sidecar produced screenshots, plus `warnings` when optional sidecar checks failed without invalidating the required proof. If profile health or verdict fails, requested sidecars are not executed; they are recorded in `skippedInteractionProofs` with a reason and next action so agent feedback stays explicit without mixing runner evidence into an untrusted timing run. When the failed profile preserved partial provider evidence, skipped interaction proof pointers may also include `profileGateDiagnostics` with captured and blocking per-kind diagnostic sufficiency, unresolved requested diagnostic inventory entries, a provider-evidence next action, and native-performance claim, completeness, comparability, target-binding, target-binding detail, and source-status context derived from the profile artifacts. That lets aggregate readers see whether sidecars were skipped because useful diagnostics were only partial, provider-blocked, requested-missing, or native-performance-diagnostic-only before opening the profile folder. When an iOS storage-backed profile-session start wait fails, skipped interaction proof pointers may include `profileGateReadiness` with failure class, command count, dev-client deep-link status, foreground probe facts, pending phase, expected evidence, seed status, raw readiness paths, and the readiness next action derived from the failed profile health check. Aggregate artifacts may also include top-level `profileGateReadiness` counts with derived command-channel detail tags such as no-command, deep-link, storage-seed, and foreground-target ownership, plus `profileGateReadinessNextActions` owner/code counts, so single-platform readers can classify readiness blockers and route follow-up before opening each skipped sidecar entry. Aggregate artifacts may also include top-level `profileGateRequestedDiagnostics` and `profileGateProviderEvidenceNextActions` counts so single-platform readers can see requested-but-blocking provider diagnostics and provider-tooling follow-up before opening each skipped sidecar entry. Aggregate artifacts may also include `profileNativePerformance`, a rollup of native-performance evidence attached by profile runs, with profile/evidence counts, diagnostic source status counts, completeness status counts, claim sufficiency counts, comparability counts, target-binding counts, and optional target-binding detail counts. This rollup is an index over profile artifacts; provider capture, validation, and claim readiness remain owned by the linked profile evidence. When a failed linked summary identifies a next-action owner or the `unresolved` routing sentinel, live-proof and proof-set aggregates preserve and rank that value instead of defaulting it to runner ownership. The aggregate artifact records `status`, `comparisonStatus`, `comparisonCounts`, optional per-comparison `metricSummary` counts/highlights, and a `nextAction` hint so agents can distinguish failed proof gates, regressions, mixed metric movement, missing baselines, inconclusive comparisons, partial sidecar evidence, and clean summaries without scraping prose. Generated aggregate artifacts include `nextAction.owner` with the resolved product-neutral owner vocabulary plus `unresolved` when the app-truth/scenario boundary remains ambiguous.

Platform-set proof commands write `live-proof-set.json` and `agent-summary.md` under the caller-provided proof-set output directory. The proof-set artifact records required platforms, present platforms, missing platforms, each linked `live-proof.json`, failed proof reasons, regression-gate reasons, and a next action. When required platform proofs are missing, the proof set may include `missingPlatformNextActions` with owner/code counts per missing platform so readers can separate coverage collection from failed proof, warning, and skipped sidecar follow-up. When linked proofs fail or trigger an active regression gate, the proof set may include `proofFailureNextActions` with owner/code counts from those proof next-action hints, so readers can separate failed proof or regression follow-up ownership from skipped sidecar blockers. If failed linked proofs carry diagnostic sufficiency pairs through skipped sidecar declarations, the proof set may include `proofFailureDiagnosticSufficiency` with failed proof count plus captured and blocking per-kind/status counts so provider-blocked and diagnostic-only evidence on failed proofs is visible separately from optional warning and skipped-gate summaries. If failed linked proofs carry requested diagnostic inventory through skipped sidecar declarations, the proof set may include `proofFailureRequestedDiagnostics` with failed proof count plus requested diagnostic counts by kind, status, and requiredness so requested-but-missing diagnostics are visible separately from optional unrequested surfaces. If failed linked proofs carry native-performance claim context through skipped sidecar declarations, the proof set may include `proofFailureNativePerformance` with failed proof count plus claim sufficiency, completeness, comparability, target-binding, target-binding detail, and diagnostic source counts so native-performance claim blockers on failed proofs are visible separately from skipped-gate summaries. If failed linked proofs carry preserved provider-evidence next actions through skipped sidecar declarations, the proof set may include `proofFailureProviderEvidenceNextActions` with failed proof count plus owner/code counts so provider-tooling follow-up is visible without opening each failed profile folder. If failed linked proofs carry profile-session readiness context through skipped sidecar declarations, the proof set may also include `proofFailureReadiness` with failed proof count, skipped proof count, failure class, command total, dev-client deep-link, foreground probe, seed, pending phase, expected-evidence, and derived readiness-detail counts so no-command, storage seed, deep-link, and foreground-target command-channel blockers are visible without opening every platform proof first. If failed linked proofs carry readiness next actions through skipped sidecar declarations, the proof set may include `proofFailureReadinessNextActions` with failed proof count plus owner/code counts for runtime-environment follow-up. When linked proofs include optional interaction warnings with next-action hints, the proof set may include `interactionWarningNextActions` with owner/code counts for those warning checks, so partial sidecar evidence remains visible without upgrading warnings into failed proof gates. When linked proofs include skipped sidecar declarations, the proof set may include `skippedInteractionProofCount` and flattened `skippedInteractionProofs` entries with platform, linked proof, reason, next action, and any profile-gate diagnostics or readiness context already carried by the child proof. It may also include `skippedInteractionProofNextActions` with owner/code counts from those skipped proof next-action hints, so readers can see whether blockers concentrate in runtime environment, app truth, provider tooling, runner, scenario contract, or optimization follow-up. When those skipped proofs include diagnostic sufficiency pairs, the proof set may also include `profileGateDiagnosticSufficiency` with captured and blocking per-kind/status counts so readers can see provider partial-evidence shape across platforms. When skipped proof gates include native-performance claim context, the proof set may include `profileGateNativePerformance` with claim sufficiency, completeness, comparability, target-binding, target-binding detail, and diagnostic source counts for those skipped gates. When skipped proof gates include preserved provider-evidence next actions, the proof set may include `profileGateProviderEvidenceNextActions` with owner/code counts for those skipped gates. When skipped proof gates include profile-session readiness context, the proof set may include `profileGateReadiness` with failure class, command total, dev-client deep-link, foreground probe, seed, pending phase, expected-evidence, and derived readiness-detail counts for those skipped gates. When skipped proof gates include readiness next actions, the proof set may include `profileGateReadinessNextActions` with owner/code counts for those skipped gates. When linked proofs include `profileNativePerformance`, the proof set may also include a combined `profileNativePerformance` rollup with profile/evidence counts, diagnostic source status counts, completeness status counts, claim sufficiency counts, comparability counts, target-binding counts, and optional target-binding detail counts across platforms. This gives agents one stable Android-plus-iOS gate after the per-platform live proofs have written their own aggregate evidence; the proof-set rollups remain indexes over linked profile evidence, not new product-performance claims.

`ci-evidence-pack.json` (`schemaVersion` 1.0.0) is a runner-neutral wrapper over exactly one live-proof-set reference. It does not replace the proof set. The PR1 builder and reader validate the pack schema and cross-record semantics. The runner-independent assembler reads and hash-verifies the live-proof-set file, then checks SHA-256, byte size, schema, platform inventory, and selected-attempt run identity before building the pack. Child proof and summary pointers must resolve to distinct regular files inside the real artifact root. The assembler verifies pointer identity and containment but does not read or semantically interpret child bytes. Existing live-proof-set child pointers may be absolute host paths; the assembler accepts those pointers only when they are contained by the declared artifact root and does not copy them into the pack. Stable live-proof-set reading is the hash-bound file read; this slice does not claim broader TOCTOU guarantees over later child-path races. `liveProofSet` is one hash-bearing reference; the assembler does not interpret product verdicts. Emitted packs are not rewritten; retries remain distinct retained attempts. That immutability is artifact lifecycle, not a JavaScript deep-freeze. The pack preserves exact source, platform, attempt, and evidence identities, plus run-relative hash-bound evidence. Failed and rejected attempts remain visible; a selected retry does not erase them. Missing required platform, stale or mismatched source, and invalid or incomplete evidence fail closed. Selected unsupported authority is `not_evaluable`, never retroactive `not_applicable`. Artifact presence proves only that artifact's obligation; product verdict remains the linked verdict truth. Mechanism status, the derived Android-plus-iOS evidence claim, product verdict, comparison, publication, release, and deployment stay separate. The pack itself does not carry publication, release, or deployment fields.

`ci-evidence-publication-receipt.json` (`schemaVersion` 1.0.0) is a separate public contract that binds one immutable CI evidence pack by exact SHA-256 digest and exact byte size. It records publication mechanics only: destination identity, attempt identity, and `publicationStatus` of `published`, `partial`, `failed`, or `not_published`. It does not rewrite pack mechanism status, the two-platform evidence claim, product verdict, comparison, release, or deployment. Publication success proves only that the exact pack bytes were published as recorded; it is not product success, comparison success, release acceptance, deployment, or runtime acceptance.

`readCiEvidencePublicationReceipt(receiptPath, exactPackBytes)` is the exact-byte authority: it parses the supplied pack bytes after local semantic admission. `assertCiEvidencePublicationReceiptForExactPackBytes(receipt, parsedPack, exactPackBytes)` then binds an already-admitted parsed pack to those same bytes so unknown evidence ids, non-present published evidence, copied identity, sha256, and byteSize fail closed. `assertCiEvidencePublicationReceiptForPack` validates semantic and copied binding only; it does not hash pack bytes. Do not treat a ForPack-only check as byte-identity proof. Receipt publication cannot rewrite mechanism, two-platform, product, comparison, completeness, assembly, release, deployment, or runtime truth.

The public renderer signature is `renderCiEvidencePublicationSummary(pack, receipt, exactPackBytes)`. Invalid binding or unsafe published destinations throw `CiEvidencePublicationReceiptError`. Publication success does not prove deployment.

Failed, rejected, private, not-available, and invalid publication outcomes remain visible retained records. A later successful receipt does not erase them. Destinations are generic safe HTTPS URLs; this contract does not encode GitHub-specific upload, workflow, or PR reporting behavior. The deterministic Markdown reviewer summary requires the same exact pack bytes as the receipt and must surface distinct publication and two-platform status fields without claiming product success. Upload, PR reporting, workflow orchestration, release acceptance, and deployment remain later separate proof layers.

Provider or custom-script evidence attachments are copied into stable run folders and inventoried in `manifest.artifacts.evidenceAttachments`. Each inventory entry records the evidence channel, kind, run-relative path, source filename, byte size, sha256 hash, completeness status, corruption status, redaction status, redaction policy metadata, and transformations; it does not preserve local absolute source paths. ASL does not inspect arbitrary screenshots, HARs, logs, traces, or provider blobs for sensitive data. Direct `--signal` and `--capture` attachments therefore default to `redactionStatus: "unknown"` and a policy authority of `asl-default`. Operators may declare direct attachment status with `--signal <kind>@redacted:<path>`, `--signal <kind>@not-redacted:<path>`, `--capture <kind>@redacted:<path>`, or `--capture <kind>@not-redacted:<path>` only when they own that privacy decision. Provider command outputs may declare `redactionStatus: "redacted"` or `"not-redacted"` only when the provider owns that privacy decision. Redacted provider or operator-declared outputs are marked as `declared-non-sensitive`; copied artifacts with unknown or not-redacted status are marked as `may-contain-sensitive-data` so agents do not treat inventory as privacy clearance.

Native performance evidence uses the `nativePerformance` kind. This is separate from `profiler`: use it for platform-native frame, render, memory, and trace summaries such as Android Perfetto, trace-processor output, `gfxinfo`/framestats, `meminfo`, logcat-derived render signals, iOS Instruments, xctrace exports, MetricKit, or simulator-derived native summaries. A provider can mark `nativePerformance` output as required, and the profile manifest will preserve it as a required diagnostic when captured. JSON native-performance outputs are validated against ASL's native-performance evidence schema, so they must include provider, platform, run, scenario, and at least one content surface such as summary, metrics, frames, memory, events, traces, attachments, or a `diagnosticSources` inventory. Raw traces should remain attached evidence while structured summaries carry the claim-ready facts, provenance, and comparability status.

`comparison.json` schemaVersion `1.2.0` records scenario-contract compatibility in `comparisonBasis.scenarioContract` and the measurement policy. `exact` means the hashes matched; `declared-compatible` means the current scenario explicitly accepted the baseline hash; `legacy-compatible` preserves prior behavior when the current artifact has no hash; and `incompatible` blocks ordinary and native comparison truth. The declaration is directional, same-scenario only, and non-transitive. Exact trusted candidates are selected before declared-compatible candidates. SchemaVersion `1.1.0` may also include a `nativePerformance` section. That section is product-neutral and fail-closed: it only compares attachments that were already classified comparison-ready, requires trusted baseline and current runs, and requires exact or explicitly accepted scenario contracts plus matching `scenarioId`, `comparisonLane`, and `cohortHash` before the native pair is considered. Trusted native metric rows report baseline/current/delta/percentChange/direction plus a separate budget result of `passed`, `failed`, or `not-configured`. If the same-condition policy, target contract, bounded window, tool identity, sample descriptors, or evidence trust cannot be proven, the section stays `not-comparable` and preserves explanations instead of inventing a performance claim.

### Historical evaluation

`historical-evaluation.json` schemaVersion `1.0.0` is a separate public artifact contract for consumer-owned evaluation over local run history. It does not change `comparison.json`, represent the historical population as a virtual baseline run, or make the ASL runner responsible for producing the file. V1 defines types, schema, and semantic validation only: it does not define discovery, selection, evaluation, writing, CLI, remote storage, release, or workflow behavior.

The consumer is the policy authority. Every metric and native-history policy must say `authority: "consumer-declared"`; ASL supplies no metric, threshold, eligibility, or product defaults. `policy.history` is exactly `local-only`. ASL owns the definitions of the admitted aggregation modes while the consumer chooses either declared mode. Each policy declares at least three eligible historical runs, either `median` or `mean`, `warmup: "none"`, `outliers: "none"`, and explicit metric units, `lower-is-better` or `higher-is-better` direction, and non-negative absolute and relative tolerance. Relative tolerance is a unit-interval ratio applied to `abs(historicalValue)`. The effective tolerance is `max(absolute, relative * abs(historicalValue))`. Mean adds metric values in the declared canonical `orderedSamples` order starting from numeric zero, then divides by `N`. Median sorts the samples numerically; for even `N`, it is the arithmetic mean of the two middle values.

One exact scope governs the artifact: non-empty `scenarioId`, `comparisonLane`, and `platform`, exact SHA-256 `cohortHash`, and `lineage.status: "exact"` with the exact `scenarioHash`. Declared-compatible or legacy lineage is not admitted in V1. Eligibility, aggregation, current sample, and decision are separate sections. The current run is eligibility-checked and recorded as `currentSample`, but it is never a member of `historicalPopulation` or `orderedSamples`. Historical samples preserve their declared order and each included, excluded, aggregated, and current record retains run id, completion time, run-relative artifact path, and SHA-256 provenance. Absolute and traversing source paths are invalid public provenance.

Eligibility fails closed through the closed reasons `missing-evidence`, `partial-evidence`, `non-finite-sample`, `incompatible-evidence`, `untrusted-health`, `retry-attempt`, `identity-mismatch`, `lineage-mismatch`, `stale-clock`, `invalid-clock`, and `native-not-ready`. Reasons form an unordered set: each reason must be unique, and array order has no semantic meaning when current eligibility and current-sample reasons are compared. Aggregation is `computed`, `insufficient-evidence`, or `not-comparable`; non-finite sample and result values are invalid. Directional metric rows require `historicalValue`, `currentValue`, `delta`, and `percentChange`. `delta` is `currentValue - historicalValue`; `percentChange` is `delta / abs(historicalValue) * 100`. Historical `+0` and `-0` both require `null`. Every finite nonzero historical value is used as the denominator without clamping; if that computation is non-finite, the artifact fails closed because public numeric results must remain finite. Apply tolerance before direction: a delta within the effective tolerance is `unchanged`; outside tolerance, a negative delta improves `lower-is-better` and a positive delta improves `higher-is-better`. No-decision metric rows are `insufficient-evidence` or `not-comparable` and must not carry directional operands.

Aggregate decision reduction is deterministic. All unchanged metrics reduce to `unchanged`. At least one regression and no improvement reduces to `regressed`; at least one improvement and no regression reduces to `improved`; both reduce to `mixed`. A required `not-comparable` metric blocks every directional aggregate claim as `not-comparable`. Otherwise, any required `insufficient-evidence` metric blocks it as `insufficient-evidence`.

JSON Schema validates the closed structural representation, but cannot prove equality across repeated records. Consumers must call `validateHistoricalEvaluationArtifact()` before accepting an artifact. The pure validator rejects the current run in any historical list, included/sample provenance disagreement, count drift, computed populations below the declared minimum, duplicate or non-contiguous order, aggregation arithmetic drift, decision operand drift, tolerance/direction drift, and invalid aggregate reduction. Derived finite floating-point values may differ by at most eight adjacent IEEE-754 binary64 representable values without crossing zero or changing sign. The validator treats `-0` and `+0` as the same explicit zero value. No nonzero value, including `Number.MIN_VALUE`, compares equivalent to zero or to an opposite-sign value; same-sign subnormal values retain their individual adjacent ranks, and non-finite values never compare equivalent. This validator-only allowance accepts redundant producer encodings of canonical aggregation, delta, and percent values; canonical recomputation from `orderedSamples` remains authoritative for every decision operand, delta, percent, tolerance, direction, and status check. The allowance is product-neutral numerical validation and never reuses or changes the consumer's declared metric tolerance. Integer counts, order, identities, statuses, and provenance remain exact. `HistoricalEvaluationArtifact` aliases the explicitly named `UnvalidatedHistoricalEvaluationArtifact` structural input. Only a successful validator result exposes the branded `ValidatedHistoricalEvaluationArtifact`; TypeScript assignment alone does not prove finite numbers, hashes, paths, timestamps, minimum counts, or cross-record integrity.

Native history is optional and remains separate. A consumer-declared `nativeHistory` policy uses the same top-level exact scope and requires a paired `nativeEvaluation`; its eligibility, aggregation, current sample, and decision do not merge into the ordinary metric decision. Ordinary and native current-sample provenance must identify the same `runId` and `endedAt`, and that shared current run is excluded from both historical populations and both ordered-sample lists. An `insufficient-evidence` or `not-comparable` result is evidence only. V1 defines no exit-code effect, verdict change, or release gate, and the strict schema rejects fields that attempt to add those semantics.

Native performance evidence can also declare `claimSufficiency`. Use `sufficient-for-diagnosis` when partial frame, memory, trace, or render evidence can explain a run but should not drive a product or release claim. Use `insufficient-for-claim` when useful native evidence survived but a required surface, comparable baseline, complete trace window, or target binding is missing. Use `unknown` only when a provider preserves native evidence but cannot classify sufficiency yet. ASL accepts those diagnostic states without pretending the evidence is release-ready. A declared `claimSufficiency.status: "sufficient-for-comparison"` is only one input to comparison readiness; the shared classifier also requires current artifact identity, complete evidence, an explicit comparable policy, real capture time and clock metadata, a durable captured source, recognized numeric native-performance measurements rather than timestamp or window metadata, a consistent bounded lifecycle or trace window, and durable observed target proof matching the declared app and device.

The native-performance helper functions preserve explicit provider claim classifications instead of replacing them with helper defaults. That lets a provider attach useful native diagnostics while still marking a missing required output, ambiguous target binding, or non-comparable capture window as claim-blocking. App and device ids identify the requested target but do not verify it by themselves. `classifyNativePerformanceComparisonReadiness()` is the semantic interpretation boundary after structural schema validation: caller context resolves current identity, durable run-relative paths, durable JSON reads, and SHA-256 reads for run-contained artifacts without moving filesystem or platform-tool ownership into the helper. The classifier uses those hashes to prove that target-binding command records, staged raw capture artifacts, the bound `target-binding.json` attachment, and the runner-owned `raw/runner-active-loop-window.json` record still match exact bytes at interpretation time. It returns `diagnostic-only` with missing-evidence reasons when a provider self-attests readiness without measurable samples, consistent capture bounds, or durable observed matching target proof. The runner uses that classification when deciding whether required native-performance evidence was actually satisfied, while preserving the provider artifact for diagnosis.

`diagnosticSources` is the source inventory for native-performance lanes. Each source records a product-neutral `sourceId`, status, optional tool metadata, data classes, and the next action when it is missing or unverified. Android providers should distinguish sources such as `gfxinfo`, `framestats`, `meminfo`, `perfetto`, `trace-processor`, and `logcat-render`. iOS providers should distinguish `instruments`, `xctrace`, `metrickit`, `simctl`, and any project-local `native-trace` source. A scaffolded source inventory is not claim-ready evidence by itself; statuses such as `unverified`, `not-requested`, `unsupported`, `failed`, `timeout`, `partial`, and `available-unproven` keep agents from treating a listed source as fully captured. Use `captured` only when the source produced artifacts or structured metrics, and use `unknown` only when a provider can preserve the inventory but cannot classify the source outcome yet.

When a failed provider command preserves native-performance evidence, the `partial_provider_evidence_preserved` health check includes native-performance claim context when it can read the validated JSON attachment. `nativePerformanceClaimSufficiency`, `nativePerformanceClaimSufficiencyDetails`, `nativePerformanceCompletenessStatus`, `nativePerformanceComparability`, `nativePerformanceTargetBinding`, and `nativePerformanceDiagnosticSources` summarize the evidence envelope so `agent-summary.md` can route the next action without treating partial native diagnostics as product-performance proof. Claim-sufficiency details preserve compact `claim`, `reason`, `nextAction`, missing-evidence, and supporting-evidence fields from the native-performance evidence so aggregate readers can see why a claim is only diagnostic or comparison-ready without opening the provider JSON first.

Evidence folders:

- `raw/`
- `captures/`
- optional `signals/js`
- optional `signals/memory`
- optional `signals/network`

The artifact contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, `comparison.json` records before/after baseline comparison, and `agent-summary.md` gives agents the health gate before they touch code.

Ordinary budget comparison and native-performance comparison remain distinct truths. Native regressions participate in `asl-compare --fail-on-regression`, `asl-compare-latest --fail-on-regression`, and live-proof effective regression truth. Native `not-comparable` does not. Native budget status is reported per metric but does not by itself turn a run into an ordinary verdict failure.

Failed or warning health checks may include scalar `metadata.nextActionCode` and `metadata.nextAction` fields. These are stable, agent-readable recovery hints for runner setup failures such as missing adb, an unbooted simulator, an uninstalled app package, or an unresolved selector. Host-bound availability checks may also include `metadata.failureClass` values such as `host_access`, `timeout`, `missing_binary`, or `command_surface` so agents can distinguish sandbox or daemon access from a broken runner command. Android dev-client startup readiness checks may use `dev_client_reload_limbo` with next action `restart_metro_and_reload_dev_client` when ready-log evidence shows Metro bundle loading is still in progress, or `dev_client_host_mismatch` with next action `fix_android_dev_client_metro_host` when the app logs show a loopback Metro websocket attempt after ASL opened a device-routable dev-client URL. iOS target-foreground checks may use `dev_client_foreground_mismatch` with next action `reload_ios_dev_client_url` when the runner opened a dev-client URL but the target bundle did not own the foreground surface after capture. iOS profile-session start waits may use `dev_client_not_foreground`, `dev_client_shell_foreground_no_js_app`, or `profile_command_channel_missing` when foreground evidence distinguishes the failed readiness boundary; they fall back to `dev_client_bundle_or_command_channel_not_ready` when ASL opened a dev-client URL but cannot sharpen the foreground or command-channel owner. When ASL reopens a configured iOS development-client URL during readiness repair, artifacts record `ios_dev_client_readiness_repair_opened`, the retry raw path, and `profileSessionStartRepair` metadata. The generated `agent-summary.md` renders the stable scalar context for these checks, including command count, dev-client deep-link status, foreground probe status, foreground ownership, last deep-link label, profile-session seed status, pending phase, expected evidence, and raw diagnostic paths. iOS simctl sidecar liveness failures may use `ios_simctl_runner_liveness_timeout` with next action `inspect_ios_simctl_runner_timeout` when the capture body exceeded its whole-capture watchdog after publication started; those checks include scalar pending-phase and watchdog-budget metadata so agents can see the last runner phase without opening raw JSON first. When a runner classifies a readiness failure from a known log signature, `metadata.evidencePattern` names that signature without replacing the raw artifact. The summary builder renders those hints in `agent-summary.md`, but they do not make timing evidence trustworthy unless scenario health passes.

When profile-session commands reach terminal status, app-owned truth event counts are available, but truth still fails iteration completeness, the `truth_events_incomplete` health check records `nextActionCode: "inspect_truth_iteration_mapping"` with completed command counts. That classification means command transport was alive, but the app truth, scenario milestone names, command sequence or iteration metadata, or cycle-body contract needs inspection before any product timing claim is trusted.

When a provider command fails after writing some declared outputs, ASL keeps the captured diagnostics in the manifest and emits `partial_provider_evidence_preserved` as a warning health check. Its metadata lists `capturedKinds`, `capturedPaths`, `diagnosticOnlyKinds`, and, when applicable, `failedRequiredKinds`/`blockingRequiredKinds` so agents can see which useful diagnostics survived and which required surfaces still block a claim. The same check records `claimSufficiency` as `sufficient-for-diagnosis` or `insufficient-for-claim`; neither state makes unhealthy timing evidence trustworthy. For readers that inspect `health.json` before the manifest, the warning also records per-kind sufficiency pairs such as `capturedDiagnosticSufficiency: "nativePerformance:diagnostic-only"` and `blockingDiagnosticSufficiency: "accessibility:provider-blocked"` when those statuses are available. The warning includes `nextActionCode`, `nextAction`, and `nextActionOwner: "provider_tooling"` so aggregate live-proof readers can roll provider-evidence follow-up without treating preserved diagnostics as release-ready proof. `agent-summary.md` renders those pairs in the preserved diagnostic evidence section when present. Each manifest diagnostic also carries its own `sufficiency` interpretation, so a mixed run can show a required missing output, optional preserved evidence, diagnostic-only native performance, provider-blocked output, unsupported output, and a required diagnostic that was satisfied without relying on aggregate metadata. When an adb sidecar capture fails after preserving logcat, screenshot, or profile-session artifacts, ASL records `partial_sidecar_evidence_preserved` instead. If the adb sidecar failed health but preserved a usable `raw/adb-logcat.txt`, Android profile runs still publish final profile artifacts from that log and add an `android_adb_sidecar_health` warning. That warning uses `android_adb_sidecar_output_limit_profile_published` when the driver hit its output buffer and includes `outputLimitExceeded`/`maxBufferBytes` in sidecar metadata. Older or externally produced sidecars can lack that explicit driver flag; exact historical buffer-sized raw files are then listed under `possibleOutputCapRawPaths` with `possibleOutputCapBytes`, which is a diagnostic hint rather than a product verdict. Agent summaries index preserved or degraded diagnostic classifications separately from failed checks so agents can use them for diagnosis without treating the run as a product claim. Those outputs are diagnostic-only until missing required outputs are fixed and health passes.

Profile runs that ingest adb or simctl sidecar artifacts verify runtime identity when the profile command supplies an expected package, bundle, serial, or concrete simulator UDID, or when project config supplies a non-placeholder app id. A proven sidecar package, bundle, or target mismatch fails health with `runtime_identity_mismatch` before timing evidence is trusted. If the selected sidecar lacks metadata that can prove identity, health fails with `runtime_identity_unverified` instead of letting agents optimize from a run whose app or target cannot be proven.

Profile-session helper evidence carries `helperVersion` and, for command-bearing
session evidence, helper payload identity fields. The cadence state, fail-fast
queue policy, and observed settle telemetry require helper version `1.1.0` plus
the expected payload id/hash for the command behavior the runner released. When
profile events or session entries prove a missing or mismatched helper version,
profile health fails with `profile_session_helper_version_missing` or
`profile_session_helper_version_mismatch`. When command-bearing session evidence
proves a same-version stale payload id/hash, profile health fails with
`profile_session_helper_identity_mismatch` so agents do not optimize from stale
app-helper behavior that merely shares the same version string. Command-bearing
session evidence that lacks helper payload identity fails health with
`profile_session_helper_identity_missing`; command, cadence, and truth evidence
are not accepted from an unverifiable helper payload. The helper payload hash is
a helper-emitted semantic contract digest, not a host-side byte attestation of
the Metro bundle.

The current profile runner writes health, verdict, agent summary, metrics, causal-run, and budget-verdict artifacts.

## Quick-proof setup contract

`coordinateQuickProof()` is a runner-neutral setup boundary for small or
time-sensitive proof work. It accepts explicit setup and total budgets plus a
minimum product-budget ratio. Product work cannot begin after the setup deadline
or when doing so would consume the reserved product share. Each adapter path can
receive one initial attempt and one retry. Paths are considered in
`trusted-automated`, `degraded-direct`, then `manual-assisted` order while
preserving caller order inside each tier. Fallback is forbidden after any
product action starts. Every phase is raced against the remaining deadline and
receives an abort signal. The product adapter context requires the mutable
boundary callback, and the adapter must await `beginProductAction()` immediately
before its first product action;
that successful boundary remains authoritative if
the adapter subsequently throws or returns malformed output.

Capabilities are matched by operation and required argument. Tool-wide support
does not satisfy a missing operation argument. Read-only discovery may report an
identity as `unresolved-until-observed`; preflight must resolve every required
identity and prove any expected value before product execution. Authorization is
a credential-free, expiring grant scoped to the goal, operations, optional
target, and delegation chain. Required resources must be returned by the caller's
lease port as an exact trusted match. The coordinator passes that grant and lease
to the selected adapter but does not replace the durable resource lease contract.
Authorization and lease identity/lifetime are revalidated immediately before
the mutable boundary. Acquired leases are released during cleanup even when
their trust validation fails. A lease port must synchronously call
`registerAcquiredLease()` when it establishes ownership, before later async work,
so a timed-out acquisition can still be released. Product execution that throws
or returns malformed output before the boundary leaves product-start state
unknown and blocks retry or fallback.

`quick-proof.json` records phase accounting, adapter attempts, identity state,
exact source/package identity, authorization and lease summaries, cleanup, time to first product action, proof
tier, and the final coordination decision. `setup-only` means no product action
started. It cannot contain a product result and must not be interpreted as
scenario health, a product verdict, performance evidence, or release acceptance.
The matching summary repeats that boundary. `product-executed` only records that
mutation was confirmed, either with exact mutable-boundary timing or as failed
`observed-late` evidence; normal scenario health and verdict artifacts remain
authoritative for product interpretation.
If an adapter reports mutation without passing `beginProductAction()`, the
artifact fails product execution with `timingStatus: observed-late`; exact setup
duration and time to first product action remain null rather than being inferred.
This remains product-failed evidence when mutable-boundary authorization was
revoked, and retains that denied authorization truth instead of rewriting the
mutation as setup-only evidence. Public identifiers, requirements, adapter
surfaces, and optional resources are validated before any adapter phase;
malformed values are caller contract errors rather than setup evidence.
If an adapter times out, throws, or returns malformed output before the mutable boundary
and ASL cannot prove whether mutation occurred, the artifact is `inconclusive`
with `product.started: "unknown"`, null setup timing, and no proof tier. That
state blocks retry and fallback and must not be interpreted as setup-only or
product-executed evidence.
The same inconclusive rule applies when mutable-boundary validation passes but
the adapter does not confirm `productActionStarted: true`: authorization and
lease validation are not themselves mutation proof. Attempt-scoped
`identityObservations` preserve discovery and preflight identity truth across
retries and fallback while `identities` records the final selected attempt
state.
Each observation contains only identity evidence returned by that exact adapter
phase after coordinator interpretation; it is not a snapshot copied from an
earlier phase. Timed-out lease acquisition that does not settle during bounded
cleanup fails cleanup closed while retaining an automatic release guard for any
late registration.

Scenario milestone budgets remain optional outside the quick-proof contract,
whose setup and total budgets are required coordinator inputs.

Milestone budget interval semantics are explicit:

- `toMilestone` without `fromMilestone` measures elapsed time from the run or session clock origin to the matching milestone occurrence.
- `fromMilestone` plus `toMilestone` measures the interval between the two app-owned truth events for each iteration.
- repeated transition, gesture, open, close, scroll, or handoff budgets should use both milestones when the intended number is transition duration rather than cumulative elapsed time.
- when repeated interval events do not carry explicit `iteration` fields, ASL associates ordered `fromMilestone`/`toMilestone` pairs with the next expected iteration. Apps may still emit `iteration` to make the pairing explicit.

This distinction is visible in `metrics.json`: elapsed milestone-only runs populate `durationsMs` with milestone timestamps, while interval runs populate `durationsMs` with `to - from` values. Timing still remains untrusted unless `health.json` passes.

When a configured latency budget has no measurable samples, ASL reports the budget evaluation as `partial` and marks that check `unmeasurable` instead of treating it as product-performance failure. This keeps claim gating strict: the run did not pass all configured budgets, but agents must not optimize from a latency number ASL never measured. Use explicit `fromMilestone`/`toMilestone` interval budgets for command-to-completion or transition-latency claims.

`buildRunIndex()` can scan an artifact root after runs complete. It indexes folders that contain both `health.json` and `verdict.json`, marks a run trusted only when health and verdict both passed, and lets agents find the latest trusted prior run for a scenario without relying on terminal history.

`runner/resource-lease.ts` publishes lease files with same-directory hard links (`link(temp, leasePath)`) so acquisition stays atomic on one filesystem boundary. If hard-link publication fails before ownership is established, acquisition is fail-closed and no lease is claimed. If directory sync fails after publication, acquisition remains visible as acquired-but-untrusted and `runWithResourceLease()` skips protected callback work, attempts a matching release, and returns `acquisition-untrusted` evidence. Lease operations coordinate through one atomically acquired operation-guard file; active guard contention and orphaned guard discovery are explicit outcomes, and stale guards are never force-broken automatically. Heartbeat writes a complete synced replacement to a temp path and atomically renames it into place under that guard, so write/sync/prepublication failures leave the prior lease record recoverable. Lease inspection is conservative by design: pid liveness probes only classify local-host pids and remote-host records remain `unknown` instead of being treated as dead owners. Stale or malformed records are reported, not auto-taken over; manual stale recovery must use matching-token `releaseResourceLease()` and then a fresh `acquireResourceLease()`. Release atomically detaches the current candidate to a unique tombstone path before lease-id verification; mismatched detached candidates are restored without overwrite when possible or preserved at an explicit path/result and are never silently deleted. Release results also preserve directory-sync durability evidence (`durability: synced|sync-failed`) and cleanup visibility so callers can distinguish clean cleanup from post-unlink durability risk. Actors that ignore this protocol remain outside the advisory lease guarantee.

Canonical resource identities are product-neutral and deterministic: `mobile-target:<platform>:<encoded-target>`, `tcp-port:<encoded-lowercase-host>:<port>`, and `provider:<encoded-provider>[:<encoded-target>]`. `resolveResourceLeasePath()` hashes the complete resource identity into a lease filename so host paths do not need to expose target or provider identifiers. Generic Android and iOS live proofs acquire only the exact target selected by successful read-only preflight. They heartbeat during mutable profile and sidecar work, release after success or failure, and preserve a host-local, path-scrubbed lifecycle journal at `raw/resource-lease.json` under the preflight artifact. Untrusted acquisition skips mutable work; heartbeat ownership loss and untrusted release fail the live command. TCP-port and provider identities are exported for explicit owners, but consuming an endpoint or selecting a provider does not itself declare exclusive ownership.

## Supported Runner Surface

The package currently supports:

- scenario/runner compatibility planning through `check-plan`
- fixture profile loops through committed profile-event logs
- Android adb readiness checks
- Android bounded logcat capture
- Android package launch plus bounded logcat capture
- Android adb driver adapter with scenario-routed `tap`, `longPress`, `pressKey`, `scroll`, `swipe`, `assertVisible`, `inspectTree`, `screenshot`, `record`, and `readLogs`
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
