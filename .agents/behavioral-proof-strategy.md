# Behavioral Proof Strategy

Status: internal decision surface. Baseline: `origin/main` at
`a4ced100cb50e63b43e7e25eb64008dc9c9997da`. Roadmap input:
`origin/docs/mobile-trust-roadmap-0.1.15` at `dca81fac6ceaf8933a499238dd61442cd34c1a55`.
This document does not change public positioning or create a package commitment.

## Thesis and decision rule

ASL may become a behavioral proof layer for increasingly autonomous software
engineering: applications declare behavior, interchangeable adapters execute and
observe it, and ASL determines whether preserved evidence is healthy and
comparable enough to support a bounded decision. This is a hypothesis, not a
new category claim.

Invest only when a slice makes a named claim falsifiable with durable artifacts,
reduces incorrect autonomous action, and stays product-neutral. A successful
execution is not proof. Mobile remains the proving ground until a second domain
demonstrates reuse without weakening or rewriting the contract.

## Substantiated today

| Thesis element | Current support | Assessment |
| --- | --- | --- |
| Behaviors precede tools | Scenario journey, milestones, truth events, budgets, capabilities, and evidence requirements are runner-neutral (`docs/contracts.md`; scenario schemas). | Substantiated as a contract. |
| Truth is separate from control and evidence | The four-plane doctrine and thin app contract make applications own truth while runners/providers collect evidence (`docs/principles.md`; `docs/contracts.md`). | Substantiated; consumer instrumentation is still required. |
| Execution is not proof | Input actions do not establish resulting behavior; health gates timing, budget, and optimization claims (`docs/contracts.md`; `core/evidence-interpreter.ts`). | Substantiated in contracts and focused tests. |
| Adapters are replaceable | Capability planning, runner/provider manifests, executable protocol, stable failure taxonomy, and a Python conformance fixture avoid TypeScript subclassing (`docs/architecture.md`; `docs/external-adapter-protocol.md`; `runner/__tests__/fixtures/external-adapter`). | Substantiated at protocol/conformance tier; not yet a live same-scenario replacement demonstration. |
| Provenance survives failure | Run/attempt/operation identity, sequence, deadlines, hashes, run-relative references, partial artifacts, cancellation, and cleanup are represented (`docs/external-adapter-protocol.md`; artifact schemas). | Substantiated per run; privacy, transformation lineage, and retention are partial. |
| Health governs interpretation | Health, verdict, diagnostic sufficiency, native target/window binding, measurement policy, and comparison readiness fail closed (`docs/contracts.md`; `core/native-performance.ts`; `core/comparison.ts`). | Substantiated for modeled claims. |
| Trusted history informs comparison | Run indexing and latest-trusted lane selection exist (`core/run-index.ts`; `core/comparison.ts`; `runner/compare-latest.ts`). | Substantiated locally for baseline selection; not a learning system. |
| Failure routes the next action | Structured health metadata and summaries prioritize owner-specific next actions (`docs/contracts.md`; `core/agent-summary.ts`). | Partial: routing vocabulary exists, but authority and human-intervention policy are not end-to-end contracts. |

The thesis exceeds present evidence when it implies a general proof graph,
cross-run learning that changes future work, automated authority, multi-provider
claim composition, remote trusted history, low-cost adoption, or demonstrated
interoperability outside the mobile proving ground.

## Work classification

### Protocol spine

- Stable scenario/run/attempt/operation/provider identity and scenario-hash
  provenance.
- Capability negotiation, no-silent-downgrade planning, and language-neutral
  executable conformance.
- App-owned truth versus adapter-owned control/evidence.
- Bounded capture lifecycle, partial evidence, immutable references, target and
  time-window binding, health, claim sufficiency, and comparison validity.
- Closed failure ownership plus a structured next action and escalation need.

Identity, health, truth/evidence separation, failure preservation, and adapter
conformance already form a strong spine. The smallest missing pieces are claim
composition across providers, explicit authority/escalation semantics, scenario
lineage compatibility, and provenance policy for transformed or retained data.

### Proof-graph and trusted-history substrate

Existing artifacts already contain useful nodes and edges: scenario hashes,
run/attempt/operation correlations, truth timelines, artifact references and
hashes, provider identity, target/window binding, health, verdict, comparison,
and selected baselines. Run indexing and latest-trusted comparison are a local
history substrate.

Do not add a public proof-graph schema yet. First implement a derived, read-only
view over existing artifacts for the falsification cases below. Promote only an
edge or identity missing from valid derivation; otherwise a graph would duplicate
truth and create compatibility burden before demand is proven.

### Case-study and adoption proof

- One portable behavior run through two materially different adapters without a
  scenario rewrite.
- One run combining app truth with two independent evidence providers, including
  a conflicting or missing provider.
- Repeated trusted history that causes a reviewed scenario/budget/selection
  change and records why.
- A new consumer that can classify product, runner, environment, unsupported,
  and incomplete-diagnostic failures from artifacts without host logs.

These are demonstrations first. Package work is justified only when a case
exposes a reusable contract gap.

### Deferred or outside ASL core

- Generic workflow orchestration, code-change planning, source-control lineage,
  autonomous code generation, and repository-specific impact inference.
- Remote evidence stores, fleet scheduling, distributed leases, dashboards,
  notification transports, and vendor-specific review bots before local
  semantics are proven.
- A universal proof graph, generalized policy engine, or non-mobile adapter
  taxonomy based only on conceptual fit.
- Product scenarios, accounts, selectors, routes, secrets, acceptable risk,
  retention requirements, and the final decision to ship.

## Falsification matrix

| Case and claim | Required evidence | Success criterion | Falsifier | Consumer burden | Work type |
| --- | --- | --- | --- | --- | --- |
| False optimization rejection: unhealthy or unmeasurable evidence cannot justify optimization. | Same scenario with a healthy measurable baseline and a faster-looking run that has missing milestones, insufficient samples, target mismatch, or partial provider capture; health, budget, comparison, and summary artifacts. | Every invalid candidate remains diagnostic/partial for the affected claim and emits a repair action; no trusted regression/improvement claim is produced. | Any public interpreter, CLI, or summary reports an optimization from the invalid candidate, or uses mismatched/incomplete native evidence as a trusted native-performance baseline. | Declare milestones/budget and produce app truth; arrange one controlled invalid run. | Package tests plus one live mobile case. |
| Runner replacement: behavior survives adapter replacement. | One unchanged scenario hash, equivalent target/environment declaration, two independently implemented conforming adapters, their plans, normalized app-owned milestone/timeline outputs, resulting-state evidence, health, verdicts, and inventories. Include an adapter-specific-control negative case. | Both produce equivalent declared truth and resulting state without scenario edits; unsupported capabilities fail at planning; differences remain adapter evidence. | Scenario/tool-specific rewrite, divergent truth/result under passed verdicts, hidden adapter options becoming behavioral truth, or the negative case silently passing. | Supply semantic controls/selectors supported by both and app-owned truth. | Primarily case study; package work only for exposed conformance gaps. |
| Multi-provider combined proof: complementary evidence may support one narrow consumer-declared claim without collapsing provenance. | One healthy run, app truth, two provider manifests and command records, per-provider identity/status/hashes, target/window binding, and a consumer-declared rule scoped to an existing claim type such as native performance. Include one conflict/missing-output fixture. | A derived case-study result names every contribution, preserves each provider status, and downgrades on required conflict/missing evidence without claiming a generic composition contract. | Last-writer-wins, provider identity loss, evidence union implying sufficiency, or one provider failure turning into product failure without declared policy. | Configure providers and own the narrow required-evidence rule. | Case study first; package work only if it proves a minimal missing relation in an existing claim contract. |
| Correct failure-owner routing: recommendations identify the bounded repair owner without claiming action authority. | Fixtures/live runs for scenario contract, app truth, runner, provider, environment, unsupported capability, delivery, and compound/ambiguous failure; health checks and next-action metadata. | A deterministic derived recommendation selects the correct owner and bounded diagnostic action, or stays explicitly unresolved; warnings never mask the primary blocker. Consumer policy separately decides who may act. | Adapter failure routes to product repair, optimization is suggested for unhealthy proof, compound ambiguity is hidden, or a mutating action is implied without downstream authority. | Declare local ownership and authority policy; ASL supplies product-neutral failure classes. | Package recommendation tests after vocabulary audit plus case fixtures; authority stays downstream. |
| Historical learning changes a future decision: compatible history supplies information absent from a latest-only view. | Compatible repeated runs, baseline-selection record, scenario hash/lineage facts, excluded incompatible runs, a predeclared deterministic decision rule, paired full-history/latest-only evaluation, and a reviewed downstream decision record. | The paired evaluation produces different reproducible recommendations for a declared reason; the consumer-approved later change cites trusted evidence and exclusions. | Incompatible history is mixed, the paired rule gives the same result, correlation is presented as causation, or no downstream decision changes. | Own the decision rule, acceptance policy, and approval of the changed scenario/budget/selection. | Human-mediated case study first; lineage/compatibility package work only if derivation is insufficient. |

## Surgical roadmap implications

Do not replace or broaden the roadmap input. Apply a small patch against the
pinned `origin/docs/mobile-trust-roadmap-0.1.15` ref only after cockpit approval:

1. Add a short decision rule near the operating model: protocol-spine gaps and
   falsifying demonstrations outrank new surfaces; public claims remain unchanged.
2. Mark bounded iOS simctl video as shipped on exact main; retain reviewer evidence
   as a derived-view experiment unless existing artifacts prove insufficient.
3. In Horizon 1, add runner replacement, false-optimization rejection, and the
   owner-routing fault matrix as exit evidence.
4. Move advisory delivery after the protocol/history demonstrations or outside
   core. Delivery formats should consume settled claims, not force claim policy.
5. In the history horizon, require scenario-lineage and compatibility decisions
   plus the historical-learning case before remote storage, flake intelligence,
   distributed resources, or automatic selection.
6. Mark public proof graph, remote history, broad non-mobile interoperability, and
   autonomous change-to-scenario selection as decision gates, not commitments.

Keep iOS video, native-performance depth, and reviewer bundles where they already
serve hard mobile demonstrations. No new horizon is needed.

## Open architectural questions

- **Proof graph:** Which required query cannot be derived from current immutable
  artifacts? What is the minimum missing edge, if any?
- **Scenario lineage:** Is the scenario hash sufficient identity, or must a
  product-owned stable scenario id relate compatible revisions and explain
  breaking behavioral changes?
- **Trusted history:** Does core own only selection/compatibility policy over an
  injected read-only index, leaving storage, retention, and access control to the
  consumer?
- **Authority:** Should ASL stop at an evidence-backed owner/recommendation while
  consumer policy records approval and human intervention? What minimal boundary
  metadata, if any, is needed without turning ASL into a workflow engine?
- **Provenance/privacy:** How are raw, redacted, transformed, summarized, and
  deleted evidence related, and which hashes/attestations survive retention?
- **Ownership:** ASL owns product-neutral proof semantics; consumers own behavior,
  instrumentation, risk, credentials, policy thresholds, and ship decisions.
  Which combined claims require consumer-supplied policy?
- **Interoperability:** Require a real non-mobile consumer with the same scenario,
  health, evidence, and comparison needs. Syntax-only adapter conformance is not
  enough to justify a broader category.

## Next three bounded slices

1. **False-optimization rejection packet.** Dependency: existing health,
   measurement, native readiness, comparison, and latest-trusted fixtures. Core
   owns contract tests; a consumer owns one Android or iOS live case. Proof tier:
   release-gated fixtures plus one artifact packet. Stop if any invalid candidate
   yields an optimization claim; repair that gate before adding surfaces.
2. **Adapter replacement conformance case.** Dependency: one portable scenario and
   two adapters with overlapping declared capabilities, at least one outside the
   built-in runner path. Adapters own execution; consumer owns truth; core owns
   conformance interpretation. Proof tier: unchanged scenario hash, both artifact
   sets, and a planned unsupported case. Stop if success needs behavior-contract
   edits or tool-specific top-level concepts.
3. **Failure-owner routing fault matrix.** Dependency: audit current failure and
   next-action vocabularies, including compound and ambiguous failures. Core owns
   only product-neutral classification; adapters, providers, and a consumer supply
   fault cases and local authority. Proof tier: focused policy fixtures plus
   bounded mobile fault injection. Stop when unambiguous failures route
   reproducibly and ambiguity remains explicit; do not invent a centralized
   authority model to force a single answer.

Multi-provider claim composition and historical learning follow these slices.
The former first needs a real complementary-and-conflicting provider case; the
latter needs an explicit scenario-lineage/compatibility decision and a consumer
willing to own the change.

## Review gates

- Reject category language not supported by a named artifact and falsifier.
- Reject novelty claims based on familiar primitives; the only plausible novelty
  is their demonstrated synthesis.
- Reject generic workflow, source-control, or product-decision ownership drift.
- Account explicitly for consumer instrumentation, semantic controls, policies,
  comparable environments, and live-proof cost.
- A case study passes only when its deliberate negative case fails closed and the
  resulting artifacts alone explain why.
