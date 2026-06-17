# Live Proofs

Use this page when you want to move from contract validation into runtime evidence.

The goal of a live proof is not just to see a command pass. The goal is to preserve scenario health, verdicts, raw evidence, metrics, summaries, and comparison context in the standard artifact layout.

## Fixture Loop

Use the fixture loop when no simulator or device is available:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The command runs preflight, profiles baseline/current event logs, writes run artifacts, compares the current run against the latest trusted prior run, and refreshes the current run's `agent-summary.md`.

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

Read [Example Mobile App: iOS Capture](../examples/mobile-app/README.md#ios-capture) for prebuild, Xcode selection, simulator permissions, stored profile events, and individual scenario commands.

## Sidecar Interaction Proof

When `agent-device` or Argent is available, the example aggregate proofs can attach interaction sidecars:

```bash
ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android pnpm agent-device:check
ASL_ARGENT_BIN=/path/to/argent pnpm argent:check
pnpm example:android:live:agent-device -- --agent-device-session <name> --run-suffix after-change
pnpm example:ios:live:agent-device -- --agent-device-session <name> --run-suffix after-change
pnpm example:android:live:argent -- --run-suffix after-change
pnpm example:ios:live:argent -- --run-suffix after-change
```

Use the combined runner scripts when you want every configured sidecar to contribute to the same aggregate proof:

```bash
pnpm example:android:live:runners -- --agent-device-session <name> --run-suffix after-change
pnpm example:ios:live:runners -- --agent-device-session <name> --run-suffix after-change
```

Run `pnpm agent-device:check` before using agent-device sidecars; set `ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android` when the local proof must confirm both booted OS targets. For Argent, prefer a real `argent` executable on PATH, or set `ASL_ARGENT_BIN=/path/to/argent` when the package manager installed it somewhere else. `ASL_ARGENT_BIN=npx` with `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"` is supported as a wrapper shape, but run `pnpm argent:check` before relying on it because package-manager wrappers can be slower than direct binaries. Run `pnpm argent:check` first when you need a bounded tool-surface proof before attaching Argent to a device scenario. Direct iOS `asl-argent` runs can set `ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK=1` so simctl supplies screenshot evidence when Argent can launch and inspect the app but its iOS screenshot backend is unavailable. The platform runner still owns adb or simctl preflight and profile evidence, and sidecars run only after that profile evidence has passed health and budget gates. Each executed sidecar contributes interaction proof, captures, and warning summaries into the same aggregate artifact graph; skipped sidecars remain visible in the aggregate proof so agents know which runner evidence is missing and why.

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

Read next:

- [Contracts](contracts.md) for artifact layout and supported runner surface
- [Consumer App Rehearsal](consumer-rehearsal.md) for adoption inside an existing app
- [examples/mobile-app](../examples/mobile-app/README.md) for detailed dogfood app commands
