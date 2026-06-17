# Public API

Agent Scenario Loop keeps its public surface small: the root package exports stable core contracts, while runner subpaths expose executable adapters for teams that want to compose the proof loop from code.

## Root Package

Import core contracts from `agent-scenario-loop`:

```js
const {
  buildAgentSummaryMarkdown,
  buildScenarioExecutionPlan,
  buildRunIndex,
  compareRunDirectories,
  createArtifactLayout,
  evaluateRunnerCompatibility,
  validateJson,
} = require('agent-scenario-loop');
```

The root package is for stable, runner-neutral behavior:

- artifact layout and artifact writers
- profile-event parsing, metrics, manifests, causal runs, budget verdicts, and summaries
- scenario execution-plan normalization
- scenario/runner/provider compatibility checks
- port validation helpers
- typed port contracts for primary runners, drivers, evidence providers, artifact writers, and interpreters
- evidence interpretation gates
- run indexing and lane-aware latest-trusted comparison selection
- comparison artifacts
- aggregate live-proof artifacts
- schema validation

## Runner Subpaths

Runner subpaths are public when a consuming project needs to compose a workflow without shelling out to the installed binaries:

| Subpath | Purpose |
| --- | --- |
| `agent-scenario-loop/runner/agent-device` | agent-device capture runner that executes scenario-declared portable driver actions and writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/android-adb` | Android adb readiness, launch, profile-session control, driver actions, and logcat capture |
| `agent-scenario-loop/runner/android-adb-driver` | adb-backed `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, and `readLogs` driver adapter |
| `agent-scenario-loop/runner/agent-device-driver` | agent-device-backed portable action adapter for `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, `readLogs`, app open/close, and alert helpers |
| `agent-scenario-loop/runner/argent` | Argent capture runner that executes launch and coordinate-backed portable driver actions, then writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/argent-driver` | Argent-backed optional adapter for launch, URL open, normalized gestures, screenshots, and UI descriptions without bundling Argent |
| `agent-scenario-loop/runner/check-plan` | scenario/runner/provider compatibility artifact generation |
| `agent-scenario-loop/runner/compare` | direct baseline/current comparison |
| `agent-scenario-loop/runner/compare-latest` | latest trusted prior-run comparison |
| `agent-scenario-loop/runner/demo-loop` | fixture-only loop proof |
| `agent-scenario-loop/runner/example-android-live` | packaged Android example live proof |
| `agent-scenario-loop/runner/example-ios-live` | packaged iOS example live proof |
| `agent-scenario-loop/runner/init-project` | template scaffold command for consuming app layouts |
| `agent-scenario-loop/runner/ios-simctl` | iOS simctl readiness, storage-backed session control, and stored event capture |
| `agent-scenario-loop/runner/ios-simctl-driver` | simctl-backed `screenshot` and `readLogs` driver adapter |
| `agent-scenario-loop/runner/live-proof` | aggregate live-proof artifact validation, formatting, and regression gating |
| `agent-scenario-loop/runner/profile-android` | Android profile artifact pipeline |
| `agent-scenario-loop/runner/profile-ios` | iOS profile artifact pipeline |
| `agent-scenario-loop/runner/validate-project` | project-level validation for initialized consumer app scaffolds |

Installed binaries mirror those runner entrypoints for CLI use.

## Shipped Fixtures

The package intentionally ships schemas and examples:

- `agent-scenario-loop/schemas/*`
- `agent-scenario-loop/examples/*`
- `agent-scenario-loop/templates/*`

These are public fixtures and contract references. Templates are safe starting points to copy into a consuming app and adapt.

For concrete runner and evidence-provider integration steps, see [Adapter Onboarding](adapters.md).

## App Helper

`app/profile-session.ts` is shipped as source for React Native apps to copy into their own codebase. It is not a compiled CommonJS runtime export because it depends on app-side React Native modules, app bundling, and platform storage behavior.

The intended integration is:

1. Copy `app/profile-session.ts` into the app.
2. Wire `useProfileSessionBootstrap()` once near the app root.
3. Emit app-owned truth events with `emitProfileEvent()`.
4. Register optional command targets with `registerProfileCommandTargetHandler()`.

## Stability Rule

If a function, binary, schema, or example path is listed here, package smoke should verify that it is present in the packed tarball. If a new public entrypoint is added, update this document and the smoke expectations in the same change.
