# V1 Contract Plan

Decision boundary:
- Confirmed: The current repo already emits `manifest.json`, `metrics.json`, `causal-run.json`, optional `budget-verdict.json`, and `summary.md` from log-ingested `[profile-event]` lines.
- Confirmed: V1 direction is contract-first, not blocked on live device orchestration.
- Inferred: Existing `metrics.json` and `budget-verdict.json` should remain as transition aliases while cleaner health/verdict artifacts land.
- Unknown: Exact runner adapter method signatures are not implemented yet.
- Needs live verification: Planner checks must be validated against a real example app and at least one real runner.

## Current State

The public repo has:

- `app/profile-session.ts` for app-side session control, truth events, and signal attachment.
- `core/artifact-contract.js` for current artifact builders.
- `core/planner.js` for compatibility checks between scenario requirements, primary runner capabilities, and evidence providers.
- `runner/profile-ios.js` for iOS log-ingest artifact generation.
- `schemas/causal-run.schema.json`, `schemas/budget-verdict.schema.json`, `schemas/scenario.schema.json`, and `schemas/runner-capabilities.schema.json`.
- `examples/scenarios/ios/app-startup.json` and `examples/scenarios/ios/open-close-cycle.json`.
- `examples/scenarios/v1/` canonical scenario fixtures.
- `examples/runners/` runner and evidence-provider capability fixtures.

The remaining schema gap is comparison and agent summary. Health and verdict schemas exist, and `core/planner.js` can map planner compatibility results into initial `health.json` and unevaluated `verdict.json` shapes.

## Contract Shape

V1 should define these durable contracts:

- `scenario.schema.json`: product-language scenario intent, required capabilities, truth milestones, budgets, steps, required/optional artifacts, and adapter options.
- `runner-capabilities.schema.json`: what a runner can provide before planner matching.
- `health.json`: scenario execution validity.
- `verdict.json`: budget and expectation outcome for a valid or partial run.
- `comparison.json`: current run versus explicit baseline path first, then indexed baseline lookup later.
- `agent-summary.md`: agent-facing next-action readout.
- `summary.md`: human-facing readout.

Compatibility rule:

```text
scenario.requiredCapabilities must be a subset of runner.capabilities
scenario.requiredEvidence must be satisfied by the primary runner or attached evidence providers
missing required truth milestones => healthStatus partial or failed
budget failure => verdictStatus failed, not healthStatus failed
missing optional evidence => warning
```

## Scenario Schema Decisions

Scenario definitions use product-language terms.

Required fields:

- `schemaVersion`
- `id`
- `flowId`
- `platforms`
- `requiredCapabilities`
- `truthEvents`
- `steps`

Canonical step kinds:

- `launch`
- `command`
- `waitForMilestone`
- `captureEvidence`
- `gesture`
- `assertUi`

Runner-specific details are allowed only through `adapterOptions`:

- root-level `adapterOptions` configures a runner for the whole scenario
- step-level `adapterOptions` tunes one canonical step

Truth events are declared as named milestones with exact app event bindings. Example:

```json
{
  "firstUsable": {
    "event": "app_first_usable_screen",
    "required": true
  }
}
```

## Runner Capability Decisions

Required v1 capabilities:

- `launch`
- `sessionControl`
- `command`
- `logCapture`
- `artifactWrite`

Optional evidence capabilities:

- `screenshot`
- `video`
- `uiTree`
- `memory`
- `network`
- `profiler`
- `accessibility`

Primary runner rule:

- One primary runner owns the run lifecycle in v1.
- Evidence providers can attach evidence through a smaller provider interface.
- Multi-runner orchestration is out of v1.

Evidence provider interface shape:

```text
prepare
startWindow
capture
stopWindow
finalize
```

Primary adapter interface shape:

```text
prepare
launch
startSession
executeStep
waitForTruthEvent
captureEvidence
stopSession
finalize
```

## Artifact Status Model

Use explicit statuses instead of one overloaded `status`.

`healthStatus` answers whether the scenario executed validly:

- `passed`
- `failed`
- `partial`

`verdictStatus` answers whether the valid evidence met expectations:

- `passed`
- `failed`
- `inconclusive`
- `not_evaluated`

`comparisonStatus` answers whether the current run improved against baseline:

- `better`
- `worse`
- `unchanged`
- `inconclusive`

Transition rule:

- Keep writing `metrics.json` and `budget-verdict.json` until the existing runner and examples are migrated.
- New code should treat `health.json`, `verdict.json`, and `comparison.json` as the cleaner target contract.

## Baseline Policy

First implementation:

- compare against an explicitly supplied baseline artifact path

Later implementation:

- support configurable baseline policy
- default local convenience policy can be `lastTrusted`
- reports should still record the exact baseline run id and artifact path

Baseline eligibility:

- health passed
- required truth milestones complete
- required capabilities satisfied
- required evidence present
- budgets passed or were explicitly accepted
- runner/config/device provenance recorded

Baseline trust should be derived from immutable metadata and policy. Human acceptance can be recorded as an immutable annotation, not as a mutable flag on the run.

## Agent Summary

`agent-summary.md` is separate from `summary.md`.

It should include:

- health status
- verdict status
- comparison status when available
- missing required evidence
- optional evidence warnings
- budget failures
- evidence-backed likely investigation areas
- explicit `do not optimize from this run` gates when health is failed or partial

Investigation recommendations are allowed only when tied to evidence and labeled as inference.
