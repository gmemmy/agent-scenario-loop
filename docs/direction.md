# Direction

`agent-scenario-loop` is an evidence-first scenario orchestration layer for agent-driven mobile development.

It is not primarily a test runner, a React Native profiling script, or an agent wrapper. It is the durable contract above those tools: define a mobile scenario once, execute it through whichever runner fits the job, preserve evidence in a stable artifact layout, and feed an agent a concrete improvement or regression verdict.

## Positioning

Short form:

> Bring your own runner. Keep your scenarios. Keep your evidence.

Category:

> Evidence-first scenario orchestration for agent-driven mobile development.

Expanded:

> Teams define durable mobile app scenarios once, run them through whichever agent, device, and profiling runners fit the job, collect stable evidence artifacts, compare before/after behavior, and give coding agents proof of improvement or regression.

## Why This Layer Exists

Agent-operated mobile development is fragmenting across useful tactical tools:

- code-editing agents
- simulator and device drivers
- adb and xcrun wrappers
- accessibility inspectors
- profilers
- log and network collectors
- visual capture tools
- summarizers and verdict writers

Those runners should remain replaceable. A team should not lose scenario definitions, run history, budgets, screenshots, logs, memory captures, or agent-readable summaries because one runner was replaced by another.

The strategic asset is the scenario and evidence contract. Runners are tactical implementations.

## What The Project Owns

`agent-scenario-loop` should own these public contracts:

- scenario definitions
- runner capability model
- adapter contract
- execution planning
- instrumentation lifecycle
- evidence capture
- artifact layout
- budget verdicts
- historical comparison
- agent-readable summaries
- human-readable summaries
- project configuration
- example app and canonical scenarios

It should not own every runner implementation. It should make runners pluggable and make their outputs comparable.

## What The Project Does Not Own

`agent-scenario-loop` should not become:

- a replacement for Codex
- a replacement for Argent
- a replacement for agent-device
- a replacement for adb
- a replacement for XcodeBuildMCP
- a replacement for AXe
- a replacement for platform profilers
- a generic CI platform
- a generic UI test framework
- an all-in-one mobile automation stack

The core remains orchestration plus evidence contracts.

## Architecture

```text
Scenario Contract
        |
Execution Planner
        |
Runner / Adapter Layer
        |
Instrumentation + Evidence Capture
        |
Artifact Contract
        |
Health + Verdict + Comparison
        |
Agent Feedback
```

The public API should make this separation obvious:

- scenarios describe intent, commands, expected events, budgets, and capture needs
- runners declare capabilities such as launch, command transport, UI interaction, log capture, screenshots, video, memory, network, and accessibility inspection
- adapters translate a planned scenario step into runner-specific operations
- instrumentation records app-owned truth events and signals
- artifacts preserve the run in a stable layout
- health records whether the scenario executed validly
- verdicts evaluate valid runs against declared budgets
- comparison evaluates the current run against an explicit baseline or the last trusted run

## Extraction Boundary

The current working source is a live React Native app with mature scenario infrastructure: profile-session lifecycle, deep-link command transport, persisted app-side events, JS/network/memory signal slots, iOS and Android scenario definitions, driver adapters, raw logs, captures, UI trees, native signals, budget verdicts, and summaries.

See `docs/helpbnk-loop-terrain.md` for the terrain brief behind this extraction boundary. The public project is not trying to prove the loop from scratch; it is distilling the reusable contract from a loop already proven in HelpBnk.

The public project should extract the reusable parts in this order:

1. Stable scenario schema and runner capability model.
2. Planner compatibility checks between scenario requirements and runner capabilities.
3. Neutral example app wired to `app/profile-session.ts`.
4. Live iOS runner that owns launch, session start/stop, log capture, and artifact assembly.
5. Historical comparison against the last trusted run.
6. Android runner parity behind the same scenario and artifact contracts.
7. Optional evidence providers for memory, network, accessibility, and profiler outputs.

Product-specific scenario names, selectors, app routes, auth assumptions, and domain events should stay out of the core package. They belong in consuming apps or in clearly marked examples.

## Near-Term Canonical Scenarios

The example app should prove the contract with a small scenario set:

- `app-startup`: launch to first usable screen
- `open-close-cycle`: open and dismiss a target surface repeatedly
- `scroll-settle`: scroll a list and measure settled/visible evidence
- `media-open-close`: open media, wait for visual readiness, dismiss cleanly

These scenarios are broad enough to represent real mobile work while staying neutral enough for other teams to adapt.

## Success Criteria

The project is converging when:

- a scenario can be run by more than one runner without changing its durable definition
- every run writes the same artifact contract
- agents can read `agent-summary.md`, `summary.md`, `causal-run.json`, `health.json`, `verdict.json`, and optional `comparison.json` before touching code
- failed or partial scenario health blocks optimization claims
- before/after comparison can say `better`, `worse`, `unchanged`, or `inconclusive`
- product-specific logic is in the app integration or examples, not the orchestration core

## Resolved V1 Decisions

These decisions came from the June 16, 2026 grilling session and should guide the next implementation pass:

- V1 is contract-first. Live device orchestration is not the launch gate.
- The primary consumer is a coding agent mid-task; human engineers review the evidence.
- Scenarios use product-language intent, not runner-language coordinates as the primary contract.
- Trusted verdicts require app-emitted truth events. Screenshot/UI inference can only support partial or inconclusive runs.
- The canonical scenario set is `app-startup`, `open-close-cycle`, `scroll-settle`, and `media-open-close`.
- Scenario requirements and runner capabilities are both declared; the planner matches them and fails early.
- Required v1 capabilities are `launch`, `sessionControl`, `command`, `logCapture`, and `artifactWrite`.
- Optional evidence capabilities include `screenshot`, `video`, `uiTree`, `memory`, `network`, `profiler`, and `accessibility`.
- A run has separate `healthStatus` and `verdictStatus`.
- Budget failure does not mean scenario-health failure. It means a valid run proved the product missed expectations.
- Required evidence failure makes a run `partial`; optional evidence failure becomes a warning.
- Comparison is a separate `comparison.json` artifact, referenced by `verdict.json` when present.
- Baseline comparison first supports an explicit baseline path; automatic baseline indexing comes later.
- A trusted baseline is derived from immutable run metadata and policy, with optional human acceptance recorded as immutable provenance.
- `summary.md` is human-readable. `agent-summary.md` is agent-facing and may recommend evidence-backed investigation areas labeled as inference.
- Core interpretation heuristics are generic. Project-specific interpretation packs can affect summaries and recommendations, not verdicts.
