# agent-scenario-loop

Driver-agnostic scenario orchestration and profiling evidence for React Native apps. iOS-first.

Agent device-control tools can tap, swipe, and screenshot, but none of them answer the question performance work actually asks: **did my change make this flow better?** `agent-scenario-loop` is the loop around those tools — deterministic scenarios, app-emitted truth events, stable profiling artifacts, and budget verdicts, behind one contract that any interaction driver can serve.

**Bring your own driver. Keep your evidence.**

## How it works

1. You define a scenario as data: `app-startup`, `open-close-cycle`, or your own.
2. Your app emits truth events around the real user journey through a thin integration layer (`emitProfileEvent`), so a run's outcome is timestamped fact, not screenshot inference.
3. A runner executes the scenario and writes one stable artifact folder per run: metrics, budget verdict, summary, raw logs, captures, and optional signals.
4. You — or your agent — read the artifacts, compare against the last trusted run, and decide what to change next.

Interaction drivers (AXe, XcodeBuildMCP, agent-device, Argent, and whatever ships next) are adapters behind the runner boundary. Scenarios, instrumentation, budgets, and run history survive every driver switch.

## What you get out of the box

V1 ships the contracts and the artifact pipeline:

- `app/profile-session.ts`: thin React Native integration — session control, truth events, signal attachments
- `core/artifact-contract.js`: the artifact builders — manifest, metrics, causal run, budget verdict, summary
- `runner/profile-ios.js`: an iOS runner that turns scenario metadata plus `[profile-event]` logs into the full artifact set
- `examples/scenarios/ios/`: scenario manifests to start from
- `schemas/`: JSON Schemas for `causal-run.json` and `budget-verdict.json`

V1 does not yet ship live simulator orchestration as a supported public feature. The current runner assembles artifacts from event logs you capture; a fully automated driver loop is the next milestone, and it lands behind the same contract. Adopting the contracts now means that loop drops in later without rewrites.

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

## Who this is for

- teams that want deterministic scenario contracts instead of ad-hoc automation scripts
- teams that want explicit product-truth events instead of screenshot-only pass/fail claims
- teams whose agents do performance work and need artifacts they can read, diff, and act on
- teams that expect to switch interaction drivers and refuse to lose their scenarios when they do

What it is not:

- an end-to-end UI test framework
- a generic mobile automation stack
- zero-touch: your app emits the truth events, and that is the point

## Roadmap

Near-term:

- harden a supported live iOS driver loop — simulator lifecycle, deep-link control, log capture — behind the existing artifact contract
- publish the interaction-driver adapter interface as a documented public contract
- improve runner validation and failure reporting
- add more complete example integrations

Explicitly out of v1: Android, physical devices, Computer Use flows, product-specific scenarios.
