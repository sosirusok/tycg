-- Why the manager hid a post. Only its author and the manager see it; unhiding clears it.
ALTER TABLE `posts` ADD `hidden_reason` text DEFAULT '' NOT NULL;

-- Price history rows are left as they are (migrations only add). The Worker keeps only strictly
-- falling prices above the current one when it reads them (decorate in worker/posts.ts), which also
-- covers rows the previous Worker records while this migration is live, rises included.
