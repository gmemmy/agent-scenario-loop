# Agent Scenario Loop

Define app scenarios, run them with any agent or automation tool, and preserve the evidence from every run.

Agent Scenario Loop is a scenario orchestration and evidence collection framework for agent-driven software development. It sits above tactical runners: it does not replace Codex, Argent, Agent Device, adb, Xcode instrumentation, accessibility tooling, profilers, or your internal scripts. It gives them a shared scenario and evidence contract.

**Bring your own runner. Keep your scenarios. Keep your evidence.**

## Start here

| If you want to... | Read this |
| --- | --- |
| Understand the idea in plain language | [Concepts](docs/concepts.md) |
| Understand the project doctrine | [Principles](docs/principles.md) |
| See the current artifacts and package surface | [Contracts](docs/contracts.md) |
| Inspect the public package API | [Public API](docs/api.md) |
| Write your first scenario | [Scenario Authoring](docs/authoring.md) |
| Validate a scenario/runner plan before execution | [Package use](#package-use) |
| Inspect runner behavior and current runner limits | [Runner docs](runner/README.md) |
| See example scenarios and runner manifests | [examples/scenarios](examples/scenarios), [examples/runners](examples/runners) |
| Run the Android live proof path | [Android live proof](#android-live-proof) |
| Run the iOS live proof paths | [iOS live proof](#ios-live-proof) |
| See the neutral Expo dogfood app | [examples/mobile-app](examples/mobile-app/README.md) |
| See a minimal app integration note | [examples/minimal-app](examples/minimal-app/README.md) |

## The short version

An agent runner is any tool that can carry out part of a software workflow on your behalf. It might click through an app, run commands, inspect a screen, collect diagnostics, or drive a simulator or device.

The problem is not execution. The problem is everything around execution.

Once you want to mix runners, reuse scenarios, compare results across runs, preserve evidence, or evaluate changes over time, the workflow fragments quickly. Every tool has its own way to define work, capture results, and preserve context.

Agent Scenario Loop gives that work a stable shape:

1. Define a scenario as data.
2. Attach one or more runners or evidence providers.
3. Execute the scenario.
4. Write a stable artifact folder.
5. Let humans and agents inspect, compare, and act on the evidence.

For the deeper product framing, read [Concepts](docs/concepts.md).

## Core ideas

### Scenarios are assets

Scenarios describe important application behavior: a feed opening, a video upload, a livestream join, a checkout flow, or a large conversation loading. Those concerns should outlive whichever runner happens to execute them today.

Read next: [Scenarios become assets](docs/concepts.md#scenarios-become-assets).

### Runners are adapters

The best runner for a task today may not be the best runner six months from now. Agent Scenario Loop treats runners and drivers as interchangeable components behind the scenario/evidence boundary.

Read next: [Vendor-neutral by design](docs/concepts.md#vendor-neutral-by-design) and [Runner docs](runner/README.md).

### Evidence is durable

A run should leave behind artifacts that can be inspected after the terminal session is gone: logs, metrics, traces, screenshots, accessibility results, budget verdicts, and custom signals.

Read next: [Contracts](docs/contracts.md).

### The application stays in control

Most evaluation frameworks evaluate agents. Agent Scenario Loop is built to evaluate how software evolves over time. The feed, livestream, upload flow, checkout flow, or conversation is the thing that matters. Tooling orbits the scenario.

Read next: [The locus of control](docs/concepts.md#the-locus-of-control).

## Package use

The package builds to `dist/` and exposes typed core contracts from the root:

```js
const {
  buildComparisonArtifact,
  createArtifactLayout,
  evaluateRunnerCompatibility,
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  buildAgentSummaryMarkdown,
  buildScenarioExecutionPlan,
  collectScenarioDriverActions,
  buildRunIndex,
  findLatestTrustedRun,
} = require('agent-scenario-loop');
```

The preflight CLI is exported as `agent-scenario-loop` and `asl-check-plan` after package installation. The template scaffold command is exported as `asl-init`. The Android adb runner is exported as `asl-android-adb`, Android profiling is exported as `asl-profile-android`, the iOS simctl capture helper is exported as `asl-ios-simctl`, the packaged Android and iOS example proofs are exported as `asl-example-android-live` and `asl-example-ios-live`, iOS profiling is exported as `asl-profile-ios`, comparison is exported as `asl-compare` and `asl-compare-latest`, and the fixture loop is exported as `asl-demo-loop`. In this repo, use the script form:

```bash
pnpm check-plan -- --scenario examples/scenarios/mobile/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

That command does not require Xcode, a simulator, or device artifacts. It validates scenario and runner manifests, writes preflight artifacts, and stops before live execution.

Adapter authors can import `agent-scenario-loop/runner/android-adb-driver` to reuse adb-backed `tap`, `scroll`, `inspectTree`, `screenshot`, and `readLogs` driver actions plus Android lifecycle helpers without depending on the `asl-android-adb` CLI. They can import `agent-scenario-loop/runner/ios-simctl-driver` for simctl-backed `screenshot` and `readLogs` evidence actions plus explicit iOS lifecycle helpers. Built-in profile CLIs route supported scenario `driverAction` steps through those adapters during owned capture windows.

To check Android adb readiness before live scenario execution:

```bash
pnpm example:android:preflight
```

That command writes runner health, an inconclusive pre-budget verdict, an agent summary, and raw adb evidence. It does not install the app or drive arbitrary scenario steps.

## Android live proof

With the Expo example app installed on an online Android emulator or device, run the full Android proof path:

```bash
pnpm example:app:android
pnpm example:android:live
```

`example:app:android` builds, installs, and opens the private example app. Keep Metro running. `example:android:live` then checks adb/package readiness and runs startup, open-close, and scroll-settle through the same scenario/artifact contract. It prints the `agent-summary.md` entrypoint for each run.

The proof command writes:

- adb preflight health under `artifacts/example-mobile-app/android/_preflight/android-live-preflight`
- startup artifacts under `artifacts/example-mobile-app/android/app-startup/android-live-startup`
- open-close artifacts under `artifacts/example-mobile-app/android/open-close-cycle/android-live-open-close`
- scroll artifacts under `artifacts/example-mobile-app/android/scroll-settle/android-live-scroll`

The underlying profile commands remain available when you want to isolate one scenario:

```bash
pnpm example:profile:android:live:startup
pnpm example:profile:android:live:open-close
pnpm example:profile:android:live:scroll
```

These commands start a profile session through the app scheme, execute scenario-declared Android commands where needed, capture bounded logcat evidence, and write the standard `health.json`, `verdict.json`, `agent-summary.md`, `manifest.json`, `metrics.json`, `causal-run.json`, `budget-verdict.json`, and raw evidence files. If adb, the app package, or the device is unavailable, the capture writes failed health with next-action hints and the profile runner stops before making timing claims.

To attach a bounded Android logcat snapshot after a manual or agent-driven run:

```bash
pnpm android:logcat -- --package com.example.app --logcat-lines 1000 --out artifacts/android-adb-logcat
```

That writes `raw/adb-logcat.txt` beside the adb readiness evidence, so the same log can feed `asl-profile-android` when it contains `[profile-event]` lines.

To clear logcat, launch the package, wait for app-emitted profile events, and capture the resulting log window:

```bash
pnpm android:logcat -- --package com.example.app --clear-logcat --launch --wait-ms 5000 --logcat-lines 1000 --out artifacts/android-adb-launch
```

Then profile a scenario from that captured evidence:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-artifacts artifacts/android-adb-logcat --run-id <run-id>
```

Or let Android profiling own both the adb capture window and the profile artifact run:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-capture --clear-logcat --launch --wait-ms 5000 --run-id <run-id>
```

## iOS live proof

With the Expo example app installed on a booted iOS simulator and Metro connected, run the storage-backed iOS proof paths:

```bash
pnpm example:ios:live
```

The aggregate command runs simctl preflight, startup, open-close, and scroll-settle. The individual scenario commands remain available when isolating one run:

```bash
pnpm example:profile:ios:live:startup
pnpm example:profile:ios:live:open-close
pnpm example:profile:ios:live:scroll
```

These commands seed the app-owned profile session into native AsyncStorage before launch. Command scenarios also seed the scenario command queue into the same storage contract before launch. After the capture window, the runner collects stored profile events from the simulator app data container and writes the same profile artifact set used by fixture logs.

The lower-level command is:

```bash
pnpm profile:ios -- --config <config> --scenario <scenario> --simctl-capture --profile-session --profile-session-storage --launch --wait-ms 5000 --run-id <run-id>
```

When stored events are collected, `profile-ios` ingests `raw/ios-profile-events.log`. If storage-backed events are absent, it falls back to the bounded `raw/ios-simctl-log.txt` captured by simctl and scenario health must still pass before any timing claim is trusted.

To compare two completed run folders:

```bash
pnpm compare -- --baseline artifacts/runs/app-startup/baseline --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current
```

Comparison only reports better, worse, or unchanged when both runs passed scenario health. Otherwise it writes an inconclusive `comparison.json`.

To compare the current run against the newest trusted prior run for the same scenario:

```bash
pnpm compare:latest -- --root artifacts/runs --scenario app-startup --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current
```

A trusted prior run must have passed both `health.json` and `verdict.json`. The current run must pass scenario health before timing or budget evidence is compared, so a broken scenario cannot accidentally become a performance claim.

To run the complete fixture loop without a simulator:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

That command runs preflight, profiles baseline/current event logs, writes run artifacts, compares the current run against the latest trusted prior run, and refreshes the current run's `agent-summary.md`.

To verify the full release gate before publishing:

```bash
pnpm release:check
```

That command runs the test suite, packs the repo, installs the tarball into a temporary project, runs installed binaries against packaged examples, runs the installed Android and iOS example-live proofs through fake device executors, checks root exports, and verifies that schemas, examples, templates, docs, and the app helper ship in the package. `npm publish` runs the same gate through `prepublishOnly`.

Read next: [Contracts](docs/contracts.md) for the artifact layout and supported runner surface.

## Quick start

1. Copy [app/profile-session.ts](app/profile-session.ts) into your React Native app and wire `useProfileSessionBootstrap()` once near the root.
2. Emit truth events around one real user journey. One journey is enough to start.
3. Run `asl-init --out . --scenario first-journey`, or copy files from [templates](templates), then fill in your app identifiers.
4. Start from the scaffolded scenario or from [examples/scenarios/ios/app-startup.json](examples/scenarios/ios/app-startup.json) and [examples/scenarios/ios/open-close-cycle.json](examples/scenarios/ios/open-close-cycle.json).
5. Run the journey on a simulator manually or with your driver of choice while capturing device logs, so the log contains your `[profile-event]` lines. Then:

```bash
pnpm profile:ios -- --config <config> --scenario <scenario> --events <event-log>
```

The runner prints the run folder. Read `summary.md` first.

No simulator available yet? Use the committed fixture logs:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

To inspect the neutral Expo example app used for package dogfooding, start with [examples/mobile-app](examples/mobile-app/README.md). Its committed Android and iOS event logs are part of `pnpm release:check`, so the package has to prove the example app scenarios can produce passed artifacts before publishing. Android adb and iOS simctl capture paths can also feed the same profile artifact contract when the app is installed on a live device or simulator.

To validate a portable scenario, runner manifest, and initial planning artifacts before execution:

```bash
pnpm check-plan -- --scenario examples/scenarios/mobile/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

To start from clean templates instead of existing examples, run `asl-init` or copy files from [templates](templates), then follow [Scenario Authoring](docs/authoring.md).

## Who this is for

- teams that want deterministic scenario contracts instead of ad-hoc automation scripts
- teams that want explicit product-truth events instead of screenshot-only pass/fail claims
- teams whose agents do performance work and need artifacts they can read, diff, and act on
- teams that expect to switch runners and refuse to lose their scenarios or evidence history when they do

What it is not:

- an end-to-end UI test framework
- a generic mobile automation stack
- a replacement for Codex, Argent, Agent Device, adb, XcodeBuildMCP, accessibility tooling, or profilers
- zero-touch: your app emits the truth events, and that is the point

## Production Readiness

Current package guarantees:

- the public package is installable from the packed tarball
- root exports expose the core artifact, planner, comparison, writer, interpreter, and ports contracts
- installable CLIs print help and run against packaged examples, including Android and iOS example-live proof paths
- `asl-init` scaffolds package templates into a consuming app layout from the installed tarball
- packaged schemas, scenarios, runner manifests, templates, docs, and app helper resolve after install
- canonical fixture and neutral Expo-app event logs produce passed profile artifacts
- explicit baseline/current run folders can produce schema-checked `comparison.json`
- artifact roots can be indexed to find trusted prior runs per scenario
- installed commands can compare a current run against the latest trusted prior run for a scenario
- installed adapter subpaths expose proven Android adb and iOS simctl driver helpers for portable evidence actions and explicit lifecycle helpers
- Android adb capture can resolve supported portable selectors into tap and scroll coordinates from UIAutomator bounds
- installed commands expose iOS simctl capture, screenshot preservation, and iOS profile ingestion from simctl artifacts
- provider evidence attachments are inventoried with stable paths, source filenames, sizes, and sha256 hashes
- evidence-provider manifests can declare no-shell commands whose outputs are preserved under stable run artifacts
- failed evidence-provider commands write failed health, inconclusive verdicts, raw command records, and next-action summaries
- failed adb, simctl, package, selector, and capture checks emit scalar next-action hints into health metadata and `agent-summary.md`
- adapter-target manifests for external tools are schema-checked and planner-tested without bundling those tools
- package smoke blocks generated artifacts, internal-only paths, and local/product-specific strings from the tarball

Remaining hardening:

- extend Android beyond basic selector-backed adb actions into broader semantic driver support
- extend iOS beyond log/screenshot capture into richer simulator driver support
- add richer examples for real external providers without making them package dependencies

The package should remain product-neutral. Product-specific selectors, routes, auth assumptions, and scenario data belong in the consuming app, not in this repository.
