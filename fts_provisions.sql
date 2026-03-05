-- Add full-text search support for provisions.
-- Run this in Supabase SQL Editor.

ALTER TABLE provisions
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

UPDATE provisions
SET search_tsv =
  setweight(to_tsvector('english', coalesce(text, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(section, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(source_citation, '')), 'C')
WHERE search_tsv IS NULL;

CREATE OR REPLACE FUNCTION provisions_search_tsv_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.section, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.source_citation, '')), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provisions_search_tsv ON provisions;

CREATE TRIGGER trg_provisions_search_tsv
BEFORE INSERT OR UPDATE OF text, section, source_citation
ON provisions
FOR EACH ROW
EXECUTE FUNCTION provisions_search_tsv_trigger();

CREATE INDEX IF NOT EXISTS idx_provisions_search_tsv
ON provisions
USING GIN (search_tsv);
