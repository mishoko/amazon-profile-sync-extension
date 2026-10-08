-- profile_accounts now records only what connected profiles hold right now:
-- the server removes a profile's rows when it disconnects and clears the
-- table on start. Rows left by earlier versions (for example from a profile
-- whose extension was removed and installed again, which gives it a new ID)
-- are stale, so they are dropped here. Profiles unseen for 30 days are
-- deleted by the server.
DELETE FROM profile_accounts;

COMMENT ON TABLE profiles IS 'Browser profiles running Waybill (the extension''s random instance ID); deleted after 30 days unseen.';
COMMENT ON COLUMN profiles.last_seen_at IS 'Last connect, report or disconnect.';
COMMENT ON TABLE accounts IS 'One Amazon account on one marketplace. id is the lasting account ID shown in Activity.';
COMMENT ON COLUMN accounts.customer_id IS 'Amazon''s customer ID; NULL until the account has been seen signed in.';
COMMENT ON COLUMN accounts.deleted_at IS 'Set when removed in Activity; cleared by a later sign-in to the account.';
COMMENT ON TABLE profile_accounts IS 'Which connected profile holds which account right now, and its status there.';
