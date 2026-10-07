-- Browser profiles running Waybill, the Amazon accounts they report, and
-- which profile holds which account. Orders are never stored.

CREATE TABLE profiles (
  id            uuid PRIMARY KEY,               -- the extension's instance ID
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marketplace text NOT NULL CHECK (marketplace = 'amazon'),
  domain      text NOT NULL CHECK (domain ~ '^\.[a-z.]+$'),
  customer_id text,                              -- Amazon's customer ID, once known
  email       text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR email IS NOT NULL)
);

-- One row per Amazon account and marketplace.
CREATE UNIQUE INDEX accounts_customer ON accounts (marketplace, domain, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_email_only ON accounts (marketplace, domain, email) WHERE customer_id IS NULL;

CREATE TABLE profile_accounts (
  profile_id  uuid   NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  account_id  bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status      text   NOT NULL CHECK (status IN ('active', 'needs-sign-in')),
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, account_id)
);
