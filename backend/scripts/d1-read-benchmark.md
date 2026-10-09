# Local D1 Read Benchmark

Run from `backend` after installing the existing dependencies:

```powershell
node scripts/d1-read-benchmark.mjs
```

The script creates a temporary in-memory Miniflare D1 database with 10,000 historical reservations, matching calls and 1,000 diagnostic records. It measures D1 `meta.rows_read`, `meta.rows_written`, statement count and wall time before and after migration 0069. It reads the actual production retention SQL from `diagnostics.ts`; it does not access configured databases, credentials or model providers. It also asserts migration preservation and exact counter consistency.

The missing-job case represents idle recovery reads. The diagnostic case uses 100 identical insert-and-trim transactions at the 1,000-record limit. Each transaction makes one `DB.batch()` call containing two statements. The index insertion case exposes added writes rather than treating indexes and counter maintenance as free.

Example local observation: missing-job reads scanned 20,003 rows before and zero after indexing. The 100 diagnostic transactions scanned 300,800 rows before and 1,300 after; writes increased from 300 to 500 because insert/delete triggers maintain the singleton. These are synthetic, local observations, not daily production usage or billing forecasts. Local wall times are runtime and machine dependent.

Migration 0069 initializes diagnostic counts and byte totals once without trimming existing rows. Subsequent diagnostic writes delete the minimum oldest prefix needed to retain the same newest suffix as the previous descending-window query. The bounds remain 1,000 records and 999,488 bytes, including each JSON record's UTF-8 separator. Inserts, deletes (including administrator clear), byte-size updates and retention occur transactionally. The extra singleton writes are included in D1 metadata.

Focused verification:

```powershell
npm test -- test/28-ai-diagnostics.test.ts test/173-d1-read-optimization.test.ts
npm run typecheck
```

The focused tests cover concurrent writes, UTF-8 retention, count/byte boundaries, oversized historical records, comparison against the original SQL, clear-and-rewrite, byte updates, transaction rollback, singleton consistency, query plans and reserved-attempt status changes.
