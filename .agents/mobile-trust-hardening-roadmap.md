# ASL Mobile Trust Hardening Roadmap

This document is the durable planning surface for the remaining ASL adoption-hardening work. Keep it product-neutral. Downstream apps can expose gaps, but ASL work must stay focused on reusable mobile evidence contracts, runner behavior, and artifact interpretation.

## Operating Rule

Only one lane should be active at a time. Each lane should have:

- a bounded objective;
- owned files or modules;
- acceptance evidence;
- a product-neutral return format;
- no app-specific product concepts in commits, docs, schemas, or tests.

## Current Top Lane

### Attempt, Retry, Cancellation, And Partial Evidence Semantics

Status: completed in `aa355d2`.

Objective: make attempts first-class evidence so failed, retried, timed-out, cancelled, or partially cleaned-up runs cannot be hidden by a later green run.

Scope:

- attempt IDs and retry/attempt counters;
- visible retry declarations, if retries are introduced by a runner or wrapper;
- timeout, cancellation, abort, unsupported, unhealthy, and runner-environment classification;
- cleanup status and cleanup artifact references;
- valid partial artifact paths for interrupted attempts;
- agent summaries that distinguish final outcome from preserved failed-attempt evidence.

Current implementation direction:

- generated manifests record `attemptNumber` and `maxAttempts`;
- retry attempts record `retryOfAttemptId` and `retryReason`;
- attempt invariant checks reject missing retry lineage, impossible attempt counters, and self-referential retries;
- profile summaries render attempt identity, counter, terminal state, cleanup, partial-artifact validity, and retry lineage.

Acceptance evidence:

- schema-valid manifest attempt artifacts for passed, failed, timeout, cancelled, aborted, unhealthy, unsupported, and inconclusive paths;
- tests proving timeout/cancelled/aborted attempts require valid partial artifact paths;
- runner failure-path tests proving failed attempts write health/verdict/summary without claiming product verdict from unhealthy evidence;
- package smoke still passes from the packed tarball.

Suggested ownership:

- `core/artifact-contract.ts`
- `schemas/manifest.schema.json`
- `core/__tests__/artifact-contract.test.ts`
- runner failure-path tests under `runner/__tests__/`
- `docs/contracts.md`

## Remaining P0 Lanes

### Lifecycle Breadth

Status: completed in `679257d`.

Objective: model and prove lifecycle modes beyond cold launch.

Surfaces:

- warm launch;
- hot launch;
- resume;
- background/foreground;
- force-stop;
- process death;
- activity or scene recreation;
- OS reclaim;
- relaunch after termination.

Acceptance evidence:

- explicit lifecycle preconditions/postconditions in manifests;
- Android and iOS runner tests for at least one non-cold lifecycle path;
- no product-specific lifecycle names.

Current implementation direction:

- manifest lifecycle vocabulary includes `resume` in addition to launch, foreground, background, interruption, and relaunch states;
- Android and iOS profile runners accept an explicit `--lifecycle-phase` assertion for non-cold preconditions;
- live adb/simctl profile manifests assert foreground app and lifecycle postconditions when the runner owns the capture path;
- focused runner tests prove Android `warm-launch` and iOS `resume` artifacts.

### Adapter Conformance Expansion

Status: active.

Objective: make adapter behavior testable independently of implementation language.

Surfaces:

- lifecycle invariant tests;
- cancellation and deadline behavior;
- cleanup invariants;
- structured failure classification;
- artifact integrity and finalization;
- operation ID and sequence handling.

Acceptance evidence:

- conformance transcripts or fixtures for happy path and failure path;
- out-of-process adapter fixture remains non-TypeScript;
- external adapter docs match schema behavior.

Current implementation direction:

- golden transcripts cover success, unsupported action, expired deadline, cleanup/finalization failure, and sequence handling;
- the non-TypeScript fixture classifies deadline, cleanup, protocol, unsupported, and adapter failures product-neutrally;
- conformance tests reject embedded evidence bytes and non-monotonic sender sequences;
- external adapter protocol docs define failure categories, deadline behavior, cleanup invariants, and terminal finalization.

### Runtime Command Ordering Proof

Objective: prove ordered execution across wait conditions in real mobile helper flows, not only in runner payload construction.

Surfaces:

- queue append semantics;
- command sequence acknowledgement;
- wait-for-milestone boundaries;
- command/result correlation;
- repeated command cycles.

Acceptance evidence:

- helper-level tests for sequence-aware command execution;
- runner tests with wait-following-command metadata;
- causal artifacts cite sequence/correlation evidence.

### System Context Ownership

Objective: distinguish app-owned UI from system-owned UI and external surfaces.

Surfaces:

- system dialogs;
- notification shade;
- external browser;
- WebView;
- share sheet;
- picker;
- another app.

Acceptance evidence:

- schema or manifest vocabulary for system context ownership;
- runner/provider docs explaining ownership boundaries;
- no silent downgrade from app UI proof to weaker external observation.

## Remaining P1 Lanes

### Baseline And Measurement Policy

Surfaces:

- pinned versus latest baseline;
- warmups;
- valid sample counts;
- outlier policy;
- confidence and tolerance;
- baseline poisoning protection.

### Resource Arbitration

Surfaces:

- simulator/device locks;
- port ownership;
- profiler exclusivity;
- disk checks;
- orphan cleanup.

### Richer Environment Capture

Surfaces:

- permissions;
- locale;
- timezone;
- theme;
- font scale;
- orientation;
- network state;
- animation settings.

### Version Skew Detection

Surfaces:

- ASL package version;
- app helper version;
- schema version;
- runner and provider manifest versions;
- artifact reader compatibility.

### Redaction And Privacy Policy

Surfaces:

- PII and secret leakage;
- redaction status;
- transformed evidence;
- provider evidence retention;
- safe summaries.

## Completion Bar

The roadmap is complete when a new consuming mobile app can use ASL and receive truthful evidence even when:

- the app crashes;
- a command arrives late;
- a lifecycle transition interrupts execution;
- a retry happens;
- a device or simulator is misconfigured;
- a baseline is incompatible;
- a provider fails;
- artifacts are partial but still useful for diagnosis.
