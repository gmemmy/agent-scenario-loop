# Runner

The runner owns host execution. It is the boundary between scenario contracts and whichever tool actually drives the device or captures evidence.

The package ships seven public runner entrypoints. Package scripts build them into `dist/` before execution:

- `android-adb.ts`: checks adb availability, connected Android device readiness, optional package installation, optional package launch, bounded logcat output, and writes raw adb evidence.
- `check-plan.ts`: validates a scenario manifest, primary runner capability manifest, and optional evidence-provider manifests, then writes schema-checked `health.json`, `verdict.json`, `agent-summary.md`, and `planner-compatibility.json` before execution.
- `compare.ts`: reads two completed run directories, validates `health.json` and `verdict.json`, then writes or prints a schema-checked `comparison.json`.
- `demo-loop.ts`: runs the fixture preflight, baseline/current profile logs, and comparison without requiring a simulator.
- `example-android-live.ts`: runs the packaged example Android live proof with adb preflight and the canonical startup, open-close, and scroll-settle scenarios.
- `profile-android.ts`: reads project config and an Android scenario manifest, then profiles explicit event logs, prior adb artifacts, or an owned adb capture window. During profile-session capture, Android-specific command metadata takes precedence; otherwise it derives command steps from `buildScenarioExecutionPlan()`.
- `profile-ios.ts`: reads project config, an iOS scenario manifest, and an event log containing `[profile-event]` entries, then writes the current public artifact layout.

The artifact contract separates scenario health, product verdict, baseline comparison, and profile evidence into schema-checked files. `health.json`, `verdict.json`, and optional `comparison.json` provide the interpretation gate; `manifest.json`, `metrics.json`, `causal-run.json`, and `budget-verdict.json` preserve the profile evidence for agents and humans.

What it does not do yet:

- boot or control simulators
- install or build apps
- drive full scenario-step UI interactions beyond Android package launch
- capture video, screenshots, UI trees, memory, network, or accessibility evidence from built-in drivers

Those deeper orchestration capabilities land behind the same artifact contract. Primary runners own one run lifecycle. Evidence providers attach optional or required evidence through a smaller provider interface. Tools such as AXe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and log collectors plug in as adapters, so scenarios and artifacts stay stable while tactical tools change underneath.

Runner manifests separate `capabilities` from `driverActions`. Capabilities say the runner can own parts of the lifecycle or evidence contract. Driver actions say the underlying adapter can perform concrete operations such as `tap`, `scroll`, `inspectTree`, `screenshot`, `record`, `readLogs`, or `collectPerfSignals`. `check-plan` fails before execution when a required scenario step declares a `driverAction` the runner does not support.

After planning passes, `buildScenarioExecutionPlan()` normalizes scenario steps into the adapter-facing work list. It preserves app commands and milestones, records required versus optional steps, and maps step kinds to the runner port method that owns execution.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.

To exercise the full current loop without device runtime setup:

```bash
pnpm demo:loop -- --out artifacts/demo-loop
```

To prove the neutral example app scenarios through committed app evidence:

```bash
pnpm example:profile:startup
pnpm example:profile:android:startup
```

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

To turn that captured logcat evidence into scenario artifacts:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-artifacts artifacts/android-adb-logcat --run-id <run-id>
```

To let `profile:android` own both the adb capture window and the profile artifact run:

```bash
pnpm profile:android -- --config <config> --scenario <scenario> --adb-capture --clear-logcat --launch --wait-ms 5000 --run-id <run-id>
```

Android is the first live runtime target for the example app while local iOS tooling is unavailable:

```bash
pnpm example:app:android
pnpm example:android:live
```
