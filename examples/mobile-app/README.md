# Example Mobile App

This is the neutral Expo dogfood app for Agent Scenario Loop. It exists to prove the package contract with app-owned truth events before public release work.

The app surface is intentionally small:

- startup emits launch-to-ready milestones
- card open-close emits repeated interaction milestones
- scroll-settle emits list movement and settled-state milestones

Release checks use the committed Android and iOS profile-event logs in `event-logs/` so package validation stays deterministic. Android adb capture and iOS simctl capture can also launch the package, collect runtime evidence, and feed the same scenario artifacts through the profile runners.

The app is intentionally private and minimal. It uses a direct Expo entrypoint, a safe-area provider, and one screen so iOS and Android drivers can launch the same app surface without creating product-specific fixtures.

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

If a selected Xcode beta cannot run the current Expo/RN toolchain cleanly, point `ASL_EXAMPLE_XCODE_DEVELOPER_DIR` at a stable Xcode developer directory before running the iOS Metro-port command or raw local iOS build commands.

## Files

- `index.ts`: direct Expo entrypoint and safe-area provider
- `src/example-screen.tsx`: scenario surface wired to `app/profile-session.ts`
- `package.json`, `app.json`, `tsconfig.json`: private Expo app configuration
- `metro.config.js`: allows the app to import the package helper from the repo/package root
- `asl.config.json`: runner config for example app artifact output
- `scenarios/android/*.json`: Android profile scenario manifests
- `scenarios/ios/*.json`: iOS profile scenario manifests
- `event-logs/*.log`: deterministic profile-event evidence fixtures

## Fixture Proof

Run one example scenario through the package runner:

```bash
pnpm example:profile:startup
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

The individual live commands remain useful while debugging one scenario:

```bash
pnpm example:profile:android:live:startup
pnpm example:profile:android:live:open-close
pnpm example:profile:android:live:scroll
```

The command targets live in the scenario `adapterOptions.androidAdb.commands` block, while the app handles them through `registerProfileCommandTargetHandler`. If adb, the package, or the device is unavailable, the adb capture folder gets a failed `health.json` and the profile run stops before making timing claims.

`scenarios/android/app-startup-video.json` is an opt-in variant that adds an optional `record` capture step. Use it when you want adb to preserve `captures.video` for a startup run without making video part of the default live proof.

## iOS Capture

With the example app installed on a booted iOS simulator and Metro connected, the iOS runner can own a simctl capture window before writing profile artifacts. The live commands use storage-backed profile-session and command seeding, so they do not depend on iOS unified logs carrying JavaScript console output:

```bash
pnpm example:ios:live
```

The aggregate command runs simctl preflight, startup, open-close, and scroll-settle. The individual scenario commands remain useful while debugging one scenario:

```bash
pnpm example:profile:ios:live:startup
pnpm example:profile:ios:live:open-close
pnpm example:profile:ios:live:scroll
```

Pass a run suffix when you want preserved iOS live artifact directories:

```bash
pnpm example:ios:live -- --run-suffix after-change
```

Each command writes simctl capture evidence under `artifacts/example-mobile-app/ios/_ios-simctl-captures/<run-id>`, collects stored app truth events into `raw/ios-profile-events.log`, then writes scenario artifacts under the matching scenario run directory.

The command targets live in the scenario `adapterOptions.iosSimctl.commands` block, while the app handles them through `registerProfileCommandTargetHandler`. If simctl, the installed app, or the simulator is unavailable, the simctl capture folder gets a failed `health.json` and the profile run stops before making timing claims.
