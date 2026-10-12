#!/usr/bin/env bash
# Creates the three ORBOT roles and the record / secrets databases (plus test twins).
#   orbot_owner   - owns the record schema, runs migrations. Not used by the running API.
#   orbot_app     - the running API. SELECT + INSERT on the record only (granted by migrations).
#   orbot_secrets - the only role that can connect to the secrets databases.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE orbot_owner   LOGIN PASSWORD '${ORBOT_DB_OWNER_PASSWORD}';
CREATE ROLE orbot_app     LOGIN PASSWORD '${ORBOT_DB_APP_PASSWORD}';
CREATE ROLE orbot_secrets LOGIN PASSWORD '${ORBOT_DB_SECRETS_PASSWORD}';

CREATE DATABASE orbot              OWNER orbot_owner;
CREATE DATABASE orbot_test         OWNER orbot_owner;
CREATE DATABASE orbot_secrets      OWNER orbot_secrets;
CREATE DATABASE orbot_secrets_test OWNER orbot_secrets;

REVOKE ALL ON DATABASE orbot_secrets      FROM PUBLIC;
REVOKE ALL ON DATABASE orbot_secrets_test FROM PUBLIC;
REVOKE ALL ON DATABASE orbot              FROM PUBLIC;
REVOKE ALL ON DATABASE orbot_test         FROM PUBLIC;
GRANT CONNECT ON DATABASE orbot      TO orbot_app;
GRANT CONNECT ON DATABASE orbot_test TO orbot_app;
SQL

for db in orbot orbot_test; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO orbot_owner;
GRANT USAGE ON SCHEMA public TO orbot_app;
SQL
done

for db in orbot_secrets orbot_secrets_test; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO orbot_secrets;
SQL
done
