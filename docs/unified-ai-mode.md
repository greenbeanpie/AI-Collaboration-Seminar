# Unified AI model routing

The global AI tab remains `/app/settings/ai`, guarded by the existing super-admin or
operator authorization. No live configuration or credential is changed by this patch.

## Configuration and compatibility

`AiConfig` adds optional `routingMode: 'advanced' | 'unified'` and optional `unified`.
The three original `textEconomy`, `visionEconomy`, and `review` entries remain stored
as advanced drafts. Missing mode means legacy advanced routing. Unified mode requires
its own model entry, with one endpoint, protocol, model, encrypted key reference and options.
Switching modes retains the inactive configuration; the UI never copies a saved key
from an advanced entry into the unified slot.

Storage uses the existing versioned `ai_config_versions.config_json`; no new service,
database table, or migration is needed. Admin GET returns raw drafts with `keyConfigured`,
never ciphertext or plaintext keys. PUT adds `expectedVersion` for the new UI and an
atomic version comparison at insertion. Legacy requests omitting mode/unified preserve
those stored values instead of silently switching an active unified configuration.

Destination checks still apply to every edited slot, including inactive drafts. Existing
provider/protocol/endpoint-bound key reuse rules and AES-GCM storage remain in force;
this change does not claim to add cryptographic AAD binding that did not previously exist.
Provider-specific option compatibility is checked for the active mode; selecting a
previously incomplete advanced draft requires validating it before activation.

## Runtime boundary

`loadAiConfig(db, frozenVersionId)` resolves unified routing by default, mapping all
three runtime purpose fields to the **same unified entry**. Admin editing alone uses
`loadAiConfig(db, undefined, false)` to retain raw drafts. Runtime callers must not opt
out of resolution. `configForPurpose` also resolves explicit supplied snapshots.

Existing callers therefore share the frozen version and configuration:

| Purpose | Existing consumers |
| --- | --- |
| textEconomy | requirement extraction, agent writing/guidance/chat, assignment, collaboration decomposition/assignment |
| review | reviews, rehearsals, collaboration evaluation |
| visionEconomy | page OCR |
| prices/limits | budget reservation/estimate and call accounting use the resolved snapshot too |

Existing current-version, membership, job, concurrency, budget and reservation guards
are retained. A missing frozen configuration does not fall back to another endpoint.
Already-created jobs keep their existing snapshot semantics.

## Capabilities and activation

Text-only unified models require successful text and review probes; vision is required
only when declared supported. OCR and gateway image inputs reject unsupported vision
before key decryption or an outbound model request. The UI explains the limitation.
There is no fallback to the stored advanced vision model.

Saving still disables AI until applicable capability probes pass. Any configuration
change invalidates the previous probe results; enabling compares the saved configuration
and checks reports for that exact version. Probes are explicit user actions and may
make paid requests; no probe or provider switch is performed by this implementation task.

## Integration boundaries

This feature edits `AiSettings.tsx`, the AI config/admin/probe/gateway modules and the OCR
capability guard. The separate profile/privacy task should keep these changes when
merging its collaboration/AI work and keep using the default resolved configuration loader.
Settings route ownership remains described in `settings-extension-handoff.md`.
