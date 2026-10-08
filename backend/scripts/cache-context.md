# Cache context verification

The project investigation and creation preview freeze their initial messages and
tool definitions in encrypted checkpoints. Incremental data and complete tool
exchanges are serialized in order. Compaction starts at 80% of `maxInputChars`
and aims for 50%; fixed requirements, clarification answers, protected evidence
and the newest tool exchange can keep the request above the target. Requests
above the hard limit are rejected before dispatch. These are serialized character
budgets, not exact token counts. Compaction introduces a new cache phase.

Run local checks from the repository root:

```powershell
npm test --prefix backend -- test/160-ai-cache-protocol.test.ts test/171-context-phases.test.ts test/draft-execution-continuation.test.ts
npm run typecheck
npm run check:migrations
```

Run the read-only production report from `backend` after migration:

```powershell
$cacheQuery = Get-Content scripts/cache-stats.sql -Raw
node node_modules/wrangler/bin/wrangler.js d1 execute ai-office-db-production --env production --remote "--command=$cacheQuery" --json
```

Cache rate uses only calls with known input and cache usage; coverage shows how
many calls qualify. Historical records remain unknown. Do not average per-call
percentages. Compare task input volume, call count and latency alongside the rate.
The report does not estimate a bill from assumed provider prices.

Passing the SQL as a single `--command=` argument preserves multiline SQL and
leading comment markers on Windows. Remote `--file` execution uses the import
path, which does not expose the SELECT rows needed for this report.

Repeated reads are per-call deltas, tracked using 128-bit SHA-256 fingerprints of
tool name and arguments for the most recent 256 distinct read requests. The
bounded window avoids expanding every encrypted checkpoint without limit;
repeated reads outside it are not counted. The query exposes this window and the
number of calls with read metadata. No plaintext arguments, bodies or reasoning
are added to ordinary diagnostic logs.

Production acceptance checks only deployed version and non-inference health/API
reads. Actual cache improvement, task quality and cost changes require naturally
occurring tasks; local mocked providers cannot establish those benefits.
