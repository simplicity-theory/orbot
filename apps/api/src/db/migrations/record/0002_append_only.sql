-- Append-only enforcement, two independent layers:
--  1. Privileges: the running API (orbot_app) may only SELECT and INSERT.
--  2. Triggers: UPDATE, DELETE and TRUNCATE raise an error for every role,
--     including the table owner.

CREATE FUNCTION orbot_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The ORBOT record is append-only: % on % is not allowed. Write a new version instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'OR001';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['record_version', 'record_supersession', 'record_event', 'schema_migration'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$s_no_update_delete BEFORE UPDATE OR DELETE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION orbot_forbid_change()', t);
    EXECUTE format(
      'CREATE TRIGGER %1$s_no_truncate BEFORE TRUNCATE ON %1$I
         FOR EACH STATEMENT EXECUTE FUNCTION orbot_forbid_change()', t);
  END LOOP;
END $$;

REVOKE ALL ON record_version, record_supersession, record_event FROM PUBLIC;
GRANT SELECT, INSERT ON record_version, record_supersession, record_event TO orbot_app;
GRANT SELECT ON record_active, record_archive TO orbot_app;
GRANT SELECT ON schema_migration TO orbot_app;
GRANT USAGE ON SEQUENCE task_number_seq TO orbot_app;
