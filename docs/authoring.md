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

The command refuses to overwrite existing files unless `--force` is provided. Use `--dry-run` to preview the file list without writing.

## Templates

You can also copy these files manually and rename them as needed:

| Template | Use |
| --- | --- |
| `templates/project.config.json` | Project-local app identifiers, artifact paths, and runner defaults |
| `templates/mobile-scenario.json` | First portable mobile scenario |
| `templates/primary-runner.json` | Primary runner capability manifest |
| `templates/evidence-provider.json` | Optional evidence-provider manifest |

The templates are valid JSON and are checked by package smoke. They intentionally use neutral placeholder names.

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
- `milestones`: named event checkpoints with phases and timeouts
- `cycles`: iteration count and stop policy
- `budgets`: thresholds to evaluate only after truth-event health passes
- `artifacts`: required and optional evidence outputs

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

Use `driverAction` only when the scenario truly requires a concrete operation such as `tap`, `scroll`, `screenshot`, `readLogs`, or `collectPerfSignals`. The planner fails early when no active runner or provider can satisfy a required driver action.

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
  --capture uiTree:artifacts/provider/ui-tree.json
```

Signals are copied into `signals/js`, `signals/memory`, or `signals/network` and listed in `manifest.json`. Captures are copied into `captures` and replace the matching named capture path in the manifest. Attached provider evidence is preserved as proof, but timing verdicts still come from app-owned truth events and budgets.

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
