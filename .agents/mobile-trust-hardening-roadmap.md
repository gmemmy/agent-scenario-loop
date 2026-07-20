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

Protocol-spine gaps and demonstrations that can falsify a trust claim outrank
new delivery, storage, graph, or automation surfaces. Public positioning remains
grounded in shipped contracts and proof; the broader behavioral-proof thesis is
an internal hypothesis, not a package claim. ASL may recommend a bounded owner
or next action, but consumers retain authority, approval, and final action policy.

## Current-Main Reconciliation

Classification is against `origin/main` at
`a4ced100cb50e63b43e7e25eb64008dc9c9997da`, after package `0.1.15` and merged
work through #258, not old PR status.

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
- Bounded iOS simctl video capture preserves subprocess output and partial
  failures, validates finalized MP4/QuickTime bytes, and exposes a run-relative
  capture only after validation.
- Trusted native-performance comparison now requires structured same-condition
  policy and metric descriptors, measurable samples, complete durable evidence,
  observed target identity, and a bounded capture window. Incomplete or
  incompatible evidence remains diagnostic instead of becoming comparison truth.
- Live Android and iOS capture can bracket the runner-owned active loop with
  provider `startWindow` and `stopWindow`, then normalize after raw evidence is
  staged and finalize without rewriting prior command evidence.
- Native-performance live runs stage the requested app, target, and active-window
  policy before capture. Immutable provider command records bind the staged
  request hash, and comparison-ready target proof must bind the runner-owned
  active window plus the hashed raw capture outputs used by normalization.
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

Early exit evidence must include deliberate negative cases:

- a faster-looking unhealthy or unmeasurable run cannot support optimization;
  mismatched or incomplete native evidence remains diagnostic and cannot support
  a trusted native-performance baseline or comparison claim;
- one unchanged scenario contract and app-owned truth definition is exercised by
  two independently implemented adapters, with unsupported behavior failing
  during planning instead of forcing a scenario rewrite;
- scenario-contract, app-truth, runner, provider, environment, unsupported, and
  compound failures yield the correct bounded owner recommendation or remain
  explicitly unresolved. Authority to act stays downstream.

Exit when a new consumer can distinguish product failure, runner failure,
unhealthy environment, unsupported capability, and incomplete diagnostics
without inspecting host-only logs.

### 2. Reviewer evidence as a derived view

Objective: make a bounded run understandable to a reviewer without weakening
artifact truth.

- Experiment with a reviewer evidence bundle as a derived view over existing
  manifests, health, verdict, summaries, captures, and integrity metadata.
- Do not introduce a public bundle or proof-graph contract unless the experiment
  identifies a required relation that cannot be derived from existing artifacts.
- Treat shipped iOS video as realism evidence, not scenario truth by itself.
- Keep bundle generation separate from artifact interpretation; missing media
  must render as explicit unavailable/failed evidence with a reason.
- **Ownership:** core owns the derived bundle contract if one is needed; the iOS
  adapter owns capture; consumer apps own what their scenarios display.
- **Proof gate:** schema/contract tests for any public artifact change, iOS
  runner failure-path tests, package smoke, and a sanitized reviewer fixture.

### 3. Advisory delivery integrations after proof semantics

Objective: deliver concise evidence-backed results to review and operations
surfaces without making those surfaces truth owners.

This horizon starts only after the early falsification demonstrations pass and
the claims being delivered have settled proof semantics. Delivery must not force
new core claim policy.

- Begin with pull-request checks/comments and webhook-style outputs derived from
  completed artifacts.
- Include run/scenario identity, health, verdict, comparison status, strongest
  evidence links, missing diagnostics, platform, and next action.
- Delivery failures must be separately classified and must not mutate the run
  verdict or erase artifacts.
- **Ownership:** delivery modules own formatting and transport; core owns the
  artifact fields they consume; repositories own credentials, authority, and
  action policy.
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
- Decide how compatible scenario revisions relate, and complete a
  historical-learning case with a predeclared rule and paired full-history versus
  latest-only evaluation before expanding history behavior.
- Classify flakes from preserved attempts and comparable cohorts; never relabel
  unhealthy or unmeasurable runs as product flakes.
- Add distributed resource coordination behind the existing lease semantics,
  including expiry, fencing, orphan recovery, and conflict evidence.
- Keep automatic change-to-scenario selection parked until exercised coverage
  contracts support conservative, explainable selection and fallback-to-full-set,
  and the historical-learning case proves that history changes a bounded decision
  without mixing incompatible scenarios.
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

## Decision Gates, Not Commitments

Keep these outside committed core horizons until a bounded case demonstrates a
product-neutral contract need that existing artifacts cannot express:

- a public proof graph rather than derived read-only views;
- remote trusted-history storage, retention, or access-control infrastructure;
- broad non-mobile interoperability beyond language-neutral conformance;
- generic multi-provider claim composition beyond a narrow consumer-declared
  proof case that preserves each provider's identity and failure status;
- autonomous change-to-scenario selection or other generic workflow policy.

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
