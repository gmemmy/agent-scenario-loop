# Principles

`agent-scenario-loop` has one durable claim: scenarios, contracts, and evidence must outlive the current runner.

Read this after [Concepts](concepts.md). Concepts explains the model; this page is the compressed doctrine.

## Four planes

ASL separates mobile proof into four planes. Mixing them is the usual source of flaky claims.

1. Control plane
Use semantic app commands, deep links, and deterministic hooks to start and steer the scenario. Raw UI replay is a realism check, not the preferred control architecture.

2. Truth plane
Use app-owned truth events, stored signals, route state, and committed artifacts as the source of what happened.

3. Evidence plane
Preserve logs, screenshots, videos, profiler exports, memory captures, network captures, UI trees, metrics, verdicts, comparisons, and summaries in one stable artifact layout.

4. Realism plane
Use taps, swipes, alerts, full UI interaction, and external device tools to prove the app still behaves under real interaction pressure.

## Invariants

- Deterministic evidence beats quick scenario passability.
- Scenario health is part of product truth. A flaky scenario is not trustworthy evidence.
- Generated runs are outputs, not source.
- The artifact contract is a public API.
- App integration stays thin.
- Runners and interaction drivers are adapters, not schema owners. Scenarios and artifacts must outlive any individual runner.
- Runners can be swapped, combined, introduced, or compared without rewriting scenario definitions.
- The application behavior remains the locus of control. Tooling orbits the scenario; the scenario does not belong to the tooling.
- Every scenario execution should make future comparison easier by adding evidence and historical context.
- Failed or partial scenario health cannot support an optimization claim.
- Product-specific selectors, routes, auth assumptions, and domain events stay outside the orchestration core.
- Public claims stay narrower than internal ambition.

## Read next

- [Architecture](architecture.md) for the TypeScript-first, language-neutral contract boundary
