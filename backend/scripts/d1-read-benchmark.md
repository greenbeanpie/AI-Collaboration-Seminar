# Local D1 Read Benchmark

Run from `backend` after installing the existing dependencies:

```powershell
node scripts/d1-read-benchmark.mjs
```

The script creates a temporary in-memory Miniflare D1 database with 10,000 historical reservations, matching calls and 1,000 diagnostic records. It measures D1 `meta.rows_read`, `meta.rows_written`, statement count and wall time before and after migration 0069. It reads the actual production retention SQL from `diagnostics.ts`; it does not access configured databases, credentials or model providers. It also asserts migration preservation and exact counter consistency.

The missing-job case represents idle recovery reads. The diagnostic case uses 100 identical insert-and-trim transactions at the 1,000-record limit. Each transaction makes one `DB.batch()` call containing two statements. The index insertion case exposes added writes rather than treating indexes and counter maintenance as free.

The idle-hour case executes the actual recovery candidate query 120 times, with one running reservation and 10,000 historical reservations. The task-lifecycle case simulates ten model call records, diagnostic writes, reservation lookups and settlement. It performs no inference and excludes other business queries and model/network latency. Before/after cases use equivalent synthetic workloads; the after case contains the few extra historical rows from the before case.

To reproduce the 20-task eligibility comparison using the real backend service and local D1 metadata:

```powershell
npm test -- test/173-task-agent-eligibility-batch.test.ts --reporter=verbose
```

Its measured fixture reports 120 single-task service queries versus 5 batch queries, with `rows_read` 100 versus 63 and no writes. This excludes HTTP authorization middleware, whose checks still run once for each HTTP request. The browser fixture verifies that mounted task readers share one HTTP request and duplicate dialog readers add none.

For browser acceptance, run the frontend dev server on port 5197, then from the repository root:

```powershell
node scripts/verify-d1-read-ui.mjs http://127.0.0.1:5197 output/d1-read-ui
```

The browser fixture serves synthetic GET responses for 20 mounted tasks, a duplicate dialog, missing-state polling, terminal-state stopping and session clearing. It blocks all unexpected API requests and writes reports/screenshots. The `frontend/test-fixtures` page is a development verification entry and is not a production build entry.

Production read-only audit can be repeated from `backend` in PowerShell:

```powershell
$auditQuery = Get-Content scripts/d1-read-audit.sql -Raw
node node_modules/wrangler/bin/wrangler.js d1 execute ai-office-db-production --env production --remote "--command=$auditQuery" --json
```

This intentionally runs the old diagnostic selection query for comparison; it never deletes records. Audit queries and exports themselves consume reads, so run them on demand rather than polling them. Daily account usage and actual billing changes need natural traffic measurements; these fixtures do not establish a uniform cost reduction.

Example local observation: missing-job reads scanned 20,003 rows before and zero after indexing. The 100 diagnostic transactions scanned 300,800 rows before and 1,300 after; writes increased from 300 to 500 because insert/delete triggers maintain the singleton. These are synthetic, local observations, not daily production usage or billing forecasts. Local wall times are runtime and machine dependent.

Migration 0069 initializes diagnostic counts and byte totals once without trimming existing rows. Subsequent diagnostic writes delete the minimum oldest prefix needed to retain the same newest suffix as the previous descending-window query. The bounds remain 1,000 records and 999,488 bytes, including each JSON record's UTF-8 separator. Inserts, deletes (including administrator clear), byte-size updates and retention occur transactionally. The extra singleton writes are included in D1 metadata.

Focused verification:

```powershell
npm test -- test/28-ai-diagnostics.test.ts test/173-d1-read-optimization.test.ts
npm run typecheck
```

The focused tests cover concurrent writes, UTF-8 retention, count/byte boundaries, oversized historical records, comparison against the original SQL, clear-and-rewrite, byte updates, transaction rollback, singleton consistency, query plans and reserved-attempt status changes.
