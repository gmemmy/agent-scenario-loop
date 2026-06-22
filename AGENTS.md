# Agent Scenario Loop Agent Guidance

This file governs the repository. It should stay a routing and standards
surface: point to the owning docs, encode non-negotiables, and avoid copying
large doctrine blocks that already live elsewhere.

## Operating Principle

Agent Scenario Loop is a product-neutral scenario orchestration and evidence
system. Agents working here must preserve deterministic behavior, explicit
contract boundaries, durable artifacts, and truthful proof over quick green
runs or app-specific shortcuts.

When there is a conflict between making a demo pass quickly and producing
trustworthy reusable evidence, choose trustworthy evidence.

## Authority

Follow the nearest deeper `AGENTS.md` if one exists. Otherwise, use these
sources in this order:

1. Direct system, developer, and user instructions
2. This `AGENTS.md`
3. Public package contracts in `docs/contracts.md`
4. Project doctrine in `docs/principles.md` and `docs/architecture.md`
5. Runner behavior in `runner/README.md`
6. Public documentation boundaries in `.agents/public-documentation-audit.md`
7. Documentation tone guidance in `.agents/documentation-philosophy.md`
8. Local source code and verified artifact output

If guidance drifts, align code and docs back toward the owning source instead
of inventing a parallel rule.

## Task Routing

- Public artifact, scenario, runner, provider, health, verdict, manifest,
  comparison, and package contracts: `docs/contracts.md`
- Scenario model, evidence-first doctrine, and the control/truth/evidence/
  realism planes: `docs/principles.md`
- TypeScript-first implementation with language-neutral adapter boundaries:
  `docs/architecture.md`
- Runner responsibilities, current limits, adapters, and provider surfaces:
  `runner/README.md`
- Scenario authoring and portable app behavior: `docs/authoring.md`
- External adapter protocol and conformance expectations:
  `docs/external-adapter-protocol.md`
- Consumer app adoption and rehearsal: `docs/consumer-rehearsal.md`
- Live proof commands, release gates, and platform proof routing:
  `docs/live-proofs.md`
- Public API and package exports: `docs/api.md`
- Public documentation boundaries: `.agents/public-documentation-audit.md`
- Public positioning and wording: `.agents/documentation-philosophy.md`
- Mobile trust hardening roadmap: `.agents/mobile-trust-hardening-roadmap.md`

Open only the pointers relevant to the task. Do not read every doctrine file by
default when a narrower pointer answers the question.

## Non-Negotiables

- Keep ASL product-neutral. HelpBnk or any other consuming app may expose gaps,
  but selectors, routes, accounts, product concepts, and app-specific truth
  events belong in the consuming app, not this package.
- The artifact contract is a public API. Changes to schemas, artifact fields,
  status vocabularies, path layout, or summary semantics require matching docs,
  focused tests, and release-check awareness.
- App integration stays thin. App helpers emit session control, truth events,
  and signal attachments; runners and providers collect evidence around them.
- Runners and interaction tools are adapters, not schema owners. Do not bake
  adb, simctl, Agent Device, Argent, XcodeBuildMCP, axe, profiler, or other
  tool names into top-level artifact concepts unless the contract explicitly
  models that adapter.
- Deterministic control comes first. Prefer semantic commands, deep links,
  profile-session commands, stable selectors, app-owned truth events, and
  provider manifests before raw taps, swipes, or ad hoc log scraping.
- Raw interaction remains useful for realism proof, but scenario correctness
  should not depend on coordinate replay when a semantic or native-grade
  control surface exists.
- Failed, partial, unhealthy, unsupported, cancelled, timed-out, or retried
  attempts must remain visible. Never let a later green run erase useful failed
  evidence or imply a product verdict from untrusted health.
- Missing diagnostics must be explicit. A manifest path is an evidence claim;
  do not advertise a sidecar, provider output, screenshot, log, memory, network,
  accessibility, profiler, or native-performance artifact unless it was produced
  or intentionally referenced with status and reason.
- Scenario health gates interpretation. Timing, budget, comparison, and
  optimization claims require trusted health and measurable samples.
- Platform coverage must be stated exactly. If only Android or only iOS was
  exercised, call out the gap instead of presenting mobile proof as complete.
- Generated runs are outputs, not source. Do not commit runtime artifacts under
  `artifacts/**`, `dist/**`, example app build output, raw logs, screenshots,
  recordings, heap dumps, traces, or provider exports unless they are sanitized
  fixtures required by tests or durable public docs.

## Evidence Rules

- Before changing runtime behavior, identify which plane owns the issue:
  control, truth, evidence, or realism.
- Before claiming a live proof, report the strongest relevant artifact paths,
  scenario names, run ids, health/verdict/comparison status, and platform.
- Treat stale consumer installs, stale Metro or simulator state, mismatched app
  ids, wrong runner manifests, and version skew as invalid proof until reset or
  explicitly classified.
- Keep downstream validation as downstream validation. ASL owns package
  contracts and proof packets; the consuming app owns its runtime, product
  scenarios, accounts, and app-specific instrumentation.
- When consumer evidence exposes a reusable package gap, translate it into
  ASL vocabulary: runner behavior, provider contract, artifact interpretation,
  schema status, lifecycle semantics, environment capture, or release gate.
- Do not optimize from missing milestones, incomplete cycles, unmeasurable
  budgets, unbound profiler output, or partial provider evidence unless the
  task is explicitly to repair that evidence path.

## Coding Hygiene

- Prefer explicit typed states over clusters of booleans. When behavior has
  phases, terminal outcomes, retries, cleanup, provider execution, lifecycle, or
  capability negotiation, model it as a discriminated union, enum-like string
  vocabulary, or small state machine with named transitions.
- Boolean flags are acceptable only for simple independent facts. If two or
  more booleans must be read together to understand behavior, introduce a named
  state, status object, or reducer-style transition helper.
- Avoid nested ternaries. Use named variables, `if` blocks, lookup tables, or
  `switch` statements when logic has more than one branch or encodes policy.
- Do not hide contract policy inside inline expressions. Status derivation,
  next-action selection, trust classification, diagnostic inventory, and
  downgrade handling should live in named functions that tests can target.
- Keep status vocabularies closed and product-neutral. Reuse existing
  health/verdict/attempt/diagnostic/provider/lifecycle words before adding new
  strings, and update schemas/docs/tests when a public vocabulary changes.
- Make illegal states hard to represent. Prefer constructors/builders that
  require the evidence, reason, cleanup, or partial-artifact fields needed for a
  given status instead of assembling loose objects across distant branches.
- Separate parsing, planning, execution, artifact writing, and interpretation.
  A function that shells out or reads the device should not also decide product
  trust semantics unless that is its explicit boundary.
- Keep object spread conditionals shallow. If assembling an artifact needs many
  conditional properties, build the semantic subobjects first, then compose the
  final artifact.
- Use exhaustive `switch` or explicit fallback handling for public statuses and
  driver actions. Unknown external input should become a structured
  unsupported/failed health result, not an accidental default success path.
- Add tests at the policy boundary, not only at the CLI happy path. State
  transitions, health gates, unmeasurable budgets, partial provider evidence,
  lifecycle assertions, and public schema changes need focused coverage.

## TypeScript And API Boundaries

- Keep `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`
  meaningful. Do not work around them with broad `any`, non-null assertions, or
  unchecked casts unless the boundary has already validated the input.
- Treat JSON, CLI args, environment variables, filesystem reads, subprocess
  output, and provider manifests as untrusted input. Narrow them with local
  parsers, schema validators, or small type guards before building artifacts.
- Public exports, bins, schemas, templates, and docs move together. If an API,
  CLI flag, artifact field, schema enum, or package file list changes, update
  the matching reader-facing docs and tests in the same change.
- Keep package dependencies minimal. This package is currently intentionally
  small; do not add runtime dependencies for convenience parsing, formatting, or
  shell helpers when the standard library or existing project code is enough.
- Preserve CommonJS/package compatibility unless the task explicitly changes the
  package module strategy and updates build, package, docs, and smoke coverage.

## Errors, Processes, And Files

- Prefer structured results for expected runner/provider failures. Reserve
  thrown errors for programmer mistakes, corrupt inputs, or unrecoverable host
  failures that cannot be represented as health/verdict artifacts.
- Every subprocess path must have bounded timeout behavior, captured stdout and
  stderr, exit status, and a stable health/check interpretation. Do not add
  shell-string execution when `execFile`-style argument arrays can represent the
  command.
- Never let provider or runner failures silently drop evidence. Preserve partial
  outputs when they are valid for diagnosis, mark them partial/failed, and
  include the next action.
- Keep file writes atomic enough for artifact consumers: write complete JSON
  objects, validate schema-bound payloads before or at write time, and avoid
  leaving public artifact paths pointing at missing files.
- Do not persist absolute local source paths in public artifacts unless the
  contract explicitly calls for host-local evidence. Prefer run-relative paths,
  hashes, byte sizes, provider ids, and redaction/completeness metadata.

## Validation

Use the narrowest command that proves the change, then widen when contracts,
runner behavior, package surface, or release readiness are touched.

- Type-only or local contract work: `pnpm typecheck`
- Core/package behavior: `pnpm test`
- Package surface, schemas, examples, and release-sensitive changes:
  `pnpm release:check`
- Packed consumer behavior: `pnpm package:smoke` or
  `pnpm consumer:rehearse`
- Downstream local package gate when validating a consuming app handoff:
  `pnpm downstream:local-package`

If a validation command cannot run, report the blocker and the residual risk.
Do not replace failed validation with prose confidence.

## Public Surface Discipline

Anything under `docs/**`, `examples/**`, `schemas/**`, `templates/**`,
`runner/README.md`, `README.md`, package exports, bins, or package `files` is
public-facing unless explicitly excluded. Keep public docs concrete and
problem-first:

- describe ASL as scenario orchestration and evidence, not as another runner;
- keep scenarios as durable assets and evidence as the output;
- explain historical comparison where relevant;
- avoid startup language such as "unlock", "revolutionize", "game-changing",
  "cutting-edge", "next-generation", "seamless", "transformative",
  "supercharge", and "AI-powered";
- do not link public docs into `.agents/`.

## Commit And Scope Hygiene

- Use Conventional Commits for ASL commits.
- Keep changes scoped to the owning contract, runner, schema, doc, or example.
- Do not publish, tag, or push release artifacts from local confidence alone.
- Do not revert or overwrite unrelated dirty work. At the time this guidance was
  added, unrelated edits may exist in this repo; inspect before editing shared
  files.
