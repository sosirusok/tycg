-- Earlier exchange posts had no separate wanted-category field. The old editor
-- and detail screen used account as their fallback; carry that compatibility
-- default into stored data so both search and detail use the same value.
-- This is a UI fallback, not evidence that an author specified the target.
-- Authors can choose the correct target when they next edit the listing.
UPDATE posts
SET details = json_set(details, '$.wantedCategory', 'account')
WHERE kind = 'exchange'
  AND (json_extract(details, '$.wantedCategory') IS NULL
       OR json_extract(details, '$.wantedCategory') = '');
