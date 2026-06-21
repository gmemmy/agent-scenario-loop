# Roadmap Ledger

This ledger tracks package-owned work that emerged from real adopter proofs. Keep it product-neutral: adopter artifacts can expose a gap, but ASL owns the reusable runner, schema, evidence, and orchestration contracts.

## Current Priority

### 1. Boring Stability

Keep runner failure modes bounded, classified, and artifact-backed.

- Preserve finalized artifacts on provider failure, startup failure, stale-session detection, and runner interruption where possible.
- Continue tightening runtime identity checks: package/app id, foreground app, bundle/build identity, profile-session storage keys, run id freshness, device id, Metro/dev-client target, and source sidecar provenance.
- Fail fast when the runner cannot prove the runtime being measured, instead of letting product metrics absorb stale or wrong-target evidence.

### 2. Evidence Completeness

Every run folder should explain what happened without transcript reconstruction.

- Keep `manifest.artifacts.diagnostics` honest: requested, captured, unavailable, not requested, unsupported, or failed with reason and next action.
- Preserve command metadata, platform logs, raw provider outputs, stdout/stderr, screenshots, causal timeline, and health/verdict separation.
- Prefer sidecar-relative or copied evidence paths that resolve cleanly from the profile artifact.

### 3. Native Performance Diagnostics

Add a product-neutral native-performance evidence lane before treating mobile render/memory proof as budget-comparable.

- Use `nativePerformance` for platform-native frame/render/memory diagnostics such as Android Perfetto, trace-processor summaries, `gfxinfo`/framestats, `meminfo`, logcat render signals, iOS Instruments, MetricKit, and simctl-derived native summaries.
- Keep raw traces and heavy captures as attachments; put claim-ready facts in structured provider summaries.
- Record provenance: tool, tool version, platform, device, app/build, run id, scenario id, time window, clock domain, target binding, completeness, corruption, redaction, and comparability.
- Treat this lane as diagnostic-only until ASL can prove stable baseline compatibility, perturbation policy, and comparison semantics.

### 4. Provider Capability And Lifecycle Policy

Providers should be selected by capability and lifecycle fit, not by one catch-all tool.

- Keep primary runners responsible for app launch, profile-session truth, logs, and core sidecars.
- Use providers for focused diagnostics: accessibility, UI tree, memory, network, profiler, native performance, video, trace, or React DevTools evidence.
- Make lifecycle explicit: before run, active loop, after capture, post run, rehydrated proof, and heavy diagnostics.
- Mark perturbing evidence as diagnostic-only unless the scenario intentionally measures with that provider active.

### 5. Evidence Sufficiency And Claim Gating

ASL should state what a run can and cannot prove.

- Health-green plus verdict-green is not enough when required diagnostics are absent.
- Provider-captured evidence is not product performance evidence when scenario health failed.
- Dev-client evidence is not release-readiness evidence unless the scenario cohort declares that compatibility.
- Native traces, profiler output, and HARs need declared sufficiency before they can support ratchets.

## Next Lanes

1. Android native diagnostics provider contract and runner support for Perfetto/gfxinfo/meminfo/logcat-derived render summaries.
2. Runtime identity/fail-fast preflight as a reusable health contract.
3. Provider lifecycle docs/schema cleanup for active-loop versus after-capture and rehydrated diagnostics.
4. Gesture/native contract proof class for mobile touch ownership, system UI boundaries, back behavior, scroll physics, accessibility exposure, and gesture arbitration.
5. Experiment loop closure: make the next bounded hypothesis easier to derive from artifacts without automating product optimization.

## Later

- Performance ratchets once evidence is stable, comparable, and cohort-aware.
- CI hardening: smoke matrix, schema compatibility, fixture conformance, publish dry-runs, and downstream reference-adopter gates.
- Repository cleanup: runner kernel refactor, artifact writer consolidation, provider execution boundaries, profile-session helper declarations, and docs pruning.
