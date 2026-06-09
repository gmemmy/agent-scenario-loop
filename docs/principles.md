# Principles

`agent-scenario-loop` is a small agent-oriented foundation for deterministic mobile scenarios and stable profiling artifacts in React Native apps.

## Three planes

1. Control plane
Use semantic app commands, deep links, and deterministic hooks before falling back to raw UI replay.

2. Truth plane
Use explicit profile events, stored signals, route state, and committed artifacts as the source of truth.

3. Realism plane
Use taps, swipes, and full UI interaction for realism checks and last-mile validation, not as the primary control architecture.

## Invariants

- Deterministic evidence beats quick scenario passability.
- Scenario health is part of product truth. A flaky scenario is not trustworthy evidence.
- Generated runs are outputs, not source.
- The artifact contract is a public API.
- App integration stays thin.
- Interaction drivers are adapters, not schema owners. Scenarios and artifacts must outlive any individual driver.
- Public claims stay narrower than internal ambition.
