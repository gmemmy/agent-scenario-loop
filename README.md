# Agent Scenario Loop

Agent Scenario Loop is an evidence-first scenario orchestration layer for agent-driven mobile development.

It lets teams define durable app scenarios once, run them through whichever agent, device, and profiling runners fit the job, collect stable evidence artifacts, compare before/after behavior, and give coding agents proof of improvement or regression.

Execution tools can change. The scenario and evidence contract should not.

**Bring your own runner. Keep your scenarios. Keep your evidence.**

Package: [agent-scenario-loop on npm](https://www.npmjs.com/package/agent-scenario-loop)

## Start Here

| If you want to... | Read this |
| --- | --- |
| Understand the idea in plain language | [Concepts](docs/concepts.md) |
| Understand the project doctrine | [Principles](docs/principles.md) |
| Understand why ASL is a protocol, not a TypeScript-only library | [Architecture](docs/architecture.md) |
| Implement or evaluate an out-of-process adapter in any language | [External Adapter Protocol](docs/external-adapter-protocol.md) |
| Inspect artifacts, schemas, and supported surfaces | [Contracts](docs/contracts.md) |
| Write your first scenario | [Scenario Authoring](docs/authoring.md) |
| Add a runner or evidence provider | [Adapter Onboarding](docs/adapters.md) |
| Rehearse adoption in an existing app | [Consumer App Rehearsal](docs/consumer-rehearsal.md) |
| Run fixture, Android, or iOS proofs | [Live Proofs](docs/live-proofs.md) |
| Use the package from code | [Public API](docs/api.md) |
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

## What Can It Orchestrate?

ASL is useful when a team needs a repeatable answer to "did this app journey work, and can we trust the evidence?"

Common workloads include:

- mobile startup, resume, navigation, scrolling, sheet, drawer, media, checkout, auth, network recovery, and upload flows
- regression checks that compare a current run with the latest trusted run
- provider-backed diagnostics such as screenshots, logs, memory, network, accessibility, profiler, or native performance summaries
- CI or release gates that should fail when runtime setup, app events, diagnostics, or budgets are not trustworthy
- agent handoffs where the next operator needs artifact paths and a clear owner for the next action

ASL works through files and commands. Scenario JSON goes in, runner and provider evidence comes out, and the result is captured as health, verdict, metrics, manifest, and summary artifacts. Agents, CI jobs, scripts, and humans can all operate against that same contract.

## A First Useful Case Study

A small first adoption does not need every runner or provider. Start with one journey:

1. Pick one user-visible behavior, such as app startup or opening a detail view.
2. Write a scenario file that names the expected steps and the app event that proves the journey completed.
3. Add the lightweight app helper and emit that app event from the real app code.
4. Run the scenario with the available runner, or use fixture logs while wiring the first integration.
5. Inspect the artifacts:
   - `health.json` says whether the run was trustworthy enough to interpret.
   - `verdict.json` says whether the run supports a pass, failure, or inconclusive result.
   - `metrics.json` contains measured samples when the scenario produced them.
   - `manifest.json` inventories the evidence that was actually captured.
   - `agent-summary.md` points an agent or human to the next action.

Once that single journey is reliable, add budgets, comparisons, provider diagnostics, and more platforms one at a time. A failed run is still useful when it clearly says whether the next fix belongs to device setup, the app event contract, a provider, the scenario, or product performance.

## What A Run Should Prove

A useful ASL run should leave enough evidence for an agent or human to answer five questions without relying on terminal memory:

1. **What command or scenario ran?** The artifact names the scenario, platform, run id, app target, runner, provider manifests, and command transport where the runner can prove them.
2. **What app truth happened?** The app emits profile-session milestones and signals; ASL preserves them in health, metrics, causal-run, and summary artifacts.
3. **What native or provider evidence was captured?** Logs, screenshots, accessibility output, profiler exports, memory/network evidence, and native-performance summaries are inventoried only when produced or intentionally referenced with status.
4. **Can this run support the claim?** Health gates interpretation. Budgets, comparisons, and optimization claims are trusted only when the scenario is healthy and the measured samples exist.
5. **Who owns the next action?** Artifacts should distinguish runner setup, provider/tooling, runtime environment, app truth, scenario contract, and product optimization work.

That is the loop: execute, preserve evidence, classify trust, compare when valid, and route the next bounded action to the right owner.

## Trust Boundaries

ASL keeps several trust boundaries explicit:

- **Runtime identity**: package or bundle id, foreground ownership, helper version, sidecar target, and stale profile-session evidence are runner-owned proof surfaces. When they cannot be verified, the run should not become product evidence.
- **App-owned truth**: application milestones are not synthesized by ASL. Missing truth means the scenario or app instrumentation needs inspection before timing claims are trusted.
- **Provider diagnostics**: provider outputs can be complete, partial, failed, unsupported, or diagnostic-only. Useful native or profiler evidence can survive a provider failure without pretending a missing surface exists.
- **Native performance**: `nativePerformance` is a first-class evidence kind for platform frame, render, memory, and trace summaries. Built-in Perfetto, gfxinfo, meminfo, Instruments, MetricKit, and trace-processor capture are not bundled; providers can attach structured summaries under the stable contract.
- **Platform coverage**: Android and iOS proof are separate unless both were exercised. A run on one platform is evidence for that platform only.
- **Summaries**: `agent-summary.md` is an index into artifacts, not a replacement for `health.json`, `verdict.json`, `metrics.json`, `manifest.json`, or raw evidence.

These boundaries let agents move quickly without optimizing from the wrong bundle, stale Metro graph, missing milestone, partial provider output, or diagnostic-only trace.

## Quick Start

Install or use the package, then scaffold a first scenario inside an app:

```bash
asl-init --out . --scenario first-journey
```

Add the optional repository-scoped agent skill when you want an agent workspace to load ASL operating guidance from the consuming app:

```bash
asl-init --out . --scenario first-journey --with-agent-skill
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
- a replacement for agent workspaces, device runners, adb, simctl, XcodeBuildMCP, Maestro, Detox, Appium, accessibility tooling, or profilers
- an agent evaluation framework

Those tools can still execute or observe the work. Agent Scenario Loop gives the scenario, evidence, and history a stable home.

## Package Guarantees

Current package guarantees are tracked in [Contracts](docs/contracts.md), [Runner docs](runner/README.md), and the release checks exercised by:

```bash
pnpm release:check
```

The package should remain product-neutral. Product-specific selectors, routes, auth assumptions, accounts, and scenario data belong in the consuming app, not in this repository.

## Read next

- [Concepts](docs/concepts.md) for the plain-language model
