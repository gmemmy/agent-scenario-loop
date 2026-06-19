# Architecture

ASL is implemented in TypeScript, but its contracts are language-neutral.

The TypeScript package is the reference implementation for planning, execution,
schema validation, artifact writing, health/verdict/comparison interpretation,
run indexing, CLIs, the TypeScript runner SDK, and the React Native/Expo helper.
Those implementation modules are not the interoperability contract.

## Contract Boundary

JSON Schema and normative documentation are the source of truth for external
participants. TypeScript interfaces should reflect those contracts, not replace
them.

Language-neutral contracts include:

- scenario schemas;
- runner and evidence-provider manifests;
- capability definitions;
- truth-event envelopes;
- command and result envelopes;
- lifecycle states;
- error taxonomy;
- artifact schemas;
- cancellation and timeout semantics;
- protocol-version negotiation.

External adapters must be able to participate out of process. A valid adapter
may be an executable written in Swift, Kotlin, Python, Rust, shell, TypeScript,
or another language, provided it satisfies the documented schemas and protocol.
The minimal executable protocol is described in
[External Adapter Protocol](external-adapter-protocol.md).

## Reference Environments

React Native and Expo remain the primary active battle-testing environment.
They provide real Android and iOS pressure across lifecycle behavior, command
transport, native boundaries, instrumentation, packaging, evidence provenance,
and agent-facing summaries.

The React Native helper is a reference transport. It does not define the truth
event contract by itself. Native apps must be able to emit ASL truth events
without embedding a JavaScript runtime.

## Public Interoperability Rules

- Scenario files must remain structured data, not arbitrary JavaScript.
- Runners and providers must not be required to subclass TypeScript classes.
- Large evidence should be passed by file reference, not embedded as base64.
- External adapters should use structured protocol messages over stdio.
- Messages should carry run ids, attempt ids, sequence numbers, operation ids,
  deadlines, platform, clock-domain metadata, adapter identity, and artifact
  references where applicable.
- Failed operations should return structured failure data with stable codes,
  classes, retryability, and next-action hints.

## Audit Snapshot

Current public contracts are JSON schemas and JSON manifests. Scenario fixtures
are structured JSON and do not require callbacks or closures. Runner/provider
manifests describe capabilities and commands as data.

Known implementation-specific surfaces are intentionally reference paths:

- npm package scripts and Node CLIs are the TypeScript distribution channel.
- built-in adb, simctl, Argent, and agent-device runners are TypeScript
  adapters.
- React Native profile-session logging and AsyncStorage are reference truth
  event transports.
- provider command examples use Node scripts, but provider manifests can point
  at any executable.

These are acceptable as reference implementation details. They should not become
requirements in scenario schemas, artifact schemas, or external-adapter protocol
messages.

## Future Design Test

Could a Swift, Kotlin, Python, or Rust implementation satisfy this contract
using only the schemas, protocol documentation, executable interface, and
conformance fixtures?

If yes, TypeScript remains a productive reference implementation. If no, the
implementation-specific assumption should be identified and removed from the
contract surface.

## Read next

- [External Adapter Protocol](external-adapter-protocol.md) for the out-of-process adapter envelope, operations, failures, and conformance fixture
