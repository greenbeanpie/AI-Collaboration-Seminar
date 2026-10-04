# DSH bridge protocol v1

All endpoints live under `/api/v1/agent-bridges` and retain the normal `{data,requestId}` / structured error envelopes. Browser writes use password-session cookies and the existing Origin policy. Device requests use their own Bearer capability; that capability is never accepted by generic project, file, submission or administration endpoints.

## Pairing and authorization

The device creates a cryptographically random secret before POST `/pairings`; it sends only its SHA256 hash, name and versions. Anonymous pairing is limited to 20 requests per 600 seconds per Cloudflare connecting IP via the existing D1 rate limiter. The returned browser approval URL uses the first configured HTTPS website Origin. A logged-in member chooses project scopes within ten minutes. Project IDs, device ownership and current membership are validated server-side. `/device` reports pairing state; `/device/workspaces` registers a short display label only. Absolute local paths remain on the device. Browser `/devices` lists owned devices and DELETE `/devices/{id}` revokes the capability. Device POST `/device/disconnect` revokes only its own capability. Credentials are not sessions or model API keys.

## Handoff and execution

POST `/projects/{projectId}/tasks/{taskId}/handoffs` requires `Idempotency-Key`, `expectedRevision` and `targetDeviceId`. It creates one durable checking record and reuses the project's semantic AI eligibility checker. Pending, failed, disabled, negative or stale judgments cannot dispatch. GET/list and device claim advance a completed check without another model request.

Each run stores an immutable, hashed R2 snapshot of full task/criteria, goal, latest saved standard, recursively selected prerequisite submissions and their fixed material versions, current resource text and original attachments. D1 context stamps guard versions, assignment, goal, standards, graph, current resources, source processing and original file lifecycles before claim and reviewed adoption. Active runs retain results after an edit and expose `stale:true`; direct adoption is then disabled.

POST `/device/claim` atomically claims one run per device. Claimed runs are sticky and are never reassigned after a lease or network timeout. Repeated claim returns the same run; dispatch uncertainty stays blocked until cancellation/failure is explicitly acknowledged. Queue entries expire after 24 hours. Archived/AI-disabled project queues are blocked before dispatch; active runs retain stale drafts. Events use increasing sequence IDs and reject different payloads for a repeated sequence. A run cannot switch DSH session identity. Cancel returns `cancel_requested` until the actual device acknowledgment.

After revocation or membership removal, the known device secret retains one narrow operation: POST a `cancelled` event for the exact device/owner-bound active run, matching its persisted session ID (if created). It is permitted only when cancellation was requested or the original capability is no longer valid. Sequence numbers can skip earlier uncommitted progress events. Duplicate sequence/payload is acknowledged; a different payload conflicts. This terminal acknowledgment returns only `{acknowledged:true,state:'cancelled'}`, frees the sticky slot and exposes no draft/input DTO. Reads, downloads, uploads, other events and new claims remain denied. The plugin must stop local execution, disconnect/revoke as requested, acknowledge cancellation, then remove its local credential.

Device input download endpoints authorize both the bound run and the exact fixed file/lifecycle listed in the snapshot. They do not expose generic file URLs with reusable credentials.

## Results and human adoption

The snapshot includes `artifactPolicy`: at most 20 artifacts, **50 MiB per artifact in v1**, and the existing allowed upload extensions. The bounded single-PUT bridge transport has an explicit cap; it does not change unlimited generic document/multipart uploads. The device preflights these limits before transmitting.

Artifact UUIDs, size and SHA256 define an immutable manifest. Upload reuses normal file extension, magic-byte, UTF-8 and DOCX-package validation and contributor attribution, but **does not automatically start parsing, audio, resource-index or model work**. Repeated manifest/content transfer recovers stored files without replacing bytes. Completion requires every selected file to be available and match the manifest, plus the bound DSH session. Completion saves a draft only; it never updates task state.

POST `/handoffs/{id}/adopt-and-submit` requires cookie authentication, the initiating/current assigned member, `reviewed:true` and `expectedTaskRevision`. Admission checks current task, source context, saved standard and available artifact bytes. One D1 transaction creates an immutable `ai_adoption` material version and runs the same normal submission statements used by the browser. Normal AI evaluation is queued through the existing evaluation service. Repeated adoption returns the original submission, without creating extra material versions or evaluations. Stale results remain downloadable for manual reconciliation via existing project workflows.

Migration `0053_agent_bridges.sql` is additive. No credentials, account IDs, existing task/material identities or foreign-key relationships are reset. Referenced snapshot objects remain audit data; only unreferenced bridge snapshots are eligible for ordinary orphan GC after its existing grace period.

## Reproducible checks

```powershell
npm run typecheck --prefix backend
npm run test --prefix backend -- test/131-agent-bridges.test.ts test/85-collaboration.test.ts test/80-tasks-materials.test.ts test/127-automatic-task-evaluation.test.ts test/129-task-agent-eligibility.test.ts test/25-gc-retention.test.ts
```

Tests run actual Workers D1/R2 bindings and mocked model responses, including concurrent claim, capability revocation, safe upload/checksum, fixed-input deletion, current standard, atomic adoption races, shared submission regression and GC retention. They do not assert live-model execution or production deployment.
