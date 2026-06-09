# Runner

The runner owns host execution. It is the boundary between scenario contracts and whatever tool actually drives the device.

V1 ships one supported executable: `profile-ios.js`. It reads project config, a scenario manifest, and an event log containing `[profile-event]` entries, then writes the full public artifact layout — `manifest.json`, `metrics.json`, `causal-run.json`, `budget-verdict.json` when budgets are configured, `summary.md`, and copied raw logs under `raw/`.

What it does not do yet:

- boot or control simulators
- drive the app through an interaction driver
- capture logs, video, or UI trees itself

That live orchestration layer is the next milestone, and it lands behind the same artifact contract. Interaction drivers — AXe, XcodeBuildMCP, agent-device, Argent — plug in as adapters, so scenarios and artifacts stay stable while drivers change underneath.

Freezing the contracts first is deliberate: adopt the artifact shape now, inherit the automated loop later without rewrites.
