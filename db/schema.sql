-- App tables are deliberately outside public: Supabase's public Data API cannot bypass the server.
CREATE SCHEMA IF NOT EXISTS planner;
CREATE TABLE IF NOT EXISTS planner.events (
  id text PRIMARY KEY, name text NOT NULL, label text NOT NULL, position integer NOT NULL, rounds smallint[] NOT NULL DEFAULT ARRAY[1,2]::smallint[]
);
CREATE TABLE IF NOT EXISTS planner.slots (
  id text PRIMARY KEY, label text NOT NULL, starts_at timestamptz NOT NULL UNIQUE,
  capacity integer NOT NULL CHECK (capacity >= 0)
);
CREATE TABLE IF NOT EXISTS planner.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  name_key text NOT NULL UNIQUE, wca_id text UNIQUE
);
CREATE TABLE IF NOT EXISTS planner.settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), locked boolean NOT NULL DEFAULT false
);
ALTER TABLE planner.settings ADD COLUMN IF NOT EXISTS max_slots integer NOT NULL DEFAULT 2 CHECK (max_slots >= 0);
INSERT INTO planner.settings(id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS planner.bookings (
  competitor_id uuid NOT NULL REFERENCES planner.competitors(id) ON DELETE CASCADE,
  slot_id text NOT NULL REFERENCES planner.slots(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES planner.events(id),
  round smallint NOT NULL CHECK (round IN (1, 2)),
  PRIMARY KEY (competitor_id, slot_id)
);
CREATE INDEX IF NOT EXISTS bookings_slot ON planner.bookings(slot_id);

-- All writers serialize on settings, competitor, then Slot rows.
-- Repeating an event across different Slots is intentionally allowed.
CREATE OR REPLACE FUNCTION planner.enforce_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path = planner, pg_temp AS $$
DECLARE slot_capacity integer; booking_limit integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.slot_id <> OLD.slot_id OR NEW.competitor_id <> OLD.competitor_id) THEN
    RAISE EXCEPTION 'BOOKING_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM planner.events WHERE id = NEW.event_id AND NEW.round = ANY(rounds)) THEN
    RAISE EXCEPTION 'INVALID_EVENT_ROUND';
  END IF;
  SELECT max_slots INTO booking_limit FROM planner.settings WHERE id=true FOR SHARE;
  PERFORM id FROM planner.competitors WHERE id=NEW.competitor_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM planner.bookings WHERE slot_id=NEW.slot_id AND competitor_id=NEW.competitor_id)
     AND (SELECT count(*) FROM planner.bookings WHERE competitor_id=NEW.competitor_id) >= booking_limit THEN
    RAISE EXCEPTION 'BOOKING_LIMIT';
  END IF;
  SELECT capacity INTO slot_capacity FROM planner.slots WHERE id = NEW.slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SLOT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM planner.bookings WHERE slot_id = NEW.slot_id AND competitor_id = NEW.competitor_id)
     AND (SELECT count(*) FROM planner.bookings WHERE slot_id = NEW.slot_id) >= slot_capacity THEN
    RAISE EXCEPTION 'SLOT_FULL';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_capacity ON planner.bookings;
CREATE TRIGGER enforce_capacity BEFORE INSERT OR UPDATE ON planner.bookings
FOR EACH ROW EXECUTE FUNCTION planner.enforce_capacity();
REVOKE ALL ON SCHEMA planner FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA planner FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA planner FROM PUBLIC;
