# Contracts

This package ships the scenario, runner, and artifact contracts that make Agent Scenario Loop useful before every live runner is automated.

The package is intentionally contract-first: adopt the scenario and artifact shape now, then inherit more automated runner loops later without rewriting your scenarios.

## What ships today

- [app/profile-session.ts](../app/profile-session.ts): thin React Native integration for session control, truth events, and signal attachments
- [core/agent-summary.ts](../core/agent-summary.ts): agent-facing summary builder for health, verdict, and comparison state
- [core/artifact-layout.ts](../core/artifact-layout.ts): canonical artifact path contract for one run directory
- [core/artifact-writer.ts](../core/artifact-writer.ts): schema-enforcing writers for stable JSON/text artifacts
- [core/comparison.ts](../core/comparison.ts): comparison artifact builder for trusted before/after run folders
- [core/artifact-contract.ts](../core/artifact-contract.ts): artifact builders for manifest, metrics, causal run, budget verdict, and summary
- [core/evidence-interpreter.ts](../core/evidence-interpreter.ts): evidence interpretation helpers that gate timing claims on scenario health
- [core/planner.ts](../core/planner.ts): compatibility checks between scenario requirements, primary runner capabilities, and evidence providers
- [core/ports.ts](../core/ports.ts): ports-and-adapters method surfaces for runners, drivers, providers, writers, and interpreters
- [core/schema-validator.ts](../core/schema-validator.ts): dependency-free validation for the JSON Schema subset used by the public contracts
- [runner/profile-android.ts](../runner/profile-android.ts): Android log-ingest runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- [runner/profile-ios.ts](../runner/profile-ios.ts): iOS log-ingest runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- [runner/android-adb.ts](../runner/android-adb.ts): Android adb readiness preflight and optional bounded logcat capture that write runner health and raw adb evidence
- [runner/demo-loop.ts](../runner/demo-loop.ts): fixture loop that proves preflight, profile, and comparison without a simulator
- [examples/event-logs](../examples/event-logs): deterministic profile-event logs for the fixture loop
- [examples/mobile-app](../examples/mobile-app): neutral Expo dogfood app with scenario manifests and profile-event evidence fixtures
- [examples/scenarios/ios](../examples/scenarios/ios): iOS profile scenario manifests for the current log-ingest runner
- [examples/scenarios/mobile](../examples/scenarios/mobile): canonical portable scenario fixtures
- [examples/runners](../examples/runners): primary runner and evidence-provider capability fixtures
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
- `truthEvents`: app-owned milestone events keyed by stable milestone id
- `milestones`: inspectable milestone list with event names, phases, timeouts, and descriptions
- `expectedEvents`: event names the runner or log ingest should expect to observe
- `cycles`: repeat count, warmup count, and failure policy for repeated journeys
- `budgets`: product thresholds evaluated only after scenario health passes
- `steps`: runner-facing launch, command, wait, gesture, and capture actions
- `artifacts`: required and optional evidence outputs

The scenario contract is intentionally runner-neutral. Runners can map steps to adb, XcodeBuildMCP, agent-device, accessibility tools, profilers, or custom scripts while preserving the same journey, milestones, budgets, and expected events.

## Public artifact layout

Every run should produce a stable artifact folder.

Core artifacts:

- `health.json`: whether the scenario execution was valid enough to interpret
- `verdict.json`: budget outcome for product behavior, or `not_evaluated` before evidence is collected
- `comparison.json`: optional before/after result against a trusted baseline
- `agent-summary.md`: agent-readable health gate and next-action summary
- `planner-compatibility.json`: optional preflight detail from runner/provider matching

Profile runner artifacts:

- `manifest.json`
- `metrics.json`
- `budget-verdict.json`
- `causal-run.json`
- `summary.md`

`manifest.json`, `metrics.json`, `budget-verdict.json`, and `causal-run.json` are schema-checked before the runner writes them. This keeps profile artifacts stable while the live runner layer matures.

Evidence folders:

- `raw/`
- `captures/`
- optional `signals/js`
- optional `signals/memory`
- optional `signals/network`

The artifact contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, `comparison.json` records before/after baseline comparison, and `agent-summary.md` gives agents the health gate before they touch code.

The current profile runner writes health, verdict, agent summary, metrics, causal-run, and budget-verdict artifacts.

Budgets are supported but optional for adoption.

## Current Scope

Live simulator or device orchestration is not yet a supported public feature. The current Android and iOS profile runners assemble artifacts from event logs you capture. The Android adb runner verifies readiness and can attach bounded logcat evidence before or after manual execution; `profile-android` can read that adb artifact folder through `--adb-artifacts`. Fully automated runner/adapter loops land behind the same contract.

Not yet shipped as supported public features:

- full Android scenario execution beyond adb readiness preflight, bounded logcat capture, and log-ingest artifact assembly
- physical devices
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

Add `--capture-logcat --logcat-lines <count>` to write `raw/adb-logcat.txt` in the same artifact folder. If logcat capture is requested and fails, scenario health fails because timing and event evidence would be incomplete.

Use that captured logcat evidence directly with Android profiling:

```bash
pnpm profile:android -- --config core/config-template.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-artifacts artifacts/android-adb-preflight --run-id android-run-1
```

## Historical comparison

Use `compare` to build `comparison.json` from two completed run folders:

```bash
pnpm compare -- --baseline artifacts/runs/app-startup/baseline --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current
```

The comparison gate is intentionally strict. If either run failed scenario health, or if the scenario ids do not match, the comparison is `inconclusive`. Numeric budget checks are compared only after that health gate passes.

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

This is not a replacement for live device proof. It is a stable contract check that keeps the evidence loop reproducible while iOS or Android runtime setup is unavailable.

## Read next

- [README](../README.md) for the shortest path through the project
- [Concepts](concepts.md) for the broader product framing
- [Runner docs](../runner/README.md) for current runner behavior and limits
