-- profiles now lists the browser profiles connected right now, like
-- profile_accounts: a row is created when a profile connects and deleted
-- when it disconnects; the server clears both tables on start. Rows of
-- profiles that are no longer connected are removed here.
DELETE FROM profile_accounts;
DELETE FROM profiles;

COMMENT ON TABLE profiles IS 'Browser profiles running Waybill that are connected right now (the extension''s instance ID).';
COMMENT ON COLUMN profiles.first_seen_at IS 'When this connection began.';
COMMENT ON COLUMN profiles.last_seen_at IS 'Last report on this connection.';
