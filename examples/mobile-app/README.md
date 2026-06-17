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
pnpm asl:agent-device:ios
pnpm asl:agent-device:android
pnpm asl:argent:ios
pnpm asl:argent:android
ASL_ARGENT_BIN=npx ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run" pnpm asl:argent:android
```

The `*:provider` scripts execute `runner-manifests/evidence-provider.json`, which runs the deterministic provider scripts and inventories generated accessibility, profiler, memory, and network evidence in `manifest.artifacts.evidenceAttachments`.

The `asl:agent-device:*` and `asl:argent:*` scripts are portable interaction proof lanes. They require the corresponding external tool and a running device or simulator, but they write the same ASL health, verdict, raw, capture, and summary artifacts. For Argent without a global binary, use `ASL_ARGENT_BIN=npx` with `ASL_ARGENT_BASE_ARGS="--yes @swmansion/argent run"`; Argent uses `--udid` for both iOS simulators and Android emulators.

Live proof and inspection scripts are also available from the app directory:

```bash
pnpm asl:android:live
pnpm asl:live-proof:android
pnpm asl:ios:live
pnpm asl:live-proof:ios
```

The live-proof scripts pass `--fail-on-regression`, so a comparison status of `regressed` exits nonzero. This keeps the dogfood example aligned with the package scaffold and makes regression evidence a real gate by default.

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

The live Android commands assume the isolated Metro server is on port `8097`. They configure adb reverse and the app's React Native debug host as `localhost:8097` before launch, so the example app does not accidentally load another app's Metro bundle from the default `8081` port. To apply only that Android Metro routing setup, run:

```bash
pnpm example:app:android:metro-port
```

Override the target package or debug host when needed:

```bash
ASL_EXAMPLE_ANDROID_APP_ID=<package-name> ASL_EXAMPLE_ANDROID_DEBUG_HOST=<host:port> pnpm example:app:android:metro-port
```

Pass a run suffix when you want preserved live artifact directories for before/after comparison:

```bash
pnpm example:android:live -- --run-suffix before-change
```

After a baseline exists, add `--compare-latest` to run every canonical Android scenario and write comparison summaries in the same command:

```bash
pnpm example:android:live -- --run-suffix after-change --compare-latest
```

Add `--fail-on-regression` when the aggregate command should return a nonzero exit after writing evidence for a regressed comparison:

```bash
pnpm example:android:live -- --run-suffix after-change --compare-latest --fail-on-regression
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

The aggregate command runs simctl preflight, startup, open-close, and scroll-settle. The individual scenario commands remain useful while debugging one scenario:

It also writes `_live-proof/ios-live-proof/live-proof.json` and `_live-proof/ios-live-proof/agent-summary.md` under the iOS artifact root as the batch entrypoint.

```bash
pnpm example:profile:ios:live:startup
pnpm example:profile:ios:live:open-close
pnpm example:profile:ios:live:scroll
```

Pass a run suffix when you want preserved iOS live artifact directories:

```bash
pnpm example:ios:live -- --run-suffix after-change
```

After a baseline exists, add `--compare-latest` to compare each passed iOS scenario against the latest trusted prior run:

```bash
pnpm example:ios:live -- --run-suffix after-change --compare-latest
```

Add `--fail-on-regression` when the aggregate command should return a nonzero exit after writing evidence for a regressed comparison:

```bash
pnpm example:ios:live -- --run-suffix after-change --compare-latest --fail-on-regression
```

If global `xcode-select` points at a beta Xcode whose simulator services are not ready, set `ASL_EXAMPLE_XCODE_DEVELOPER_DIR` before the Node runner starts:

```bash
ASL_EXAMPLE_XCODE_DEVELOPER_DIR=<xcode-app>/Contents/Developer pnpm example:ios:live -- --device <booted-simulator-udid>
```

If direct `xcrun simctl list devices` works but the Node-based runner reports `ios_simctl_unavailable`, the runner may be inside an agent sandbox without CoreSimulator access. Rerun with simulator/CoreSimulator permissions before treating the failure as an app or Xcode setup regression.

Each command writes simctl capture evidence under `artifacts/example-mobile-app/ios/_ios-simctl-captures/<run-id>`, collects stored app truth events into `raw/ios-profile-events.log`, then writes scenario artifacts under the matching scenario run directory.

The command targets live in the scenario `adapterOptions.iosSimctl.commands` block, while the app handles them through `registerProfileCommandTargetHandler`. If simctl, the installed app, or the simulator is unavailable, the simctl capture folder gets a failed `health.json` and the profile run stops before making timing claims.
