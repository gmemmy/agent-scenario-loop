# Runner And Provider Targets

These manifests are public contract fixtures. They are schema-checked, planner-tested, and shipped with the package so adapter authors can start from known capability shapes.

They do not mean the package bundles every named tool. A fixture describes what a tool-specific adapter can provide behind the Agent Scenario Loop ports.

## Primary Runner Targets

| Manifest | Platforms | Contract role | Notes |
| --- | --- | --- | --- |
| `adb-android.json` | Android | Built-in adb runner target | Matches the bundled adb driver and Android profile capture path. |
| `xcodebuildmcp-ios.json` | iOS | XcodeBuildMCP target | Models an iOS simulator driver with UI, screenshot, video, log, and accessibility evidence. |
| `agent-device-android.json` | Android | agent-device target | Matches the bundled agent-device driver adapter's portable interaction subset. |
| `agent-device-ios.json` | iOS | agent-device target | Same portable interaction contract on iOS. |
| `argent-android.json` | Android | Argent target | Models Argent as an interaction runner paired with wrapper-owned log capture. |
| `argent-ios.json` | iOS | Argent target | Models Argent as an interaction runner with native-devtools and restart-health expectations. |
| `manual-log-ingest.json` | iOS, Android | fixture-only log ingest | Intentionally insufficient for live lifecycle ownership; useful for proving planner failures. |

## Evidence Provider Targets

| Manifest | Platforms | Contract role | Notes |
| --- | --- | --- | --- |
| `argent-react-profiler-provider.json` | Android | Argent profiler provider | Models profiler evidence as a provider lane separate from primary interaction control. |
| `axe-accessibility-provider.json` | iOS, Android | axe accessibility provider | Demonstrates a command-backed accessibility provider output. |
| `rozenite-profiler-provider.json` | iOS, Android | Rozenite profiler provider | Describes profiler evidence without bundling the runtime tool. |
| `script-accessibility-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for accessibility evidence. |
| `script-memory-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for memory evidence and signal attachment. |
| `script-native-performance-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for native frame/render/memory diagnostics such as Perfetto, gfxinfo, framestats, and meminfo summaries. |
| `script-network-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for network capture evidence. |
| `script-profiler-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for profiler evidence and JS signal attachment. |

## Rules

- Keep `capabilities` about lifecycle or evidence ownership.
- Keep `driverActions` about concrete operations the adapter can perform.
- Keep `uiContexts` about the surface the adapter can own; do not use `app` proof for system dialogs, share sheets, external browsers, WebViews, pickers, notifications, or another app unless the manifest explicitly declares that context.
- Do not add a capability or driver action until a runner or provider can produce the corresponding evidence.
- Keep `providerCommands` on evidence-provider manifests; primary runners should own lifecycle orchestration, not provider command wrappers. Prefer `phase: "afterCapture"` for diagnostics that inspect an already captured adb/simctl sidecar.
- When a tool writes files independently, attach them through `--signal`, `--capture`, or a `providerCommands` manifest so the run keeps stable artifact paths.
- Treat these manifests as starting contracts; consuming apps can narrow them to match the exact adapter they install.

## Tool Surface Notes

The bundled `agent-device` driver adapter and `asl-agent-device` capture runner map the declared portable subset: app open/close, alert inspection, `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, and `readLogs`. Planner compatibility validates the agent-device target metadata that must be known before runtime: `tap` needs a selector, `adapterOptions.agentDevice.ref`, or `adapterOptions.agentDevice.x/y`; `assertVisible` needs a portable selector; selector matching must be exact until the adapter maps richer match modes. The agent-device CLI may expose more commands than the fixture declares, including recording, performance, network, trace, batch, and React DevTools operations. Keep those out of the primary runner manifest until an adapter maps them into stable Agent Scenario Loop artifacts. For example, Android snapshots, network dumps, and performance evidence can be attached through a provider once the project proves those commands on its devices; React DevTools, traces, and recording should stay in explicit heavy lanes until their outputs are stable ASL artifacts.

The Argent fixtures are external-tool contracts, not bundled package dependencies. `@swmansion/argent` exposes a local MCP/CLI surface for iOS Simulator and Android Emulator control, so Agent Scenario Loop should keep two lanes distinct when an app adopts it: a primary interaction adapter for launch, gestures, screenshot requests, and UI descriptions, and a provider lane for profiler output such as React commit or CPU summaries. Android can pair fast adb interaction with an Argent profiler provider so profiling startup cost does not slow every tap or scroll. iOS can use Argent `describe` as AXRuntime accessibility evidence when that command is reliable for the selected simulator and bundle; treat native UIKit hierarchy restart requirements as a separate unsupported or heavy diagnostic until the project can capture them consistently. iOS adapters should treat native-devtools disconnects, restart-required statuses, required screenshot failures, and root-only UI descriptions as failed scenario health, because timing budgets are not trustworthy when required UI evidence is unverifiable. Optional screenshot failures should stay visible as warnings. When Argent can prove launch and accessibility but its iOS screenshot backend is unavailable, ASL may attach simctl as a screenshot fallback provider while keeping the Argent warning in health. Argent output files should enter ASL through `raw/`, `captures/`, `signals/js`, or provider-command attachments with stable manifest inventory; do not create Argent-specific top-level artifact folders. React profiler CPU summaries are lifecycle evidence when they require a prior start/stop session. Provider output should preserve target-binding proof, raw profile attachments, derived summaries, and diagnostic-only/comparable status instead of treating those summaries as passive snapshots.

Native performance providers should translate platform-native evidence into a product-neutral `nativePerformance` attachment. On Android, that can include Perfetto traces, trace-processor summaries, `gfxinfo`/framestats, `meminfo`, and logcat-derived render signals. On iOS, it can include Instruments, MetricKit, or simctl-derived native performance summaries. JSON native-performance outputs are schema-validated, so keep raw traces as attachments and put claim-ready facts in a structured provider summary with native tool, clock window, device/app binding, completeness, and comparability policy. Do not collapse native frame or memory evidence into generic profiler output.

The `asl-init` native-performance provider script is a scaffold, not a real capture backend. It emits platform-aware, diagnostic-only JSON with `claimSufficiency.status: "insufficient-for-claim"` so adopters can wire manifests and schema validation before replacing the script with Android Perfetto/gfxinfo/meminfo/logcat capture or iOS xctrace/Instruments/MetricKit/simctl summaries. Treat scaffold output as provider-wiring proof only.
