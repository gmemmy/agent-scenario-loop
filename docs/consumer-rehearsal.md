# Consumer App Rehearsal

Use this checklist before adopting Agent Scenario Loop in an existing React Native app. The goal is to prove the package workflow locally before treating it as part of the app's everyday agent loop.

In this repository, the automated packed-package rehearsal is:

```bash
pnpm consumer:rehearse
```

It creates a temporary existing app-shaped package, installs the packed tarball, runs `asl-init`, merges generated scripts into `package.json`, replaces scaffold placeholders, runs both platform plan scripts, runs generated fixture profile scripts against deterministic event logs, runs the generated Argent interaction scripts through a deterministic adapter double, validates the project through the installed CLI, and proves stale merged scripts are rejected. Use the manual checklist below when rehearsing inside a real app.

Package gates run child package-manager and CLI commands with a bounded timeout. Set `ASL_PACKAGE_GATE_TIMEOUT_MS` when a slow local registry, proxy, or package cache needs a larger budget:

```bash
ASL_PACKAGE_GATE_TIMEOUT_MS=300000 pnpm consumer:rehearse
```

## 1. Initialize The Scaffold

From the consuming app root:

```bash
asl-init --out . --scenario first-journey
```

Review the generated files before merging anything into existing app scripts:

- `asl.config.json`
- `scenarios/mobile/first-journey.json`
- `runner-manifests/primary-runner.json`
- `runner-manifests/evidence-provider.json`
- `scripts/asl-capture-accessibility-provider.mjs`
- `scripts/asl-capture-profiler-provider.mjs`
- `src/devtools/profile-session.ts`
- `asl/package-scripts.json`
- `asl/gitignore-snippet`

Keep generated artifacts ignored. Commit only durable scenarios, manifests, config, docs, and app helper wiring.

Merge the required generated `asl:*` entries from `asl/package-scripts.json` into the app `package.json`. `asl-validate-project` treats missing or drifted merged scripts as an error because agents need stable local commands, not just scaffold files.

## 2. Wire App Truth

Mount `useProfileSessionBootstrap()` once near the app root.

Emit truth events around one stable journey:

- journey intent accepted
- first useful visual state
- command target opened or completed
- return or completion state

Register command targets only where they map to real app behavior. Avoid selectors or commands that depend on local data, private accounts, or temporary UI state.

## 3. Validate Before Runtime

Run:

```bash
asl-validate-project --root . --platform all --out artifacts/asl/project-validation
```

Fix errors before runtime proof. Treat warnings and `nextActions` as setup work that should be resolved before the app depends on the scenario for regression decisions.

## 4. Prove One Platform First

Keep deterministic validation and live device proof as separate lanes. `asl-check-plan`, fixture profile runs, `pnpm package:smoke`, and `pnpm consumer:rehearse` should work in ordinary build or agent sandboxes. Live runs that touch adb, simctl, agent-device, Argent, emulators, simulators, or physical devices need host/device access. If a live command cannot reach those host services, classify it as runner environment health before treating it as a scenario regression.

Prefer Android first when iOS tooling is unstable:

```bash
asl-check-plan --scenario scenarios/mobile/first-journey.json --runner runner-manifests/primary-runner.json --platform android --out artifacts/asl/plan/first-journey-android
asl-profile-android --config asl.config.json --scenario scenarios/mobile/first-journey.json --adb-capture --profile-session --clear-logcat --launch --out artifacts/asl/android --run-id first-journey-android-live --comparison-lane first-journey-android-live
```

Use iOS once the app is installed on a booted simulator:

```bash
asl-check-plan --scenario scenarios/mobile/first-journey.json --runner runner-manifests/primary-runner.json --platform ios --out artifacts/asl/plan/first-journey-ios
asl-profile-ios --config asl.config.json --scenario scenarios/mobile/first-journey.json --simctl-capture --profile-session --profile-session-storage --launch --out artifacts/asl/ios --run-id first-journey-ios-live --comparison-lane first-journey-ios-live
```

For Expo dev-client builds, set `ASL_IOS_DEV_CLIENT_URL` to the app's dev-client URL in ignored local env state. `asl-profile-ios` and `asl-live-ios` open it before reading stored profile-session evidence.

When `--wait-ms` is omitted, profile-session live capture derives the final adb or simctl evidence window from the scenario execution steps and cycle count. Use an explicit `--wait-ms` only for an app-specific override.

## 5. Compare Only Trusted Runs

After two passed runs exist, compare the current run against the newest trusted prior run:

```bash
ASL_COMPARE_ANDROID_CURRENT=artifacts/asl/android/first-journey/first-journey-android-live pnpm asl:compare:android
```

Do not make improvement or regression claims when scenario health failed or the comparison is inconclusive.

Keep each proof mode in its own comparison lane. Fixture, Android live, iOS live, adb-only, simctl-only, and sidecar-backed runs can share a scenario id, but they should not borrow each other's baselines.

## 6. Decide Adoption Scope

Before expanding beyond the first journey, confirm:

- the app helper is committed and mounted once
- the scenario is boring and repeatable
- app-owned truth events are stable
- artifacts are ignored locally and not packed or committed
- every durable runtime proof has an explicit comparison lane
- `agent-summary.md` gives enough context for a coding agent to act
- failed setup produces concrete next actions
- at least one platform has a passed live proof

Only then add more scenarios, providers, or runner adapters.
