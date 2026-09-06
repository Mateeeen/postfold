-- Identity, as a person recognises it.
--
-- The UI renders posts the way LinkedIn renders them, because a draft reply is
-- a judgement about a specific post by a specific person and the user has to
-- recognise both to judge it. Name and headline alone do not do that; a face
-- does. Everything here is display material — nothing reads these to make a
-- sending decision.
--
-- Avatar URLs are signed and expire, which is why they are cached rather than
-- treated as stable identifiers: they are refreshed on connect and on each
-- content sync, and a stale one degrades to initials rather than breaking.
ALTER TABLE accounts ADD COLUMN avatar_url TEXT;
ALTER TABLE accounts ADD COLUMN public_identifier TEXT;
ALTER TABLE accounts ADD COLUMN location TEXT;

ALTER TABLE discovered_posts ADD COLUMN author_avatar_url TEXT;
