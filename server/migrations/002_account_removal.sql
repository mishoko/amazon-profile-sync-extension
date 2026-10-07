-- Accounts removed in Activity are kept but hidden (soft delete). A removed
-- account comes back only when a profile reports a sign-in to it that
-- happened after the removal.
ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;
