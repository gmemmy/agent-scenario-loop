# Public API

Agent Scenario Loop keeps its public surface small: the root package exports stable core contracts, while runner subpaths expose executable adapters for teams that want to compose the proof loop from code.

## Root Package

Import core contracts from `agent-scenario-loop`:

```js
const {
  buildAgentSummaryMarkdown,
  buildScenarioClaimHash,
  buildScenarioExecutionPlan,
  buildRunIndex,
  buildAndroidNativePerformanceEvidence,
  classifyNativePerformanceComparisonReadiness,
  compareRunDirectories,
  coordinateQuickProof,
  createArtifactLayout,
  createQuickProofAuthorizationPort,
  dispatchDriverAction,
  evaluateRunnerCompatibility,
  validateJson,
} = require('agent-scenario-loop');
```

The root package is for stable, runner-neutral behavior:

- artifact layout and artifact writers
- claim-complete scenario/verdict structural types and deterministic claim hashing
- claim prerequisite declarations plus dependency, authority-capability, and final admission inspection
- profile-event parsing, metrics, manifests, causal runs, budget verdicts, and summaries
- scenario execution-plan normalization, including resolved cadence pacing metadata
- scenario/runner/provider compatibility checks
- port validation and driver dispatch helpers
- typed port contracts for primary runners, drivers, evidence providers, artifact writers, and interpreters
- evidence interpretation gates
- run indexing and lane-aware latest-trusted comparison selection
- comparison artifacts, including `comparison.json` schemaVersion `1.1.0` with optional native-performance comparison truth
- local historical evaluation structural types and semantic validation for consumer-produced `historical-evaluation.json`
- aggregate live-proof artifacts
- allowlist-first evidence-package types and `materializeEvidencePackage()`
- CI evidence-pack types and helpers (`CiEvidencePack`, `buildCiEvidencePack`,
  `readCiEvidencePack`, `deriveCiEvidencePackMechanismStatus`,
  `deriveCiEvidencePackTwoPlatformClaim`, `assertCiEvidencePackSemantics`,
  `assertCiEvidencePackRunRelativePath`, `verifyCiEvidencePackLiveProofSet`,
  `assembleCiEvidencePack`) plus `SCHEMAS.ciEvidencePack`
- CI evidence publication receipt and deterministic summary types and helpers
  (`CiEvidencePublicationReceipt`, `CiEvidencePublicationStatus`,
  `buildCiEvidencePublicationReceipt`,
  `readCiEvidencePublicationReceipt`, `assertCiEvidencePublicationReceiptForExactPackBytes`,
  `assertCiEvidencePublicationReceiptForPack`, `renderCiEvidencePublicationSummary`,
  `evaluateCiEvidencePublicationSummary`, `CiEvidencePublicationAudience`,
  `CiEvidencePublicationSummaryEvaluationOptions`,
  `CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION`,
  `CiEvidencePublicationReceiptError`) plus `SCHEMAS.ciEvidencePublicationReceipt`
- CI evidence GitHub publication input, gate, and report helpers
  (`admitCiEvidenceGithubPublicationFacts`, `evaluateCiEvidenceGithubPublicationGate`,
  `CiEvidenceGithubPublicationGateError`, `buildCiEvidenceGithubPublicationReport`,
  `CiEvidenceGithubPublicationReport`) plus
  `CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION` from
  `./core/ci-evidence-github-publication-input`,
  `./core/ci-evidence-github-publication-gate`, and
  `./core/ci-evidence-github-publication-report`
- quick-proof coordination for bounded setup, operation-specific capability
  discovery, scoped authorization and lease propagation, one retry per adapter
  path, deterministic pre-product fallback, and setup-only friction evidence
- schema validation
- Android native-performance evidence normalization from provider-captured `gfxinfo`, framestats, `meminfo`, and trace-processor summaries
- iOS native-performance evidence normalization from provider-captured Instruments, xctrace, MetricKit, simctl, or native-trace summaries, including parser helpers for common xctrace and MetricKit text summaries
- shared Android/iOS native-performance comparison-readiness classification from captured source, bounded window, observed target, completeness, comparability, and claim evidence

`materializeEvidencePackage(request)` is the package-root API for building an allowlist-first, owner-private local evidence directory. The request and output contracts are shipped as `schemas/evidence-package-request.schema.json` and `schemas/evidence-package.schema.json`, registered as `SCHEMAS.evidencePackageRequest` and `SCHEMAS.evidencePackage`. The adapter bridge request is shipped as `schemas/adapter-live-proof-request.schema.json` and registered as `SCHEMAS.adapterLiveProofRequest`. The materializer stable-reads only declared regular files, requires portable output-relative destinations under `files/`, rejects path traversal, portable path collisions, symlinks, missing or empty files, selected sensitive environment/key paths, and selected private-key markers, and never replaces an existing output directory. It verifies private staged bytes, atomically reserves a previously absent output directory, moves the staged payload into that reservation, and installs the hash-bearing `evidence-package.json` completion manifest last alongside `SHA256SUMS`. Failed publication removes package-owned incomplete output and newly created empty parent directories. `EvidencePackageError.rejections` is the structured local failure inventory. Package completion proves this narrow materialization contract only; it is not a general secret scanner, and callers remain responsible for semantic redaction of otherwise admissible contents.

The public bins `asl-adapter-live-proof` and `asl-evidence-package` are also available through `agent-scenario-loop/runner/adapter-live-proof` and `agent-scenario-loop/runner/evidence-package`. The adapter subpath exports `AdapterLiveProofError`, `buildAdapterLiveProof`, and `main`; the evidence-package runner subpath exports `main`. These exports expose the same local runner I/O mechanics as the bins and do not add semantic authority. `asl-adapter-live-proof --request <json>` accepts `adapter-live-proof-request.schema.json`, verifies one exact target-bound Agent Device preflight and one same-scenario capture, hashes declared sidecars, and writes a platform `live-proof.json`. Required missing, invalid, unavailable, or rejected sidecars fail that live-proof gate. It does not evaluate product semantics, and the direct adapter verdict remains `not_evaluated`. `asl-evidence-package --request <json>` emits one JSON completion record on success. Rejected allowlist entries emit a structured rejected record, exit nonzero, and create no canonical package directory. Neither command runs a device, uploads artifacts, publishes evidence, or changes release state.

TypeScript consumers can import `CiEvidencePack` types and the named builder, reader, derivation, verifier, assembler, and parse helpers from the package root. The assembler public API is `assembleCiEvidencePack`, `verifyCiEvidencePackLiveProofSet`, `CiEvidencePackAssemblyOptions`, `VerifiedCiEvidencePackLiveProofPointer`, and `VerifiedCiEvidencePackLiveProofSet`. `buildCiEvidencePack` and `readCiEvidencePack` validate the pack schema and cross-record semantics. `parseCiEvidencePackBytes(bytes)` admits exact pack bytes and throws `CiEvidencePackError` for fatal UTF-8, JSON, schema, or derived-semantic failures. `verifyCiEvidencePackLiveProofSet` and `assembleCiEvidencePack` read and hash-verify the live-proof-set file; child proof and summary pointers must resolve to distinct regular files inside the real artifact root. The assembler verifies pointer identity and containment but does not read or semantically interpret child bytes. Stable contained-file I/O stays internal to the assembler module and is not a package-root export. Emitted packs are not rewritten; retries remain distinct retained attempts. That immutability is artifact lifecycle, not a JavaScript deep-freeze. Mechanism status, the derived Android+iOS evidence claim, product verdict, comparison, publication, release, and deployment remain distinct. The schema is shipped at `agent-scenario-loop/schemas/ci-evidence-pack.schema.json` and registered as `SCHEMAS.ciEvidencePack`.

The package also ships a runner-independent CLI as bin `asl-ci-evidence-pack` (`dist/runner/ci-evidence-pack.js`) and public embedding subpath `agent-scenario-loop/runner/ci-evidence-pack`. That subpath exports CLI types, parsers, the request reader, run functions, the atomic writer, `FileSystemPort`, and `main` as runner I/O mechanics; they are not semantic authority and do not run devices or uploads. `parseCiEvidencePackCliArgs` accepts a `process.argv`-shaped string array (program and script slots, then flags). Command dispatch is an exhaustive switch over the closed command union; an unsupported runtime command value fails closed as usage exit `2` and does not summarize. Nested request shape checks are defense-in-depth only; `assembleCiEvidencePack` remains the authoritative schema and semantic admission. Path values are preserved exactly and are not trimmed. Subcommands:

- `assemble --request <request.json>` consumes an exact closed request envelope `{ artifactRoot, outDir, input }`. `input` is the exact closed `CiEvidencePackBuildInput` own-key vocabulary. Extra top-level or `input` keys, unknown nested keys, and non-object nested array entries are usage exit `2`. Missing, wrong-typed, or semantically invalid values that reach verification or assembly fail as evidence exit `1`. The closed assemble request has no runner-identity field. Runner and provider identity remain in the hash-bound live-proof-set and its linked proof and provider artifacts; the CI pack does not synthesize or reinterpret that identity.
- `summarize --pack <ci-evidence-pack.json> --receipt <ci-evidence-publication-receipt.json> [--out <summary.md>]` reads pack bytes once, binds the receipt and summary to those exact bytes, and writes deterministic Markdown atomically. `--out` that equals the pack or receipt as a resolved string, or an existing `--out` whose `realpath` resolves to the pack or receipt (including a symlink or case alias), is usage exit `2` before any reads or writes and cannot clobber either input. Default Node `FileSystemPort` enforces that alias check via optional `existsSync`/`realpathSync`; if an existing output cannot be safely resolved, the CLI fails closed as usage exit `2`. Custom ports may omit those optional methods.
- `github-report --pack <ci-evidence-pack.json> --input <github-publication-input.json> --out <new-directory>` reads exact pack bytes once, admits restricted authenticated-reviewer publication facts from `--input`, evaluates the GitHub publication gate, and materializes a local reviewer report. Those exact pack bytes are bound to the generated receipt and Markdown report. `--out` is an exclusively reserved new directory: existing files, directories, symlinks, dangling symlinks, pack or input aliases, and races are never replaced. The writer uses an incomplete-marker protocol (`.ci-evidence-github-report.incomplete`) and emits canonical `ci-evidence-publication-receipt.json` and `ci-evidence-github-report.md` only after a complete successful write; the incomplete marker must not remain on a finished write. Occupied `--out` is usage exit `2` and preserves existing bytes. Exit `0` only when the publication gate passes. A valid failed publication gate still writes both canonical files, emits stdout `gateStatus` `failed`, and exits `1`. Malformed, unsafe, or I/O failure exits `1`, or usage `2` as defined; interrupted or failed writes may retain a marker-bearing visibly incomplete directory and do not promise that no directory remains. Product verdict and comparison remain separate non-gates in the pack/report contract and are not emitted on github-report stdout. This command is local-only: it does not upload, call the GitHub API, create checks, publish a release, deploy, run devices or runtime work, or prove product acceptance. Restricted authenticated-reviewer HTTPS links are not public visibility.

Outputs: assemble writes `ci-evidence-pack.json` under `outDir` and retains failed or retried attempts. Every successful canonical assemble write emits one JSON stdout record with `phase`, `artifact`, `publicationAttempted=false`, `gateStatus` (`passed` or `failed`), `mechanismStatus`, and `twoPlatformClaimStatus`. Assemble exit `0` requires the current assemble gate to pass: current source, a passed live proof set, complete evidence, succeeded assembly/mechanism, and a passed derived two-platform evidence claim. Comparison and product verdict remain separate and do not gate pack assembly. If assembly returns a schema-valid nonpassing pack, the CLI writes it, emits the failed-gate stdout record, and exits `1`. Verification, assembler, or I/O exceptions return `1` without claiming or writing a canonical pack. Summarize writes the Markdown summary (default next to the pack unless `--out` is set). Every successful summary write emits one JSON stdout record with `phase`, `artifact`, and `gateStatus` equal to the exact `evaluateCiEvidencePublicationSummary` status. Summarize exit `0` requires that publication evaluation to pass; a schema-valid nonpassing summary is written, emits the failed-gate stdout record, and exits `1`. Integrity, read, render, or write failure remains no-write and exit `1`. Exit `2` is usage or request-shape failure; assemble does not create an output pack. Neither assemble, summarize, nor github-report runs devices, uploads, calls GitHub, publishes a release, deploys, or proves product, runtime, release, or deployment acceptance. Usage help uses evidence-pack and publication-gate wording and does not claim product, runtime, comparison, release, deployment, upload, or GitHub success. `gateStatus` is a local CLI JSON field for that written artifact; it is not a new public schema vocabulary. Every successful github-report write emits one JSON stdout record with `phase` `github-report`, `artifactDirectory`, `receiptArtifact`, `reportArtifact`, and `gateStatus` for the publication gate only. It does not emit `artifact`, `productVerdictStatus`, or `comparisonStatus`.

TypeScript consumers can import publication receipt types and helpers from the package root. A receipt binds SHA-256 and byte size of exact packed CI evidence pack bytes and records publication mechanics without rewriting pack mechanism status, two-platform claims, or product verdicts. Destinations must be safe HTTPS URLs; failed, rejected, private, not-available, and invalid outcomes remain retained. `publicationStatus` is `published`, `partial`, `failed`, or `not_published`. Publication success proves only that the bound pack bytes were published, not product success, comparison trust, release acceptance, deployment, or runtime acceptance. `readCiEvidencePublicationReceipt(receiptPath, exactPackBytes)` requires those exact pack bytes as a second argument and, after UTF-8/JSON/schema/local semantic admission, parses them as the bound pack and asserts identity, presence, sha256, and byteSize against that byte sequence. `assertCiEvidencePublicationReceiptForExactPackBytes(receipt, parsedPack, exactPackBytes)` binds an already-admitted parsed pack to those same exact bytes; it does not re-parse pack JSON. `assertCiEvidencePublicationReceiptForPack` validates semantic and copied binding against an already-parsed pack object only; it does not hash bytes. The public renderer signature is `renderCiEvidencePublicationSummary(pack, receipt, exactPackBytes)`; it requires those same exact pack bytes and emits deterministic Markdown that keeps the distinct publication and two-platform status surfaces. Generic render behavior remains public-link strict and does not expose restricted URLs. The evaluator signature is `evaluateCiEvidencePublicationSummary(pack, receipt, exactPackBytes, options?)`. Default and explicit `options.audience='public'` require safe HTTPS public visibility. `options.audience='authenticated_reviewer'` permits safe HTTPS public or restricted outcomes so reviewer-link obligations can pass without treating restricted destinations as public. Receipt admission, exact-byte binding, non-present evidence rejection, and `publicationStatus` remain unchanged. Neither audience mode proves mechanism, two-platform evidence, product, runtime, comparison, release, or deployment acceptance. This is audience policy only, not GitHub upload or API behavior. Invalid binding or unsafe published destinations throw `CiEvidencePublicationReceiptError`. The schema is shipped at `agent-scenario-loop/schemas/ci-evidence-publication-receipt.schema.json` and registered as `SCHEMAS.ciEvidencePublicationReceipt`. Receipt helpers remain generic pack-byte binding, evaluation, and rendering. `github-report` adds local GitHub reviewer-report materialization and publication-gate evaluation. Upload orchestration, GitHub API calls, check creation, and remote publication remain outside the CLI. Neither receipt helpers nor `github-report` prove product, runtime, comparison, release, or deployment acceptance.

TypeScript consumers can import GitHub publication facts admission, gate evaluation, gate error, report builder, and report types from the package root. Facts admission is restricted authenticated-reviewer publication input, not public publication. Gate evaluation is a publication-layer decision and does not rewrite pack mechanism status, two-platform claims, product verdict, or comparison. The report builder `buildCiEvidenceGithubPublicationReport(exactPackBytes, publicationFacts)` materializes local reviewer Markdown and a bound receipt; it does not upload, call the GitHub API, create checks, release, deploy, or accept product or runtime behavior. Restricted authenticated-reviewer links are not public visibility.

TypeScript consumers can import `HistoricalEvaluationArtifact`, the explicitly named `UnvalidatedHistoricalEvaluationArtifact`, and the branded `ValidatedHistoricalEvaluationArtifact` from the package root. `HistoricalEvaluationArtifact` is an unvalidated structural alias; TypeScript cannot prove schema refinements or cross-record integrity. Call `validateHistoricalEvaluationArtifact(unknown)` to run both the strict schema and semantic integrity checks before accepting the branded result. The schema is shipped at `agent-scenario-loop/schemas/historical-evaluation.schema.json` and registered as `SCHEMAS.historicalEvaluation`. This V1 surface remains consumer-produced and local-only; it does not export an evaluator, selector, reader, writer, or CLI command, and it does not alter `comparison.json` or process exit behavior.

TypeScript consumers can also import the `ScenarioClaimDefinition`,
`ScenarioClaimAssertion`, `ClaimResult`, and related closed-vocabulary types.
Use `buildScenarioClaimHash()` to derive the canonical SHA-256 identity for a
complete claim definition. This is a reader and authoring foundation only:
current runners reject scenario `1.1.0` before runtime, do not evaluate these
claims or emit verdict `1.1.0`, and a
schema-valid claim result is not proof that ASL produced or trusted it.
`ClaimAssertionResult` is discriminated by assertion kind and terminal status;
its expectation and observation objects preserve event, order, terminal-state,
bounded-count, absence, or artifact-validation structure without generic
`present`/`absent` scalar conventions. Validate JSON consumers against the
shipped verdict schema. TypeScript alone cannot enforce JSON integer refinements
or prove that a repeated expectation matches its scenario claim. In
particular, the schema enforces non-negative integer counts and a positive count
for rejected absence while the structural TypeScript observation uses
`number`; consumers must validate unknown JSON before relying on that numeric
policy.

Use `inspectScenarioClaimClosure(scenario, { platform, variant? })` to inspect
the authored closure graph for one exact selection. The returned
`ScenarioClaimClosureInspection` reports `closed`, `not_closed`, or
`outside_contract` with deterministic check IDs and blocking reasons. It does
not inspect runtime authority, adapter capabilities, safety, authorization,
human approval, evidence, or verdict truth, and it has no filesystem or runner
side effects. A `closed` result must never be presented as admission or product
success.

Use `inspectScenarioClaimDependencies(scenario, { platform, variant? })` to
inspect the required top-level dependency inventory for one exact selection.
The returned `ScenarioClaimDependencyInspection` reports `complete`,
`incomplete`, or `outside_contract`, preserves applicable dependency IDs in
authored order, and checks dependency identity, claim references, and
applicability containment. `JourneyEntryDependency`, `ClaimScopedDependency`,
and `ScenarioClaimDependency` are exported structural types. The reader does
not discover, observe, execute, or admit a dependency predicate.

Use `inspectScenarioClaimAuthority(scenario, { platform, variant? },
declarations)` after schema and closure inspection to check the selected
claim-complete assertions and dependency predicates against caller-supplied
authority-capabilities
`1.0.0` declarations. The returned `ScenarioClaimAuthorityInspection` reports
`compatible`, `incompatible`, or `outside_contract`, per-subject checks,
blocking reasons, and a bounded next action. The package also exports the
`AuthorityCapabilities` structural type and registers the shipped schema as
`SCHEMAS.authorityCapabilities`.

Each authority check discriminates `subjectKind: "claim_assertion"` from
`subjectKind: "dependency_predicate"`. Claim rows carry `claimId`, `claimRole`,
and `assertionId`. Dependency rows carry `dependencyId`, `dependencyKind`, and
`predicateId`; only `claim_scoped` rows carry `claimIds`. Consumers must not
fabricate claim identity for a journey-entry prerequisite.

The inspector performs no discovery, filesystem reads, runner work, evidence
evaluation, or artifact writes. `compatible` means only that each applicable
claim assertion and dependency predicate has an exact declared producer path
with sufficient static strength and completeness. It does not mean admitted,
executable, available at runtime, approved, evaluated, or passed. Validate untrusted declarations against
`agent-scenario-loop/schemas/authority-capabilities.schema.json` before treating
them as catalog input.

Use `inspectScenarioClaimSafety(scenario, { platform, variant? })` to inspect
the claim-complete scenario's static safety declaration. The package exports
the `ScenarioSafetyDeclaration` and `ScenarioClaimSafetyInspection` types. For
a mutating declaration, `complete` proves only that mutation identity,
required safeguards, and terminal reconciliation reference unambiguous,
applicable mandatory assertions and authored terminal invariants. Read-only
declarations have no mutation bindings. The inspector performs no authorization,
approval, resource acquisition, discovery, or runtime admission.

Use `inspectScenarioClaimVerdictReduction(scenario, { platform, variant? },
candidateVerdict)` to inspect whether a caller-supplied verdict `1.1.0`
candidate preserves the exact applicable claim and assertion inventory,
canonical claim hashes, authored expectations, health gate, and deterministic
claim and journey status reduction. Every return value carries
`trust: "inventory_reduction_only"` and reports `reduced`, `incoherent`, or
`outside_contract`. A reduced inspection is not a trusted verdict: the
function does not read or admit evidence, execute the scenario, return the
candidate verdict object, or establish that any supported or rejected result
is true. Current runners still reject scenario `1.1.0` before runtime and do
not emit verdict `1.1.0`.

Use `buildClaimCompleteVerdict(input)` to construct one frozen verdict `1.1.0`
artifact from a schema-valid scenario `1.1.0`, a pre-runtime selection of
platform and optional variant plus applicable and excluded claim IDs, a
`healthStatus`, a run ID, and exactly one reconciled `ClaimResult` per
applicable claim. The builder returns a deep-frozen candidate whose reduction
matches the claim-complete inventory: passed, failed, or inconclusive journey
status with the corresponding health projection. Failed or partial health does
not throw: it produces an inconclusive candidate and projects every
claim/assertion to `health_gate_failed`. Malformed, incoherent, sparse, or
foreign input, no applicable mandatory claim, an unsupported assertion kind,
invalid output schema, or a rejected reduction inspection throw and fail
closed. The builder returns a frozen candidate or throws; it does not return a
structured fail-closed result. It does not admit evidence, execute scenarios,
write artifacts, publish verdicts, establish product truth, or enable current
runners to execute scenario `1.1.0`.

Use `buildScenarioClaimCompleteContractHash(scenario)` to derive the canonical
SHA-256 identity of one complete, schema-valid scenario `1.1.0` document. The
hash covers the entire closed scenario object, including descriptive,
operational, journey, claim, and safety fields. Object-key order does not
matter and authored array order does. This conservative V1 identity means any
scenario edit invalidates prior approval; it is not a partial semantic-subset
hash.

Use `inspectScenarioClaimApproval(scenario, { platform, variant? }, approval)`
to inspect a caller-supplied `scenario-claim-approval` `1.0.0` sidecar. The
record binds the exact scenario ID and full contract hash plus the selected
platform and optional variant. Results are `bound`, `invalidated`, or
`outside_contract`, and every result carries
`trust: "exact_hash_attestation_only"`. A bound result proves only that the
opaque caller attestation still names the current bytes and selection. ASL
does not authenticate `approverRef`, expire `approvedAt`, grant runtime
authorization, admit execution, evaluate evidence, issue a verdict, raise a
proof tier, or permit publication. Runtime authorization remains a separate
scoped and expiring gate. The closed approval schema is shipped at
`agent-scenario-loop/schemas/scenario-claim-approval.schema.json` and is
registered as `SCHEMAS.scenarioClaimApproval`.
`ScenarioClaimApprovalRecord` is an unvalidated structural TypeScript type;
TypeScript cannot prove JSON regex, string-length, or date-time refinements.
Validate unknown records against the shipped schema before inspection or
storage.

Use `inspectScenarioClaimAuthorization(scenario, selection, request, grant)`
to inspect a credential-free `scenario-claim-authorization-grant` `1.0.0`
record. The request supplies the goal, exact operation set, mandatory target
resource, and deterministic `nowMs`; the inspector never reads the ambient
clock. The package exports `ScenarioClaimAuthorizationGrant`,
`ScenarioClaimAuthorizationRequest`, and
`ScenarioClaimAuthorizationInspection`. Results are `compatible`,
`incompatible`, or `outside_contract` with ordered checks, blocking reasons,
and a bounded next action. `platform` and `variant` are absent from the result
when the untrusted selection cannot be validated, so the reader never invents
coverage identity.

Compatibility requires exact scenario ID and full hash, selection, safety
class, mutation identity when applicable, goal, target resource, operation
set, and an unexpired grant. It is not final admission, authenticated
delegation, resource ownership, mutable-boundary revalidation, or permission
to execute scenario `1.1.0`. Validate unknown grants against
`agent-scenario-loop/schemas/scenario-claim-authorization-grant.schema.json`,
registered as `SCHEMAS.scenarioClaimAuthorizationGrant`. The structural
TypeScript type does not prove JSON patterns or calendar validity.

Use `inspectScenarioClaimAdmission({ scenario, selection, authorityCatalog,
authorizationRequest, authorizationGrant, approval })` to compose the complete
static admission decision for one exact scenario `1.1.0` selection. The
returned `ScenarioClaimAdmissionInspection` is a closed union:
`outside_contract` carries only the failed schema-and-selection gate; `blocked`
carries all six owner inspections, ordered gate summaries, and a non-empty
blocking-gate inventory; `admitted` carries all six successful inspections and
an empty blocking inventory. A blocked result names the first gate in the fixed
closure, authority, safety, authorization, approval, and dependency order while
retaining every later failure.

The package exports the input, selection, gate, inspection, and result types.
Gate summaries index owner status only. Detailed checks, blocking reasons, and
next actions remain on the owning reader result and are not flattened or
reinterpreted. Missing selected-platform assertion or dependency-predicate
authority is blocking, never `not_applicable`.

This API is pure pre-runtime semantic admission. It does not inspect a device,
discover runtime capability, acquire a lease, read the ambient clock, evaluate
evidence, emit an artifact, or enable scenario `1.1.0` execution. An `admitted`
result is not health, product success, verdict, baseline certification, or
runtime acceptance.

Use `buildScenarioClaimEvidenceRunIdentityHash(runIdentity)` to derive the
canonical identity of one closed evidence run context. The caller supplies the
exact scenario and selection, source and package, target and installed app,
runner, adapter, transport, app-helper payload, environment cohort, and every
named evidence producer. Producer order does not affect the hash; the function
does not mutate the caller's array. Malformed, cyclic, non-plain, non-finite,
absolute-path, traversing, duplicate-producer, or invalid-hash input throws
`InvalidScenarioClaimEvidenceRunIdentityError`.

Use `inspectScenarioClaimEvidenceCandidateIdentity({ admission, scenario,
runIdentity, claimId, assertionId, candidate })` after an `admitted` result to
inspect whether one in-memory evidence candidate is identity-compatible and
eligible for later evaluation. The reader binds the exact run identity,
applicable claim and assertion, admission authority declaration, producer
version and payload hash, required evidence strength and completeness,
kind-specific artifact or observation-window contract, capture status, and
cleanup status. Results are `outside_contract`, `blocked`, or `eligible` with
the fixed gate order `run_identity`, `assertion_identity`,
`authority_binding`, `evidence_binding`, and `lifecycle`. After foundational
input validation, all gates run so later failures remain visible.
The whole runtime envelope is untrusted: `null`, arrays, primitives, missing
required fields, and unexpected keys fail closed as `outside_contract` with the
existing reason vocabulary. Closed vocabularies require actual strings.
Evidence paths must be nonempty, trimmed, free of ASCII control characters and
DEL, and run-relative. Admitted authority checks are closed per subject kind;
extra keys make that admission unusable for this reader.

An `eligible` result includes `eligibleCandidate`, a newly assembled
`ScenarioClaimEligibleEvidenceCandidate` projection. The projection is
detached from the caller candidate: authority, evidence path and SHA, and
nested observation-window data are copied, and the reader never returns or
retains the original object. Capture is always `produced`; cleanup is only
`finalized` or `not_required`. The union is kind-strict: `validatedEvidence`
carries artifact kind and validation contract only, `boundedCount` and
`absence` carry the observation window only, and `eventOccurrence`,
`eventOrder`, and `terminalState` carry neither. Blocked and
`outside_contract` results omit `eligibleCandidate`.

Use `inspectScenarioClaimRawObservationAdmission({ candidate, artifactBytes })`
with that `eligibleCandidate` projection to bind one JSON observation artifact
to its exact declared bytes before decoding it. The reader recomputes SHA-256
over the supplied `Uint8Array`, compares it with the candidate evidence hash,
then performs fatal UTF-8 decoding and closed-shape JSON parsing. It admits
`eventOccurrence`, `eventOrder`, `terminalState`, `boundedCount`, and `absence`
observations. Windowed observations must repeat the exact eligible observation
window. Results are `outside_contract`, `blocked`, `unsupported`, or `admitted`.
`validatedEvidence` remains explicitly `unsupported` on this JSON-native
route because opaque validator reports are a different evidence path; use the
validated-evidence readers below instead of treating that contract as undefined.

This pure reader performs no file discovery or writes, and an admitted
observation is not an assertion result, health result, product verdict,
baseline, or runtime acceptance. Artifact presence proves only the artifact
obligation. Production callers must pass the projection returned by the
candidate-identity reader rather than synthesizing authority. The exported
raw-observation types describe an in-process decoded view; this slice defines
no new persisted proof artifact or schema file.

Use `inspectScenarioClaimJsonNativePointInterpretation(assertionInput,
admittedInput)` as a pure post-admission assertion interpreter for
`eventOccurrence`, `eventOrder`, and `terminalState`. The input must be a
matching admitted raw-observation result plus the exact assertion. The
interpreter does not discover files, write artifacts, or accept an artifact
path as proof of support. The inspector returns `outside_contract` or
`interpreted`. Only `interpreted` contains one `ClaimAssertionResult`;
`outside_contract` contains `reasonCodes` and no result. On `interpreted`,
`supported`, `rejected`, and `not_evaluable` are assertion-level semantics
only; they are not health, claim result, journey verdict, baseline,
certification, publication, or runtime acceptance. Trust is
`admitted_observation_interpretation_only`: admitted bytes may be interpreted,
but artifact presence alone is not semantic support. Duplicate, missing,
conflicting, or ambiguous point evidence remains `rejected` or
`not_evaluable`. This surface does not emit `not_applicable` at runtime and
does not enable scenario 1.1.0 execution.

Use `inspectScenarioClaimJsonNativeWindowedInterpretation(assertionInput,
admittedInput)` as a pure post-admission assertion interpreter for
`boundedCount` and `absence`. The input must be a matching admitted
JSON-native raw observation plus the exact assertion. Admission is a
prerequisite: an admitted artifact alone does not support product behavior.
Window bounds are inclusive. Bounds, observation counts, and admitted artifact
`byteLength` must be non-negative `Number.isSafeInteger` values; unsafe
integers are `outside_contract`. Interpretation requires a complete
observation window; incomplete authority does not prove absence, and a zero
count is not absence proof without that complete authority. Candidate-identity
admission already binds assertion authority; this interpreter does not rematch
those fields. Unrepresentable `WindowedClaimAuthority`, including `point`
completeness, is `input_invalid`.
`authoritative_evidence_rejected` is closed assertion-result vocabulary when
an admitted observation fails the inclusive bound or absence check; it does
not recast observed strength as product authority. The inspector returns
`outside_contract` or `interpreted`. Only `interpreted` contains one
`ClaimAssertionResult`; `outside_contract` contains `reasonCodes` and no
result. On `interpreted`, `supported`, `rejected`, and `not_evaluable` are
assertion-level semantics only. This closed taxonomy is not health, claim
result, journey verdict, baseline, certification, publication, or runtime
acceptance. Candidate reconciliation, health, `ClaimResult`, verdict,
runtime, artifact writes, and publication remain separate. This surface does
not emit `not_applicable` at runtime and does not enable scenario 1.1.0
execution.

Use `inspectScenarioClaimValidatedEvidenceReportIdentity({ candidate, report,
reportBytes })` with an eligible `validatedEvidence` projection to bind a
distinct closed run-relative report identity and its exact bytes. The reader
recomputes report SHA-256 before any semantic interpretation and rejects
subject/report path or SHA collisions. Results are `outside_contract`,
`blocked`, or `admitted`. An admitted result proves only report identity and
exact bytes, not validator semantics.

Use `inspectScenarioClaimValidatedEvidenceAdmission({ candidate, subjectBytes,
report, reportBytes })` to compose that report-identity check after binding
exact subject bytes to `candidate.evidence.sha256`. The composer first parses
one stable eligible candidate projection, binds subject bytes before caller
report fields are read, then delegates report identity, byte, and collision
checks. Results are `outside_contract`, `subject_blocked`, `report_blocked`,
or `identity_admitted`. `identity_admitted` proves only exact subject and
distinct report identities and bytes. It does not parse or execute
`validationContract`, decide support or rejection, evaluate depicted or
measured behavior, or create a `ClaimAssertionResult`, health, verdict,
baseline, comparison, or publication authority. Neither reader performs
filesystem, runtime, device, runner, provider, network, artifact-write, or
publication side effects.

Use `inspectScenarioClaimValidatedEvidenceResultAdmission({
validatedEvidence, result, resultBytes })` to bind a closed run-relative
validator-result identity and its exact bytes after identity-admitted
validated evidence. The schema ships at
`agent-scenario-loop/schemas/validated-evidence-result.schema.json` and is
registered as `SCHEMAS.validatedEvidenceResult`. The reader recomputes result
SHA-256 before any semantic interpretation. `resultId` is any schema-valid
stable safe identifier; it is not required to equal the literal
`validator-result` and is separate from the result artifact path. The
validator tuple in exact result bytes is schema-validated and preserved. This
slice has no independently predeclared expected validator producer to compare
against, so the tuple is not independently authority-bound. The reader still
requires the admitted assertion, `validationContract`, subject identity, and
report identity. Results are `outside_contract`, `blocked`, or `admitted`.
`admitted` proves only result identity and exact bytes plus those identity
bindings. Validator `status` values `passed`, `failed`, and `not_evaluable`
are validator vocabulary only. A passing validator result remains exact-byte
identity evidence only; it is never a `ClaimAssertionResult`, claim support,
contradiction, health, verdict, baseline, comparison, or product truth.
This surface performs no filesystem, runtime, device, runner, provider,
network, artifact-write, verdict, or publication side effects and does not
enable scenario `1.1.0` execution.

`eligible` means only that the named candidate may enter a future semantic
assertion evaluator. It does not establish assertion support, contradiction,
health, product truth, verdict, proof tier, publication eligibility, freshness,
certification, or cross-candidate consistency. Private or redacted local
evidence can remain eligible; this reader does not disclose or publish it. It
performs no filesystem, clock, runner, provider, target, or artifact-writing
work and does not enable scenario `1.1.0` execution.

Use `coordinateQuickProof()` when an owning runner needs to bound setup before
starting a product scenario. Callers provide adapter paths, operation and
argument requirements, identities that preflight must observe, a credential-free
authorization grant, exact source/package identity, and a lease port for any exclusive resource. The
coordinator allows one retry per adapter path, orders trusted, direct, and manual
paths deterministically, and stops all retry/fallback once any product action
starts. `unresolved-until-observed` is valid during read-only discovery but must
become an observed compatible identity before product execution. Manual and
direct paths remain explicit proof tiers.

Every adapter phase receives an `AbortSignal` and is bounded by the remaining
setup or total deadline. The product adapter context requires
`beginProductAction()`; adapters must call and await it immediately before their first mutable
action. That boundary call revalidates authorization, lease lifetime, and budget
reserve, then closes retry and fallback even if the operation later
throws or returns malformed output. Authorization and lease lifetime are checked
again at that boundary.
An adapter that reports mutation without successfully crossing the boundary is
recorded as failed `observed-late` product execution. ASL does not invent an
exact mutation timestamp or allow another adapter to retry the action.
If an adapter times out, throws, or returns malformed output before the boundary and ASL
cannot prove whether mutation occurred, the artifact is `inconclusive` with
`product.started: "unknown"`. It is neither setup-only evidence nor permission
to retry or fall back.
Crossing `beginProductAction()` validates authority and ownership; it is not by
itself mutation proof. The adapter must also return
`productActionStarted: true`. Missing confirmation remains inconclusive and
blocks another path.

`writeQuickProofArtifacts()` writes schema-validated `quick-proof.json` and an
`agent-summary.md`. A setup-only artifact records phase duration, capability,
source/package identity, target identity, authorization, lease, retry, fallback,
and cleanup truth. It is not a
product health, runtime, performance, or release verdict. The public schema is
`agent-scenario-loop/schemas/quick-proof.schema.json` and is registered as
`SCHEMAS.quickProof`. This foundation does not launch a device or replace the
existing durable resource-lease owner.
`identityObservations` preserves adapter-, attempt-, and phase-scoped identity
evidence across retries and fallback; `identities` remains the final selected
attempt state.

Lease ports must synchronously call `registerAcquiredLease()` at the instant
ownership is established, before later asynchronous work can delay or fail the
acquisition promise. This lets the coordinator release ownership even when the
acquisition call itself reaches its deadline.
If a timed-out acquisition does not settle during bounded cleanup, cleanup fails
closed; the retained callback remains an automatic release guard for any later
contract-violating registration, but that later result cannot rewrite the
already-published artifact.

Malformed coordinator input is a caller contract error: empty identifiers or
resources, duplicate operation or identity declarations, unsupported adapter
tiers, and incomplete port or adapter method surfaces throw before capability
discovery or product work begins. Authorization denial remains an evidence
outcome when a structurally valid grant is expired, out of scope, or revoked.

Use `dispatchDriverAction()` when a runner has already normalized a scenario step and needs to call the active stable built-in `DriverPort` implementation without binding to adb, simctl, agent-device, Argent, or another concrete tool. The shared port recognizes the same portable driver-action vocabulary as scenario manifests, including richer primitives such as `drag`, `rotateGesture`, `customGesture`, and `runSequence`. A driver still has to implement and declare each action explicitly; unsupported actions fail as missing methods instead of silently downgrading.

Use `buildAndroidNativePerformanceEvidence()` inside project-local provider scripts after they capture Android `dumpsys gfxinfo`, `dumpsys gfxinfo framestats`, `dumpsys meminfo`, or a structured trace-processor summary. The helper parses headline frame, per-frame framestats, jank, render, memory, CPU, scheduling, and trace-window fields into a schema-valid `nativePerformance` envelope while keeping comparability `diagnostic-only` until a separate baseline policy proves the run is comparable. Raw Perfetto traces and trace-processor outputs should be attached through the `attachments` option; the helper records them as diagnostic sources without claiming release comparability. Providers can also pass `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, `completenessStatus`, `comparisonPolicy`, and `comparisonMetrics` overrides when a native lane timed out, failed, was unsupported, ambiguous, incomplete, or intentionally not requested, so the artifact preserves provider-owned capture status and claim boundaries instead of implying every listed lane was captured or comparable. Live `agent-scenario-loop/runner/profile-android` runs can now bracket the active adb capture loop with provider `startWindow` and `stopWindow` commands, then stage raw run evidence before `afterCapture` normalization and `finalize`; fixture/event-log and `--adb-artifacts` runs still fail closed for those live-window phases. When a selected provider declares native-performance outputs, the live runner also stages `raw/native-performance-request.json` before `startWindow` so the provider can recover the exact requested app/target identity and the runner-owned active-loop policy before it starts capture; the runner also records the staged request hash in immutable provider command args so later phases can fail closed on drift. Those live runners also write the package-owned active-loop record at `raw/runner-active-loop-window.json`, and trusted target binding must copy that exact `startedAt`/`endedAt`/`durationMs` window instead of minting provider-local timestamps. Provider command placeholders now include `{appId}`, `{packageName}`, `{providerId}`, `{serial}`, `{targetId}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}` for Android window capture, and control phases may declare `outputs: []` when they manage session state rather than writing evidence immediately. When a provider wants comparison-ready truth, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` if it needs the hash-bound requested identity/window contract, write the observed target-binding record to `raw/providers/<providerId>/target-binding.json`, and preserve runner command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files. After `afterCapture` records the owning target-binding hash, later `finalize` work must stay in separate command records instead of mutating `target-binding.json` in place. Supplying app and device ids records the requested identity but no longer verifies it by itself; a provider must explicitly attach observed matching target proof before comparison classification can pass. Trusted native comparison additionally requires schemaVersion `1.1.0` plus a structured same-condition policy and metric-descriptor contract; older `1.0.0` envelopes remain readable for diagnosis but do not become comparison-ready on their own.
Keep policy/tool/source/build/environment inputs provider-owned by passing them through provider command args/env (for example `ASL_NATIVE_PERFORMANCE_POLICY_ID`, `ASL_NATIVE_PROVIDER_TOOL_VERSION`, `ASL_NATIVE_PERFORMANCE_TARGET_BUILD_MODE`, and `ASL_NATIVE_PERFORMANCE_ENVIRONMENT_JSON`) rather than extending the runner-owned request file.

The initialized provider script accepts `--gfxinfo`, `--framestats`, `--meminfo`, and `--trace-processor-summary` for Android inputs. The trace-processor value must point at a JSON object whose fields match the helper summary input, such as frame counts, deadline misses, CPU milliseconds, scheduling delay, trace id, and window start/end times.

Use `buildIosNativePerformanceEvidence()` inside project-local provider scripts after they capture iOS Instruments, xctrace, MetricKit, simctl, or native-trace summaries. The helper normalizes frame, hitch, memory, CPU, scheduling, thermal, battery, and trace-window fields into the same `nativePerformance` contract while preserving provider ownership of capture, export, and time-window binding. Providers can pass structured summary objects directly, or use `parseIosXctraceSummaryText()` and `parseIosMetricKitSummaryText()` to normalize common text/export summaries before building the evidence envelope. The same `diagnosticSources`, `claimSufficiency`, `comparability`, `targetBinding`, `completenessStatus`, `comparisonPolicy`, and `comparisonMetrics` override inputs are available for iOS sources such as Instruments, xctrace, MetricKit, simctl, and native-trace lanes. Live `agent-scenario-loop/runner/profile-ios` runs can now bracket the active simctl capture loop with provider `startWindow` and `stopWindow` commands, then stage raw run evidence before `afterCapture` normalization and `finalize`; fixture/event-log and `--simctl-artifacts` runs still fail closed for those live-window phases. When a selected provider declares native-performance outputs, the live runner also stages `raw/native-performance-request.json` before `startWindow` so the provider can recover the exact requested app/target identity and the runner-owned active-loop policy before it starts capture; the runner also records the staged request hash in immutable provider command args so later phases can fail closed on drift. Those live runners also write the package-owned active-loop record at `raw/runner-active-loop-window.json`, and trusted target binding must copy that exact `startedAt`/`endedAt`/`durationMs` window instead of minting provider-local timestamps. Provider command placeholders now include `{appId}`, `{bundleId}`, `{providerId}`, `{targetId}`, `{udid}`, `{nativePerformanceRequestPath}`, `{nativePerformanceRequestSha256}`, and `{nativeTargetBindingPath}` for iOS window capture, and control phases may declare `outputs: []` when they manage session state rather than writing evidence immediately. Provider-owned capture sessions can also override `captureMode` and `lifecycle`; use this to preserve bounded start/end/duration facts and mark profiling perturbation truthfully. When a provider wants comparison-ready truth, read `{nativePerformanceRequestPath}` and `{nativePerformanceRequestSha256}` if it needs the hash-bound requested identity/window contract, write the observed target-binding record to `raw/providers/<providerId>/target-binding.json`, and preserve runner command records under `raw/provider-commands/<providerId>-<commandId>.started.json`, `raw/provider-commands/<providerId>-<commandId>.json`, plus matching stdout/stderr files. After `afterCapture` records the owning target-binding hash, later `finalize` work must stay in separate command records instead of mutating `target-binding.json` in place. As on Android, bundle and device ids remain unverified until the provider attaches observed matching target proof. Trusted native comparison additionally requires schemaVersion `1.1.0` plus the structured same-condition policy and metric-descriptor contract; older `1.0.0` envelopes remain readable for diagnosis but do not satisfy comparison readiness by themselves.

Use `classifyNativePerformanceComparisonReadiness(evidence, context)` before treating either platform's envelope as comparison evidence. The caller-owned context supplies the current platform/provider/run/scenario identity, the run-relative path of the native-performance envelope, an `evidencePathExists` resolver for durable run artifacts, a `readEvidenceJson` resolver for run-contained JSON such as `raw/providers/<providerId>/target-binding.json`, and a `readEvidenceSha256` resolver that returns the current SHA-256 for any durable run-relative artifact the classifier needs to hash-check. This keeps filesystem ownership outside the contract helper while still letting the helper prove that target-binding command records, staged raw artifacts, and the final bound attachment all agree on exact bytes. It returns `comparison-ready` only when identity matches, the native-performance envelope and at least one captured source are durable inside the run, the artifact has complete evidence, a comparison claim with supporting evidence, an explicit comparable policy, schemaVersion `1.1.0` with structured `comparisonPolicy` and `comparisonMetrics`, a real capture timestamp and clock domain, at least one recognized numeric frame, memory, CPU, scheduling, GPU, I/O, network, thermal, or battery measurement, a consistent bounded lifecycle or trace window, and durable observed target proof matching the declared app and device. That observed proof must validate against the package target-binding schema, preserve exact requested and observed identities, preserve an `activeLoop` window for trusted same-condition capture, exactly match the runner-owned `raw/runner-active-loop-window.json` record for `startedAt`, `endedAt`, and `durationMs`, carry `captureArtifacts` entries that name the raw active-window artifacts used by the normalized evidence, and point back to immutable provider command records whose `startWindow` or `stopWindow` `outputs[]` entries carry matching `runRelativePath` and SHA-256 values for those same surfaced artifact paths. Timestamp, sequence, and capture-window metadata do not count as measurements, and after-capture normalization alone does not make a run comparison-ready. Otherwise it returns `diagnostic-only` with stable missing-evidence reasons. Structural schema validity is intentionally preserved so incomplete provider output remains available for diagnosis rather than disappearing behind a validation failure.

## Runner Subpaths

Runner subpaths are public when a consuming project needs to compose a workflow without shelling out to the installed binaries:

| Subpath | Purpose |
| --- | --- |
| `agent-scenario-loop/runner/agent-device` | agent-device capture runner that executes scenario-declared portable driver actions and writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/android-adb` | Android adb readiness, launch, profile-session control, driver actions including tap, long press, key press, scroll, swipe, assertions, screenshots, recording, and logcat capture |
| `agent-scenario-loop/runner/android-adb-driver` | adb-backed `tap`, `longPress`, `pressKey`, `scroll`, `swipe`, `assertVisible`, `inspectTree`, `screenshot`, `record`, and `readLogs` driver adapter |
| `agent-scenario-loop/runner/agent-device-driver` | agent-device-backed portable action adapter for `tap`, `longPress`, `typeText`, `fill`, `focus`, `scroll`, `swipe`, `rotate`, `pressKey`, `pressButton`, iOS `pinch`, `assertVisible`, `inspectTree`, `screenshot`, `readLogs`, app open/close, and alert helpers |
| `agent-scenario-loop/runner/argent` | Argent capture runner that executes launch and coordinate-backed portable driver actions, then writes ASL health, verdict, raw, and capture artifacts |
| `agent-scenario-loop/runner/argent-driver` | Argent-backed optional adapter for launch, URL open, normalized tap/long-press/drag/pinch/rotate-gesture/scroll/swipe inputs, screenshot requests, and UI descriptions without bundling Argent |
| `agent-scenario-loop/runner/check-plan` | scenario/runner/provider compatibility artifact generation |
| `agent-scenario-loop/runner/compare` | direct baseline/current comparison |
| `agent-scenario-loop/runner/compare-latest` | latest trusted prior-run comparison |
| `agent-scenario-loop/runner/demo-loop` | fixture-only loop proof |
| `agent-scenario-loop/runner/example-android-live` | packaged Android example live proof |
| `agent-scenario-loop/runner/example-ios-live` | packaged iOS example live proof |
| `agent-scenario-loop/runner/host-doctor` | aggregate host/device preflight for adb, simctl, agent-device, and Argent availability before live proof |
| `agent-scenario-loop/runner/init-project` | template scaffold command for consuming app layouts |
| `agent-scenario-loop/runner/ios-simctl` | iOS simctl readiness, storage-backed session control, stored event capture, lifecycle crash detection, and host crash-report attachment |
| `agent-scenario-loop/runner/ios-simctl-driver` | simctl-backed `screenshot`, bounded `record`, and `readLogs` driver adapter; finalized video is exposed only after MP4/QuickTime validation |
| `agent-scenario-loop/runner/live-android` | generic one-scenario Android live proof runner with adb preflight, profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-ios` | generic one-scenario iOS live proof runner with simctl preflight, storage or deep-link profile-session capture, optional agent-device and Argent sidecars, latest-trusted comparison, and aggregate live-proof artifacts |
| `agent-scenario-loop/runner/live-proof` | aggregate live-proof artifact validation, multi-artifact platform-set checks, durable `live-proof-set.json` writing, formatting, failed-proof gating, and regression gating |
| `agent-scenario-loop/runner/profile-android` | Android profile artifact pipeline |
| `agent-scenario-loop/runner/profile-ios` | iOS profile artifact pipeline |
| `agent-scenario-loop/runner/resource-lease` | deterministic lease inspect/acquire/heartbeat/release helpers using operation guards, atomic heartbeat replacement, tombstone-verified release retention, explicit durability evidence, and canonical mobile-target, TCP-port, provider, and hashed lease-path identity helpers |
| `agent-scenario-loop/runner/validate-project` | project-level validation for initialized consumer app scaffolds |

Installed binaries mirror those runner entrypoints for CLI use.

## Shipped Fixtures

The package intentionally ships schemas and examples:

- `agent-scenario-loop/schemas/*`
- `agent-scenario-loop/examples/*`
- `agent-scenario-loop/templates/*`

These are public fixtures and contract references. Templates are safe starting points to copy into a consuming app and adapt. The optional `templates/skills/agent-scenario-loop/` folder gives repository-scoped agents ASL operating guidance without making the skill part of ASL runtime truth.

For concrete runner and evidence-provider integration steps, see [Adapter Onboarding](adapters.md).

## App Helper

The shipped helper comprises `app/profile-session.ts`, the package-owned declaration `app/profile-session.d.ts`, and the identity JSON `app/profile-session-helper.json`. Copying requires the source plus identity JSON; using the package subpaths supplies both. The `react-native` runtime condition points at `app/profile-session.ts` because the helper depends on app-side React Native modules, app bundling, and platform storage behavior; the `types` condition points at `app/profile-session.d.ts` so consumer TypeScript does not need to parse the implementation file from `node_modules`.

`agent-scenario-loop/app/profile-session-helper.json` is the machine-readable installed-package helper identity. Package gates can resolve and read that JSON without evaluating React Native source. The runtime helper derives `PROFILE_SESSION_HELPER_VERSION`, `PROFILE_SESSION_HELPER_PAYLOAD_ID`, and `PROFILE_SESSION_HELPER_PAYLOAD_SHA256` from the same JSON and emits those values in app-owned profile evidence. Version equality alone is not a payload match: command-backed live proof requires the app bundle to emit the payload id/hash expected by the runner, otherwise ASL fails health before trusting command timing or milestone behavior.

The intended integration is:

1. Copy `app/profile-session.ts` and `app/profile-session-helper.json` into the app, or re-export the package subpaths so both the helper source and identity JSON come from the installed package.
2. Wire `useProfileSessionBootstrap()` once near the app root.
3. Emit app-owned truth events with `emitProfileEvent()`.
4. Register optional command targets with `registerProfileCommandTargetHandler()`.

## Stability Rule

If a function, binary, schema, or example path is listed here, package smoke should verify that it is present in the packed tarball. If a new public entrypoint is added, update this document and the smoke expectations in the same change.
