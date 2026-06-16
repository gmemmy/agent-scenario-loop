# Example Mobile App

This is the neutral Expo dogfood app for Agent Scenario Loop. It exists to prove the package contract with app-owned truth events before public release work.

The app surface is intentionally small:

- startup emits launch-to-ready milestones
- card open-close emits repeated interaction milestones
- scroll-settle emits list movement and settled-state milestones

Release checks use the committed Android and iOS profile-event logs in `event-logs/` so package validation stays deterministic. Android adb capture can also launch the package, collect a bounded logcat window, and feed the same scenario artifacts through `profile:android --adb-capture`.

The app is intentionally private and minimal. It uses Expo Router so iOS and Android drivers can launch the same app surface without creating product-specific fixtures.

Android is the first live runtime target while iOS local tooling is unavailable:

```bash
pnpm install
pnpm android
```

From the package root, the same launch command is available as:

```bash
pnpm example:app:android
```

## Files

- `app/`: Expo Router routes for the example app
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

With an emulator or device online and the example app installed, the Android runner can own the capture window before writing profile artifacts:

```bash
pnpm profile:android -- --config examples/mobile-app/asl.config.json --scenario examples/mobile-app/scenarios/android/app-startup.json --adb-capture --clear-logcat --launch --wait-ms 5000 --run-id android-live-startup
```

If adb, the package, or the device is unavailable, the adb capture folder gets a failed `health.json` and the profile run stops before making timing claims.
