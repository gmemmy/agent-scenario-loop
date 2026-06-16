# Runner

The runner owns host execution. It is the boundary between scenario contracts and whichever tool actually drives the device or captures evidence.

V1 ships two supported TypeScript runner sources. Package scripts build them into `dist/` before execution:

- `check-plan.ts`: validates a v1 scenario manifest, primary runner capability manifest, and optional evidence-provider manifests, then writes schema-checked `health.json`, `verdict.json`, and `planner-compatibility.json` before execution.
- `profile-ios.ts`: reads project config, a transition scenario manifest, and an event log containing `[profile-event]` entries, then writes the current public artifact layout — `manifest.json`, `metrics.json`, `causal-run.json`, `budget-verdict.json` when budgets are configured, `summary.md`, and copied raw logs under `raw/`.

The target v1 contract separates scenario health, product verdict, and baseline comparison into `health.json`, `verdict.json`, and optional `comparison.json`. `metrics.json` and `budget-verdict.json` remain transition artifacts while the runner migrates.

What it does not do yet:

- boot or control simulators
- drive the app through an interaction driver
- capture logs, video, or UI trees itself

That live orchestration layer is the next milestone, and it lands behind the same artifact contract. Primary runners own one run lifecycle. Evidence providers attach optional or required evidence through a smaller provider interface. Tools such as AXe, XcodeBuildMCP, agent-device, Argent, adb, profilers, accessibility inspectors, and log collectors plug in as adapters, so scenarios and artifacts stay stable while tactical tools change underneath.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.
