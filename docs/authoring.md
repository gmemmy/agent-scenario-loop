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
- `cycles`: iteration count, stop policy, and optional setup/body step ids
- `budgets`: thresholds to evaluate only after truth-event health passes
- `artifacts`: required and optional evidence outputs

Use `comparisonLane` when a scenario should always compare within one stable proof mode, such as `feed-open-android-live`. Profile CLIs can also receive `--comparison-lane`; the CLI flag wins when one-off runs need a different lane.

For repeated scenarios, separate setup from the measured body. Commands that clear state, navigate home, dismiss modals, or establish readiness should not be measured every iteration unless that cleanup is the journey under test. Use `cycles.setupStepIds` for leading setup commands that run once, or `cycles.bodyStepIds` to name the repeated command body. If neither is provided, ASL profile-session runners infer a conservative setup prefix from readiness waits and measured milestone budgets, but explicit ids are clearer for complex flows.

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

### Resume Scenarios

`--lifecycle-phase resume` and related runner controls assert runner-owned lifecycle setup in `manifest.environment`; they do not create product truth events. If a scenario waits for `app_resumed`, `feed_restored_after_resume`, or another resumed-state milestone, the app must emit that event from the code path that proves resumed product readiness.

## Budget Intervals

Milestone budgets measure the interval the scenario names. A budget with only `toMilestone` measures elapsed time from the run or session clock origin to each matching milestone occurrence. That is correct for startup and first-usable-screen budgets, but it is cumulative for repeated interactions.

For transition or gesture budgets, provide both ends of the interval:

```json
{
  "name": "surface transition p95",
  "source": "milestone",
  "metric": "p95",
  "unit": "ms",
  "limit": 300,
  "fromMilestone": "surfaceTransitionRequested",
  "toMilestone": "surfaceSettled"
}
```

Use app-owned truth events for both milestones. Do not use a command-delivered event as the start point unless that command delivery is the product fact being measured.

When the start event is useful only as a timing anchor, keep it optional and keep scenario health tied to the completion truth. For repeated flows, set `metricEvents.milestone` or the completion-oriented cycle events to the truth that proves the iteration completed, then use the optional intent milestone as `fromMilestone` in the budget.

## Steps

Use steps to describe intent and required adapter actions:

- `launch`: app lifecycle start
- `command`: app command such as `activate-target:first-journey`
- `waitForMilestone`: wait for an app-owned truth event
- `captureEvidence`: collect logs, screenshot, profiler output, or another artifact
- `gesture`: portable UI gesture intent
- `assertUi`: UI assertion intent

Use `driverAction` only when the scenario truly requires a concrete operation such as `tap`, `longPress`, `scroll`, `swipe`, `drag`, `pinch`, `rotate`, `rotateGesture`, `typeText`, `fill`, `focus`, `pressKey`, `pressButton`, `assertVisible`, `screenshot`, `readLogs`, `collectPerfSignals`, `customGesture`, or `runSequence`. The planner fails early when no active runner or provider can satisfy a required driver action.

Input actions and observable results are separate. `longPress` is a held press, not proof that a menu, drag handle, selection affordance, reorder state, or another platform-owned surface appeared. `drag` is a press-move-release input, not proof that an item moved, a slider changed, or a reorder completed. `pinch` is a zoom gesture, not proof that zoom occurred. `rotate` is a device-orientation input, not proof that layout, state, or platform controls survived rotation. `rotateGesture` is a two-finger rotation input, not proof that content orientation changed. `focus` is focus input, not proof that the target became active. `pressKey` is a discrete key or system-button input, not proof that navigation, keyboard state, or another OS surface changed. `typeText` is keyboard input for an already focused field, and `fill` is target-backed text entry; neither proves that the field accepted or persisted the value. Pair input actions with app-owned milestones, `assertVisible`, UI context declarations, screenshots, or provider evidence before treating the run as product truth.

Use `customGesture` only for a named adapter-owned gesture whose full inputs are declared in `adapterOptions` and whose runner transcript records the resolved command, target binding, timeout, stdout/stderr, and unsupported/failed reason. Use `runSequence` only for a static list of known actions that can run without observing intermediate UI state; if step two depends on what step one reveals, model the steps separately with an assertion or milestone between them.

For profile-session command transport, platform `waitMs` metadata is queue pacing. ASL preserves it in storage and deep-link command envelopes and waits before releasing the next queued command. App-owned milestones still provide the truth that a command produced the intended product state.

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

Adapters may resolve selectors through accessibility trees, test ids, native UI inspection, or tool-specific selector engines. Android adb resolves `testId`, `resourceId`, `accessibilityId`, `accessibilityLabel`, and `text` selectors from UIAutomator bounds for tap and scroll actions. Argent gesture steps currently use normalized or pixel coordinates from `adapterOptions.argent`; it does not resolve tap, long-press, drag, pinch, rotate-gesture, or scroll targets from selectors. Coordinates belong in adapter metadata only when the selected runner cannot resolve a durable selector. If a tool exposes richer gestures than the bundled adapter declares, model them as unsupported until the adapter records command arguments, stdout/stderr, target binding, and failure class for that action.

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

Signals are copied into `signals/js`, `signals/memory`, or `signals/network` and listed in `manifest.json`. Captures are copied into `captures`; screenshots are listed in `artifacts.captures.screenshots`, while video and UI tree captures replace the matching named capture path in the manifest. Every attached file is also listed in `artifacts.evidenceAttachments` with kind, run-relative path, source filename, byte size, sha256 hash, completeness status, corruption status, redaction status, redaction policy metadata, and transformation list. Attached provider evidence is preserved as proof, but timing verdicts still come from app-owned truth events and budgets.

Provider manifests can also declare `providerCommands`. Profile runners execute those commands when passed with `--provider <manifest>`, but only when the provider manifest includes the selected platform. Commands run after the platform evidence source has been collected or supplied, so heavy diagnostics can be attached in a post-loop rehydration run with `--adb-artifacts` or `--simctl-artifacts` instead of perturbing the measured command window. Use `phase: "afterCapture"` for capture-sidecar diagnostics and `phase: "postRun"` for post-profile enrichment; older `capture` phase values remain accepted for existing manifests as an after-capture alias. The schema also reserves `prepare`, `startWindow`, `stopWindow`, and `finalize` for future lifecycle scheduling, but current profile runners fail those phases with `provider_lifecycle_phase_unsupported` rather than running them at the wrong time. A provider with `platforms: ["ios"]` passed to an Android profile writes failed `health.json` with `provider_platform_unsupported` and does not run the command. Commands run without a shell, can use placeholders such as `{providerDir}`, `{runDir}`, `{runId}`, `{scenarioId}`, and `{platform}`, and must declare their output files. Provider-channel outputs are copied or preserved under `raw/providers/<provider-id>/` and inventoried in `artifacts.evidenceAttachments`; signal and capture outputs can still map into the standard `signals/*` or `captures/` folders. An output can set `required: true` when the provider treats that file as required evidence; matching entries in `manifest.artifacts.diagnostics` then remain marked required in addition to scenario-authored `artifacts.required` and `requiredCapabilities`. Provider outputs can also set `redactionStatus` when the provider owns the privacy decision; ASL records that as `redactionPolicy.authority: "provider-declared"` and still treats unknown or not-redacted files as possible sensitive-data carriers. Command stdout, stderr, exit code, phase, and argv are preserved under `raw/provider-commands/`. When a provider command exits nonzero or declares an unsupported lifecycle phase, the runner writes failed `health.json`, inconclusive `verdict.json`, and `agent-summary.md` with a next-action hint instead of making timing claims.

The `examples/runners/script-*.json` manifests show package-neutral wrappers for accessibility, profiler, memory, network, and native performance evidence. They intentionally reference placeholder commands such as `capture-accessibility`, `capture-memory`, or `capture-native-performance`; replace those with your project-local script, binary, or agent command. The contract that matters is the declared output path and evidence kind, not the specific tool used to create the file.

Use `kind: "nativePerformance"` for platform-native render, frame, memory, or trace summaries. Android examples include Perfetto, trace-processor summaries, `gfxinfo`/framestats, `meminfo`, and logcat-derived render signals. iOS examples include Instruments, xctrace exports, MetricKit, or simulator-derived native performance summaries. JSON native-performance outputs are schema-validated and should preserve provider identity, tool metadata, target binding, lifecycle, completeness, comparability, and at least one content surface such as frames, memory, metrics, traces, attachments, or `diagnosticSources`. Keep raw traces attached, keep provenance explicit, and mark the evidence diagnostic-only until the scenario has a stable cohort and comparison policy for native metrics.

Use `diagnosticSources` when a provider needs to make platform parity or missing native lanes explicit. A scaffold can list Android sources such as `gfxinfo`, `framestats`, `meminfo`, `perfetto`, `trace-processor`, and `logcat-render`, or iOS sources such as `instruments`, `xctrace`, `metrickit`, and `simctl`, but it must mark uncaptured sources as `unverified`, `not-requested`, `unsupported`, `failed`, `timeout`, or `available-unproven`. Use `partial` when a source produced useful but incomplete evidence, `captured` only when artifacts or structured metrics are attached or summarized, and `unknown` only when the provider cannot classify the source outcome yet.

Project-local Android native-performance providers can use `buildAndroidNativePerformanceEvidence()` from the root package after capturing `dumpsys gfxinfo`, `dumpsys meminfo`, or a structured trace-processor summary. The helper normalizes headline frame, jank, render, memory, CPU, scheduling, and trace-window fields into the native-performance schema and deliberately leaves the evidence diagnostic-only; it does not make the run budget-comparable or release-ready by itself. Attach raw Perfetto traces and trace-processor output paths as provider artifacts so agents can inspect the source evidence without treating the helper as the capture owner.

Project-local iOS native-performance providers can use `buildIosNativePerformanceEvidence()` after capturing Instruments, xctrace, MetricKit, simctl, or project-local native trace summaries. The helper normalizes frame, hitch, memory, CPU, scheduling, thermal, battery, and trace-window fields into the native-performance schema while keeping capture, export, and trace-window ownership with the provider. It is diagnostic-only unless a later comparable capture lane proves target binding, completeness, and baseline compatibility.

Native-performance evidence may be attached as diagnostic-only even when it is partial or captured after the active loop. If a provider declares `comparability.status: "comparable"`, ASL treats that as a stronger claim: the evidence must name the tool, use a known capture mode, be complete, and verify the device/app target binding. Use `diagnostic-only`, `captured-not-comparable`, or `low-confidence` for useful evidence that can explain a run but should not drive a ratchet or release claim yet.

When a provider cannot prove it is attached to exactly the requested app and device, keep that uncertainty in `targetBinding` instead of hiding it in prose. Use `status: "ambiguous"` when multiple runtimes could own the evidence, `status: "mismatch"` when the provider observed a different app or device, and `candidateTargets` to list the expected and observed targets with their source artifact paths. Ambiguous or mismatched binding is diagnostic evidence only; it cannot support a comparable claim.

When native diagnostics are useful but incomplete, set `claimSufficiency.status` explicitly. Use `sufficient-for-diagnosis` for evidence that can guide the next bounded experiment, and `insufficient-for-claim` when a missing surface such as a trace window, accessibility snapshot, complete provider output, or comparable baseline prevents a product claim. Use `unknown` only when the provider preserves native evidence but cannot classify sufficiency yet. Reserve `sufficient-for-comparison` for complete, comparable, target-verified evidence; the schema rejects that overclaim when the supporting comparability, completeness, or binding fields are missing.

For React Native profiling, prefer a provider that emits both the raw profiler export and a structured JSON summary. JSON outputs with `kind: "profiler"` are validated against ASL's profiler evidence schema, so include the provider id, platform, run id, scenario id, tool metadata, completeness status, and at least one content surface such as samples, metrics, events, traces, a profile object, summary, or attachment references. If profiler evidence depends on explicit start/stop commands, model it as lifecycle-owned evidence: declare `captureMode`, `profileKind`, `lifecycle`, `targetBinding`, and `comparability` so agents can distinguish passive existing reports from session captures, inline captures that may perturb budgets, and after-capture or rehydrated diagnostics. CPU summaries derived from a prior profiler session should not be attached as passive evidence unless the provider also preserves the session provenance and raw attachments. If your profiler only produces a native trace or flamegraph, attach it as preserved evidence and avoid making performance claims until a provider translates the relevant facts into structured metrics.

## Artifacts

A completed profile run should leave the standard artifact set:

- `health.json`
- `verdict.json`
- `agent-summary.md`
- `manifest.json`
- `metrics.json`
- `causal-run.json`

`agent-summary.md` is an index over those truth files, not a replacement for them. It includes a `next action` section with a product-neutral owner so agents can route follow-up work without guessing: `runtime_environment`, `app_truth`, `provider_tooling`, `asl_runner`, `scenario_contract`, or `product_optimization`. Runtime identity, stale target state, and foreground mismatches point to `runtime_environment`; missing app milestones point to `app_truth`; partial or failed diagnostics point to `provider_tooling`; runner, sidecar, ingest, or artifact-finalization problems point to `asl_runner`; missing interval anchors or unmeasurable checks point to `scenario_contract`; and only health-passed measurable budget failures point to `product_optimization`.
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
