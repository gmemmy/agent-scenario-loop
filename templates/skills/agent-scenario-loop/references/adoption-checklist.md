# Adoption Checklist

Use this checklist when bringing ASL into a consuming app or validating an existing adoption.

1. Confirm `agent-scenario-loop` is installed from the registry, not a local tarball or link.
2. Inspect `package.json` for project-owned `asl:*` scripts.
3. Locate `asl.config.json` and verify app identifiers, artifact roots, and supported drivers are project-owned.
4. Inspect scenario manifests under the configured scenario root.
5. Inspect runner and evidence-provider manifests.
6. Run the project validation script.
7. Run the selected scenario's plan check before live device work.
8. Use fixture/profile proof for package, parsing, and artifact-contract validation.
9. Use Android or iOS live proof for product behavior claims.
10. Use both platforms when a release or task requires cross-platform evidence.
11. Preserve generated artifacts; do not delete failed attempts to make a later run look cleaner.
12. Cite `health.json`, `verdict.json`, `comparison.json` when present, and `agent-summary.md` in the final report.
13. Keep selectors, app identifiers, credentials, routes, and truth events in the consuming app, not ASL core.
