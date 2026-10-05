# Tailspin: contributor/agent notes

- Read PRODUCT.md before changing scope. Record deviations in docs/decisions.md.
- Never commit real session transcripts or content derived from them. Fixtures are synthetic only.
- src/core, src/detectors, src/report, src/redact, and parse files in adapters must stay isomorphic: no node:* imports.
- Detectors: write the positive AND false-positive fixtures first. No finding without evidence. Precision over recall.
- All dynamic text in the HTML report is rendered via textContent. Treat transcript content as hostile.
- Redaction happens in the data model, never in the view layer.
- Output must be deterministic. Sort everything. No "now" timestamps inside findings.
- Label every number measured or estimated, with the method.
- No network calls, telemetry, or writes outside the chosen output path.
- Keep runtime dependencies minimal and justify each new one.
- Commands: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run eval`.
