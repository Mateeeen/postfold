-- Which day's summary has already been read.
--
-- A date, not a boolean or a timestamp. The digest is a yesterday object: it
-- appears once, is dismissible, and does not come back until the next day has
-- something to report. A digest that recalculates live becomes ambient, and
-- ambient things stop being read — which defeats the only job it has, being
-- the answer to "what went out without me".
ALTER TABLE accounts ADD COLUMN digest_dismissed_on TEXT;
