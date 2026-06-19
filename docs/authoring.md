# Scenario Authoring

Start with one journey that matters. A good scenario is boring, repeatable, inspectable, and portable.

## Init Command

After installing the package, scaffold the starter layout with:

```bash
asl-init --out . --scenario first-journey
```

That creates:

- `asl.config.json`
- `scenarios/mobile/first-journey.json`
- `runner-manifests/primary-runner.json`
- `runner-manifests/evidence-provider.json`
- `scripts/asl-capture-accessibility-provider.mjs`
- `scripts/asl-capture-profiler-provider.mjs`
- `src/devtools/profile-session.ts`
- `asl/README.md`
- `asl/package-scripts.json`
- `asl/gitignore-snippet`

The command refuses to overwrite existing files unless `--force` is provided. Use `--dry-run` to preview the file list without writing. It does not edit your existing `package.json` or `.gitignore`; merge the generated script and ignore snippets intentionally. Project validation reports an error until the required generated `asl:*` scripts are present in the app `package.json`, and it flags direct installed-bin scripts that drift from `asl/package-scripts.json`.

After filling in app identifiers, validate the whole initialized project before runtime proof:

```bash
asl-validate-project --root . --platform all --out artifacts/asl/project-validation
```

Project validation checks the app-side profile-session helper, package-script snippets, app `package.json` script merge and drift, project config required fields, declared `drivers.supported` entries for fixture, adb, simctl, agent-device, and Argent lanes, scenario manifests, runner manifests, provider manifests, local provider-command script references, and planner compatibility. Validation also classifies declared drivers into package-supported lanes, known external target contracts such as XcodeBuildMCP, and custom driver names, so agents can distinguish bundled ASL execution paths from adapter targets that must be supplied by the host project. Missing live app identifiers such as `app.profileSessionScheme`, `app.iosBundleId`, or `app.androidPackage` are errors for the selected platform, as are missing artifact roots and missing scenario-root declarations for the selected platform. Placeholder app identity values are reported as warnings so a fresh scaffold can still prove installability while real app setup remains visible before live proof. The JSON artifact also includes structured `nextActions` for agents.

Project validation also checks whether `.gitignore` includes the generated `asl/gitignore-snippet` patterns for runtime artifacts, local runner config, traces, and local proof captures. Missing patterns are warnings with an `ignore_runtime_artifacts` next action; they do not block setup, but they should be fixed before running live scenarios repeatedly.

The generated compare and live-proof scripts require `ASL_COMPARE_IOS_CURRENT`, `ASL_COMPARE_ANDROID_CURRENT`, or `ASL_LIVE_PROOF` so agents pass explicit artifact paths instead of leaving shell-sensitive placeholders in package scripts.

## Templates

You can also copy these files manually and rename them as needed:

| Template | Use |
| --- | --- |
| `templates/project.config.json` | Project-local app identifiers, artifact paths, and runner defaults |
| `templates/mobile-scenario.json` | First portable mobile scenario |
| `templates/primary-runner.json` | Primary runner capability manifest |
| `templates/evidence-provider.json` | Optional evidence-provider manifest |
| `templates/scripts/asl-capture-accessibility-provider.mjs` | Runnable starter provider command for deterministic accessibility evidence |
| `templates/scripts/asl-capture-profiler-provider.mjs` | Runnable starter provider command for deterministic profiler, memory, and network evidence |
| `templates/integration-readme.md` | Consumer-app wiring guide generated into `asl/README.md` |
| `templates/package-scripts.json` | Package-script snippets generated into `asl/package-scripts.json`; project validation also checks that required scripts exist in app `package.json` and direct installed-bin scripts have not drifted |
| `templates/skills/agent-scenario-loop/SKILL.md` | Optional repository-scoped Codex skill generated into `.agents/skills/agent-scenario-loop/SKILL.md` by `asl-init --with-agent-skill` |
| `templates/skills/agent-scenario-loop/references/*.md` | Optional skill references for artifact interpretation and adoption checks |

The JSON templates are schema-checked, and every shipped template is checked by package smoke. They intentionally use neutral placeholder names.

## Scenario Shape

A scenario should answer five questions:

1. What journey does the app need to prove?
2. Which app-owned truth events prove progress and completion?
3. How many cycles should run?
4. Which budgets are meaningful only after scenario health passes?
5. Which runner capabilities or driver actions are required?

Minimal fields:

- `id`: stable scenario id, such as `feed-open` or `checkout-submit`
- `flowId`: stable product flow id used in summaries and causal artifacts
- `platforms`: `ios`, `android`, or both
- `requiredCapabilities`: lifecycle and evidence ownership needed for the run
- `truthEvents`: app-owned events that make the scenario trustworthy
- `steps`: launch, command, wait, gesture, assertion, or evidence capture steps

Preferred fields:

- `journey`: human-readable intent, actor, start state, and end state
- `comparisonLane`: default historical baseline lane for runs of this scenario
- `milestones`: named event checkpoints with phases and timeouts
- `cycles`: iteration count and stop policy
- `budgets`: thresholds to evaluate only after truth-event health passes
- `artifacts`: required and optional evidence outputs

Use `comparisonLane` when a scenario should always compare within one stable proof mode, such as `feed-open-android-live`. Profile CLIs can also receive `--comparison-lane`; the CLI flag wins when one-off runs need a different lane.

## Truth Events

Treat truth events as app-owned facts, not runner observations. The app should emit them from the code path that actually represents the journey state.

Good truth events:

- `feed_open_requested`
- `feed_first_content_visible`
- `message_send_completed`
- `checkout_submit_failed`

Weak truth events:

- `button_clicked`
- `waited_1000ms`
- `screen_probably_loaded`

Timing is not trusted unless scenario health passes. If a required truth event is missing, the run can still write artifacts, but verdicts and comparisons must remain inconclusive.

## Steps

Use steps to describe intent and required adapter actions:

- `launch`: app lifecycle start
- `command`: app command such as `activate-target:first-journey`
- `waitForMilestone`: wait for an app-owned truth event
- `captureEvidence`: collect logs, screenshot, profiler output, or another artifact
- `gesture`: portable UI gesture intent
- `assertUi`: UI assertion intent

Use `driverAction` only when the scenario truly requires a concrete operation such as `tap`, `scroll`, `assertVisible`, `screenshot`, `readLogs`, or `collectPerfSignals`. The planner fails early when no active runner or provider can satisfy a required driver action.

Use `selector` to describe the intended app target without committing the scenario to one driver. Supported selector kinds are `testId`, `accessibilityId`, `accessibilityLabel`, `text`, `resourceId`, and `xpath`.

```json
{
  "id": "start-journey",
  "kind": "gesture",
  "driverAction": "tap",
  "selector": {
    "kind": "testId",
    "value": "first-journey-start"
  }
}
```

Adapters may resolve selectors through accessibility trees, test ids, native UI inspection, or tool-specific selector engines. Android adb resolves `testId`, `resourceId`, `accessibilityId`, `accessibilityLabel`, and `text` selectors from UIAutomator bounds for tap and scroll actions. Argent gesture steps currently use normalized or pixel coordinates from `adapterOptions.argent`; it does not resolve tap or scroll targets from selectors. Coordinates belong in adapter metadata only when the selected runner cannot resolve a durable selector.

## Runners And Providers

Primary runners own the run lifecycle: prepare, launch, start session, execute commands, wait, capture evidence, stop, and finalize.

Evidence providers attach smaller evidence windows: profiler data, accessibility snapshots, memory evidence, network evidence, or other signals.

Use an evidence provider when:

- the primary runner should not own that tool
- the evidence can be collected independently
- the same provider should work with multiple primary runners

When a provider or custom script has already written files, attach them to a profile run with repeatable CLI flags:

```bash
asl-profile-android \
  --config asl.config.json \
  --scenario scenarios/android/app-startup.json \
  --events artifacts/raw/adb-logcat.txt \
  --signal js:artifacts/provider/js-profile.json \
  --signal network:artifacts/provider/network.har \
  --capture screenshot:artifacts/provider/final-screen.png \
  --capture uiTree:artifacts/provider/ui-tree.json
```

Signals are copied into `signals/js`, `signals/memory`, or `signals/network` and listed in `manifest.json`. Captures are copied into `captures`; screenshots are listed in `artifacts.captures.screenshots`, while video and UI tree captures replace the matching named capture path in the manifest. Every attached file is also listed in `artifacts.evidenceAttachments` with kind, run-relative path, source filename, byte size, sha256 hash, completeness status, corruption status, redaction status, and transformation list. Attached provider evidence is preserved as proof, but timing verdicts still come from app-owned truth events and budgets.

Provider manifests can also declare `providerCommands`. Profile runners execute those commands when passed with `--provider <manifest>`, but only when the provider manifest includes the selected platform. A provider with `platforms: ["ios"]` passed to an Android profile writes failed `health.json` with `provider_platform_unsupported` and does not run the command. Commands run without a shell, can use placeholders such as `{providerDir}`, `{runDir}`, `{runId}`, `{scenarioId}`, and `{platform}`, and must declare their output files. Provider-channel outputs are copied or preserved under `raw/providers/<provider-id>/` and inventoried in `artifacts.evidenceAttachments`; signal and capture outputs can still map into the standard `signals/*` or `captures/` folders. Command stdout, stderr, exit code, phase, and argv are preserved under `raw/provider-commands/`. When a provider command exits nonzero, the runner writes failed `health.json`, inconclusive `verdict.json`, and `agent-summary.md` with a next-action hint instead of making timing claims.

The `examples/runners/script-*.json` manifests show package-neutral wrappers for accessibility, profiler, memory, and network evidence. They intentionally reference placeholder commands such as `capture-accessibility` or `capture-memory`; replace those with your project-local script, binary, or agent command. The contract that matters is the declared output path and evidence kind, not the specific tool used to create the file.

## Artifacts

A completed profile run should leave the standard artifact set:

- `health.json`
- `verdict.json`
- `agent-summary.md`
- `manifest.json`
- `metrics.json`
- `causal-run.json`
- `budget-verdict.json` when budgets are configured
- `summary.md`
- `raw/*`
- `captures/*`
- `signals/*`

Commit scenario definitions, runner manifests, docs, and app integration code. Do not commit generated native folders, runtime artifacts, simulator recordings, screenshots, profiler exports, or local app data containers.

## Validation

Validate a scenario and runner before execution:

```bash
pnpm check-plan -- --scenario templates/mobile-scenario.json --runner templates/primary-runner.json --platform ios --out artifacts/plan/first-journey
```

Run the release gate before publishing package changes:

```bash
pnpm release:check
```

## Read next

- [Adapter Onboarding](adapters.md) for runner and provider integration
