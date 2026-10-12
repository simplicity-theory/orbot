-- The permanent record. Append-only: rows are inserted, never updated or deleted.
-- A rewrite inserts a new version plus a supersession stamp (itself a new row).

CREATE TABLE record_version (
  id          uuid        PRIMARY KEY,
  entity_type text        NOT NULL,
  entity_id   uuid        NOT NULL,
  version     integer     NOT NULL CHECK (version > 0),
  unit_id     uuid,
  title       text        NOT NULL,
  body        jsonb       NOT NULL,
  body_text   text        NOT NULL,
  actor       text        NOT NULL,
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  search      tsvector    GENERATED ALWAYS AS (
                setweight(to_tsvector('english', title), 'A') ||
                setweight(to_tsvector('english', body_text), 'B')
              ) STORED,
  UNIQUE (entity_id, version)
);
CREATE INDEX record_version_type_idx   ON record_version (entity_type, entity_id);
CREATE INDEX record_version_unit_idx   ON record_version (unit_id);
CREATE INDEX record_version_search_idx ON record_version USING gin (search);
CREATE INDEX record_version_body_idx   ON record_version USING gin (body jsonb_path_ops);

CREATE TABLE record_supersession (
  entity_id             uuid        NOT NULL,
  version               integer     NOT NULL,
  superseded_by_version integer     NOT NULL,
  superseded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_by         text        NOT NULL,
  reason                text        NOT NULL,
  PRIMARY KEY (entity_id, version),
  FOREIGN KEY (entity_id, version) REFERENCES record_version (entity_id, version),
  FOREIGN KEY (entity_id, superseded_by_version) REFERENCES record_version (entity_id, version),
  CHECK (superseded_by_version = version + 1)
);

CREATE TABLE record_event (
  seq          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id           uuid        NOT NULL UNIQUE,
  kind         text        NOT NULL,
  unit_id      uuid,
  bot_id       uuid,
  task_id      uuid,
  operation_id uuid,
  mission_id   uuid,
  actor        text        NOT NULL,
  body         jsonb       NOT NULL,
  body_text    text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  search       tsvector    GENERATED ALWAYS AS (to_tsvector('english', body_text)) STORED
);
CREATE INDEX record_event_kind_idx   ON record_event (kind, seq);
CREATE INDEX record_event_unit_idx   ON record_event (unit_id, seq);
CREATE INDEX record_event_bot_idx    ON record_event (bot_id, seq);
CREATE INDEX record_event_task_idx   ON record_event (task_id, seq);
CREATE INDEX record_event_search_idx ON record_event USING gin (search);

CREATE SEQUENCE task_number_seq START 101;

-- Current version of everything (what bots are briefed from).
CREATE VIEW record_active AS
SELECT v.*
FROM record_version v
WHERE NOT EXISTS (
  SELECT 1 FROM record_supersession s
  WHERE s.entity_id = v.entity_id AND s.version = v.version
);

-- Every prior version, with who/when/why it was superseded.
CREATE VIEW record_archive AS
SELECT v.*,
       s.superseded_by_version,
       s.superseded_at,
       s.superseded_by,
       s.reason AS superseded_reason
FROM record_version v
JOIN record_supersession s USING (entity_id, version);

-- A version > 1 may only be inserted in the same transaction as the stamp on its predecessor,
-- and must keep the entity's type. Checked at commit so the two inserts can come in any order.
CREATE FUNCTION orbot_check_version_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version > 1 THEN
    IF NOT EXISTS (
      SELECT 1 FROM record_version p
      WHERE p.entity_id = NEW.entity_id AND p.version = NEW.version - 1
        AND p.entity_type = NEW.entity_type
    ) THEN
      RAISE EXCEPTION 'record_version % v% has no predecessor of the same type', NEW.entity_id, NEW.version;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM record_supersession s
      WHERE s.entity_id = NEW.entity_id AND s.version = NEW.version - 1
    ) THEN
      RAISE EXCEPTION 'record_version % v% was inserted without superseding v%',
        NEW.entity_id, NEW.version, NEW.version - 1;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER record_version_chain
  AFTER INSERT ON record_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orbot_check_version_chain();
