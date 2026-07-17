# Live Proofs

Use this page when you want to move from contract validation into runtime evidence.

The goal of a live proof is not just to see a command pass. The goal is to preserve scenario health, verdicts, raw evidence, metrics, summaries, and comparison context in the standard artifact layout.

## Fixture Loop

Use the fixture loop when no simulator or device is available:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The command runs preflight, profiles baseline/current event logs, writes run artifacts, compares the current run against the latest trusted prior run, and refreshes the current run's `agent-summary.md`.

It writes:

- `preflight/app-startup/health.json`
- `preflight/app-startup/verdict.json`
- `preflight/app-startup/agent-summary.md`
- `profile-runs/app-startup/demo-baseline/*`
- `profile-runs/app-startup/demo-current/*`
- `profile-runs/app-startup/demo-current/comparison.json`

This is not a replacement for live device proof. It is a stable contract check that keeps the evidence loop reproducible through trusted prior-run selection while iOS or Android runtime setup is unavailable.

## Plan Check

Use `check-plan` to validate a scenario, runner manifest, and optional evidence-provider manifests before execution:

```bash
pnpm check-plan -- --scenario examples/scenarios/mobile/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

This validates the input manifests, writes schema-checked `health.json` and `verdict.json`, writes `agent-summary.md`, and includes the raw planner match in `planner-compatibility.json`.

Live profile wrappers also run this compatibility check before adb, simctl, agent-device, or provider capture starts. A compatible run writes `planner-compatibility.json` as the first profile artifact, then continues into the platform capture. An incompatible run writes failed `health.json`, inconclusive `verdict.json`, `agent-summary.md`, and the planner artifact in the profile run folder, then exits before touching the device runtime. This keeps missing required diagnostics, unsupported platforms, and impossible runner/provider plans out of the long capture loop.

## Host/Device Access

Keep deterministic validation and live device proof as separate execution lanes.

These commands are sandbox-safe because they use committed fixtures, generated temporary apps, package metadata, or explicit artifact files:

- `pnpm test`
- `pnpm release:check`
- `pnpm package:smoke`
- `pnpm consumer:rehearse`
- `pnpm demo:loop`
- `asl-check-plan`
- profile commands that read `--events`
- `asl-live-proof`

These commands are host/device lanes and should run with access to the local device driver state from the first attempt:

- `asl-host-doctor`
- `asl-android-adb`, `asl-profile-android --adb-capture`, and `asl-live-android`
- `asl-ios-simctl`, `asl-profile-ios --simctl-capture`, and `asl-live-ios`
- `asl-agent-device` and aggregate proofs with `--agent-device-proof`
- `asl-argent` and aggregate proofs with `--argent-proof`
- example app install/build/start commands that touch emulators, simulators, Metro, or native build tools

If a live command cannot reach adb, CoreSimulator, `agent-device`, Argent, a simulator, an emulator, or a required local app service, classify the result as runner environment health. Do not call it an app regression or a scenario failure until the platform preflight and scenario health have passed. The runners write failed health artifacts and `nextAction` values for this case so agents can preserve the evidence trail while rerunning the same command with the right host/device access. Aggregate live-proof artifacts include a `nextAction.owner` field when ASL writes them, so agents can tell whether the next bounded action belongs to runtime environment setup, app truth, provider tooling, the ASL runner, scenario contract work, or product optimization.

For repeated local work, prefer narrow, reusable permissions for the exact package scripts you run often instead of one-off retries after expected preflight failures. Keep Metro on an isolated port for the proof app, use direct installed binaries when available, and keep bounded command timeouts on wrapper-based tools such as `npx`-launched Argent.

When a live proof validates a freshly installed local ASL tarball inside a downstream Expo or React Native app, restart Metro from that downstream app root before launching the dev client. Otherwise the native shell can load a stale JS bundle even though `node_modules` points at the candidate package.

Put machine-specific runner settings in an ignored `.asl.local.env` file at the app or repo root instead of repeating inline environment variables in every command. ASL CLIs load the nearest `.asl.local.env` without overriding already-exported values, so CI and explicit shell overrides still win. Typical local values include:

```sh
ASL_HOST_DOCTOR_REQUIRE=android,ios,agent-device,argent
ASL_HOST_DOCTOR_TCP_PORTS=localhost:8081
ASL_HOST_DOCTOR_MIN_FREE_DISK=artifacts/asl:1024
ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES=perfetto:perfetto,xctrace:xctrace record
ASL_HOST_DOCTOR_ORPHAN_PROCESSES=trace:trace_processor
ASL_HOST_DOCTOR_LEASES=android:artifacts/asl/leases/android.json,ios:artifacts/asl/leases/ios.json
ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android
ASL_ANDROID_AGENT_DEVICE_SESSION=android-example
ASL_IOS_AGENT_DEVICE_SESSION=default
ASL_ARGENT_BIN=pnpm
ASL_ARGENT_BASE_ARGS="dlx @swmansion/argent run"
ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK=1
```

Before a live proof, run the host doctor for the lanes you intend to use:

```bash
asl-host-doctor --require android,ios --out artifacts/asl/host-doctor
asl-host-doctor --tcp-port localhost:8081 --out artifacts/asl/host-doctor
asl-host-doctor --min-free-disk artifacts/asl:1024 --out artifacts/asl/host-doctor
asl-host-doctor --exclusive-process "perfetto:perfetto,xctrace:xctrace record" --out artifacts/asl/host-doctor
asl-host-doctor --orphan-process trace:trace_processor --out artifacts/asl/host-doctor
asl-host-doctor --lease android:artifacts/asl/leases/android.json --out artifacts/asl/host-doctor

ASL_ARGENT_BIN=pnpm \
  ASL_ARGENT_BASE_ARGS="dlx @swmansion/argent run" \
  asl-host-doctor \
  --require android,ios,agent-device,argent \
  --agent-device-require-platforms ios,android \
  --out artifacts/asl/host-doctor
```

The doctor composes the existing adb, simctl, agent-device, Argent, optional TCP service checks, optional artifact disk-capacity checks, optional exclusive process checks, optional stale-process checks, and optional durable lease-record checks into one ASL artifact set. Use `--tcp-port <host:port>` or `ASL_HOST_DOCTOR_TCP_PORTS` for required local services such as Metro or a dev-server debug host. Use `--min-free-disk <path:mb>` or `ASL_HOST_DOCTOR_MIN_FREE_DISK` before trace-heavy, video, or native-diagnostics proof that can fill the artifact root. Use `--exclusive-process <label:pattern>` or `ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES` when a profiler, recorder, or native trace lane must own the host resource alone; the matcher ignores only the exact configured `label:pattern` text when it appears as host-doctor configuration via `--exclusive-process` or `ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES`, and still reports genuine matching commands. Use `--orphan-process <label:pattern>` or `ASL_HOST_DOCTOR_ORPHAN_PROCESSES` on POSIX hosts to report leftover tool processes such as trace processors, profilers, or device tool servers before a new proof starts. The orphan-process pattern is a literal process-command substring, not a regular expression, and ASL never kills matching processes. Use `--lease <label:path>` or `ASL_HOST_DOCTOR_LEASES` when shared devices, simulators, or provider sessions have durable owner files; ASL reports active, missing, expired, malformed, and unreadable lease records but does not acquire or delete them. A failed doctor is environment evidence, not product evidence: fix the host access, command shape, missing local service, conflicting or stale process, artifact storage, or active lease before starting scenario execution.

## Platform Preflight and Profile Capture

Use `android:preflight` to verify adb and connected-device readiness before adding live Android scenario execution:

```bash
pnpm android:preflight -- --package com.example.app --out artifacts/android-adb-preflight
```

The command writes `health.json`, `verdict.json`, `agent-summary.md`, `raw/adb-version.txt`, `raw/adb-devices.txt`, and `raw/android-metadata.json`. If adb, a connected online device, or an optional package check fails, health fails and the verdict remains `inconclusive`.

Add `--capture-logcat --logcat-lines <count>` to write `raw/adb-logcat.txt` in the same artifact folder. Add `--react-native-debug-host <host:port>` with `--package <name>` for React Native development builds that need adb reverse plus the app `debug_http_host` preference before launch; the runner writes `raw/adb-react-native-reverse.txt` and `raw/adb-react-native-debug-host.txt`. Add `--clear-logcat --launch --wait-ms <ms>` with `--package <name>` to clear logs, launch the package, wait for a bounded capture window, and then collect logcat evidence. If requested capture-window setup or logcat capture fails, scenario health fails because timing and event evidence would be incomplete.

Use captured logcat evidence directly with Android profiling:

```bash
pnpm profile:android -- --config core/config-template.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-artifacts artifacts/android-adb-preflight --run-id android-run-1
```

Or let Android profiling own the adb capture window before it writes profile artifacts:

```bash
pnpm profile:android -- --config core/config-template.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-capture --react-native-debug-host localhost:8097 --clear-logcat --launch --run-id android-run-1
```

Use `profile:ios --simctl-capture` when the example app or a consuming app is already installed on a booted simulator:

```bash
pnpm profile:ios -- --config core/config-template.json --scenario examples/mobile-app/scenarios/ios/app-startup.json --simctl-capture --profile-session --profile-session-storage --launch --run-id ios-run-1
```

The command writes a separate simctl capture folder under the selected output root, immediately publishes `raw/ios-simctl-capture-started.json`, seeds the app-owned profile session into native AsyncStorage before launch, then collects stored app profile events after the capture window. Command scenarios seed the scenario command queue through the same storage contract before launch. Command envelopes preserve `commandId`, `sequence`, `queueId`, command pacing `waitMs`, setup prerequisites in `dependsOnMilestones`, and, for normalized execution-plan commands followed by a milestone wait, `waitForMilestone` plus `waitTimeoutMs`. Deep-link command transport uses the same envelope in query parameters except for storage-only setup prerequisites. Default xcrun/simctl subprocesses are bounded by `--command-timeout-ms` so simulator access failures can finalize health artifacts instead of leaving only planner output. When `raw/ios-profile-events.log` exists, the iOS profile runner ingests that stored truth-event log; otherwise it falls back to `raw/ios-simctl-log.txt`.

If the selected runner also receives `--provider <manifest>`, live adb/simctl capture now schedules provider `startWindow` before the active capture loop, `stopWindow` immediately after it, `afterCapture` only after raw run evidence is staged, and `finalize` for cleanup. Rehydrated `--adb-artifacts`, `--simctl-artifacts`, and fixture/event-log runs stay post-capture-only and fail closed for live-window phases instead of pretending the provider trace overlapped the measured interaction window. Control-only provider phases may declare `outputs: []`; any declared output must be freshly written during that command or ASL rejects it as stale evidence.

Profile manifests only list sidecar paths that were copied into the profile run or deliberately referenced as external sidecar evidence. If a simctl or adb capture folder is the real evidence source, `manifest.artifacts.diagnostics` records the diagnostic status plus `sidecarRoot`/`evidenceDependency` instead of inventing profile-root files such as `raw/device.log`, `captures/run.mp4`, or `captures/ui-tree.json`. Rehydrated runs may record `evidenceDependency.root: "sidecar"` with paths relative to `sidecarRoot`, so agents do not have to reason from long `../../` paths alone.

Android adb capture health can fail even when the sidecar preserved a usable
`raw/adb-logcat.txt`. In that case the Android profile runner still publishes
final profile artifacts from the preserved log and records
`android_adb_sidecar_health` as a warning in `health.json`. If the adb command
hit the configured output buffer, the warning code is
`android_adb_sidecar_output_limit_profile_published` and the sidecar driver
metadata records `outputLimitExceeded` plus `maxBufferBytes`. When a legacy or
external sidecar preserves exact buffer-sized raw files without that explicit
driver flag, the profile warning records `possibleOutputCapRawPaths` instead.
Treat the final profile health, verdict, metrics, and causal timeline as the
interpretation surface, and treat the failed sidecar checks as diagnostic
context for the next capture.

When a scenario requests a screenshot, pass supported simulator screenshot options through the iOS capture command with `--screenshot-type`, `--screenshot-display`, or `--screenshot-mask`; ASL records the chosen options in capture metadata and the resulting path in `manifest.artifacts.captures.screenshots`.

For profile-session capture on Android or iOS, omitting `--wait-ms` lets ASL derive the final evidence window from scenario execution waits and cycle count. Command-backed profile sessions use the expanded command queue, including setup commands, repeated cycle body commands, resolved scenario cadence or command pacing `waitMs`, milestone-gate `waitTimeoutMs`, and a conservative buffer. Explicit `--wait-ms` remains authoritative when a consuming app has a known startup or logging delay that the scenario cannot express.

On Android storage-backed runs, the adb sidecar may record an early
`profileSessionCompletionWait` timeout before the final profile artifact has
parsed all same-run app-owned profile-session records. When final profile
evidence proves the command queue reached terminal status, profile health adds
`android_profile_session_sidecar_observation` with
`android_profile_session_completion_reconciled_from_profile_evidence`. When the
trusted final profile saw every expected same-run command delivered but not
terminal before the early sidecar wait exhausted, the code is
`android_profile_session_delivery_reconciled_from_profile_evidence`. Treat the
profile health, verdict, metrics, and causal timeline as the interpretation
surface while preserving the sidecar wait metadata as early-capture diagnostic
context.

Scenario command targets live in `adapterOptions.iosSimctl.commands`, while the app handles them through `registerProfileCommandTargetHandler`. The iOS proof does not depend on unified logs carrying JavaScript console output; it depends on app-owned stored profile events.

Attach independently produced provider evidence with `--signal <js|memory|network>[@redacted|@not-redacted|@unknown]:<path>` or `--capture <screenshot|video|uiTree>[@redacted|@not-redacted|@unknown]:<path>` so profile commands copy those files into stable run folders and inventory them in `manifest.artifacts.evidenceAttachments`. Omit the redaction suffix unless the operator owns that privacy declaration.

An iOS scenario that requests the portable `record` action or `video` artifact starts a bounded `simctl` simulator recording around the active capture window. ASL stops and finalizes the recorder before publishing artifacts, captures recorder stdout/stderr plus exit signal metadata, validates MP4/QuickTime `ftyp` brands, and includes `captures.video` only when that validated file exists. Start failures, cancellation, finalization timeouts, and invalid output fail or partially degrade simctl sidecar health while preserving useful raw recorder diagnostics.

## Generic Mobile Proof

Use the generic live runners in a consuming app after `asl-init` has created `asl.config.json`, `scenarios/mobile/<id>.json`, and the `asl:*` package-script snippets:

```bash
asl-live-android \
  --config asl.config.json \
  --scenario scenarios/mobile/app-startup.json \
  --package dev.example.app \
  --serial <emulator-serial> \
  --out artifacts/asl/android-live \
  --compare-latest \
  --fail-on-regression

asl-live-ios \
  --config asl.config.json \
  --scenario scenarios/mobile/app-startup.json \
  --bundle dev.example.app \
  --device <simulator-udid> \
  --out artifacts/asl/ios-live \
  --compare-latest \
  --fail-on-regression
```

These commands run one portable scenario through the platform preflight, profile-session capture, profile artifact pipeline, optional sidecar interaction runners, optional latest-trusted comparison, and aggregate live-proof writer. The platform profile runner captures app-owned truth first; sidecars run afterward so a UI-driver session cannot interfere with the evidence-producing adb or simctl window.
When no trusted prior run exists, the comparison is recorded as skipped without failing the live proof. When a comparable prior run exists, `--fail-on-regression` makes an ordinary or trusted native-performance regression exit nonzero after artifacts are written. Native `not-comparable` evidence is preserved in `comparison.json` and live-proof summaries, but it does not trip the regression gate by itself.

Add sidecars when external drivers are available:

```bash
ASL_ARGENT_BIN=/path/to/argent \
  asl-live-android --config asl.config.json --scenario scenarios/mobile/app-startup.json \
  --package dev.example.app --serial <emulator-serial> --out artifacts/asl/android-live \
  --agent-device-proof --argent-proof --compare-latest --fail-on-regression

ASL_ARGENT_BIN=/path/to/argent \
  asl-live-ios --config asl.config.json --scenario scenarios/mobile/app-startup.json \
  --bundle dev.example.app --device <simulator-udid> --out artifacts/asl/ios-live \
  --agent-device-proof --argent-proof --compare-latest --fail-on-regression
```

The platform runner still owns profile evidence. `agent-device` and Argent contribute interaction proof pointers under the same aggregate `live-proof.json` only after the profile run has produced trusted artifacts. If the profile health or budget verdict fails, requested sidecars are recorded under `skippedInteractionProofs` with a recovery hint, and the aggregate command exits nonzero after writing `live-proof.json`. When the failed profile preserved partial provider evidence, skipped sidecar pointers also carry compact `profileGateDiagnostics` for captured versus blocking diagnostic sufficiency, unresolved requested diagnostic inventory, preserved provider-evidence next action, and native-performance claim context, including claim-sufficiency detail, completeness, and target-binding detail when available, so the aggregate entrypoint explains why sidecar proof was withheld without turning partial diagnostics into product-performance evidence. For iOS storage-backed profile-session start failures, skipped sidecar pointers may also carry `profileGateReadiness` with dev-client, foreground, seed, expected-evidence, and raw readiness path context from the failed profile health artifact. The aggregate artifact may also include top-level `profileGateReadiness` counts and derived readiness detail tags plus `profileGateReadinessNextActions` owner/code counts so a single-platform proof exposes no-command, deep-link, seed, foreground-target, and readiness follow-up ownership before proof-set aggregation. It may also include top-level `profileGateRequestedDiagnostics` and `profileGateProviderEvidenceNextActions` counts so requested-but-blocking provider diagnostics and provider-tooling follow-up are visible before proof-set aggregation. When profile runs attach native-performance evidence, the aggregate artifact may include `profileNativePerformance` counts for evidence envelopes, diagnostic source statuses, completeness, claim sufficiency, claim-sufficiency detail, comparability, target binding, and target-binding detail. Treat those counts as an index into the profile artifacts, not as a product-performance claim by themselves. Proof-set artifacts may roll provider-evidence next actions into failed-proof and profile-gate owner/code counts, making provider-tooling follow-up visible across platforms without upgrading partial diagnostics into release evidence. If a sidecar itself fails a required step, the aggregate command also fails after preserving that sidecar's raw output and `agent-summary.md`. Optional sidecar failures, such as a screenshot helper failing after a successful UI assertion, are preserved as interaction proof warnings so agents can report partial evidence without treating timing as suspect.

## Android Proof

With the neutral Expo example app installed on an online Android emulator or device, run:

```bash
pnpm example:app:android
pnpm example:android:live
```

The aggregate proof runs adb/package preflight plus the canonical startup, open-close, and scroll-settle scenarios. It writes a batch entrypoint under:

```text
artifacts/example-mobile-app/android/_live-proof/android-live-proof/agent-summary.md
```

The root example live scripts pass `--compare-latest --fail-on-regression` by default. Missing same-lane baselines are recorded as skipped comparison evidence; real regressions exit nonzero after artifacts are written. Use a run suffix when preserving before/after runs:

```bash
pnpm example:android:live -- --run-suffix before-change
pnpm example:android:live -- --run-suffix after-change
```

After dependency, native-build, or scenario-contract changes, use `--seed-baseline` to capture a trusted same-cohort baseline immediately before the measured run. The seeded profiles use `*-baseline` run ids, must pass health and verdict, and stay in the same comparison lane:

```bash
pnpm example:android:live -- --run-suffix release-check --seed-baseline
```

When latest-trusted comparison sees slower single-run timing but both baseline and current remain inside their budgets, ASL reports `low_confidence` instead of `regressed`. Treat that as a repeat-or-sample signal, not proof of product regression.

Read [Example Mobile App: Android Capture](../examples/mobile-app/README.md#android-capture) for Metro routing, adb permissions, individual scenario commands, selector behavior, and optional video capture.

Expo dev-client Android shells may need an explicit Metro deep link after the native app launches. Put that local URL in ignored env state, for example `ASL_EXAMPLE_ANDROID_DEV_CLIENT_URL=asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097`, so Android profile capture opens the correct app session before profile-session control. With storage-backed profile sessions, ASL waits for `Running "main"` by default before writing AsyncStorage. Set `ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_PATTERN` only when the app has a more precise readiness marker. If readiness fails, the runner reports an unhealthy startup gate and does not deliver stored commands or profile-session deep links.

If the ready-log artifact shows the dev client still loading or bundling JavaScript from Metro, ASL classifies the failure as `dev_client_reload_limbo` with next action `restart_metro_and_reload_dev_client`. If ASL opened a device-routable dev-client URL but the app logs show a loopback Metro websocket attempt, ASL classifies the failure as `dev_client_host_mismatch` with next action `fix_android_dev_client_metro_host`. Treat both as runtime-environment evidence: restart or retarget the dev-client session, rerun, and do not use the scenario for app truth or performance claims until startup readiness passes.

Apps using the ASL profile-session AsyncStorage bridge can opt into storage delivery with `--android-profile-session-storage`. The Android runner resolves the session `startedAt` from the selected device clock before writing AsyncStorage, so milestone timing stays device-relative instead of host-clock-relative. Storage-backed capture keeps a bootstrap grace period before the final logcat snapshot, and a missing or stale app-side profile-session start fails health before any product timing claim. Override the default storage keys with `ASL_ANDROID_PROFILE_SESSION_STORAGE_KEY` and `ASL_ANDROID_PROFILE_COMMAND_STORAGE_KEY` only when adopting an existing app-owned bridge.

## iOS Proof

With the neutral Expo example app installed on a booted iOS simulator and Metro connected, run:

```bash
pnpm example:app:ios:prebuild
pnpm example:app:start:isolated
pnpm example:app:ios
pnpm example:ios:live
```

The aggregate proof runs simctl preflight plus the canonical startup, open-close, and scroll-settle scenarios. It writes a batch entrypoint under:

```text
artifacts/example-mobile-app/ios/_live-proof/ios-live-proof/agent-summary.md
```

The root example live scripts pass `--compare-latest --fail-on-regression` by default. Use a run suffix the same way:

```bash
pnpm example:ios:live -- --run-suffix after-change
```

Use `--seed-baseline` for fresh release checks where no compatible trusted iOS baseline exists yet:

```bash
pnpm example:ios:live -- --run-suffix release-check --seed-baseline
```

The same `low_confidence` comparison policy applies to iOS seeded baselines, where simulator and dev-client startup timing can vary between adjacent runs while still satisfying product budgets.

Expo dev-client iOS shells may need an explicit Metro deep link after the native app launches. Put that local URL in ignored env state, for example `ASL_EXAMPLE_IOS_DEV_CLIENT_URL=asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097`, so iOS profile capture opens the correct app session before collecting evidence.

If the runner opened an iOS dev-client URL but `simctl appinfo` reports that the target bundle is not foreground-owned after capture, ASL classifies the failure as `dev_client_foreground_mismatch` with next action `reload_ios_dev_client_url`. The failed check records the opened dev-client URL label, URL, and run-relative raw output path when available. Treat that as runtime-environment evidence: restart Metro from the consuming app worktree if needed, reopen the dev-client URL, and rerun before trusting profile-session or screenshot evidence.

The default iOS live proof transport seeds profile-session control into simulator app storage. Use `--ios-profile-session-transport deeplink` when the app should receive profile-session start and command control through app URLs instead.

For storage-backed iOS live proofs, ASL waits briefly for same-run app evidence after seeding storage and opening the dev-client URL. Tune that readiness boundary with `--ios-profile-session-start-wait-ms` or `ASL_IOS_PROFILE_SESSION_START_WAIT_MS` when a consuming app needs a longer first-bundle startup window. If the first wait exhausts after ASL opened an iOS development-client URL, ASL may reopen that same configured URL once before final classification when the foreground evidence points at a dev-client launch surface rather than an app command-channel failure. The repair attempt is recorded in metadata and raw output as `ios_dev_client_readiness_repair_opened` and `raw/ios-dev-client-readiness-retry-1.txt`. If the final wait still exhausts, inspect the sidecar `ios_profile_session_start_wait` check before treating the run as product evidence. The check records the command count, whether ASL opened a dev-client URL, foreground ownership when appinfo is available, the expected app evidence, a `readinessDetail`, the pending runner phase, and a runtime-environment next action; `raw/ios-profile-session-readiness.json` carries the same context with storage keys and the last opened deep link. When ASL has enough evidence, the failure class distinguishes `dev_client_not_foreground`, `dev_client_shell_foreground_no_js_app`, and `profile_command_channel_missing`; unknown foreground evidence stays under `dev_client_bundle_or_command_channel_not_ready`. `dev_client_foreground_command_channel_missing` remains the readiness detail for a foreground-owned target bundle where same-run profile-session evidence never appeared. Aggregate live-proof and proof-set artifacts may preserve and roll up that readiness next action alongside readiness detail counts. When available, `raw/ios-profile-session-start-app-info.txt` preserves the foreground probe captured at the missing-start boundary.

If the whole iOS simctl capture watchdog fires, inspect the `ios_simctl_capture_liveness` check. Its metadata records the pending runner phase, phase details, watchdog budget, and any profile-session expectation that was active when the capture timed out. Derived watchdog budgets include declared capture waits, storage-backed profile-session start waits, and the possible development-client readiness repair wait so a normal declared wait window is not shorter than the watchdog that supervises it. `raw/ios-metadata.json` still contains the full phase object and collected raw artifact list for deeper diagnosis.

When an iOS app exits during the capture window, inspect `raw/ios-app-lifecycle-log.txt` first. If the host wrote a matching DiagnosticReports crash file in time, ASL also attaches it as `raw/ios-host-diagnostic-report-<bundle>.ips` and records the bounded search in `raw/ios-host-diagnostic-report-search.txt`.

Read [Example Mobile App: iOS Capture](../examples/mobile-app/README.md#ios-capture) for prebuild, Xcode selection, simulator permissions, stored profile events, and individual scenario commands.

## Sidecar Interaction Proof

When `agent-device` or Argent is available, the example aggregate proofs can attach interaction sidecars:

```bash
ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android pnpm agent-device:check
ASL_ARGENT_BIN=/path/to/argent pnpm argent:check
ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION=<name> pnpm example:android:live:agent-device -- --run-suffix after-change
ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION=<name> pnpm example:ios:live:agent-device -- --run-suffix after-change
pnpm example:android:live:argent -- --run-suffix after-change
pnpm example:ios:live:argent -- --run-suffix after-change
```

The `agent-device:check` and `argent:check` scripts pass `--out` and write availability `health.json`, `verdict.json`, `agent-summary.md`, and raw tool-surface JSON under `artifacts/agent-device-check` and `artifacts/argent-check`. Agent Device availability evidence includes the raw capability probe plus a normalized ASL capability and driver-action inventory when `capabilities --json` is available.

Use the combined runner scripts when you want every configured sidecar to contribute to the same aggregate proof:

```bash
ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION=<name> pnpm example:android:live:runners -- --run-suffix after-change
ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION=<name> pnpm example:ios:live:runners -- --run-suffix after-change
```

Run `pnpm agent-device:check` before using agent-device sidecars; set `ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android` when the local proof must confirm both booted OS targets. The check runs `agent-device session list --json`, writes active sessions and capability inventory into `raw/agent-device-availability.json`, and includes compact `agent_device_sessions` and ASL driver-action inventory lines in `agent-summary.md` when available. Capture runs write each Agent Device command transcript under `raw/` and inventory command results in `raw/agent-device-metadata.json`; when stdout or stderr contains a structured JSON result envelope, the metadata records its source, success flag, data keys, error code, message, hint, diagnostic id, stream byte counts, and compact previews. Use the raw transcript as the complete evidence claim and the metadata summary as an index for failed, timed-out, or partial-output sidecar commands. If the artifact shows a named session already owns the target device, pass `ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION` or `ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION` to the aggregate script, or pass `--agent-device-session <name>` directly after `--`. This defaults to `reuse`, where the session owns target selection. Set `ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION_MODE=bind` or `ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION_MODE=bind` when you want ASL to create or name the sidecar session while still forwarding the configured Android serial or iOS UDID; this avoids borrowing a default session that is bound to the wrong OS. For Argent, prefer a real `argent` executable on PATH, or set `ASL_ARGENT_BIN=/path/to/argent` when the package manager installed it somewhere else. `ASL_ARGENT_BIN=npx` with `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"` is supported as a wrapper shape, but run `pnpm argent:check` before relying on it because package-manager wrappers can be slower than direct binaries. Run `pnpm argent:check` first when you need a bounded tool-surface proof before attaching Argent to a device scenario. Both checks preserve artifacts via `--out`, so failed command-surface evidence can be inspected without relying on terminal scrollback. Direct iOS `asl-argent` runs can set `ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK=1` so simctl supplies screenshot evidence when Argent can launch and inspect the app but its iOS screenshot backend is unavailable. The platform runner still owns adb or simctl preflight and profile evidence, and sidecars run only after that profile evidence has passed health and budget gates. Each executed sidecar contributes interaction proof, captures, and warning summaries into the same aggregate artifact graph; skipped sidecars remain visible in the aggregate proof so agents know which runner evidence is missing and why.

## Platform Set Gate

After Android and iOS live proofs have both written aggregate artifacts, assert the platform set with one inspector command:

```bash
pnpm example:mobile:live-proof
```

For a consumer app scaffolded with `asl-init`, the equivalent script is:

```bash
pnpm asl:live-proof:both
```

Both commands call `asl-live-proof` with two `--file` values, `--require-platforms android,ios`, `--out`, and `--fail-on-regression`. The gate writes `live-proof-set.json` and `agent-summary.md` under the proof-set artifact directory, then exits nonzero when a required platform proof is missing, when any proof artifact has `status: failed`, or when a required regression gate reports `comparisonStatus: regressed`. When required platform proofs are missing, the proof set renders missing-platform next-action owner/code counts so readers can see coverage collection ownership separately from failed proof, warning, or skipped sidecar follow-up. When linked proofs fail or trip an active regression gate, the proof set renders proof next-action owner/code counts so readers can see failed proof or regression follow-up ownership before scanning each platform proof. If failed linked proofs carry diagnostic sufficiency pairs through skipped sidecar declarations, the proof set renders failed-proof diagnostic counts so provider-blocked and diagnostic-only evidence is visible before opening each platform proof. If failed linked proofs carry requested diagnostic inventory through skipped sidecar declarations, the proof set renders failed-proof requested diagnostic counts by kind, status, and requiredness so requested-but-missing diagnostics stay distinct from optional unrequested surfaces. If failed linked proofs carry native-performance claim context through skipped sidecar declarations, the proof set renders failed-proof native-performance counts for claim sufficiency, claim-sufficiency detail, completeness, comparability, target binding, target-binding detail, and diagnostic sources before opening each platform proof. If failed linked proofs carry profile-session readiness context through skipped sidecar declarations, the proof set also renders failed-proof readiness counts for failure class, command total, dev-client deep-link, foreground probe, seed, pending phase, expected evidence, and derived command-channel detail tags. When linked proofs include optional interaction warnings with next-action hints, the proof set renders warning next-action owner/code counts without treating those warnings as failed proof gates. If linked platform proofs skipped requested sidecars, the proof set renders those skipped interaction proofs with platform, linked proof, reason, next action, and profile-gate diagnostic or readiness context. It also renders skipped proof next-action owner/code counts, so readers can see the blocker ownership shape before scanning each skipped proof. It renders profile-gate diagnostic sufficiency counts when skipped proofs carry captured or blocking diagnostic sufficiency pairs, so readers can distinguish partial provider evidence from claim-satisfying evidence at the platform-set gate. When skipped proof gates include native-performance claim context, the proof set renders native-performance claim sufficiency, claim-sufficiency detail, completeness, comparability, target-binding, target-binding detail, and diagnostic source counts for those gates. When skipped proof gates include profile-session readiness context, the proof set renders failure class, command total, dev-client deep-link, foreground probe, seed, pending phase, expected-evidence, and command-channel detail counts for those gates. If linked platform proofs include native-performance rollups, the proof set also renders combined profile/evidence counts, diagnostic source statuses, completeness, claim sufficiency, claim-sufficiency detail, comparability, target binding, and target-binding detail so readers can see cross-platform evidence depth without opening each proof first. Use `ASL_ANDROID_LIVE_PROOF` and `ASL_IOS_LIVE_PROOF` in consumer apps, or `ASL_EXAMPLE_ANDROID_LIVE_PROOF` and `ASL_EXAMPLE_IOS_LIVE_PROOF` in the checked-in example app, to point at suffixed proof files.

For a final local proof before an agent claims improvement, enable artifact pointer checks:

```bash
ASL_REQUIRE_LIVE_PROOF_ARTIFACTS=1 pnpm example:mobile:live-proof
ASL_REQUIRE_LIVE_PROOF_ARTIFACTS=1 pnpm asl:live-proof:both
```

This passes `--require-artifacts` so `asl-live-proof` verifies that each referenced run directory, summary, comparison artifact, and interaction capture exists on disk. Leave it off when inspecting copied or archived `live-proof.json` files without the full artifact tree.

By default, relative pointers are resolved from the current working directory. Use `--artifact-base-dir <dir>` with direct `asl-live-proof` calls when inspecting a project from a different shell location.

## Comparison

Compare explicit completed runs:

```bash
pnpm compare \
  -- --baseline artifacts/runs/app-startup/baseline \
  --current artifacts/runs/app-startup/current \
  --out artifacts/runs/app-startup/current \
  --fail-on-regression
```

Or compare the current run against the newest trusted prior run for the same scenario:

```bash
pnpm compare:latest \
  -- --root artifacts/runs \
  --scenario app-startup \
  --current artifacts/runs/app-startup/current \
  --out artifacts/runs/app-startup/current \
  --fail-on-regression
```

Scenario health must pass before timing or budget evidence can support an improvement or regression claim.

The comparison gate is intentionally strict. If either run failed scenario health, or if the scenario ids do not match, the comparison is `inconclusive`. Numeric budget checks are compared only after that health gate passes. `comparison.json` includes `comparisonBasis` with the baseline/current run ids and run directories, giving agents artifact-local provenance instead of forcing them to infer it from folder names. It also includes `measurementPolicy`, which records the baseline selection mode, poisoning protections, valid sample counts, timing tolerance, and confidence level used for the comparison. When trusted baseline/current native evidence also proves the same-condition contract, `comparison.json` schemaVersion `1.1.0` adds a `nativePerformance` section with per-metric deltas, direction, percent change, and separate budget status. If that contract cannot be proven, the section stays `not-comparable` with explanations instead of upgrading diagnostics into a claim.

The latest-trusted command excludes the exact current run directory from baseline selection. Baseline trust requires passed health and passed verdict. It also requires artifact schemas the current reader understands: missing legacy schema versions remain legacy-compatible, but malformed schema versions or future major versions are indexed as `artifact_schema_incompatible` and cannot seed baselines. For attempt-aware artifacts, baseline trust also requires a clean first passed attempt, no retry lineage, no failed or partial cleanup, and no valid partial-artifact diagnostic fragments. Current runs must pass scenario health before the command will compare timing or budget evidence. If the current manifest declares `comparisonLane`, baseline selection is scoped to trusted prior runs with the same lane; if the current manifest has no lane, selection stays within unlabeled trusted prior runs. Profile manifests also include `scenarioHash`, a stable fingerprint of the normalized scenario contract. When the current run has that hash, latest-trusted selection only compares against trusted prior runs with the same hash; legacy runs without the hash remain comparable only to legacy current runs. This keeps proof modes such as plain live proof and live proof plus agent-device sidecar from comparing against each other, and it keeps migrated scenario definitions from poisoning before/after verdicts. Latest-trusted artifacts set `comparisonBasis.strategy` to `latest_trusted_prior`, record selection counts for inspected, trusted, trusted-prior, lane-comparable, and scenario-contract-comparable candidates, and mirror the active lane, scenario hash, and cohort hash inside `measurementPolicy.baselineSelection.poisoningProtection` when those filters are active.

## Release Gate

Before publishing, run the package gate:

```bash
pnpm release:check
```

That gate builds the release scripts, runs tests and readiness checks, packs the package once, then reuses that tarball for package smoke, installed-binary checks, fake-device example proofs, schema/example/template/doc packaging checks, and the packed-package consumer rehearsal. Reusing one tarball keeps the release path closer to npm publish behavior and avoids repeated clean/build/pack cycles.

When a release-sensitive change affects a real adopter's runner, schema, provider, or app-helper contract, also run `pnpm downstream:local-package` against that adopter before publishing. That gate installs the packed local tarball into the downstream app, runs the requested app-owned validation commands, and restores package metadata afterward.

When the release is ready, publish through the repo coordinator:

```bash
pnpm release:publish
```

That command runs the full release gate, records a local proof marker for the current clean `main` checkout, runs the package clean/build step immediately before upload, uploads with npm lifecycle scripts disabled for that verified upload, verifies the published package version on the registry, creates the matching `vX.Y.Z` git tag, and pushes the tag to `origin`. The tag push triggers the GitHub Release workflow, which verifies that the tag matches `package.json` and that npm already contains the same package version before creating the GitHub Release. Direct `npm publish` remains guarded by `prepublishOnly`.

If the full gate already passed for the same package version and checkout but npm upload or tag synchronization failed, resume only the upload/tag phase:

```bash
pnpm release:publish -- --resume-upload
```

The resume path refuses to run unless the local proof marker still matches the current clean `main` checkout, package name, version, package metadata, lockfile hash, and commit. If npm already contains the package version because a previous upload succeeded before tagging, the same command resumes at tag synchronization.

Package smoke and consumer rehearsal keep child commands bounded so package-manager stalls fail with the temporary rehearsal directory preserved. Set `ASL_PACKAGE_GATE_TIMEOUT_MS` to raise the per-command timeout when a local registry, proxy, or cold package cache is slow:

```bash
ASL_PACKAGE_GATE_TIMEOUT_MS=300000 pnpm release:check
```

## Run Plan First

Profile runs write `run-plan.json` before provider commands, evidence ingest, and final health classification. Inspect it first when a live loop stalls or fails early: it records the scenario id, scenario hash, input mode (`fixture-event-log`, `adb-sidecar`, `simctl-sidecar`, or live capture), expected iterations, command transport, provider manifests, requested diagnostics, scenario metadata when declared, and evidence source paths. `run-plan.json.requestedDiagnostics` is planned demand only (scenario artifact tokens, including aggregate `signals`, plus capability aliases and selected provider-command output declarations); it is not a capture result or readiness claim. Live sidecars also write a raw started checkpoint such as `raw/adb-capture-started.json` or `raw/ios-simctl-capture-started.json` before the first mutable platform command. The profile CLIs print a compact run-plan heartbeat to stderr while keeping stdout reserved for the run directory.

## Side References

- [Consumer App Rehearsal](consumer-rehearsal.md) for adoption inside an existing app
- [examples/mobile-app](../examples/mobile-app/README.md) for detailed dogfood app commands
- [Public API](api.md) for package imports and programmable runner composition
