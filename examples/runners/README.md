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
| `argent-android.json` | Android | Argent target | Models Argent as an interaction runner with adb-backed fallback evidence options. |
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
| `script-network-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for network capture evidence. |
| `script-profiler-provider.json` | iOS, Android | project-local script provider | Command wrapper pattern for profiler evidence and JS signal attachment. |

## Rules

- Keep `capabilities` about lifecycle or evidence ownership.
- Keep `driverActions` about concrete operations the adapter can perform.
- Do not add a capability or driver action until a runner or provider can produce the corresponding evidence.
- When a tool writes files independently, attach them through `--signal`, `--capture`, or a `providerCommands` manifest so the run keeps stable artifact paths.
- Treat these manifests as starting contracts; consuming apps can narrow them to match the exact adapter they install.

## Tool Surface Notes

The bundled `agent-device` driver adapter maps the declared portable subset: app open/close, alert inspection, `tap`, `scroll`, `assertVisible`, `inspectTree`, `screenshot`, and `readLogs`. The agent-device CLI may expose more commands than the fixture declares, including recording, performance, network, trace, batch, and React DevTools operations. Keep those out of the primary runner manifest until an adapter maps them into stable Agent Scenario Loop artifacts. For example, performance or React DevTools output should usually start as an evidence provider or signal attachment, while `record` should only be declared once video capture is wired into `captures.video`.
