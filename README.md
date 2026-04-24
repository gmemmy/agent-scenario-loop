# agent-scenario-loop

`agent-scenario-loop` is an iOS-first, contract-first profiling substrate for agent-operated React Native teams.

It is not a generic test framework. V1 focuses on deterministic mobile scenario execution inputs, explicit truth events, and stable profiling artifacts.

## V1 scope

This first public cut includes:

- `app/`: thin React Native session wiring and public app-side contracts
- `core/`: reusable artifact contract and config template
- `runner/profile-ios.js`: an iOS-first scaffold that writes the public artifact set from scenario metadata and profile-event logs
- `examples/`: generic iOS scenario manifests and minimal integration examples
- `docs/`: public principles for contract-first scenario execution

This first public cut does not include:

- live simulator orchestration as a supported public feature
- Android support
- physical-device flows
- Computer Use flows
- HelpBnk doctrine, selectors, bundle IDs, schemes, budgets, or product scenarios
- Codex rules or skills as required runtime dependencies

## Public contracts

The required public app-side contracts are:

- session control: `startProfileSession`, `stopProfileSession`, `applyProfileSessionUrl`
- truth events: `emitProfileEvent`
- signal attachments: `storeProfileSignal`

The stable artifact layout is:

- `manifest.json`
- `metrics.json`
- `summary.md`
- `raw/`
- `captures/`
- optional `signals/js`, `signals/memory`, `signals/network`

Budgets are supported, but optional for adoption.

## What is supported today

The supported public runner path in v1 is `runner/profile-ios.js`.

It reads:

- project config
- scenario metadata
- optional event logs containing `[profile-event]` entries

It writes:

- `manifest.json`
- `metrics.json`
- `causal-run.json`
- `budget-verdict.json` when budgets are configured
- `summary.md`
- copied raw event logs under `raw/`

That means the current release is suitable for teams that want to standardize scenario contracts and artifact shape first, then harden live orchestration behind the same contract later.

## Quick start

1. Copy `app/profile-session.ts` into your React Native app and wire `useProfileSessionBootstrap()` near the root.
2. Emit stable profile events around one real user journey.
3. Copy `core/config-template.json` into project-specific config and fill in app identifiers.
4. Start from `examples/scenarios/ios/app-startup.json` or `examples/scenarios/ios/open-close-cycle.json`.
5. Run `node runner/profile-ios.js --config <config> --scenario <scenario> --events <event-log>`.

## Positioning

`agent-scenario-loop` is for teams that want:

- deterministic scenario contracts
- explicit product-truth events instead of screenshot-only pass/fail claims
- stable profiling artifacts that agents and humans can inspect
- a thin app integration layer for React Native

It is not positioned as:

- an end-to-end UI test framework
- a generic mobile automation stack
- a full mobile developer OS in v1

## Roadmap

Near-term future work:

- harden a real supported iOS interaction driver path behind the same artifact contract
- improve runner validation and failure reporting
- add more complete example integrations

Explicitly out of v1:

- Android support
- physical-device flows
- Computer Use flows
- product-specific doctrine or scenarios
