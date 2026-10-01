-- 링크 미리보기 (WP48). Additive only: two posts columns with defaults and one cache table. The previous
-- Worker reads none of them; a post it writes while this deploy rolls out gets the defaults (preview
-- on, no cards), so its next save by the new Worker builds the cards.

-- The author's per-post switch '링크 미리보기' (default on).
ALTER TABLE `posts` ADD `link_preview` integer NOT NULL DEFAULT 1;
-- Up to 3 cards built when the post is saved ([{url,site,domain,title,description,image?}]).
ALTER TABLE `posts` ADD `link_cards` text NOT NULL DEFAULT '[]';

-- Fetched previews by normalized address: ok rows are reused for 7 days, failed rows for 1 day. The
-- daily cleanup deletes rows older than 7 days.
CREATE TABLE IF NOT EXISTS `link_cache` (
    `url` text PRIMARY KEY,
    `card` text NOT NULL,
    `ok` integer NOT NULL,
    `fetched_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `link_cache_fetched` ON `link_cache` (`fetched_at`);
