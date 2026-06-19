# Artifact Interpretation

ASL separates evidence health, product verdict, and comparison status. Keep those meanings distinct.

## Read Order

1. `health.json`: whether the evidence-producing run completed with enough trustworthy data to interpret downstream artifacts.
2. `verdict.json`: whether the product behavior satisfied the scenario's expectations, budgets, milestones, and required events.
3. `comparison.json`: whether a compatible baseline/current pair improved, regressed, stayed unchanged, or remained inconclusive.
4. `agent-summary.md`: compressed outcome for humans and agents after the structured artifacts are understood.

## Health

When health is not passed, do not claim product improvement or regression from dependent timing, budget, or comparison artifacts. Classify the issue as execution, environment, instrumentation, lifecycle, or evidence capture.

## Verdict

Passed health plus failed verdict is trustworthy evidence of a product failure. Diagnose the failed event, milestone, budget, or expectation instead of treating the run as untrusted.

## Comparison

Only interpret comparison output when ASL selected or accepted a compatible baseline. If no trusted compatible prior exists, keep the current run as evidence and avoid before/after claims.

## Reporting

Reports must cite exact artifact paths and distinguish health status, product verdict, and comparison status.
