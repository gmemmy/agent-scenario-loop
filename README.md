# agent-scenario-loop

Evidence-first scenario orchestration for agent-driven mobile development.

Agent tools can edit code, build apps, drive devices, inspect accessibility trees, collect logs, run profilers, and summarize evidence. None of those capabilities should own a team's durable validation contract. `agent-scenario-loop` sits above tactical runners: it keeps scenario definitions, app-emitted truth events, stable artifacts, budgets, and before/after evidence in one contract that different runners can serve over time.

**Bring your own runner. Keep your scenarios. Keep your evidence.**

## How it works

1. You define a scenario as data: `app-startup`, `open-close-cycle`, or your own.
2. Your app emits truth events around the real user journey through a thin integration layer (`emitProfileEvent`), so a run's outcome is timestamped fact, not screenshot inference.
3. A runner executes the scenario and writes one stable artifact folder per run: metrics, budget verdict, summary, raw logs, captures, and optional signals.
4. You — or your agent — read the artifacts, compare against the last trusted run, and decide what to change next.

Runners and drivers (Codex, AXe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and whatever ships next) are adapters behind the scenario/evidence boundary. Scenarios, instrumentation, budgets, and run history survive every runner switch.

## What you get out of the box

V1 ships the contracts and the artifact pipeline:

- `app/profile-session.ts`: thin React Native integration — session control, truth events, signal attachments
- `core/artifact-contract.js`: the artifact builders — manifest, metrics, causal run, budget verdict, summary
- `core/planner.js`: planner compatibility checks between scenario requirements, primary runner capabilities, and evidence providers
- `core/schema-validator.js`: dependency-free validation for the JSON Schema subset used by the public v1 contracts
- `runner/profile-ios.js`: an iOS runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- `examples/scenarios/ios/`: transition scenario manifests for the current iOS log-ingest runner
- `examples/scenarios/v1/`: canonical v1 scenario fixtures
- `examples/runners/`: primary runner and evidence-provider capability fixtures
- `schemas/`: JSON Schemas for current artifacts plus the v1 scenario and runner capability contracts
- `docs/direction.md`: the product direction and extraction boundary for the public project
- `docs/v1-contract-plan.md`: the resolved v1 contract plan before runner migration

V1 does not yet ship live simulator orchestration as a supported public feature. The current runner assembles artifacts from event logs you capture; a fully automated runner/adapter loop is the next milestone, and it lands behind the same contract. Adopting the contracts now means that loop drops in later without rewrites.

Also out of v1 scope: Android, physical devices, and Computer Use flows.

## Public contracts

App-side, what your app exposes:

- session control: `startProfileSession`, `stopProfileSession`, `applyProfileSessionUrl`
- truth events: `emitProfileEvent`
- signal attachments: `storeProfileSignal`

Artifact layout, what every run produces:

- `manifest.json` — run identity: scenario, driver, simulator, tool versions, status
- `metrics.json` — cycle timings, failures, timeouts, budget evaluation
- `budget-verdict.json` — pass or fail against the scenario's committed budget, when budgets are configured
- `causal-run.json` — the run as a phase timeline
- `summary.md` — the human-readable readout
- `raw/`, `captures/`, and optional `signals/js`, `signals/memory`, `signals/network`

The v1 target contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, and `comparison.json` records before/after baseline comparison. `core/planner.js` can already derive initial health and unevaluated verdict artifacts from compatibility results. The current runner still writes `metrics.json` and `budget-verdict.json` as transition artifacts.

Budgets are supported but optional for adoption.

## Quick start

1. Copy `app/profile-session.ts` into your React Native app and wire `useProfileSessionBootstrap()` near the root.
2. Emit truth events around one real user journey. One journey is enough to start.
3. Copy `core/config-template.json` into project-specific config and fill in your app identifiers.
4. Start from `examples/scenarios/ios/app-startup.json` or `examples/scenarios/ios/open-close-cycle.json`.
5. Run the journey on a simulator — manually or with your driver of choice — while capturing device logs, so the log contains your `[profile-event]` lines. Then:

```bash
node runner/profile-ios.js --config <config> --scenario <scenario> --events <event-log>
```

The runner prints the run folder. Read `summary.md` first.

To validate a v1 scenario, runner manifest, and initial planning artifacts before execution:

```bash
node runner/check-plan.js --scenario examples/scenarios/v1/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

This validates the input manifests, writes schema-checked `health.json` and `verdict.json`, and includes the raw planner match in `planner-compatibility.json`.

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

- harden planner validation around the v1 scenario and runner capability schemas
- add a neutral example app with canonical startup, open-close, scroll, and media scenarios
- harden a supported live iOS driver loop — simulator lifecycle, deep-link control, log capture — behind the existing artifact contract
- improve runner validation and failure reporting
- add historical comparison so agents can report improvement, regression, or inconclusive evidence against the last trusted run

Explicitly out of v1: Android, physical devices, Computer Use flows, product-specific scenarios.
