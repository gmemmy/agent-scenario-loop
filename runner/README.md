# Runner

`agent-scenario-loop` keeps host execution behind a runner boundary.

V1 scope in this extraction:

- one supported target: iOS simulator
- stable artifact contract in `../core/`
- scenario manifests under `../examples/scenarios/ios/`
- one supported public executable: `profile-ios.js`

Current contents:

- `profile-ios.js`: contract-first scaffold that reads config, scenario metadata, and optional `[profile-event]` logs, then writes the public artifact layout

Non-goals for v1:

- shipping a hardened live simulator orchestration layer
- claiming device automation support
- claiming Computer Use support

The goal of the public cut is to freeze the reusable contracts first, then harden live orchestration behind them in later releases.
