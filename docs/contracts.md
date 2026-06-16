# V1 Contracts

V1 ships the scenario, runner, and artifact contracts that make Agent Scenario Loop useful before a fully automated live runner exists.

The current package is intentionally contract-first: adopt the scenario and artifact shape now, then inherit more automated runner loops later without rewriting your scenarios.

## What ships today

- [app/profile-session.ts](../app/profile-session.ts): thin React Native integration for session control, truth events, and signal attachments
- [core/agent-summary.ts](../core/agent-summary.ts): agent-facing summary builder for health, verdict, and comparison state
- [core/artifact-layout.ts](../core/artifact-layout.ts): canonical v1 artifact path contract for one run directory
- [core/artifact-writer.ts](../core/artifact-writer.ts): schema-enforcing writers for stable JSON/text artifacts
- [core/comparison.ts](../core/comparison.ts): comparison artifact builder for trusted before/after run folders
- [core/artifact-contract.ts](../core/artifact-contract.ts): artifact builders for manifest, metrics, causal run, budget verdict, and summary
- [core/evidence-interpreter.ts](../core/evidence-interpreter.ts): evidence interpretation helpers that gate timing claims on scenario health
- [core/planner.ts](../core/planner.ts): compatibility checks between scenario requirements, primary runner capabilities, and evidence providers
- [core/ports.ts](../core/ports.ts): ports-and-adapters method surfaces for runners, drivers, providers, writers, and interpreters
- [core/schema-validator.ts](../core/schema-validator.ts): dependency-free validation for the JSON Schema subset used by the public v1 contracts
- [runner/profile-ios.ts](../runner/profile-ios.ts): iOS log-ingest runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- [examples/scenarios/ios](../examples/scenarios/ios): transition scenario manifests for the current iOS log-ingest runner
- [examples/scenarios/v1](../examples/scenarios/v1): canonical v1 scenario fixtures
- [examples/runners](../examples/runners): primary runner and evidence-provider capability fixtures
- [schemas](../schemas): JSON Schemas for current artifacts plus the v1 scenario and runner capability contracts

## Public app contract

App-side, your app exposes:

- session control: `startProfileSession`, `stopProfileSession`, `applyProfileSessionUrl`
- truth events: `emitProfileEvent`
- signal attachments: `storeProfileSignal`

The app integration is intentionally thin. The application emits truth; runners and providers collect evidence around it.

## Public artifact layout

Every v1 run should produce a stable artifact folder.

Core artifacts:

- `health.json`: whether the scenario execution was valid enough to interpret
- `verdict.json`: budget outcome for product behavior, or `not_evaluated` before evidence is collected
- `comparison.json`: optional before/after result against a trusted baseline
- `agent-summary.md`: agent-readable health gate and next-action summary
- `planner-compatibility.json`: optional preflight detail from runner/provider matching

Transition runner artifacts:

- `manifest.json`
- `metrics.json`
- `budget-verdict.json`
- `causal-run.json`
- `summary.md`

Evidence folders:

- `raw/`
- `captures/`
- optional `signals/js`
- optional `signals/memory`
- optional `signals/network`

The target v1 contract separates scenario health from product verdict: `health.json` records execution validity, `verdict.json` records budget outcome, `comparison.json` records before/after baseline comparison, and `agent-summary.md` gives agents the health gate before they touch code.

The current runner still writes `metrics.json` and `budget-verdict.json` as transition artifacts.

Budgets are supported but optional for adoption.

## Current scope

V1 does not yet ship live simulator orchestration as a supported public feature. The current runner assembles artifacts from event logs you capture. A fully automated runner/adapter loop is the next milestone, and it lands behind the same contract.

Out of v1 scope:

- Android
- physical devices
- Computer Use flows
- product-specific scenarios

## Preflight planning

Use `check-plan` to validate a scenario, runner manifest, and optional evidence-provider manifests before execution:

```bash
pnpm check-plan -- --scenario examples/scenarios/v1/app-startup.json --runner examples/runners/xcodebuildmcp-ios.json --platform ios --out artifacts/plan/app-startup
```

This validates the input manifests, writes schema-checked `health.json` and `verdict.json`, writes `agent-summary.md`, and includes the raw planner match in `planner-compatibility.json`.

## Historical comparison

Use `compare` to build `comparison.json` from two completed run folders:

```bash
pnpm compare -- --baseline artifacts/runs/app-startup/baseline --current artifacts/runs/app-startup/current --out artifacts/runs/app-startup/current
```

The comparison gate is intentionally strict. If either run failed scenario health, or if the scenario ids do not match, the comparison is `inconclusive`. Numeric budget checks are compared only after that health gate passes.

## Read next

- [README](../README.md) for the shortest path through the project
- [Concepts](concepts.md) for the broader product framing
- [Runner docs](../runner/README.md) for current runner behavior and limits
