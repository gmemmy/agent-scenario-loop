# Example Mobile App

This is the neutral Expo dogfood app for Agent Scenario Loop. It exists to prove the package contract with app-owned truth events before public release work.

The app surface is intentionally small:

- startup emits launch-to-ready milestones
- card open-close emits repeated interaction milestones
- scroll-settle emits list movement and settled-state milestones

Current CI uses the committed profile-event logs in `event-logs/` with the iOS log-ingest runner. Live simulator/device execution should replace those logs behind the same scenarios and artifact layout.

The app is intentionally private and minimal. It uses Expo Router so future iOS and Android drivers can launch the same app surface without creating product-specific fixtures.

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
- `scenarios/android/*.json`: Android log-ingest scenario manifests
- `scenarios/ios/*.json`: iOS log-ingest scenario manifests
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
