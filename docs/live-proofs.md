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

If a live command cannot reach adb, CoreSimulator, `agent-device`, Argent, a simulator, an emulator, or a required local app service, classify the result as runner environment health. Do not call it an app regression or a scenario failure until the platform preflight and scenario health have passed. The runners write failed health artifacts and `nextAction` values for this case so agents can preserve the evidence trail while rerunning the same command with the right host/device access.

For repeated local work, prefer narrow, reusable permissions for the exact package scripts you run often instead of one-off retries after expected preflight failures. Keep Metro on an isolated port for the proof app, use direct installed binaries when available, and keep bounded command timeouts on wrapper-based tools such as `npx`-launched Argent.

Put machine-specific runner settings in an ignored `.asl.local.env` file at the app or repo root instead of repeating inline environment variables in every command. ASL CLIs load the nearest `.asl.local.env` without overriding already-exported values, so CI and explicit shell overrides still win. Typical local values include:

```sh
ASL_HOST_DOCTOR_REQUIRE=android,ios,agent-device,argent
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

ASL_ARGENT_BIN=pnpm \
  ASL_ARGENT_BASE_ARGS="dlx @swmansion/argent run" \
  asl-host-doctor \
  --require android,ios,agent-device,argent \
  --agent-device-require-platforms ios,android \
  --out artifacts/asl/host-doctor
```

The doctor composes the existing adb, simctl, agent-device, and Argent checks into one ASL artifact set. A failed doctor is environment evidence, not product evidence: fix the host access or command shape before starting scenario execution.

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

The command writes a separate simctl capture folder under the selected output root, seeds the app-owned profile session into native AsyncStorage before launch, then collects stored app profile events after the capture window. Command scenarios seed the scenario command queue through the same storage contract before launch. Command envelopes preserve `commandId`, `sequence`, `queueId`, command pacing `waitMs`, and, for normalized execution-plan commands followed by a milestone wait, `waitForMilestone` plus `waitTimeoutMs`. Deep-link command transport uses the same envelope in query parameters. When `raw/ios-profile-events.log` exists, the iOS profile runner ingests that stored truth-event log; otherwise it falls back to `raw/ios-simctl-log.txt`.

Profile manifests only list sidecar paths that were copied into the profile run or deliberately referenced as external sidecar evidence. If a simctl or adb capture folder is the real evidence source, `manifest.artifacts.diagnostics` records the diagnostic status plus `sidecarRoot`/`evidenceDependency` instead of inventing profile-root files such as `raw/device.log`, `captures/run.mp4`, or `captures/ui-tree.json`. Rehydrated runs may record `evidenceDependency.root: "sidecar"` with paths relative to `sidecarRoot`, so agents do not have to reason from long `../../` paths alone.

When a scenario requests a screenshot, pass supported simulator screenshot options through the iOS capture command with `--screenshot-type`, `--screenshot-display`, or `--screenshot-mask`; ASL records the chosen options in capture metadata and the resulting path in `manifest.artifacts.captures.screenshots`.

For profile-session capture on Android or iOS, omitting `--wait-ms` lets ASL derive the final evidence window from scenario execution waits and cycle count. On iOS, command-backed profile sessions use the expanded command queue, including setup commands, repeated cycle body commands, command pacing `waitMs`, milestone-gate `waitTimeoutMs`, and a conservative buffer. Explicit `--wait-ms` remains authoritative when a consuming app has a known startup or logging delay that the scenario cannot express.

Scenario command targets live in `adapterOptions.iosSimctl.commands`, while the app handles them through `registerProfileCommandTargetHandler`. The iOS proof does not depend on unified logs carrying JavaScript console output; it depends on app-owned stored profile events.

Attach independently produced provider evidence with `--signal <js|memory|network>:<path>` or `--capture <screenshot|video|uiTree>:<path>` so profile commands copy those files into stable run folders and inventory them in `manifest.artifacts.evidenceAttachments`.

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
When no trusted prior run exists, the comparison is recorded as skipped without failing the live proof. When a comparable prior run exists, `--fail-on-regression` makes a regression exit nonzero after artifacts are written.

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

The platform runner still owns profile evidence. `agent-device` and Argent contribute interaction proof pointers under the same aggregate `live-proof.json` only after the profile run has produced trusted artifacts. If the profile health or budget verdict fails, requested sidecars are recorded under `skippedInteractionProofs` with a recovery hint, and the aggregate command exits nonzero after writing `live-proof.json`. If a sidecar itself fails a required step, the aggregate command also fails after preserving that sidecar's raw output and `agent-summary.md`. Optional sidecar failures, such as a screenshot helper failing after a successful UI assertion, are preserved as interaction proof warnings so agents can report partial evidence without treating timing as suspect.

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

The default iOS live proof transport seeds profile-session control into simulator app storage. Use `--ios-profile-session-transport deeplink` when the app should receive profile-session start and command control through app URLs instead.

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

The `agent-device:check` and `argent:check` scripts pass `--out` and write availability `health.json`, `verdict.json`, `agent-summary.md`, and raw tool-surface JSON under `artifacts/agent-device-check` and `artifacts/argent-check`.

Use the combined runner scripts when you want every configured sidecar to contribute to the same aggregate proof:

```bash
ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION=<name> pnpm example:android:live:runners -- --run-suffix after-change
ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION=<name> pnpm example:ios:live:runners -- --run-suffix after-change
```

Run `pnpm agent-device:check` before using agent-device sidecars; set `ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android` when the local proof must confirm both booted OS targets. The check runs `agent-device session list --json`, writes active sessions into `raw/agent-device-availability.json`, and includes a compact `agent_device_sessions` line in `agent-summary.md`. If the artifact shows a named session already owns the target device, pass `ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION` or `ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION` to the aggregate script, or pass `--agent-device-session <name>` directly after `--`. This defaults to `reuse`, where the session owns target selection. Set `ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION_MODE=bind` or `ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION_MODE=bind` when you want ASL to create or name the sidecar session while still forwarding the configured Android serial or iOS UDID; this avoids borrowing a default session that is bound to the wrong OS. For Argent, prefer a real `argent` executable on PATH, or set `ASL_ARGENT_BIN=/path/to/argent` when the package manager installed it somewhere else. `ASL_ARGENT_BIN=npx` with `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"` is supported as a wrapper shape, but run `pnpm argent:check` before relying on it because package-manager wrappers can be slower than direct binaries. Run `pnpm argent:check` first when you need a bounded tool-surface proof before attaching Argent to a device scenario. Both checks preserve artifacts via `--out`, so failed command-surface evidence can be inspected without relying on terminal scrollback. Direct iOS `asl-argent` runs can set `ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK=1` so simctl supplies screenshot evidence when Argent can launch and inspect the app but its iOS screenshot backend is unavailable. The platform runner still owns adb or simctl preflight and profile evidence, and sidecars run only after that profile evidence has passed health and budget gates. Each executed sidecar contributes interaction proof, captures, and warning summaries into the same aggregate artifact graph; skipped sidecars remain visible in the aggregate proof so agents know which runner evidence is missing and why.

## Platform Set Gate

After Android and iOS live proofs have both written aggregate artifacts, assert the platform set with one inspector command:

```bash
pnpm example:mobile:live-proof
```

For a consumer app scaffolded with `asl-init`, the equivalent script is:

```bash
pnpm asl:live-proof:both
```

Both commands call `asl-live-proof` with two `--file` values, `--require-platforms android,ios`, `--out`, and `--fail-on-regression`. The gate writes `live-proof-set.json` and `agent-summary.md` under the proof-set artifact directory, then exits nonzero when a required platform proof is missing, when any proof artifact has `status: failed`, or when a required regression gate reports `comparisonStatus: regressed`. Use `ASL_ANDROID_LIVE_PROOF` and `ASL_IOS_LIVE_PROOF` in consumer apps, or `ASL_EXAMPLE_ANDROID_LIVE_PROOF` and `ASL_EXAMPLE_IOS_LIVE_PROOF` in the checked-in example app, to point at suffixed proof files.

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

The comparison gate is intentionally strict. If either run failed scenario health, or if the scenario ids do not match, the comparison is `inconclusive`. Numeric budget checks are compared only after that health gate passes. `comparison.json` includes `comparisonBasis` with the baseline/current run ids and run directories, giving agents artifact-local provenance instead of forcing them to infer it from folder names. It also includes `measurementPolicy`, which records the baseline selection mode, poisoning protections, valid sample counts, timing tolerance, and confidence level used for the comparison.

The latest-trusted command excludes the exact current run directory from baseline selection. Baseline trust requires passed health and passed verdict. For attempt-aware artifacts, baseline trust also requires a clean first passed attempt, no retry lineage, no failed or partial cleanup, and no valid partial-artifact diagnostic fragments. Current runs must pass scenario health before the command will compare timing or budget evidence. If the current manifest declares `comparisonLane`, baseline selection is scoped to trusted prior runs with the same lane; if the current manifest has no lane, selection stays within unlabeled trusted prior runs. Profile manifests also include `scenarioHash`, a stable fingerprint of the normalized scenario contract. When the current run has that hash, latest-trusted selection only compares against trusted prior runs with the same hash; legacy runs without the hash remain comparable only to legacy current runs. This keeps proof modes such as plain live proof and live proof plus agent-device sidecar from comparing against each other, and it keeps migrated scenario definitions from poisoning before/after verdicts. Latest-trusted artifacts set `comparisonBasis.strategy` to `latest_trusted_prior`, record selection counts for inspected, trusted, trusted-prior, lane-comparable, and scenario-contract-comparable candidates, and mirror the active lane, scenario hash, and cohort hash inside `measurementPolicy.baselineSelection.poisoningProtection` when those filters are active.

## Release Gate

Before publishing, run:

```bash
pnpm release:check
```

That gate builds the release scripts, runs tests and readiness checks, packs the package once, then reuses that tarball for package smoke, installed-binary checks, fake-device example proofs, schema/example/template/doc packaging checks, and the packed-package consumer rehearsal. Reusing one tarball keeps the release path closer to npm publish behavior and avoids repeated clean/build/pack cycles.

Package smoke and consumer rehearsal keep child commands bounded so package-manager stalls fail with the temporary rehearsal directory preserved. Set `ASL_PACKAGE_GATE_TIMEOUT_MS` to raise the per-command timeout when a local registry, proxy, or cold package cache is slow:

```bash
ASL_PACKAGE_GATE_TIMEOUT_MS=300000 pnpm release:check
```

## Run Plan First

Profile runs write `run-plan.json` before provider commands, evidence ingest, and final health classification. Inspect it first when a live loop stalls or fails early: it records the scenario id, scenario hash, input mode (`fixture-event-log`, `adb-sidecar`, `simctl-sidecar`, or live capture), expected iterations, command transport, provider manifests, requested diagnostics, and evidence source paths. The profile CLIs also print a compact run-plan heartbeat to stderr while keeping stdout reserved for the run directory.

## Side References

- [Consumer App Rehearsal](consumer-rehearsal.md) for adoption inside an existing app
- [examples/mobile-app](../examples/mobile-app/README.md) for detailed dogfood app commands
- [Public API](api.md) for package imports and programmable runner composition
