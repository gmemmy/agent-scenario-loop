# Runner

The runner owns host execution. It is the boundary between scenario contracts and whichever tool actually drives the device or captures evidence.

The package ships fifteen public runner entrypoints. Package scripts build them into `dist/` before execution:

- `agent-device.ts`: executes scenario-declared portable driver actions through the external `agent-device` CLI, then writes ASL health, verdict, raw command transcripts, and capture artifacts.
- `android-adb.ts`: checks adb availability, connected Android device readiness, optional package installation, optional React Native debug-host setup, optional package launch, ordered adb driver actions, bounded logcat output, and raw adb evidence.
- `argent.ts`: executes scenario-declared launch and Argent-compatible portable driver actions through the external Argent CLI, then writes ASL health, verdict, raw command transcripts, and screenshot captures.
- `check-plan.ts`: validates a scenario manifest, primary runner capability manifest, and optional evidence-provider manifests, then writes schema-checked `health.json`, `verdict.json`, `agent-summary.md`, and `planner-compatibility.json` before execution.
- `compare.ts`: reads two completed run directories, validates `health.json` and `verdict.json`, then writes or prints a schema-checked `comparison.json`.
- `compare-latest.ts`: scans an artifact root for the newest trusted prior run for a scenario, rejects unhealthy current runs, then writes or prints a schema-checked `comparison.json`.
- `demo-loop.ts`: runs the fixture preflight, profile history, and latest-trusted comparison without requiring a simulator.
- `example-android-live.ts`: runs the packaged example Android live proof with adb preflight and the canonical startup, open-close, and scroll-settle scenarios.
- `example-ios-live.ts`: runs the packaged example iOS live proof with simctl preflight and the canonical startup, open-close, and scroll-settle scenarios.
- `init-project.ts`: copies package templates into a conventional consuming app layout without overwriting existing files by default.
- `ios-simctl.ts`: checks iOS simulator readiness, optional app installation, optional app launch, profile-session storage seeding, storage-backed command seeding, profile-session deep links, bounded simulator logs, stored profile-event collection, and writes raw simctl evidence.
- `live-proof.ts`: validates aggregate `live-proof.json` artifacts, prints their status and next action, and can fail on regressions.
- `profile-android.ts`: reads project config and an Android scenario manifest, then profiles explicit event logs, prior adb artifacts, or an owned adb capture window. During profile-session capture, Android-specific command metadata takes precedence; otherwise it derives command steps from `buildScenarioExecutionPlan()`.
- `profile-ios.ts`: reads project config and an iOS scenario manifest, then profiles explicit event logs, prior simctl artifacts, or an owned simctl capture window. During profile-session capture, iOS-specific command metadata takes precedence; otherwise it derives command steps from `buildScenarioExecutionPlan()`.
- `validate-project.ts`: validates initialized project config, scenario manifests, runner manifests, and planner compatibility before runtime proof.

The package also exports small adapter modules for device drivers. `runner/android-adb-driver` exposes adb-backed `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, `record`, and `readLogs` driver actions, and keeps Android-specific helpers such as log clearing, package launch, and deep-link execution behind explicit method names. `runner/ios-simctl-driver` exposes simctl-backed `screenshot` and `readLogs` evidence actions while keeping launch, terminate, and deep-link helpers explicit. The iOS screenshot action supports the synchronous `simctl io screenshot` options for image type, display, and mask. `runner/agent-device-driver` maps portable actions to the external `agent-device` CLI for iOS or Android, including app open/close and alert helpers, without making agent-device a package dependency. `runner/argent` wraps Argent as an ASL artifact-writing runner, while `runner/argent-driver` maps Argent's optional CLI/MCP-backed tool surface to coordinate-backed gestures, launch, screenshots, and UI descriptions without making Argent a package dependency. Planner compatibility fails early when Argent gesture steps omit required coordinate metadata or visibility assertions use non-exact selectors.

When `profile-android` owns an adb capture window, scenario steps with supported Android `driverAction` values are normalized through `buildScenarioExecutionPlan()` and routed to that adapter. Step metadata under `adapterOptions.androidAdb` can set log bounds, coordinate inputs, raw filenames, video capture filenames, screenrecord duration, remote screenrecord paths, and wait behavior while preserving `raw/adb-logcat.txt` as the default profile input for log capture. For tap and scroll steps without coordinates, Android adb can resolve portable selectors from UIAutomator bounds before issuing input commands. `assertVisible` uses the same selector contract and preserves the UIAutomator XML as raw evidence. `record` writes an adb command transcript under `raw/` and pulls the mp4 into `captures/`, where `profile-android` attaches it as the run's `captures.video` artifact.

When `profile-ios` owns a simctl capture window, a scenario step with `driverAction: "screenshot"` or `artifact: "screenshot"` requests a screenshot capture. The default path is `captures/ios-screenshot.png`; explicit simctl screenshot types use the matching extension, and the profile run attaches that screenshot through the same manifest capture contract used for provider artifacts.

When `profile-ios` or `profile-android` runs with `--agent-device-capture`, the profile runner executes scenario-declared portable driver actions through `agent-device` as a sidecar interaction window. App truth events still come from `--events`, `--simctl-capture`, or `--adb-capture`; agent-device contributes health-gated interaction proof and screenshots that are attached to the profile manifest.

When `--agent-device-session <name>` is supplied, the sidecar lets that existing session own agent-device target selection. Direct selectors such as Android serials or iOS UDIDs can still drive the adb/simctl profile window, but they are not forwarded into the agent-device commands where they can conflict with a session lock.

When iOS profile-session commands run through deep links, `ios-simctl` writes one raw file per opened URL and inventories each result in `raw/ios-metadata.json` with the label, URL, argv, exit code, wait, and raw path. A failed deep-link command fails capture health before the profile runner trusts timing evidence.

The artifact contract separates scenario health, product verdict, baseline comparison, and profile evidence into schema-checked files. `health.json`, `verdict.json`, and optional `comparison.json` provide the interpretation gate; `manifest.json`, `metrics.json`, `causal-run.json`, and `budget-verdict.json` preserve the profile evidence for agents and humans.

What it does not do yet:

- boot or control simulators
- install or build apps
- drive broad semantic UI workflows beyond selector-backed adb actions
- capture memory, network, or accessibility evidence from built-in drivers

Those deeper orchestration capabilities land behind the same artifact contract. Primary runners own one run lifecycle. Evidence providers attach optional or required evidence through a smaller provider interface. Provider manifests can declare no-shell commands and output files; profile runners preserve those outputs through `artifacts.evidenceAttachments` without bundling the provider tool. Tools such as axe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and log collectors plug in as adapters, so scenarios and artifacts stay stable while tactical tools change underneath.

Runner manifests separate `capabilities` from `driverActions`. Capabilities say the runner can own parts of the lifecycle or evidence contract. Driver actions say the underlying adapter can perform concrete operations such as `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, `record`, `readLogs`, or `collectPerfSignals`. `check-plan` fails before execution when a required scenario step declares a `driverAction` no active runner or provider supports.

`examples/runners` includes adapter-target manifests for `agent-device`, Argent, XcodeBuildMCP, and axe-style accessibility evidence, plus `script-*` provider manifests for accessibility, profiler, memory, and network evidence. These fixtures let the planner prove capability matching and command-output inventory. For agent-device, the shipped driver adapter covers the portable interaction subset while broader tool surfaces still stay behind explicit future adapters or provider attachments. For Argent, the shipped runner covers launch, coordinate-backed gestures, screenshots, and UI descriptions, while React profiler output first lands as provider evidence under `signals/js` unless a future adapter maps it into a stable ASL artifact.

After planning passes, `buildScenarioExecutionPlan()` normalizes scenario steps into the adapter-facing work list. It preserves app commands and milestones, records required versus optional steps, and maps step kinds to the runner port method that owns execution.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.

To exercise the full current loop without device runtime setup:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

The demo loop writes a baseline run, writes a current run, then uses the same latest-trusted comparison path that agents use against historical artifact roots.

To prove the neutral example app scenarios through committed app evidence:

```bash
pnpm example:profile:startup
pnpm example:profile:android:startup
```

To prove the portable agent-device driver path against an installed example app:

```bash
ASL_EXAMPLE_IOS_UDID=<simulator-udid> pnpm example:agent-device:ios:startup
ASL_EXAMPLE_ANDROID_AGENT_DEVICE_SESSION=android-example ASL_EXAMPLE_ANDROID_SERIAL=<emulator-serial> pnpm example:agent-device:android:startup
```

In sandboxed agent environments, run these commands with permission to access the local device driver state. The runner shells out to `agent-device`, which needs access to its daemon files and simulator or emulator control surfaces.

To wrap an existing Argent install in ASL artifacts:

```bash
ASL_EXAMPLE_IOS_UDID=<simulator-udid> pnpm example:argent:ios:startup
ASL_EXAMPLE_ANDROID_SERIAL=<emulator-serial> pnpm example:argent:android:startup
```

Pass `--argent`, `--base-args`, `--device-flag`, or `--app-flag` when your local Argent command shape differs from the default `argent run ...` invocation. Argent tap and scroll steps require coordinate metadata under `adapterOptions.argent`; visibility checks use the portable selector against Argent's app description output.

To check Android runtime readiness without starting scenario execution:

```bash
pnpm android:preflight -- --package com.example.app --out artifacts/android-adb-preflight
```

To attach raw Android logs around a manual or agent-driven run:

```bash
pnpm android:logcat -- --package com.example.app --logcat-lines 1000 --out artifacts/android-adb-logcat
```

To create a bounded Android launch capture:

```bash
pnpm android:logcat -- --package com.example.app --clear-logcat --launch --wait-ms 5000 --logcat-lines 1000 --out artifacts/android-adb-launch
```

For React Native development builds, add `--react-native-debug-host <host:port>` to make the capture window configure adb reverse and the app's `debug_http_host` preference before launch:

```bash
pnpm android:logcat -- --package com.example.app --react-native-debug-host localhost:8097 --clear-logcat --launch --wait-ms 5000 --out artifacts/android-adb-launch
```

That writes `raw/adb-react-native-reverse.txt` and `raw/adb-react-native-debug-host.txt` alongside the rest of the adb setup evidence.

To turn that captured logcat evidence into scenario artifacts:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-artifacts artifacts/android-adb-logcat --run-id <run-id>
```

To let `profile:android` own both the adb capture window and the profile artifact run:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-capture --clear-logcat --launch --wait-ms 5000 --run-id <run-id>
```

To run the example app through the current live capture paths:

```bash
pnpm example:app:android
pnpm example:android:live
pnpm example:ios:live
```

The aggregate Android and iOS live proof commands accept `--run-suffix <label>` when you want artifact directories that do not overwrite the deterministic default run ids:

```bash
pnpm example:android:live -- --run-suffix before-change
pnpm example:ios:live -- --run-suffix after-change
```

Add `--compare-latest` to have the aggregate command compare each passed scenario against the latest trusted prior run for that platform:

```bash
pnpm example:android:live -- --run-suffix after-change --compare-latest
pnpm example:ios:live -- --run-suffix after-change --compare-latest
```

The comparison step writes `comparison.json` and `agent-summary.md` under `artifacts/example-mobile-app/<platform>/comparisons/<scenario-id>/<run-id>`. The comparison artifact records `comparisonBasis`, including explicit baseline/current run folders or latest-trusted selection counts. Example live profiles also write a `comparisonLane` into `manifest.json`; latest-trusted comparison uses it to keep plain runs and agent-device-backed aggregate runs in separate baseline pools. Runs without a lane compare only against other unlabeled trusted runs. A missing prior trusted run is reported as skipped without failing an otherwise healthy live proof.

When the external `agent-device` CLI is available, add `--agent-device-proof` or run the package scripts below to attach the shared startup UI assertion to the aggregate proof. If `agent-device session list` shows the target device is already owned by a named session, pass `--agent-device-session <name>` so the aggregate proof reuses that session instead of contending for the device.

```bash
pnpm example:android:live:agent-device -- --agent-device-session <name> --run-suffix after-change --compare-latest
pnpm example:ios:live:agent-device -- --agent-device-session <name> --run-suffix after-change --compare-latest
```

Each aggregate live proof also writes `_live-proof/<run-id>/live-proof.json` and `_live-proof/<run-id>/agent-summary.md`, giving agents one batch entrypoint that links preflight evidence, scenario run summaries, per-profile health/verdict statuses, optional interaction proofs, optional comparisons, aggregate comparison counts, and per-comparison metric summaries.

To inspect or gate the batch artifact:

```bash
pnpm live-proof -- --file artifacts/example-mobile-app/android/_live-proof/android-live-proof/live-proof.json --fail-on-regression
```

The individual iOS profile commands remain useful while debugging one scenario:

```bash
pnpm example:profile:ios:live:startup
pnpm example:profile:ios:live:open-close
pnpm example:profile:ios:live:scroll
```

The iOS live commands seed the app-owned profile session into native AsyncStorage before launch. Command scenarios also seed a command queue into the same storage contract. After the capture window, the runner collects stored profile events from the simulator app data container. When stored events are present, `profile-ios` ingests `raw/ios-profile-events.log`; otherwise it falls back to bounded `raw/ios-simctl-log.txt` from the simctl capture artifact.

When multiple Xcode versions are installed, set `DEVELOPER_DIR` before invoking the Node runner to scope `xcrun simctl` to a specific Xcode without changing global `xcode-select`.
