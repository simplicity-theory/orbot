-- The secrets store. Physically separate from the record (own database, own role).
-- Values are AES-256-GCM encrypted with ORBOT_SECRETS_KEY; the secret's name is bound
-- in as additional authenticated data so ciphertexts cannot be swapped between names.
-- This is the one place in ORBOT where rows change: rotating a secret must not keep
-- the old value around. Every store/rotate/revoke is logged in the record, by name only.

CREATE TABLE secret (
  name        text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,99}$'),
  ciphertext  bytea       NOT NULL,
  iv          bytea       NOT NULL,
  auth_tag    bytea       NOT NULL,
  key_id      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  revoked_at  timestamptz
);
