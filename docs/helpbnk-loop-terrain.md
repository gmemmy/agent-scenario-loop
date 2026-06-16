# HelpBnk Loop Terrain

Decision boundary:
- Confirmed: This brief is based on source inspection of the private HelpBnk app checkout and existing memory summaries, not a fresh live profiling run.
- Confirmed: HelpBnk already has a working agent-owned mobile scenario loop across app instrumentation, scenario definitions, iOS and Android runners, artifact generation, budgets, summaries, and signal capture.
- Inferred: Public `agent-scenario-loop` should extract the contract and adapter model from this terrain, not try to re-prove the idea with toy examples.
- Unknown: Current live pass/fail status for every HelpBnk scenario was not re-run during this pass.
- Needs live verification: Any implementation port should still be checked against a fresh HelpBnk scenario run before being treated as behaviorally equivalent.

## Why This Matters

The public project is not starting from a hypothesis.

HelpBnk has already proven that agents can use durable mobile scenarios, app-owned truth events, runner adapters, profiler/log/screenshot/UI-tree artifacts, budgets, and summaries to decide whether product changes improved or regressed real app behavior.

The extraction problem is therefore not:

> Can this idea work?

The extraction problem is:

> Which parts of the proven HelpBnk loop are reusable contracts, and which parts are HelpBnk-specific terrain?

## Proven Terrain

HelpBnk already has:

- `tools/profile-artifacts/scenarios/ios/**` and `tools/profile-artifacts/scenarios/android/**` with committed scenario definitions.
- `tools/profile-artifacts/scripts/profile-ios.js` and `profile-android.js` as host runners.
- `tools/profile-artifacts/scripts/profile-ios-driver.js` with `axe`, `xcodebuildmcp`, `agent-device`, and `argent` iOS driver adapters.
- `tools/profile-artifacts/scripts/profile-android-driver.js` with `adb` and `argent` Android interaction drivers.
- `createAndroidPerfSignalProvider` as a separate evidence-provider lane for profiler capture.
- `tools/mobile-agent-profile-loop/core/artifact-contract.js` as the shared artifact builder.
- `manifest.json`, `metrics.json`, `causal-run.json`, optional `budget-verdict.json`, `summary.md`, `raw/**`, `captures/**`, and `signals/**` per run.
- iOS native trace capture through `profile-ios-native.js`.
- Android evidence including logcat, screenrecord, uiautomator XML, `dumpsys gfxinfo`, and `dumpsys meminfo`.
- app-side profile session lifecycle in `src/devtools/profile-session.ts`.
- app-side persisted profile events, profile session entries, profile commands, and JS/memory/network signals through `src/devtools/profile-session-storage.ts`.
- route parsing and command policy in `src/devtools/profile-session-route-policy.ts` and `src/devtools/profile-session-command-policy.ts`.
- startup, home feed, gallery, media viewer, likes sheet, account drawer, pull-refresh, scope-switch, and app-resume instrumentation.

This is already a mature loop, not a thin test runner.

## Scenario Breadth

The committed scenario catalog covers:

- app startup
- app resume
- home feed scroll
- home feed scroll reversal
- home feed pagination
- home feed scope switching
- home feed chrome collapse/reveal
- pull refresh
- like toggle
- likes sheet
- account drawer
- gallery single image/video
- gallery multi image/video
- mixed media gallery
- mixed video-to-image gallery
- filtered all-video handoff
- inline video handoff
- iOS-only touch reliability and vertical/roundtrip gesture scenarios

The cross-platform state is deliberately uneven. Android is first-class for many scenarios, but some iOS flows remain blocked by Android selector or gesture-fidelity gaps. That is part of the maturity: the loop records what is real, what is partial, and why.

## App-Side Control Model

The app integration is not just `console.log`.

HelpBnk's profile session layer provides:

- profile session state: active scenario, run id, start time
- profile URL handling for `start`, `stop`, and `command`
- query-parameter command routing for Expo/dev-client edge cases
- command deduping by scenario/run/command signature
- target handler dispatch through `activate-target:<id>`
- fallback command subscribers for domain-specific command routers
- persisted commands so commands survive timing gaps
- persisted session recovery from AsyncStorage
- session expiry using `PROFILE_SESSION_MAX_AGE_MS`
- native logging bridge fallback to JS logging
- app-emitted `[profile-event]` lines
- stored JS/memory/network signals keyed by scenario/run id

The useful public abstraction is therefore not "emit log lines." It is an instrumentation lifecycle:

```text
start session
deliver semantic command
wait for app-owned milestone
capture evidence
persist signals
stop session
derive artifacts
```

## Runner Model

HelpBnk already split tactical runners from durable scenarios.

iOS:

- `axe` can describe UI, tap, swipe, screenshot, and record video.
- `agent-device` can snapshot, open URLs/apps, click selectors, press points, swipe, screenshot, and record video with fallback.
- `argent` can open URLs, launch apps, describe UI, tap/swipe through normalized coordinates, and screenshot, but video is not currently exposed.
- `xcodebuildmcp` can snapshot accessibility JSON, screenshot, tap id/label/point, swipe, and record video.

Android:

- `adb` owns fast lifecycle, intents, taps/swipes, screenshots, logcat, uiautomator XML, screenrecord, `dumpsys`, and AsyncStorage SQL through `run-as`.
- `argent` can be used as an Android interaction driver while keeping adb for platform plumbing.
- `argent` can also be used separately as a perf-signal provider around interaction windows.

The public contract should preserve this split:

- one primary runner owns lifecycle and scenario execution
- evidence providers attach optional or required evidence
- scenarios and artifacts survive driver changes

## Artifact Model

HelpBnk writes one run folder per scenario/run id.

The current artifact set is:

- `manifest.json`: run identity, driver, simulator/device, bundle/package, git sha, tool versions, artifact paths, failure reason
- `scenario.json`: resolved scenario used for that run
- `metrics.json`: timings, failures, timeouts, budget evaluation, contract evaluations, artifact references
- `causal-run.json`: timeline of app-owned events grouped into phases
- `budget-verdict.json`: pass/fail/partial against budgets when configured
- `summary.md`: human-readable readout
- `raw/**`: interaction logs, device logs, traces, exported native data
- `captures/**`: screenshots, videos, UI trees
- `signals/js`, `signals/memory`, `signals/network`, and native signal outputs

The public repo's planned `health.json`, `verdict.json`, `comparison.json`, and `agent-summary.md` should be seen as a cleanup of this proven artifact model, not as a replacement for a missing model.

## Scenario Health Doctrine

HelpBnk's doctrine is explicit:

- Do not optimize product code from a failed or partial run.
- If profile events are missing, cycles are incomplete, or timeouts occurred, harden the scenario or instrumentation first.
- A flaky scenario is not trustworthy evidence.
- Wrong bundle id, wrong scheme/configuration, wrong Android package, or ambiguous installed app variant invalidates the run.
- Timing budgets can pass while UI contract evidence is invalid; visual/UI contract checks still matter.

This is why public `agent-scenario-loop` needs separate health and verdict status. Budget failure is product evidence. Scenario failure is evidence invalidity.

## Evidence Escalation

The HelpBnk loop does not collect every possible signal on every run.

The default loop starts with:

- timing metrics
- app-emitted truth events
- summary
- screenshot/video where available
- UI tree where available
- app-side JS/network snapshots for specific scenarios

It escalates when timing is unstable, bottlenecks are ambiguous, or improvement plateaus:

- JS frame stats
- TanStack Query/network snapshots
- memory snapshots
- Rozenite/React profiler exports
- iOS native traces
- Android `gfxinfo`/`meminfo`

This supports the public model of optional and required evidence providers.

## What Is Reusable

Reusable contract surfaces:

- scenario definitions
- scenario health gate
- runner capability declarations
- adapter method surface
- evidence-provider method surface
- session lifecycle
- semantic command transport
- app-owned truth milestones
- artifact layout
- budget verdicts
- baseline comparison policy
- agent-readable summaries

Reusable implementation patterns:

- config-driven runner selection
- driver adapters behind a shared method surface
- separate interaction drivers and perf-signal providers
- persisted app-side events/signals as a fallback for log timing misses
- artifact folders as the coordination surface for agents
- generated run folders ignored by version control

## What Stays HelpBnk-Specific

These should not leak into public core:

- HelpBnk route names and auth assumptions
- `home-avatar`, `timeline-comment-action`, `image-viewer-close`, and other selectors
- feed scope/sort/topic semantics
- gallery media-shape selection policy
- inline video handoff internals
- account drawer specifics
- likes-sheet command names
- HelpBnk bundle ids, schemes, package names, simulator assumptions
- HelpBnk performance thresholds unless used as anonymized examples

They are evidence of maturity, not public API.

## Extraction Consequences

Public `agent-scenario-loop` should not feel like a demo proving that scenario loops can work.

It should feel like a distilled version of the proven HelpBnk loop:

- strict contracts first
- neutral canonical scenarios
- no product-specific selectors in core
- planner compatibility before execution
- one primary runner per run
- evidence providers as attachments
- health before verdict
- explicit partial/inconclusive states
- artifact history as the durable asset

The next implementation work should continue from this terrain:

1. Keep new public schemas strict.
2. Add a plan/check CLI that writes `health.json` and `verdict.json` before live execution.
3. Port runner behavior only after the public contracts can represent the proven HelpBnk cases.
4. Use HelpBnk scenarios as regression examples for the contract shape, not as public core fixtures.
