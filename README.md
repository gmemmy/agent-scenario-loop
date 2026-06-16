# Agent Scenario Loop

Scenario orchestration and evidence collection for agent-driven software development.

Agent runners keep getting better at doing work.

Some drive devices. Some navigate applications. Some run accessibility audits. Some collect traces. Some execute complex workflows.

An agent runner is any tool that can carry out part of a software workflow on your behalf. It might click through an app, run commands, inspect a screen, collect diagnostics, or drive a simulator or device.

The problem is not execution. The problem is everything around execution.

Once you want to mix multiple runners, reuse scenarios, compare results across runs, preserve evidence, or evaluate changes over time, the workflow fragments quickly. Every tool has its own way to define the work, capture results, and preserve context.

Agent Scenario Loop sits above that.

It does not replace your runners. It orchestrates them.

## What it is

Agent Scenario Loop is a scenario orchestration and evidence collection framework for agent-driven software development.

It lets you define application scenarios, execute them with one or more agent runners, collect evidence from those runs, and make that evidence available for analysis and decision making.

Think of it as the layer that coordinates the work rather than the thing doing the work.

**Bring your own runner. Keep your scenarios. Keep your evidence.**

## Why it exists

Teams are increasingly using specialized tools to help agents and engineers execute software workflows.

Some tools drive applications. Some inspect accessibility state. Some collect platform traces. Some run profilers. Some are internal scripts built for one company or product.

Examples include Codex, Argent, Agent Device, adb-based automation, accessibility tooling, Xcode instrumentation, profilers, and custom internal runners. You do not need to know any specific one of these tools to use the idea: Agent Scenario Loop treats them all as ways to execute or observe part of a scenario.

Each tool is good at something. Real applications rarely need only one.

You might want an accessibility runner validating UI state, an agent runner navigating the application, a profiler collecting memory data, and platform tooling capturing traces, all within the same scenario.

Agent Scenario Loop makes that possible by keeping scenario definitions, app-emitted truth events, stable artifacts, budgets, and before/after evidence in one contract that different runners can serve over time.

## How it works

You define a scenario. For example:

- opening a media-heavy feed
- joining a livestream
- uploading a video
- loading a large conversation
- completing a checkout flow

You then attach the runners and instrumentation appropriate for that scenario.

Agent Scenario Loop coordinates execution and collects evidence throughout the run. Evidence can include:

- logs
- memory metrics
- profiling traces
- network activity
- performance measurements
- accessibility results
- custom signals

The collected evidence becomes a permanent artifact of the scenario. Not something buried in a terminal session. Not something lost after a successful run. An artifact that agents and humans can inspect later.

At the contract level:

1. You define a scenario as data: `app-startup`, `open-close-cycle`, or your own.
2. Your app emits truth events around the real user journey through a thin integration layer (`emitProfileEvent`), so a run's outcome is timestamped fact, not screenshot inference.
3. A runner executes the scenario and writes one stable artifact folder per run: metrics, budget verdict, summary, raw logs, captures, and optional signals.
4. You or your agent read the artifacts, compare against the last trusted run, and decide what to change next.

## Vendor-neutral by design

Scenarios should outlive tooling choices.

The best runner for a task today may not be the best runner six months from now. Agent Scenario Loop treats runners and drivers as interchangeable components behind the scenario/evidence boundary.

You can swap runners, combine runners, introduce new runners, or compare runners without rewriting your scenario definitions.

## What you get out of the box

V1 ships the contracts and the artifact pipeline:

- `app/profile-session.ts`: thin React Native integration — session control, truth events, signal attachments
- `core/agent-summary.ts`: the agent-facing summary builder for health, verdict, and comparison state
- `core/artifact-layout.ts`: the canonical v1 artifact path contract for one run directory
- `core/artifact-writer.ts`: schema-enforcing writers for stable JSON/text artifacts
- `core/artifact-contract.ts`: the artifact builders — manifest, metrics, causal run, budget verdict, summary
- `core/evidence-interpreter.ts`: evidence interpretation helpers that gate timing claims on scenario health
- `core/planner.ts`: planner compatibility checks between scenario requirements, primary runner capabilities, and evidence providers
- `core/ports.ts`: ports-and-adapters method surfaces for runners, drivers, providers, writers, and interpreters
- `core/schema-validator.ts`: dependency-free validation for the JSON Schema subset used by the public v1 contracts
- `runner/profile-ios.ts`: an iOS runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- `examples/scenarios/ios/`: transition scenario manifests for the current iOS log-ingest runner
- `examples/scenarios/v1/`: canonical v1 scenario fixtures
- `examples/runners/`: primary runner and evidence-provider capability fixtures
- `schemas/`: JSON Schemas for current artifacts plus the v1 scenario and runner capability contracts

V1 does not yet ship live simulator orchestration as a supported public feature. The current runner assembles artifacts from event logs you capture; a fully automated runner/adapter loop is the next milestone, and it lands behind the same contract. Adopting the contracts now means that loop drops in later without rewrites.

Also out of v1 scope: Android, physical devices, and Computer Use flows.

## Public contracts

App-side, what your app exposes:

- session control: `startProfileSession`, `stopProfileSession`, `applyProfileSessionUrl`
- truth events: `emitProfileEvent`
- signal attachments: `storeProfileSignal`

Artifact layout, what every run produces:

- `health.json` — whether the scenario execution was valid enough to interpret
- `verdict.json` — budget outcome for product behavior, or `not_evaluated` before evidence is collected
- `comparison.json` — optional before/after result against a trusted baseline
- `agent-summary.md` — agent-readable health gate and next-action summary
- `planner-compatibility.json` — optional preflight detail from runner/provider matching
- transition runner artifacts: `manifest.json`, `metrics.json`, `budget-verdict.json`, `causal-run.json`, and `summary.md`
- `raw/`, `captures/`, and optional `signals/js`, `signals/memory`, `signals/network`

The v1 target contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, `comparison.json` records before/after baseline comparison, and `agent-summary.md` gives agents the health gate before they touch code. `core/planner.ts` can already derive initial health and unevaluated verdict artifacts from compatibility results. The current runner still writes `metrics.json` and `budget-verdict.json` as transition artifacts.

Budgets are supported but optional for adoption.

## Package use

The package builds to `dist/` and exposes the typed core contracts from the root:

```js
const {
  createArtifactLayout,
  evaluateRunnerCompatibility,
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  buildAgentSummaryMarkdown,
} = require('agent-scenario-loop');
```

The preflight CLI is exported as `agent-scenario-loop` and `asl-check-plan` after package installation. In this repo, use the script form:

```bash
pnpm check-plan -- --scenario examples/scenarios/v1/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

That command does not require Xcode, a simulator, or device artifacts. It validates scenario and runner manifests, writes the v1 preflight artifacts, and stops before live execution.

## Quick start

1. Copy `app/profile-session.ts` into your React Native app and wire `useProfileSessionBootstrap()` near the root.
2. Emit truth events around one real user journey. One journey is enough to start.
3. Copy `core/config-template.json` into project-specific config and fill in your app identifiers.
4. Start from `examples/scenarios/ios/app-startup.json` or `examples/scenarios/ios/open-close-cycle.json`.
5. Run the journey on a simulator — manually or with your driver of choice — while capturing device logs, so the log contains your `[profile-event]` lines. Then:

```bash
pnpm profile:ios -- --config <config> --scenario <scenario> --events <event-log>
```

The runner prints the run folder. Read `summary.md` first.

To validate a v1 scenario, runner manifest, and initial planning artifacts before execution:

```bash
pnpm check-plan -- --scenario examples/scenarios/v1/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

This validates the input manifests, writes schema-checked `health.json` and `verdict.json`, writes `agent-summary.md`, and includes the raw planner match in `planner-compatibility.json`.

## Who this is for

- teams that want deterministic scenario contracts instead of ad-hoc automation scripts
- teams that want explicit product-truth events instead of screenshot-only pass/fail claims
- teams whose agents do performance work and need artifacts they can read, diff, and act on
- teams that expect to switch runners and refuse to lose their scenarios or evidence history when they do

What it is not:

- an end-to-end UI test framework
- a generic mobile automation stack
- a replacement for Codex, Argent, agent-device, adb, XcodeBuildMCP, AXe, or profilers
- zero-touch: your app emits the truth events, and that is the point

## Roadmap

Near-term:

- publish the package boundary and keep exported declarations stable
- add a neutral example app with canonical startup, open-close, scroll, and media scenarios
- harden a supported live iOS driver loop — simulator lifecycle, deep-link control, log capture — behind the existing artifact contract
- improve runner validation and failure reporting
- add historical comparison so agents can report improvement, regression, or inconclusive evidence against the last trusted run

Explicitly out of v1: Android, physical devices, Computer Use flows, product-specific scenarios.
