# Live Proofs

Use this page when you want to move from contract validation into runtime evidence.

The goal of a live proof is not just to see a command pass. The goal is to preserve scenario health, verdicts, raw evidence, metrics, summaries, and comparison context in the standard artifact layout.

## Fixture Loop

Use the fixture loop when no simulator or device is available:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The command runs preflight, profiles baseline/current event logs, writes run artifacts, compares the current run against the latest trusted prior run, and refreshes the current run's `agent-summary.md`.

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

Read [Example Mobile App: Android Capture](../examples/mobile-app/README.md#android-capture) for Metro routing, adb permissions, individual scenario commands, selector behavior, and optional video capture.

Expo dev-client Android shells may need an explicit Metro deep link after the native app launches. Put that local URL in ignored env state, for example `ASL_EXAMPLE_ANDROID_DEV_CLIENT_URL=asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097`, so Android profile capture opens the correct app session before profile-session deep links. When bundle load time is variable, also set `ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_PATTERN='Running "main"'` so the runner waits for bounded logcat readiness evidence before sending scenario links.

Apps using the ASL profile-session AsyncStorage bridge can opt into storage delivery with `--android-profile-session-storage`. The Android runner resolves the session `startedAt` from the selected device clock before writing AsyncStorage, so milestone timing stays device-relative instead of host-clock-relative. Override the default storage keys with `ASL_ANDROID_PROFILE_SESSION_STORAGE_KEY` and `ASL_ANDROID_PROFILE_COMMAND_STORAGE_KEY` only when adopting an existing app-owned bridge.

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

Expo dev-client iOS shells may need an explicit Metro deep link after the native app launches. Put that local URL in ignored env state, for example `ASL_EXAMPLE_IOS_DEV_CLIENT_URL=asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097`, so iOS profile capture opens the correct app session before collecting evidence.

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

## Release Gate

Before publishing, run:

```bash
pnpm release:check
```

That gate runs tests, readiness checks, package smoke, installed-binary checks, fake-device example proofs, schema/example/template/doc packaging checks, and the packed-package consumer rehearsal.

Package smoke and consumer rehearsal keep child commands bounded so package-manager stalls fail with the temporary rehearsal directory preserved. Set `ASL_PACKAGE_GATE_TIMEOUT_MS` to raise the per-command timeout when a local registry, proxy, or cold package cache is slow:

```bash
ASL_PACKAGE_GATE_TIMEOUT_MS=300000 pnpm release:check
```

Read next:

- [Contracts](contracts.md) for artifact layout and supported runner surface
- [Consumer App Rehearsal](consumer-rehearsal.md) for adoption inside an existing app
- [examples/mobile-app](../examples/mobile-app/README.md) for detailed dogfood app commands
