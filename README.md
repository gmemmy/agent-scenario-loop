# Agent Scenario Loop

Agent Scenario Loop is an evidence-first scenario orchestration layer for agent-driven mobile development.

It lets teams define durable app scenarios once, run them through whichever agent, device, and profiling runners fit the job, collect stable evidence artifacts, compare before/after behavior, and give coding agents proof of improvement or regression.

Execution tools can change. The scenario and evidence contract should not.

**Bring your own runner. Keep your scenarios. Keep your evidence.**

## Start Here

| If you want to... | Read this |
| --- | --- |
| Understand the idea in plain language | [Concepts](docs/concepts.md) |
| Understand the project doctrine | [Principles](docs/principles.md) |
| Write your first scenario | [Scenario Authoring](docs/authoring.md) |
| Rehearse adoption in an existing app | [Consumer App Rehearsal](docs/consumer-rehearsal.md) |
| Inspect artifacts, schemas, and supported surfaces | [Contracts](docs/contracts.md) |
| Use the package from code | [Public API](docs/api.md) |
| Add a runner or evidence provider | [Adapter Onboarding](docs/adapters.md) |
| Run fixture, Android, or iOS proofs | [Live Proofs](docs/live-proofs.md) |
| Inspect runner behavior and limits | [Runner docs](runner/README.md) |
| Explore the neutral dogfood app | [examples/mobile-app](examples/mobile-app/README.md) |
| See runner and provider fixtures | [examples/runners](examples/runners/README.md) |

## The Model

Agent Scenario Loop keeps four things separate:

1. **Scenario**: the application behavior that matters, such as opening a feed, joining a livestream, uploading media, completing checkout, or loading a conversation.
2. **Runner**: the tool that executes or observes part of the scenario, such as adb, simctl, Agent Device, Argent, accessibility tooling, profilers, or internal scripts.
3. **Evidence**: the durable output from a run, including logs, metrics, traces, screenshots, accessibility results, budget verdicts, and custom signals.
4. **History**: trusted prior runs that let agents and humans compare whether behavior improved, regressed, or stayed inconclusive.

The scenario is the asset. Runners can change. Instrumentation can change. The app behavior remains.

## Quick Start

Install or use the package, then scaffold a first scenario inside an app:

```bash
asl-init --out . --scenario first-journey
```

Wire the generated app helper, emit truth events around one real journey, merge the generated `asl:*` scripts intentionally, then validate the project:

```bash
asl-validate-project --root . --platform all --out artifacts/asl/project-validation
```

Use `--config <file>` when a mature app keeps its ASL config outside the root `asl.config.json`.

Before runtime execution, validate a scenario and runner plan:

```bash
asl-check-plan \
  --scenario scenarios/mobile/first-journey.json \
  --runner runner-manifests/primary-runner.json \
  --platform android \
  --out artifacts/asl/plan/first-journey-android
```

No simulator or device available yet? Run the fixture loop:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

Read next:

- [Scenario Authoring](docs/authoring.md) for scenario shape and truth events
- [Consumer App Rehearsal](docs/consumer-rehearsal.md) for adoption in an existing app
- [Live Proofs](docs/live-proofs.md) for Android, iOS, comparison, and release-proof paths

## Package Surface

The root package exports stable core contracts:

```js
const {
  createArtifactLayout,
  evaluateRunnerCompatibility,
  buildScenarioExecutionPlan,
  buildRunIndex,
  findLatestTrustedRun,
} = require('agent-scenario-loop');
```

Installed CLIs include:

- project setup and validation: `asl-init`, `asl-validate-project`, `asl-check-plan`
- profile and comparison pipelines: `asl-profile-android`, `asl-profile-ios`, `asl-compare`, `asl-compare-latest`
- generic mobile live proofs: `asl-host-doctor`, `asl-live-android`, `asl-live-ios`, `asl-live-proof`
- runner-specific helpers: `asl-android-adb`, `asl-ios-simctl`, `asl-agent-device`, `asl-argent` (`asl-agent-device --check --out <dir>` and `asl-argent --check --out <dir>` verify configured external tool surfaces and preserve availability artifacts)
- dogfood and fixture helpers: `asl-demo-loop`, `asl-example-android-live`, `asl-example-ios-live`

Read [Public API](docs/api.md) for imports and [Contracts](docs/contracts.md) for artifact layout, schemas, and supported runner surfaces.

## What It Is Not

Agent Scenario Loop is not:

- an end-to-end UI test framework
- a generic mobile automation stack
- a replacement for Codex, Argent, Agent Device, adb, XcodeBuildMCP, Maestro, Detox, Appium, accessibility tooling, or profilers
- an agent evaluation framework

Those tools can still execute or observe the work. Agent Scenario Loop gives the scenario, evidence, and history a stable home.

## Package Guarantees

Current package guarantees are tracked in [Contracts](docs/contracts.md), [Runner docs](runner/README.md), and the release checks exercised by:

```bash
pnpm release:check
```

The package should remain product-neutral. Product-specific selectors, routes, auth assumptions, accounts, and scenario data belong in the consuming app, not in this repository.
