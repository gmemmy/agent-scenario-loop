# Principles

`agent-scenario-loop` is a scenario orchestration and evidence collection layer for agent-driven software development.

The durable value is not any one runner. The durable value is a stable scenario and evidence contract that survives runner changes.

It is not another agent runner. It is the layer that coordinates runners, preserves evidence, and keeps scenarios useful as tooling changes.

## Four planes

1. Control plane
Use semantic app commands, deep links, and deterministic hooks before falling back to raw UI replay.

2. Truth plane
Use explicit profile events, stored signals, route state, and committed artifacts as the source of truth.

3. Evidence plane
Preserve logs, screenshots, videos, profiler exports, memory captures, network captures, UI trees, metrics, and verdicts in one stable artifact layout.

4. Realism plane
Use taps, swipes, and full UI interaction for realism checks and last-mile validation, not as the primary control architecture.

## Invariants

- Deterministic evidence beats quick scenario passability.
- Scenario health is part of product truth. A flaky scenario is not trustworthy evidence.
- Generated runs are outputs, not source.
- The artifact contract is a public API.
- App integration stays thin.
- Runners and interaction drivers are adapters, not schema owners. Scenarios and artifacts must outlive any individual runner.
- Runners can be swapped, combined, introduced, or compared without rewriting scenario definitions.
- Failed or partial scenario health cannot support an optimization claim.
- Product-specific selectors, routes, auth assumptions, and domain events stay outside the orchestration core.
- Public claims stay narrower than internal ambition.
