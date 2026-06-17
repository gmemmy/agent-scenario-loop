# Live Proofs

Use this page when you want to move from contract validation into runtime evidence.

The goal of a live proof is not just to see a command pass. The goal is to preserve scenario health, verdicts, raw evidence, metrics, summaries, and comparison context in the standard artifact layout.

## Fixture Loop

Use the fixture loop when no simulator or device is available:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The command runs preflight, profiles baseline/current event logs, writes run artifacts, compares the current run against the latest trusted prior run, and refreshes the current run's `agent-summary.md`.

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

Use a run suffix when preserving before/after runs:

```bash
pnpm example:android:live -- --run-suffix before-change
pnpm example:android:live -- --run-suffix after-change --compare-latest
```

Add `--fail-on-regression` when regression evidence should make the aggregate command exit nonzero after writing artifacts:

```bash
pnpm example:android:live -- --run-suffix after-change --compare-latest --fail-on-regression
```

Read [Example Mobile App: Android Capture](../examples/mobile-app/README.md#android-capture) for Metro routing, adb permissions, individual scenario commands, selector behavior, and optional video capture.

## iOS Proof

With the neutral Expo example app installed on a booted iOS simulator and Metro connected, run:

```bash
pnpm example:app:ios:prebuild
pnpm example:app:start:isolated
pnpm example:ios:live
```

The aggregate proof runs simctl preflight plus the canonical startup, open-close, and scroll-settle scenarios. It writes a batch entrypoint under:

```text
artifacts/example-mobile-app/ios/_live-proof/ios-live-proof/agent-summary.md
```

Use a run suffix and latest-trusted comparison the same way:

```bash
pnpm example:ios:live -- --run-suffix after-change --compare-latest
```

Add `--fail-on-regression` when comparison regressions should fail the aggregate command:

```bash
pnpm example:ios:live -- --run-suffix after-change --compare-latest --fail-on-regression
```

Read [Example Mobile App: iOS Capture](../examples/mobile-app/README.md#ios-capture) for prebuild, Xcode selection, simulator permissions, stored profile events, and individual scenario commands.

## Sidecar Interaction Proof

When `agent-device` or Argent is available, the example aggregate proofs can attach interaction sidecars:

```bash
pnpm example:android:live:agent-device -- --agent-device-session <name> --run-suffix after-change --compare-latest
pnpm example:ios:live:agent-device -- --agent-device-session <name> --run-suffix after-change --compare-latest
pnpm example:android:live:argent -- --run-suffix after-change --compare-latest
pnpm example:ios:live:argent -- --run-suffix after-change --compare-latest
```

Use the combined runner scripts when you want every configured sidecar to contribute to the same aggregate proof:

```bash
pnpm example:android:live:runners -- --agent-device-session <name> --run-suffix after-change --compare-latest
pnpm example:ios:live:runners -- --agent-device-session <name> --run-suffix after-change --compare-latest
```

For Argent without a global binary, set `ASL_ARGENT_BIN=npx` and `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"`. The platform runner still owns adb or simctl preflight and profile evidence. Each sidecar contributes interaction proof and captures into the same aggregate artifact graph.

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
