-- Remove retired manual ledger features; retain events and AI evidence history.
-- Clear the self-reference before DROP so correction chains are safe with foreign keys enabled.
UPDATE contributions SET correction_of = NULL WHERE correction_of IS NOT NULL;
DROP TABLE contributions;
DROP TABLE resource_references;
DROP TABLE decisions;
