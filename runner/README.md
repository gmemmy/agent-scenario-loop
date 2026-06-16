# Runner

The runner owns host execution. It is the boundary between scenario contracts and whichever tool actually drives the device or captures evidence.

The package ships five supported TypeScript runner sources. Package scripts build them into `dist/` before execution:

- `android-adb.ts`: checks adb availability, connected Android device readiness, optional package installation, and writes raw adb evidence.
- `check-plan.ts`: validates a scenario manifest, primary runner capability manifest, and optional evidence-provider manifests, then writes schema-checked `health.json`, `verdict.json`, `agent-summary.md`, and `planner-compatibility.json` before execution.
- `compare.ts`: reads two completed run directories, validates `health.json` and `verdict.json`, then writes or prints a schema-checked `comparison.json`.
- `demo-loop.ts`: runs the fixture preflight, baseline/current profile logs, and comparison without requiring a simulator.
- `profile-ios.ts`: reads project config, a transition scenario manifest, and an event log containing `[profile-event]` entries, then writes the current public artifact layout — `manifest.json`, `metrics.json`, `causal-run.json`, `budget-verdict.json` when budgets are configured, `summary.md`, and copied raw logs under `raw/`.

The artifact contract separates scenario health, product verdict, and baseline comparison into `health.json`, `verdict.json`, and optional `comparison.json`. `metrics.json` and `budget-verdict.json` remain transition artifacts while the profile runner migrates.

What it does not do yet:

- boot or control simulators
- drive the app through an interaction driver
- capture logs, video, or UI trees itself
- install or launch Android apps from the adb preflight runner

That live orchestration layer is the next milestone, and it lands behind the same artifact contract. Primary runners own one run lifecycle. Evidence providers attach optional or required evidence through a smaller provider interface. Tools such as AXe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and log collectors plug in as adapters, so scenarios and artifacts stay stable while tactical tools change underneath.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.

To exercise the full current loop without device runtime setup:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

To prove the neutral example app scenarios through committed app evidence:

```bash
pnpm example:profile:startup
```

To check Android runtime readiness without starting scenario execution:

```bash
pnpm android:preflight -- --package com.example.app --out artifacts/android-adb-preflight
```

Android is the first live runtime target for the example app while local iOS tooling is unavailable:

```bash
pnpm example:app:android
```
