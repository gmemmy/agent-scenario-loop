# Example Mobile App

This is the neutral Expo dogfood app for Agent Scenario Loop. It exists to prove the package contract with app-owned truth events before public release work.

The app surface is intentionally small:

- startup emits launch-to-ready milestones
- card open-close emits repeated interaction milestones
- scroll-settle emits list movement and settled-state milestones

Release checks use the committed Android and iOS profile-event logs in `event-logs/` so package validation stays deterministic. Android adb capture and iOS simctl capture can also launch the package, collect runtime evidence, and feed the same scenario artifacts through the profile runners.

The app is intentionally private and minimal. It uses a direct Expo entrypoint, a safe-area provider, and one screen so iOS and Android drivers can launch the same app surface without creating product-specific fixtures.

The iOS app uses `plugins/with-ios-build-compat.js` during Expo prebuild. That plugin generates the scene lifecycle shape required by newer iOS simulator runtimes and keeps generated Pods on the app deployment target. The app also declares `@expo/metro-runtime` directly because strict pnpm installs do not let Expo resolve transitive Metro runtime imports across package boundaries.

## Consumer Scaffold

The example app also carries the same project-local files a consuming app gets from `asl-init`:

- `src/devtools/profile-session.ts`: local app helper entrypoint used by the screen
- `runner-manifests/primary-runner.json`: portable iOS and Android runner capability manifest
- `runner-manifests/evidence-provider.json`: optional accessibility, profiler, memory, and network provider manifest
- `scenarios/mobile/app-startup.json`: portable startup scenario used for project validation
- `scenarios/mobile/open-close-cycle.json`: portable repeated interaction scenario profiled on both iOS and Android
- `scenarios/mobile/scroll-settle.json`: portable feed scroll scenario profiled on both iOS and Android
- `asl/package-scripts.json`: public CLI snippets that a consuming app can merge into `package.json`

Validate the example app exactly like a consumer project:

```bash
pnpm asl:validate
```

The app-local `asl:*` scripts build the package from the repo root, then call the compiled public CLIs from the example app directory.

Start the example app on Android with:

```bash
pnpm install
pnpm android
```

From the package root, the same launch command is available as:

```bash
pnpm example:app:android
```

Keep Metro running after this command opens the app.

Prepare the generated iOS project with:

```bash
pnpm ios:prebuild
```

From the package root, the same prebuild command is available as:

```bash
pnpm example:app:ios:prebuild
```

The generated `ios/` directory stays ignored. Commit the Expo config, package metadata, scenarios, patches, and config plugins that reproduce it, not the generated native output.

For an isolated Metro server that does not collide with another React Native app on `8081`, start Metro from the package root with:

```bash
pnpm example:app:start:isolated
```

The isolated command uses port `8097`. If the iOS simulator falls back to another Metro server, write the React Native packager override before launching the app:

```bash
pnpm example:app:ios:metro-port
```

The command targets the booted simulator and the example app bundle id by default. Override them with environment variables when needed:

```bash
ASL_EXAMPLE_IOS_DEVICE=<simulator-udid> ASL_EXAMPLE_METRO_PORT=8097 pnpm example:app:ios:metro-port
```

If a selected Xcode beta cannot run the current Expo/RN toolchain cleanly, point `ASL_EXAMPLE_XCODE_DEVELOPER_DIR` at a stable Xcode developer directory before running the iOS Metro-port, live proof, or raw local iOS build commands.

## Files

- `index.ts`: direct Expo entrypoint and safe-area provider
- `src/example-screen.tsx`: scenario surface wired to the local profile-session helper
- `package.json`, `app.json`, `tsconfig.json`: private Expo app configuration
- `metro.config.js`: allows the app to import the package helper from the repo/package root
- `asl.config.json`: runner config for example app artifact output
- `asl/package-scripts.json`: consumer-facing package-script snippets, including portable agent-device and Argent interaction proof commands
- `runner-manifests/*.json`: project-local runner and provider capability manifests
- `scripts/asl-capture-accessibility-provider.mjs`: deterministic accessibility provider command used by provider-profile scripts
- `scripts/asl-capture-profiler-provider.mjs`: deterministic profiler, memory, and network provider command used by provider-profile scripts
- `scenarios/mobile/app-startup.json`: portable consumer-validation scenario
- `scenarios/mobile/open-close-cycle.json`: portable open-close scenario backed by committed iOS and Android fixture logs
- `scenarios/mobile/scroll-settle.json`: portable scroll-settle scenario backed by committed iOS and Android fixture logs
- `scenarios/android/*.json`: Android profile scenario manifests
- `scenarios/ios/*.json`: iOS profile scenario manifests
- `event-logs/*.log`: deterministic profile-event evidence fixtures

## Fixture Proof

Run one example scenario through the package runner:

```bash
pnpm example:profile:startup
```

From inside `examples/mobile-app`, the consumer-shaped scripts are:

```bash
pnpm asl:validate
pnpm asl:check:ios
pnpm asl:check:android
pnpm asl:profile:ios
pnpm asl:profile:android
pnpm asl:profile:ios:provider
pnpm asl:profile:android:provider
pnpm asl:agent-device:check
pnpm asl:agent-device:ios
pnpm asl:agent-device:android
pnpm asl:argent:check
pnpm asl:argent:ios
pnpm asl:argent:android
ASL_ARGENT_BIN=/path/to/argent pnpm asl:argent:android
```

The `*:provider` scripts execute `runner-manifests/evidence-provider.json`, which runs the deterministic provider scripts and inventories generated accessibility, profiler, memory, and network evidence in `manifest.artifacts.evidenceAttachments`.

The `asl:agent-device:*` and `asl:argent:*` scripts are portable interaction proof lanes. They require the corresponding external tool and a running device or simulator, but they write the same ASL health, verdict, raw, capture, and summary artifacts. `asl:agent-device:check` verifies the configured agent-device command surface and device discovery before a scenario starts; set `ASL_AGENT_DEVICE_REQUIRED_PLATFORMS=ios,android` when both OS targets must be booted. `asl:argent:check` verifies the configured Argent command and ASL-required tool surface before any device scenario starts. For Argent, prefer a real `argent` executable on PATH, or set `ASL_ARGENT_BIN=/path/to/argent` when the package manager installed it somewhere else. `ASL_ARGENT_BIN=npx` with `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"` is supported as a wrapper shape, but run `pnpm asl:argent:check` before relying on it. Argent uses `--udid` for both iOS simulators and Android emulators, and ASL resolves the iOS `booted` shorthand to the concrete simulator UDID before invoking Argent.

Live proof and inspection scripts are also available from the app directory:

```bash
pnpm asl:android:live
pnpm asl:live-proof:android
pnpm asl:ios:live
pnpm asl:live-proof:ios
```

The live scripts pass `--compare-latest --fail-on-regression`, so they write comparison context by default and exit nonzero only when a comparable trusted baseline regresses. The live-proof inspection scripts also pass `--fail-on-regression` for already-written aggregate proof files. This keeps the dogfood example aligned with the package scaffold and makes regression evidence a real gate by default.

For suffixed live runs, point the inspection script at the generated proof file:

```bash
ASL_EXAMPLE_ANDROID_LIVE_PROOF=artifacts/asl/android-live/_live-proof/android-live-proof-dogfood/live-proof.json pnpm asl:live-proof:android
```

The runner writes `health.json`, `verdict.json`, `agent-summary.md`, `metrics.json`, `causal-run.json`, and raw evidence under the printed run directory.

Additional fixture-backed profiles:

```bash
pnpm example:profile:open-close
pnpm example:profile:scroll
pnpm example:profile:android:startup
pnpm example:profile:android:open-close
pnpm example:profile:android:scroll
```

## Android Capture

With an emulator or device online and the example app installed, the Android runner can own the capture window before writing profile artifacts. The full proof command starts with adb/package preflight, runs every canonical Android example scenario, and prints the `agent-summary.md` path for each run:

```bash
pnpm example:android:live
```

The aggregate command writes `_live-proof/android-live-proof/live-proof.json` and `_live-proof/android-live-proof/agent-summary.md` under the Android artifact root as the batch entrypoint.

When `agent-device` or Argent is available, attach the same startup interaction assertion as a sidecar proof:

```bash
pnpm example:android:live:agent-device -- --agent-device-session <name>
pnpm example:android:live:argent
pnpm example:android:live:runners -- --agent-device-session <name>
```

For Argent without a global binary, set `ASL_ARGENT_BIN=/path/to/argent` to the installed executable. The `npx --yes @swmansion/argent run` wrapper shape is supported through `ASL_ARGENT_BIN=npx` and `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"`, but verify it with `pnpm asl:argent:check` before relying on it.

The adb profile scenarios run before sidecar proofs. This keeps app-owned profile events, logs, screenshots, metrics, and verdicts independent from any UI automation session opened by agent-device or Argent.

The live Android commands assume the isolated Metro server is on port `8097`. They configure adb reverse and the app's React Native debug host as `localhost:8097` before launch, so the example app does not accidentally load another app's Metro bundle from the default `8081` port. To apply only that Android Metro routing setup, run:

```bash
pnpm example:app:android:metro-port
```

Override the target package or debug host when needed:

```bash
ASL_EXAMPLE_ANDROID_APP_ID=<package-name> ASL_EXAMPLE_ANDROID_DEBUG_HOST=<host:port> pnpm example:app:android:metro-port
```

The root example live scripts pass `--compare-latest --fail-on-regression` by default. Missing same-lane baselines are recorded as skipped comparison evidence; real regressions exit nonzero after artifacts are written. Pass a run suffix when you want preserved live artifact directories for before/after comparison:

```bash
pnpm example:android:live -- --run-suffix before-change
pnpm example:android:live -- --run-suffix after-change
```

The individual live commands remain useful while debugging one scenario:

```bash
pnpm example:profile:android:live:startup
pnpm example:profile:android:live:open-close
pnpm example:profile:android:live:scroll
```

The command targets live in the scenario `adapterOptions.androidAdb.commands` block, while the app handles them through `registerProfileCommandTargetHandler`. If adb, the package, or the device is unavailable, the adb capture folder gets a failed `health.json` and the profile run stops before making timing claims.

The example Android live proof uses a short `--launch-wait-ms` delay before sending profile-session deep links so React Native has time to attach its deep-link listener after cold launch. Keep that delay separate from `--command-wait-ms`, which waits after app-handled profile commands, and `--wait-ms`, which controls the final logcat capture window.

If direct `adb devices` works but the Node-based runner reports no online device and raw `adb-devices.txt` mentions the adb daemon or `Operation not permitted`, rerun with adb daemon permissions before treating the failure as an app, package, or emulator issue.

`scenarios/android/app-startup-video.json` is an opt-in variant that adds an optional `record` capture step. Use it when you want adb to preserve `captures.video` for a startup run without making video part of the default live proof.

## iOS Capture

With the example app installed on a booted iOS simulator and Metro connected, the iOS runner can own a simctl capture window before writing profile artifacts. The live commands use storage-backed profile-session and command seeding, so they do not depend on iOS unified logs carrying JavaScript console output:

```bash
pnpm example:ios:live
```

The aggregate command runs simctl preflight, startup, open-close, and scroll-settle. It also writes `_live-proof/ios-live-proof/live-proof.json` and `_live-proof/ios-live-proof/agent-summary.md` under the iOS artifact root as the batch entrypoint.

When `agent-device` or Argent is available, attach the same startup interaction assertion as a sidecar proof:

```bash
pnpm example:ios:live:agent-device -- --agent-device-session <name>
pnpm example:ios:live:argent
pnpm example:ios:live:runners -- --agent-device-session <name>
```

For Argent without a global binary, set `ASL_ARGENT_BIN=/path/to/argent` to the installed executable. The `npx --yes @swmansion/argent run` wrapper shape is supported through `ASL_ARGENT_BIN=npx` and `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"`, but verify it with `pnpm asl:argent:check` before relying on it.

The simctl profile scenarios run before sidecar proofs. This keeps stored app truth events, screenshots, metrics, and verdicts independent from any UI automation session opened by agent-device or Argent. When Argent can launch and inspect the iOS app but its screenshot backend is unavailable, the iOS live proof keeps the Argent warning and attaches a simctl screenshot fallback under the same interaction proof captures.

```bash
pnpm example:profile:ios:live:startup
pnpm example:profile:ios:live:open-close
pnpm example:profile:ios:live:scroll
```

The root example live scripts pass `--compare-latest --fail-on-regression` by default. Pass a run suffix when you want preserved iOS live artifact directories:

```bash
pnpm example:ios:live -- --run-suffix after-change
```

If global `xcode-select` points at a beta Xcode whose simulator services are not ready, set `ASL_EXAMPLE_XCODE_DEVELOPER_DIR` before the Node runner starts:

```bash
ASL_EXAMPLE_XCODE_DEVELOPER_DIR=<xcode-app>/Contents/Developer pnpm example:ios:live -- --device <booted-simulator-udid>
```

If direct `xcrun simctl list devices` works but the Node-based runner reports `ios_simctl_unavailable`, the runner may be inside an agent sandbox without CoreSimulator access. Rerun with simulator/CoreSimulator permissions before treating the failure as an app or Xcode setup regression.

Each command writes simctl capture evidence under `artifacts/example-mobile-app/ios/_ios-simctl-captures/<run-id>`, collects stored app truth events into `raw/ios-profile-events.log`, then writes scenario artifacts under the matching scenario run directory.

The command targets live in the scenario `adapterOptions.iosSimctl.commands` block, while the app handles them through `registerProfileCommandTargetHandler`. If simctl, the installed app, or the simulator is unavailable, the simctl capture folder gets a failed `health.json` and the profile run stops before making timing claims.
