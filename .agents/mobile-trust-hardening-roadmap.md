# ASL Mobile Trust Hardening Roadmap

This is the internal planning surface for mobile trust work after `0.1.15`.
Repository contracts, merged implementation, and generated evidence remain the
source of truth. The roadmap does not create package commitments by itself.

## Operating Model

Work may proceed in bounded concurrent lanes when ownership is disjoint. Each
lane must name its plane, owned files or modules, proof gate, and integration
dependency. Contract, schema, package-export, and release-sensitive changes join
one controlled integration and release train so independently green branches do
not create an incoherent public surface.

Keep the boundaries explicit:

- **Core** owns product-neutral scenario, health, verdict, artifact,
  interpretation, comparison, and history contracts.
- **Adapters and providers** own tool-specific control and evidence collection;
  they do not define top-level truth or product verdicts.
- **Consumer apps** own product scenarios, accounts, selectors, routes, runtime
  instrumentation, and adoption proof.
- **Delivery integrations** consume completed ASL artifacts and publish advisory
  summaries; they do not replace artifact validation or release gates.

Every lane must preserve failed and partial evidence, state exact platform
coverage, and keep app-specific concepts downstream.

## Current-Main Reconciliation

Classification is against `origin/main` at package `0.1.15`, not old PR status.

### Shipped foundations

- Attempt, retry, timeout, cancellation, cleanup, and partial-artifact semantics
  are represented and tested in the artifact contract.
- Non-cold lifecycle assertions are implemented for Android and iOS runner
  paths, including warm-launch and resume coverage.
- External adapter conformance covers structured failure categories, deadlines,
  cleanup/finalization, evidence integrity, operation correlation, and sequence
  ordering with a non-TypeScript fixture.
- Runtime command ordering and acknowledgements are preserved across queued
  commands, wait boundaries, and repeated cycles.
- UI context ownership distinguishes app, system, web, and external surfaces and
  requires explicit downgrade handling.
- Measurement policy and trusted-baseline selection expose compatibility,
  minimum samples, confidence, tolerance, and unmeasurable outcomes.
- Deterministic resource leases cover device/simulator, port, and profiler
  ownership with bounded cleanup semantics.
- Native-performance evidence has shared schema validation, claim sufficiency,
  comparison-readiness gating, Android provider capture, and bounded iOS
  simctl/xctrace diagnostic capture. Incomplete provider output remains
  diagnostic evidence rather than comparison truth.
- Project validation inventories exercised scenario coverage metadata. This is
  coverage truth, not automatic change-to-scenario selection.

### Partial foundations

- Environment capture records asserted facts and runtime identity, but the
  breadth and normalization of permissions, locale, timezone, theme, font
  scale, orientation, network, animation settings, and device state are not a
  complete cross-platform policy.
- Version-skew checks cover important helper/runtime surfaces, but compatibility
  policy across package, helper, schema, runner, provider, and artifact readers
  is not yet one end-to-end gate.
- Evidence integrity and run-relative paths exist, but redaction, transformed
  evidence, secret/PII classification, retention, and safe-summary policy are
  not yet a complete contract.
- History and latest-trusted comparison exist locally, but flake intelligence,
  trend analysis, and distributed resource coordination remain future work.

### Parked dependencies

- Numeric parsing of real provider-owned xctrace export output is parked until a
  sanitized provider fixture is available. Generic xctrace-summary text parsing
  already exists; current direct xctrace capture remains diagnostic-only unless
  provider output independently satisfies the shared numeric measurement and
  binding gates.
- Further Agent Device integration is parked on upstream collaboration. Existing
  adapter and capture support remains usable; ASL must not invent upstream
  capabilities or encode its tool name into top-level artifact concepts.
- Automatic change-to-scenario selection is parked until exercised coverage
  contracts provide trustworthy selection inputs. Coverage inventory alone is
  not permission to infer impact.

## Horizons

Horizons are ordered by dependency, not a one-lane-at-a-time rule. Work inside a
horizon may run concurrently under the operating model above.

### 1. Current stabilization and adoption

Objective: make `0.1.15` dependable for real consumer rehearsal without adding
consumer-specific behavior to ASL.

- **Core lane:** close remaining environment, version-skew, and redaction gaps
  only where consumer proof demonstrates a reusable contract issue.
- **Adapter/provider lane:** keep Android and iOS readiness, lifecycle, target
  binding, partial evidence, and provider identity truthful under failure.
- **Consumer lane:** install the packed package, adopt thin helpers, run explicit
  scenarios, and return artifact paths plus exact platform coverage.
- **Proof gate:** focused tests, `pnpm test`, `pnpm release:check`, packed consumer
  rehearsal when package files move, and downstream proof owned by the consumer.

Exit when a new consumer can distinguish product failure, runner failure,
unhealthy environment, unsupported capability, and incomplete diagnostics
without inspecting host-only logs.

### 2. Reviewer evidence and iOS video

Objective: make a bounded run understandable to a reviewer without weakening
artifact truth.

- Define a reviewer evidence bundle as a derived view over existing manifests,
  health, verdict, summaries, captures, and integrity metadata.
- Add iOS video capture through the simctl adapter with bounded start/stop,
  captured subprocess output, partial-failure preservation, and run-relative
  inventory. Video is realism evidence, not scenario truth by itself.
- Keep bundle generation separate from artifact interpretation; missing media
  must render as explicit unavailable/failed evidence with a reason.
- **Ownership:** core owns the derived bundle contract if one is needed; the iOS
  adapter owns capture; consumer apps own what their scenarios display.
- **Proof gate:** schema/contract tests for any public artifact change, iOS
  runner failure-path tests, package smoke, and a sanitized reviewer fixture.

### 3. Advisory delivery integrations

Objective: deliver concise evidence-backed results to review and operations
surfaces without making those surfaces truth owners.

- Begin with pull-request checks/comments and webhook-style outputs derived from
  completed artifacts.
- Include run/scenario identity, health, verdict, comparison status, strongest
  evidence links, missing diagnostics, platform, and next action.
- Delivery failures must be separately classified and must not mutate the run
  verdict or erase artifacts.
- **Ownership:** delivery modules own formatting and transport; core owns the
  artifact fields they consume; repositories own credentials and policy.
- **Proof gate:** deterministic formatting fixtures, transport failure tests,
  idempotency/correlation proof, and no secrets or absolute host paths.

### 4. Native-performance and state-space depth

Objective: deepen measurable platform evidence and lifecycle/state coverage
without optimizing from untrusted samples.

- Add provider-export parsing for numeric iOS performance evidence only after the
  parked fixture dependency is resolved; apply the same target, window,
  completeness, sample, and comparison-readiness gates used across platforms.
- Expand lifecycle/state coverage for process death, recreation, OS reclaim,
  relaunch, permission changes, network transitions, and system-owned surfaces.
- Model state transitions with explicit closed vocabularies and named policy
  functions; do not encode them as interacting boolean clusters.
- **Ownership:** core owns shared interpretation; adapters/providers own capture;
  consumer apps own reachable product states and semantic controls.
- **Proof gate:** provider fixtures, lifecycle failure/cleanup tests, measurable
  sample assertions, comparison downgrade tests, and exact platform disclosure.

### 5. Scale: history, flake intelligence, and distributed resources

Objective: make repeated evidence useful across time and safe across concurrent
hosts and devices.

- Extend trusted local history into explicit retention, lineage, cohort, and
  compatibility policy before adding remote storage.
- Classify flakes from preserved attempts and comparable cohorts; never relabel
  unhealthy or unmeasurable runs as product flakes.
- Add distributed resource coordination behind the existing lease semantics,
  including expiry, fencing, orphan recovery, and conflict evidence.
- Resume change-to-scenario selection only after exercised coverage contracts
  can support conservative, explainable selection and fallback-to-full-set.
- **Proof gate:** deterministic history fixtures, poisoning/compatibility tests,
  repeated-run classification tests, and lease contention/recovery tests.

### 6. Public-readiness gates

Objective: decide when the package is safe to present as a reusable mobile
evidence system rather than a repository-specific implementation.

- Public contracts, schemas, exports, examples, templates, and docs agree.
- Android and iOS have explicitly scoped live proof; gaps are named rather than
  collapsed into generic mobile support.
- Packed consumer rehearsal proves install, types, bins, examples, artifact
  validation, failure preservation, and the documented adoption path.
- Security/privacy review covers redaction, retention, secrets, host paths, and
  delivery credentials.
- Reviewer evidence demonstrates trustworthy interpretation from artifacts alone.
- Release readiness requires green `pnpm release:check` plus the relevant package
  smoke, consumer rehearsal, and platform proof packets. A green fixture run is
  not a substitute for unavailable live proof.

## Integration Ledger

For every active lane, record the owner, plane, branch or issue, files/modules,
contract impact, proof gate, dependencies, and integration order. Lanes that
touch the same public vocabulary, schema, package export, or generated template
must integrate serially through the controlled release train even if their
implementation work ran concurrently.

This roadmap is complete when the public-readiness gates are met and consumers
can obtain durable, product-neutral, cross-platform evidence that remains
truthful under crashes, retries, lifecycle interruption, provider failure,
resource contention, incomplete diagnostics, and incompatible history.
