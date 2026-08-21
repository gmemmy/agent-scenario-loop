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

Project validation checks the app-side profile-session helper, package-script snippets, app `package.json` script merge and drift, project config required fields, declared `drivers.supported` entries for fixture, adb, simctl, agent-device, and Argent lanes, scenario manifests, runner manifests, provider manifests, local provider-command script references, and planner compatibility. The helper check requires the control/truth exports plus `PROFILE_SESSION_STORAGE_KEYS` and helper payload identity exports, so storage-backed Android and iOS runners can detect stale helper wiring before runtime proof. Validation also classifies declared drivers into package-supported lanes, known external target contracts such as XcodeBuildMCP, and custom driver names, so agents can distinguish bundled ASL execution paths from adapter targets that must be supplied by the host project. Missing live app identifiers such as `app.profileSessionScheme`, `app.iosBundleId`, or `app.androidPackage` are errors for the selected platform, as are missing artifact roots and missing scenario-root declarations for the selected platform. Placeholder app identity values are reported as warnings so a fresh scaffold can still prove installability while real app setup remains visible before live proof. The JSON artifact also includes structured `nextActions` for agents.

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
| `templates/authority-capabilities.json` | Static authority declaration for one named claim-evidence producer |
| `templates/scripts/asl-capture-accessibility-provider.mjs` | Runnable starter provider command for deterministic accessibility evidence |
| `templates/scripts/asl-capture-native-performance-provider.mjs` | Starter native-performance provider with scaffold/input ingestion plus opt-in Android adb and iOS Simulator xctrace diagnostics |
| `templates/scripts/asl-capture-profiler-provider.mjs` | Runnable starter provider command for deterministic profiler, memory, and network evidence |
| `templates/integration-readme.md` | Consumer-app wiring guide generated into `asl/README.md` |
| `templates/package-scripts.json` | Package-script snippets generated into `asl/package-scripts.json`; project validation also checks that required scripts exist in app `package.json` and direct installed-bin scripts have not drifted |
| `templates/skills/agent-scenario-loop/SKILL.md` | Optional repository-scoped agent skill generated into `.agents/skills/agent-scenario-loop/SKILL.md` by `asl-init --with-agent-skill` |
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
- `steps`: launch, command, wait, gesture, assertion, or evidence capture steps; normalized step ids must be unique before cycle expansion

Preferred fields:

- `metadata`: product-owned tags and behavior coverage taxonomy
- `journey`: human-readable intent, actor, start state, and end state
- `comparisonLane`: default historical baseline lane for runs of this scenario
- `acceptedBaselineScenarioHashes`: explicit prior contract hashes that remain valid baselines
- `milestones`: named event checkpoints with phases and timeouts
- `cycles`: iteration count, stop policy, and optional setup/body step ids
- `cadence`: product-neutral pacing defaults for interaction settle windows
- `budgets`: thresholds to evaluate only after truth-event health passes
- `artifacts`: required and optional evidence outputs

### Claim-Complete Scenario Contracts

Scenario `1.0.0` remains the runnable legacy diagnostic format used by the
current templates and runners. It cannot declare `claims`, cannot become a
claim-complete product pass, and must not be certified by interpreting prose,
milestones, budgets, or artifact presence as implicit claims.

Scenario `1.1.0` is the additive claim declaration format. It requires a
complete journey shape, at least one mandatory claim, and an explicit static
safety declaration. A compact declaration
looks like this:

```json
{
  "schemaVersion": "1.1.0",
  "journey": {
    "name": "Open the account surface",
    "intent": "Reach and use the account surface, then return cleanly.",
    "actor": "signed-in user",
    "startState": "home is usable",
    "endState": "home is restored with no overlay owner",
    "phases": [
      { "id": "open-account", "description": "Open the account surface.", "coverageKind": "product" },
      { "id": "return-home", "description": "Dismiss and restore Home.", "coverageKind": "recovery" }
    ],
    "terminalInvariants": [
      { "id": "home-restored", "description": "Home owns input with no stale overlay.", "coverageKind": "recovery" }
    ],
    "recovery": {
      "status": "required",
      "rationale": "The surface supports interrupted dismissal.",
      "variants": [
        { "id": "reverse-dismissal", "description": "Reverse one partial dismissal before closing.", "coverageKind": "recovery" }
      ]
    }
  },
  "claims": [
    {
      "id": "home-ownership-restored",
      "role": "mandatory",
      "applicability": { "platforms": ["ios", "android"] },
      "closes": {
        "phases": ["open-account", "return-home"],
        "terminalInvariants": ["home-restored"]
      },
      "assertions": [
        {
          "id": "home-restored-event",
          "kind": "eventOccurrence",
          "event": "home_ownership_restored",
          "authority": {
            "role": "app",
            "producerId": "app-profile-session",
            "evidenceSelector": "profileEvents.home_ownership_restored",
            "requiredStrength": "observed",
            "completeness": "point"
          }
        }
      ]
    }
  ],
  "safety": {
    "class": "read_only",
    "rationale": "The journey observes navigation ownership without mutation.",
    "allowedOperations": ["navigate", "observe", "dismiss"]
  },
  "dependencies": [
    {
      "id": "authenticated-entry",
      "kind": "journey_entry",
      "applicability": { "platforms": ["ios", "android"] },
      "predicate": {
        "id": "authenticated-session-ready",
        "kind": "eventOccurrence",
        "event": "authenticated_session_ready",
        "authority": {
          "role": "app",
          "producerId": "app-profile-session",
          "evidenceSelector": "profileEvents.authenticated_session_ready",
          "requiredStrength": "observed",
          "completeness": "point"
        }
      }
    }
  ]
}
```

The omitted ordinary scenario fields remain required by the public schema.
Claims are flat conjunctions; do not nest assertions or add scripts that decide
their own result. `applicability` is authored before runtime. A missing adapter
or authority capability on a selected platform is unsupported evidence and a
`not_evaluable` requested claim, not retroactive `not_applicable` coverage.

Declare prerequisites in the required top-level `dependencies` inventory; use
an explicit empty array when the journey has none. A `journey_entry` dependency
gates the coherent journey. A `claim_scoped` dependency additionally names the
non-empty claim set it gates. Both reuse the closed assertion vocabulary as a
single `predicate`, including an exact authority requirement. Dependency IDs
are unique, claim references must resolve, and dependency applicability cannot
be broader than the scenario or any referenced claim. These are authored,
hash-bound contract facts, not mutable setup sidecars or runtime results.

Use `inspectScenarioClaimDependencies()` for one platform and optional variant
to validate identity, claim references, applicability, and the selected
dependency inventory. `complete` is structural only. Then include dependency
predicates in `inspectScenarioClaimAuthority()`; missing producer capability is
`incompatible`, not retroactive non-applicability. Neither reader observes a
predicate, releases a command, admits execution, or produces a verdict.

Use `coverageKind: "product"` for journey nodes that perform or preserve the
intended product outcome. Use `coverageKind: "recovery"` for authored
interruption, reversal, retry, cleanup, or restored-state truth. When recovery
is `required`, declare at least one recovery variant and at least one
recovery-owned phase or terminal invariant. When recovery is `not_required`,
declare neither. These labels make authored ownership explicit; they do not
turn setup, helper, command-delivery, or artifact-presence evidence into product
truth.

Classify the whole coherent journey as `read_only`, `local_mutation`,
`reversible_backend_mutation`, or `destructive`. Read-only declarations contain
only rationale and allowed operations. Mutating declarations name a stable
mutation identity, rollback and cleanup policy, and terminal reconciliation.
Bind mutation identity and every required safeguard to applicable mandatory
assertion IDs with exactly one applicable claim owner, and bind reconciliation
to both assertion IDs and authored terminal-invariant IDs. Do not put runtime authorization or human approval in
the scenario; those are separate run-bound decisions.

Keep human approval outside the scenario JSON. A claim-complete author or
reviewer can derive the full contract identity with
`buildScenarioClaimCompleteContractHash()` and preserve a separate closed
`scenario-claim-approval` record for one platform and optional variant. Any
scenario edit invalidates that conservative V1 approval. Do not embed the
approval, approver reference, credentials, runtime grant, or publication
permission into the scenario; doing so would mix the attestation into the
contract it attests. A matching approval remains exact-hash attestation only,
not permission to execute or proof that the journey works.

Keep runtime authorization in another sidecar. A claim-complete grant binds the
full scenario hash, exact platform and optional variant, safety class, goal,
target resource, complete operation set, and expiry. Mutating grants also bind
the scenario's authored mutation identity. Do not copy credentials into this
record, make the target optional, or broaden its operation set beyond
`safety.allowedOperations`. Use a caller-supplied clock when inspecting it;
the exact expiry boundary is no longer compatible.

`inspectScenarioClaimAuthorization()` is still an authoring and integration
reader. `compatible` does not authenticate the delegation chain, acquire a
resource, revalidate authorization at the first mutable action, compose final
admission, or enable scenario `1.1.0` execution. Human approval remains the
separate exact-hash attestation described above.

Use `inspectScenarioClaimSafety()` for one exact platform and optional variant.
Its `complete` result means only that the authored static safety references are
coherent. It does not authorize operations, prove a rollback implementation is
available at runtime, acquire a resource, or admit execution.

Use `inspectScenarioClaimClosure()` during authoring to inspect one exact
platform and optional variant. A `closed` result requires every authored phase
and terminal invariant to be referenced by an applicable mandatory claim.
Supplemental claims cannot fill mandatory closure gaps, and claims from another
platform or variant are not combined. Journey node and recovery-variant IDs
must also remain unique and unambiguous. The result is a structural authoring
check only, not runtime admission, support, approval, evaluation, or a product
pass.

After closure, use `inspectScenarioClaimAuthority()` with one or more validated
authority-capabilities declarations. Each declaration belongs to one named
producer and lists the exact platforms, assertion kinds, evidence selectors,
maximum identity strength, and maximum completeness it can supply. A
`validatedEvidence` producer must additionally list artifact kinds and named
validation contracts. Keep declarations separate from runner manifests:
generic runner capabilities and artifact outputs do not establish semantic
authority.

The assertion's `authority.role` and `authority.producerId` select one producer
exactly. ASL does not search for a more convenient producer after authoring and
does not combine declarations from different platforms. Missing static paths
make the selected contract incompatible rather than non-applicable.
Supplemental assertions require the same compatible path rigor as mandatory
assertions even though only mandatory claims close journey truth. The template
at `templates/authority-capabilities.json` is a product-neutral starting point;
replace its producer and selector vocabulary with the consuming project's
declared evidence contract.

This inspection is not admission or runtime capability discovery. The initial
declarations are caller-supplied and unsigned. Keep executable scenarios on
`1.0.0` until the later safety, authorization, exact-hash approval, and claim
evaluation gates are available.

This release surface makes the contract representable and provides pure
structural closure and authority-capability inspection. It does not admit
scenarios to runtime or generate claim results. Keep templates and executable scenarios on `1.0.0`
until the admission and claim-evaluation gates ship. Current planning and
profile entry points reject `1.1.0` before runtime rather than emitting a
misleading legacy verdict.

Use `comparisonLane` when a scenario should always compare within one stable proof mode, such as `feed-open-android-live`. Profile CLIs can also receive `--comparison-lane`; the CLI flag wins when one-off runs need a different lane.

Exact scenario hashes remain the default historical boundary. When a scenario
changes without invalidating earlier evidence, its author may list the exact
prior hashes in `acceptedBaselineScenarioHashes`. The declaration is
directional from the current scenario to older baselines, applies only to the
same scenario id, and is not transitive. ASL prefers an exact trusted baseline
before a newer declared-compatible baseline. Do not use this field to bridge a
renamed scenario, infer compatibility from structure, or rescue evidence whose
lane, cohort, health, verdict, or native capture policy is incompatible.

Use `metadata` when a consuming app needs machine-readable coverage context that
does not change runner behavior. ASL validates and preserves scenario metadata
in `run-plan.json` as `scenarioMetadata`, and projects standardized
`metadata.coverage` fields into project-validation plan entries as
`scenarioCoverage`. Project validation also writes a `coverageInventory` summary
that groups discovered scenarios by `featureSet`, `behaviorContract`, `variant`,
`coverageRole`, `coverageStatus`, `evidenceTier`, `platformContract`, and
platform, then lists missing or partial coverage metadata as warning-grade gaps.
Health, verdicts, budgets, command delivery, and comparisons do not interpret
coverage metadata.

The sanctioned behavior coverage namespace is `metadata.coverage`:

```json
{
  "metadata": {
    "coverage": {
      "featureSet": "account",
      "behaviorContract": "drawer opens and closes",
      "variant": "default",
      "coverageRole": "canonical",
      "riskClass": "core",
      "platformContract": "cross-platform",
      "fixtureContract": "signed-in user",
      "evidenceTier": "runtime-readiness",
      "coverageStatus": "active",
      "ownerOnFailure": "app_or_runtime"
    },
    "tags": ["account", "drawer"]
  }
}
```

`coverageRole` is intentionally closed to `canonical`, `stress`, `degraded`,
`platform-specific`, or `diagnostic`. Other coverage values are product-defined
strings. Additional `metadata` keys are allowed for app-owned taxonomy, but they
remain descriptive evidence context rather than scenario execution policy.
Because scenario metadata is part of the scenario contract, it participates in
`scenarioHash` just like milestones, budgets, and steps.

For repeated scenarios, separate setup from the measured body. Commands that clear state, navigate home, dismiss modals, or establish readiness should not be measured every iteration unless that cleanup is the journey under test. Use `cycles.setupStepIds` for leading setup commands that run once, or `cycles.bodyStepIds` to name the repeated command body. If neither is provided, ASL profile-session runners infer a conservative setup prefix from readiness waits and measured milestone budgets, but explicit ids are clearer for complex flows.

## Cadence

Use `cadence` when a scenario needs intentional pacing between interactions.
Cadence is runner pacing, not app truth. It gives the selected runner a bounded
settle window so multi-interaction flows can wait for natural UI motion,
keyboard transitions, sheet expansion, navigation handoff, or other expected
settling before the next command is released. App-owned milestones still prove
that the interaction produced the intended product state.

Scenario-level cadence can set a default or specialize by step kind:

```json
{
  "cadence": {
    "defaultSettleMs": 100,
    "commandSettleMs": 250,
    "gestureSettleMs": 150
  }
}
```

Step-level cadence overrides the scenario policy for the one interaction:

```json
{
  "id": "expand-composer",
  "kind": "command",
  "command": "comments-composer:expand",
  "cadence": {
    "settleMs": 600,
    "reason": "expanded composer waits for keyboard and sheet animation"
  }
}
```

Use cadence for pacing, and use `waitForMilestone` plus `timeoutMs` for
readiness proof. A cadence delay should be short and intentional; it should not
hide missing truth events, fixture gaps, or slow product behavior. Normalized
execution plans preserve resolved cadence with the source (`step`,
`scenario-kind`, or `scenario-default`) so artifact readers can distinguish
author-chosen pacing from adapter-specific waits.

For an ordered command followed by `waitForMilestone`, cadence is a minimum
settle window measured from command release, not an extra sleep after readiness.
The next command continues when both conditions are satisfied: the milestone
has arrived and the minimum settle window has elapsed. A fast milestone waits
only the remaining cadence; a slow milestone continues immediately instead of
paying the fixed delay again. `timeoutMs` remains the maximum correctness wait
and is not extended by cadence. When a milestone wait omits or supplies a
non-positive timeout, the profile runners and app helper impose a 30,000 ms correctness
bound; authors should declare a smaller feature-appropriate bound when the
expected readiness window is known.

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

Portable cadence owns pacing defaults. ASL does not convert command `timeoutMs`
into `waitMs` fallback sleeps. Keep `timeoutMs` for correctness deadlines and
use `cadence` (scenario or step) for perceptual settle pacing.

Platform command envelopes inherit portable execution-plan gates when adapter
values are absent: `waitMs`, `waitForMilestone`, `waitTimeoutMs`,
`dependsOnMilestones`, and cycle failure policy. Explicit adapter command
values remain authoritative. Platform command lists must map one-to-one to the
portable command plan by stable command id. Every adapter command must declare
`id` or `commandId`; labels and command text are not identity fallbacks.
Reordered commands retain their own policy; extra, omitted, or mismatched
commands fail planning instead of borrowing policy by array position.

`cycles.stopOnFailure` defaults to `true`. Profile-session helpers fail fast on
milestone or dependency timeout by default: the timed-out command is skipped,
remaining queued commands are skipped with `prior-command-failure`, and the
logical queue stops. Commands in another scenario, run, or queue remain
runnable. `dependsOnMilestones` uses that command's `waitTimeoutMs`, or the
existing 30-second milestone default when no valid timeout is declared. Set
`cycles.stopOnFailure: false` to skip only the blocked command and continue.
Fail-fast milestone and dependency skips are scoped to the same scenario, run,
and queue; independent queues remain runnable.

Treat each interaction as one bounded settle transition. The journey and step
describe intent; an app-owned milestone describes readiness (including stable
readiness when that is what the event contract asserts); cadence supplies the
minimum perceptual observation window; and the milestone `timeoutMs` supplies
the maximum correctness wait. Readiness and cadence run concurrently, so early
readiness waits only for the unspent settle window and late readiness does not
add a fixed post-readiness sleep. A timer alone is not proof that the product is
stable: scenarios that require stability must name an app-owned stable-readiness
milestone.

When a queued profile command declares `queueId` and `sequence`, command-result
truth events used to release that command must echo those correlation values.
Target handlers receive the full command envelope so apps can attach
`commandId`, `queueId`, and `sequence` to the resulting app-owned milestone.
Setup readiness is the one sanctioned queue-less path: a `waitForMilestone`
step listed in `cycles.setupStepIds` is sent as `unscopedMilestones`, and it can
release from a same-scenario, same-run truth event only when that event has no
`queueId` or `sequence`. Events from another queue do not release the gate.

Profile-session command acknowledgements record the resolved minimum settle,
maximum readiness wait, readiness wait, actual wait at continuation, overlap
saved versus sequential waits, whether the timeout was avoided, and the
continuation reason. Queue execution does not invent retries. Cross-run retry
count and terminal lineage remain owned by `manifest.attempt`.

For deep-link profile-session transport, the app helper suppresses exact duplicate commands that arrive inside the short native handoff window. The duplicate key includes scenario, run id, queue id, command id or command envelope id, sequence, and command text, so repeated scenario-cycle commands with distinct sequence or command identity remain valid commands. ASL-owned deep-link command envelopes may include `id` when the runner needs terminal command evidence to match a precomputed queue entry exactly. Unsequenced repeated commands should use storage transport or explicit command ids when the scenario expects multiple deliveries of the same semantic command.

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
  --signal network@redacted:artifacts/provider/network.har \
  --capture screenshot@not-redacted:artifacts/provider/final-screen.png \
  --capture uiTree:artifacts/provider/ui-tree.json
```

Signals are copied into `signals/js`, `signals/memory`, or `signals/network` and listed in `manifest.json`. Captures are copied into `captures`; screenshots are listed in `artifacts.captures.screenshots`, while video and UI tree captures replace the matching named capture path in the manifest. Every attached file is also listed in `artifacts.evidenceAttachments` with kind, run-relative path, source filename, byte size, sha256 hash, completeness status, corruption status, redaction status, redaction policy metadata, and transformation list. Use `kind@redacted:path`, `kind@not-redacted:path`, or `kind@unknown:path` only when the operator owns that redaction declaration; otherwise omit the suffix and ASL records `unknown`. Attached provider evidence is preserved as proof, but timing verdicts still come from app-owned truth events and budgets.

Provider manifests can also declare `providerCommands`. Profile runners execute those commands when passed with `--provider <manifest>`, but only when the provider manifest includes the selected platform. An individual command may narrow that applicability with `providerCommands[].platforms`; omitting it applies the command to every platform supported by the provider. An inapplicable command and its outputs are omitted from planning and execution rather than reported as missing or failed evidence. Rehydrated `--adb-artifacts`, `--simctl-artifacts`, and fixture/event-log runs stay post-capture-only so heavy diagnostics can be attached without perturbing the measured command window. Live `asl-profile-android --adb-capture` and `asl-profile-ios --simctl-capture` runs add truthful lifecycle scheduling around the active scenario loop: `startWindow` runs before the runner-owned capture window opens, `stopWindow` runs immediately after it closes, `afterCapture` runs only after the runner has staged same-run raw evidence into `raw/`, `captures/`, and `signals/*`, `postRun` remains post-profile enrichment, and `finalize` remains cleanup. Older `capture` phase values remain accepted as an `afterCapture` alias. Rehydrated and fixture runs fail `startWindow`, `stopWindow`, and `finalize` closed with `provider_lifecycle_phase_unsupported` instead of pretending they overlapped the measured interaction window. A provider with `platforms: ["ios"]` passed to an Android profile writes failed `health.json` with `provider_platform_unsupported` and does not run the command. Commands run without a shell, can use placeholders such as `{providerDir}`, `{providerId}`, `{runDir}`, `{runId}`, `{scenarioId}`, `{platform}`, `{appId}`, `{packageName}`, `{bundleId}`, `{serial}`, `{targetId}`, `{udid}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}`, and must declare their output files. Evidence-provider manifests at schemaVersion `1.1.0` may also declare top-level `exclusiveResources` when the provider must own an explicit resource before mutable work starts. V1 supports only two product-neutral claim kinds: the provider identity itself (`kind: "provider"`, including `providerId: "self"`) and explicit TCP ports (`kind: "tcpPort"`). `target: "selected-target"` may narrow provider claims only when the runner has already resolved an exact target id. Primary manifests, `1.0.0` provider manifests, mobile-target redeclarations, duplicate claims, or claims outside the closed phase window vocabulary are invalid. Live-window control phases require the exact runner-selected app and target identity; if the runner cannot supply that identity, ASL fails the provider command instead of launching an unbound native trace. Provider-owned exclusive resources acquire only after read-only preflight and after the runner-owned mobile-target lease is already trusted, then before the first mutable provider phase; multiple entering claims acquire all-or-nothing in canonical resource-id order and release in reverse order. Acquisition distrust, contention, heartbeat ownership loss, or release distrust blocks mutable provider work and fails the run while preserving valid partial diagnostics, and the runner writes the path-scrubbed journal to `raw/provider-resource-leases.json`. When a selected provider declares native-performance outputs, live adb/simctl runs also stage `raw/native-performance-request.json` before `startWindow`; that request records the requested app/target identity plus the runner-owned `activeLoop` window policy pointing at `raw/runner-active-loop-window.json`, and the live runner records its staged hash in immutable provider command args. Live adb/simctl runs also write the package-owned active-loop record to `raw/runner-active-loop-window.json`; trusted native comparison requires the provider target-binding window to copy that exact `startedAt`/`endedAt`/`durationMs` tuple rather than minting a separate provider-local window. Provider-channel outputs are copied or preserved under `raw/providers/<provider-id>/` and inventoried in `artifacts.evidenceAttachments`; signal and capture outputs can still map into the standard `signals/*` or `captures/` folders. Control-only phases may declare `outputs: []`. When a command does declare outputs, ASL requires each declared file to be freshly written during that command; stale preexisting files are rejected as untrusted evidence. For native-performance comparison truth, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` when a provider needs the hash-bound requested identity/window contract, write the observed target-binding record to `{nativeTargetBindingPath}`, which resolves to `raw/providers/<providerId>/target-binding.json`, and preserve any provider-owned normalization against the runner command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files. Comparable target-binding records must also include `captureArtifacts` entries that name the raw active-window capture artifacts used by the normalized evidence; each `captureArtifacts[].path` must match a hashed `outputs[]` entry from a `startWindow` or `stopWindow` command record whose `runRelativePath` matches that same path, and that path must also be surfaced by the native-performance envelope as an attachment, trace path, or diagnostic-source path. Once `afterCapture` writes that target-binding attachment and the owning command record hashes it, later cleanup must stay in separate `raw/provider-commands/` records rather than rewriting `target-binding.json` in place. An output can set `required: true` when the provider treats that file as required evidence; matching entries in `manifest.artifacts.diagnostics` then remain marked required in addition to scenario-authored `artifacts.required` and `requiredCapabilities`. Provider outputs can also set `redactionStatus` when the provider owns the privacy decision; ASL records that as `redactionPolicy.authority: "provider-declared"`, marks declared redacted outputs as `declared-non-sensitive`, and still treats unknown or not-redacted files as possible sensitive-data carriers. Command stdout, stderr, started/completed records, exit code, phase, and argv are preserved under `raw/provider-commands/`. When a provider command exits nonzero or declares an unsupported lifecycle phase, the runner writes failed `health.json`, inconclusive `verdict.json`, and `agent-summary.md` with a next-action hint instead of making timing claims.
Keep provider-owned comparison policy, tool/version, source, build mode, and environment as explicit provider command inputs (`providerCommands[].args` or `providerCommands[].env`) and keep `raw/native-performance-request.json` runner-owned for identity plus `activeLoop` window policy only.

Diagnostic inventory entries also carry `availability` and, in newer manifests, `sufficiency`. Use those fields to route the next action: `captured` plus `sufficiency.status: "satisfies-required-diagnostic"` means the surface is present and can satisfy the declared diagnostic requirement, while `captured-diagnostic-only` plus `diagnostic-only` means evidence survived but cannot satisfy a required claim. Native-performance evidence reaches the stronger state only when it has current run identity, a durable run-contained envelope, durable captured-source and target-proof paths, finite samples, a consistent bounded window, real capture time and clock metadata, complete evidence, an explicit comparison policy, and a sufficient comparison claim. `optional-preserved-evidence` means a non-required output was captured for inspection, `provider-blocked` points at provider command output, `unsupported` points at provider or runner capability selection, `environment-blocked` points at host/runtime setup, and the missing/not-requested values distinguish scenario intent from absent optional evidence.

The `examples/runners/script-*.json` manifests show package-neutral wrappers for accessibility, profiler, memory, network, and native performance evidence. They intentionally reference placeholder commands such as `capture-accessibility`, `capture-memory`, or `capture-native-performance`; replace those with your project-local script, binary, or agent command. The contract that matters is the declared output path and evidence kind, not the specific tool used to create the file.

Use `kind: "nativePerformance"` for platform-native render, frame, memory, or trace summaries. Android examples include Perfetto, trace-processor summaries, `gfxinfo`/framestats, `meminfo`, and logcat-derived render signals. iOS examples include Instruments, xctrace exports, MetricKit, or simulator-derived native performance summaries. JSON native-performance outputs are schema-validated and should preserve provider identity, tool metadata, target binding, lifecycle, completeness, comparability, and at least one content surface such as frames, memory, metrics, traces, attachments, or `diagnosticSources`. Keep raw traces attached, keep provenance explicit, and mark the evidence diagnostic-only until the scenario has a stable cohort and comparison policy for native metrics.

Use `diagnosticSources` when a provider needs to make platform parity or missing native lanes explicit. A scaffold can list Android sources such as `gfxinfo`, `framestats`, `meminfo`, `perfetto`, `trace-processor`, and `logcat-render`, or iOS sources such as `instruments`, `xctrace`, `metrickit`, and `simctl`, but it must mark uncaptured sources as `unverified`, `not-requested`, `unsupported`, `failed`, `timeout`, or `available-unproven`. Use `partial` when a source produced useful but incomplete evidence, `captured` only when artifacts or structured metrics are attached or summarized, and `unknown` only when the provider cannot classify the source outcome yet.

Project-local Android native-performance providers can use `buildAndroidNativePerformanceEvidence()` from the root package after capturing `dumpsys gfxinfo`, `dumpsys gfxinfo framestats`, `dumpsys meminfo`, or a structured trace-processor summary. The helper normalizes headline frame, per-frame framestats, jank, render, memory, CPU, scheduling, and trace-window fields into the native-performance schema and deliberately leaves the evidence diagnostic-only; it does not make the run budget-comparable or release-ready by itself. Attach raw Perfetto traces and trace-processor output paths as provider artifacts so agents can inspect the source evidence without treating the helper as the capture owner. When you need the trace itself to overlap the active scenario window, put the tool session under provider `startWindow`/`stopWindow`, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` to recover the hash-bound requested app/target identity plus runner-owned window policy, then emit the structured summary in `afterCapture`. For trusted comparison readiness, the same provider should also write a target-binding record to `{nativeTargetBindingPath}` with requested app/target ids, observed pid/name, observed app id, the bounded `activeLoop` window, `captureArtifacts` entries naming the raw active-window capture outputs, and `sourceCommands` references back to the immutable provider command records. That `activeLoop` window must exactly match `raw/runner-active-loop-window.json`, which the live runner writes before `afterCapture` begins. Those `captureArtifacts` must map to `startWindow` or `stopWindow` outputs that the native-performance envelope also surfaces as attachments, trace paths, or diagnostic-source paths. Pass `diagnosticSources` overrides when a provider needs to preserve that a source timed out, failed, was unsupported, or was intentionally skipped.

The generated starter provider offers opt-in native capture lanes. Android uses `ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE=1` and requires an explicit package id plus device serial. Its Android-only `startWindow` command resets the bounded `gfxinfo` window, its Android-only `stopWindow` command writes target serial/package/process plus `gfxinfo`, framestats, and `meminfo` stdout as directly declared raw outputs, and `afterCapture` normalizes only those preserved bytes without recollecting from adb. Failed, timed-out, partial, stale, hash-mismatched, or argv-mismatched stop-window records remain diagnostic-only and cannot establish `captureArtifacts`. iOS Simulator uses `ASL_NATIVE_PERFORMANCE_IOS_CAPTURE=1` and requires an explicit bundle id plus simulator UDID for bounded no-shell `xcrun simctl` target checks and `xcrun xctrace record/export --toc` capture. Both lanes preserve command argv/stdout/stderr/exit-timeout evidence and keep failures or partials visible; iOS additionally preserves run-relative TOC, target-binding proof, and trace-bundle inventory files because `.trace` captures are directory bundles. These lanes can become complete enough for diagnosis when every requested step succeeds, but they remain diagnostic-only and must not claim comparison readiness without structured samples, policy, and a compatible trusted baseline.

Project-local iOS native-performance providers can use `buildIosNativePerformanceEvidence()` after capturing Instruments, xctrace, MetricKit, simctl, or project-local native trace summaries. The helper normalizes frame, hitch, memory, CPU, scheduling, thermal, battery, and trace-window fields into the native-performance schema while keeping capture, export, and trace-window ownership with the provider. If the provider captures text/export summaries instead of already-normalized objects, use `parseIosXctraceSummaryText()` or `parseIosMetricKitSummaryText()` first, then pass the parsed result as `xctraceSummary`, `instrumentsSummary`, or `metricKitSummary`. When you need the trace itself to overlap the active scenario window, put the xctrace or simulator session under provider `startWindow`/`stopWindow`, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` to recover the hash-bound requested app/target identity plus runner-owned window policy, then emit the structured summary in `afterCapture`. For trusted comparison readiness, the same provider should also write a target-binding record to `{nativeTargetBindingPath}` with requested app/target ids, observed pid/name, observed simulator platform/template, the bounded `activeLoop` window, `captureArtifacts` entries naming the raw active-window capture outputs, and `sourceCommands` references back to the immutable provider command records. That `activeLoop` window must exactly match `raw/runner-active-loop-window.json`, which the live runner writes before `afterCapture` begins. Those `captureArtifacts` must map to `startWindow` or `stopWindow` outputs that the native-performance envelope also surfaces as attachments, trace paths, or diagnostic-source paths. Pass `diagnosticSources` overrides for iOS source outcomes that should remain visible even when no structured summary was captured. The result is diagnostic-only unless a comparable capture lane proves target binding, completeness, and baseline compatibility.

Native-performance evidence may be attached as diagnostic-only even when it is partial or captured after the active loop. If a provider declares `comparability.status: "comparable"`, ASL treats that as a stronger claim: the evidence must name the tool, use a known capture mode, be complete, verify the device/app target binding, and, for schemaVersion `1.1.0`, carry a structured `comparisonPolicy` plus `comparisonMetrics` contract. The comparison policy should prove provider identity, platform, capture mode/tool/version, bounded-window definition, target family/build mode, and declared environment conditions. The metric descriptors should name recognized samples, units, aggregations, tolerances, and any configured budget. Older `1.0.0` envelopes remain readable for diagnosis, but they do not satisfy trusted native comparison readiness by themselves. Use `diagnostic-only`, `captured-not-comparable`, or `low-confidence` for useful evidence that can explain a run but should not drive a ratchet or release claim yet.

When a provider cannot prove it is attached to exactly the requested app and device, keep that uncertainty in `targetBinding` instead of hiding it in prose. Use `status: "ambiguous"` when multiple runtimes could own the evidence, `status: "mismatch"` when the provider observed a different app or device, and `candidateTargets` to list the expected and observed targets with their source artifact paths. Ambiguous or mismatched binding is diagnostic evidence only; it cannot support a comparable claim.

When native diagnostics are useful but incomplete, set `claimSufficiency.status` explicitly. Use `sufficient-for-diagnosis` for evidence that can guide the next bounded experiment, and `insufficient-for-claim` when a missing surface such as a trace window, accessibility snapshot, complete provider output, or comparable baseline prevents a product claim. Use `unknown` only when the provider preserves native evidence but cannot classify sufficiency yet. Reserve `sufficient-for-comparison` for complete, comparable, target-verified evidence; the schema rejects that overclaim when the supporting comparability, completeness, or binding fields are missing.

Provider scripts that use the native-performance helper APIs can pass explicit `claimSufficiency`, `comparability`, `targetBinding`, `completenessStatus`, `comparisonPolicy`, and `comparisonMetrics` overrides instead of hand-building JSON envelopes. Use those overrides to keep partial native evidence useful while making the missing or ambiguous surface visible. App and device ids remain unverified until the provider supplies observed matching target proof. After structural schema validation, the shared comparison-readiness classifier still requires current platform/provider/run/scenario identity, a durable run-contained envelope, durable captured-source and target-proof paths resolved by the caller, recognized numeric native-performance measurements rather than timestamp or window metadata, a consistent bounded lifecycle or trace window, real capture time and clock metadata, complete evidence, an explicit comparable policy, and a sufficient comparison claim. Missing semantic proof keeps the artifact diagnostic-only without discarding it.

For React Native profiling, prefer a provider that emits both the raw profiler export and a structured JSON summary. JSON outputs with `kind: "profiler"` are validated against ASL's profiler evidence schema, so include the provider id, platform, run id, scenario id, tool metadata, completeness status, and at least one content surface such as samples, metrics, events, traces, a profile object, summary, or attachment references. If profiler evidence depends on explicit start/stop commands, model it as lifecycle-owned evidence: declare `captureMode`, `profileKind`, `lifecycle`, `targetBinding`, and `comparability` so agents can distinguish passive existing reports from session captures, inline captures that may perturb budgets, and after-capture or rehydrated diagnostics. CPU summaries derived from a prior profiler session should not be attached as passive evidence unless the provider also preserves the session provenance and raw attachments. If your profiler only produces a native trace or flamegraph, attach it as preserved evidence and avoid making performance claims until a provider translates the relevant facts into structured metrics.

## Artifacts

A completed profile run should leave the standard artifact set:

- `health.json`
- `verdict.json`
- `agent-summary.md`
- `manifest.json`
- `metrics.json`
- `causal-run.json`

`agent-summary.md` is an index over those truth files, not a replacement for them. It includes a `next action` section with a product-neutral owner so agents can route follow-up work without guessing: `runtime_environment`, `app_truth`, `provider_tooling`, `asl_runner`, `scenario_contract`, or `product_optimization`. Runtime identity, stale target state, and foreground mismatches point to `runtime_environment`; missing app milestones point to `app_truth`; partial or failed diagnostics point to `provider_tooling`; runner, sidecar, ingest, or artifact-finalization problems point to `asl_runner`; missing interval anchors or unmeasurable checks point to `scenario_contract`; and only health-passed measurable budget failures point to `product_optimization`. An ownerless `truth_events_incomplete` check uses the `unresolved` routing sentinel when evidence cannot distinguish app truth emission from scenario contract mapping; this sentinel is preserved through live-proof summaries but is not a resolved execution owner.
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
