---
name: agent-scenario-loop
description: Use Agent Scenario Loop when implementing, debugging, optimizing, or validating mobile app behavior through durable scenarios, Android or iOS live proofs, evidence artifacts, health checks, budgets, or before-and-after comparisons. Do not use for ordinary unit-test-only changes or work unrelated to observable app behavior.
---

# Agent Scenario Loop

Use ASL to establish trustworthy evidence about changes to this mobile app.

## Discover The Project Contract

1. Inspect `package.json` for installed ASL commands and project-owned `asl:*` scripts.
2. Locate `asl.config.json` or the configured alternative.
3. Inspect scenario manifests and runner manifests.
4. Identify the scenario representing the app behavior affected by the task.
5. Reuse an existing scenario when it expresses the intended behavior.

Do not copy runner infrastructure into the application.

## Validate Before Execution

Run the project validation command configured by the repository. Then validate the selected scenario and execution plan.

Stop before live execution when required capabilities are unavailable. Report the missing capability, selected platform, runner, and the command needed to reproduce the failure.

## Select The Proof Lane

Use fixture proof when validating:

- package installation;
- scenario parsing;
- artifact contracts;
- comparison behavior;
- agent summaries.

Use Android or iOS live proof when making claims about actual app behavior. Use both platforms when the task or release gate requires cross-platform evidence.

## Interpret Results

Read evidence in this order:

1. `health.json`
2. `verdict.json`
3. `comparison.json`, when present
4. `agent-summary.md`
5. supporting raw evidence and captures when diagnosis is needed

If health is not passed:

- do not trust dependent timing or budget conclusions;
- classify the failure as execution, environment, instrumentation, lifecycle, or evidence capture;
- fix or report the evidence problem before claiming a product regression.

If health passed but verdict failed:

- treat the run as trustworthy evidence of product failure;
- diagnose the failed budget, event, milestone, or expectation.

Only interpret a comparison when ASL considers the baseline compatible.

## Non-Negotiable Rules

- Run planner validation before expensive device work.
- Prefer an existing durable scenario over inventing an ad hoc script.
- Never infer product improvement from unhealthy or partial evidence.
- Treat passed health plus failed verdict as trustworthy evidence of failure.
- Do not silently retry and discard failed attempts.
- Do not change budgets or scenarios merely to turn a failure green.
- Keep selectors, app identifiers, authentication assumptions, routes, and truth events inside the consuming app.
- Preserve the artifact directory and cite exact artifact paths in the final report.
- Use fixture proof for package and contract validation; use live proof for product claims.
- Avoid adding new runners when an existing capability already satisfies the plan.

## Report

Include:

- scenario ID;
- platform;
- run ID;
- health status;
- product verdict;
- comparison status;
- failed evidence dependencies;
- relevant artifact paths;
- recommended next action.

Do not summarize a run as simply "passed" or "failed" when health and verdict differ.

## References

- `references/artifact-interpretation.md`
- `references/adoption-checklist.md`
