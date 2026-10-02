-- 판매 통계, 대표 글 고정 and 엘리트 주간 요약 (WP63, the round-3 WP38 without its profile banner). Additive
-- only: one new table, one nullable posts column, indexes and one settings row. The previous Worker never
-- reads or writes them, so it keeps serving unchanged while this rolls out (its views simply write no
-- post_views rows).

-- Counted views per post and hour (floor(ms / 3600000)), written only for posts whose author has 판매 통계
-- by trend or more (프리미엄 and up, and the manager). The daily cleanup keeps 14 days, by the hour index.
CREATE TABLE IF NOT EXISTS `post_views` (
    `post_id` integer NOT NULL,
    `hour` integer NOT NULL,
    `n` integer NOT NULL DEFAULT 0,
    PRIMARY KEY (`post_id`, `hour`)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS `post_views_hour` ON `post_views` (`hour`);

-- 대표 글: when the author pinned the post to their profile (NULL: not pinned). Only the newest pins up to
-- the author's current allowance show, so a downgrade deletes nothing.
ALTER TABLE `posts` ADD `profile_pin_at` integer;
CREATE INDEX IF NOT EXISTS `posts_profile_pin` ON `posts` (`author_id`, `profile_pin_at`) WHERE `profile_pin_at` IS NOT NULL;

-- 시세 (엘리트): confirmed 판매 trades of a category in the last 90 days.
CREATE INDEX IF NOT EXISTS `trades_market` ON `trades` (`category`, `confirmed_at`) WHERE `kind` = 'sell' AND `removed_at` IS NULL;

-- 엘리트 주간 요약: the last week start (Monday 10:00 KST) whose summaries are done. Starting from the apply
-- time, the first summary comes on the next Monday with a whole week of post_views behind it.
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('sys:weekly_last', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
