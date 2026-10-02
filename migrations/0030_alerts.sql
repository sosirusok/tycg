-- 새 글 알림 (WP54). Additive only: columns with defaults, one new table and indexes. The previous Worker
-- inserts saved searches with explicit columns (the new ones take their defaults, alert off) and never
-- reads follows, so it keeps serving unchanged while this deploy rolls out.

-- A saved search can send 알림 (alert=1). keyword=1: the query holds only the tab, the category and the
-- search word (키워드 알림, or 게시판 새 글 알림 with no word), free for every grade; keyword=0: any other
-- filter (조건 알림, 플러스 and up). The match columns are written when the 알림 is turned on:
-- alert_word lower(trim(q)), alert_word_ns the same without spaces, alert_skins the skins the word names
-- (JSON), alert_tier/alert_season the ladder a whole search names ('28챌'; season NULL: any season), so
-- the cron matches with the same SQL the board search runs.
ALTER TABLE `saved_searches` ADD `alert` integer NOT NULL DEFAULT 0;
ALTER TABLE `saved_searches` ADD `alert_kind` text NOT NULL DEFAULT '';
ALTER TABLE `saved_searches` ADD `alert_category` text NOT NULL DEFAULT '';
ALTER TABLE `saved_searches` ADD `keyword` integer NOT NULL DEFAULT 1;
ALTER TABLE `saved_searches` ADD `alert_word` text NOT NULL DEFAULT '';
ALTER TABLE `saved_searches` ADD `alert_word_ns` text NOT NULL DEFAULT '';
ALTER TABLE `saved_searches` ADD `alert_skins` text NOT NULL DEFAULT '[]';
ALTER TABLE `saved_searches` ADD `alert_tier` text NOT NULL DEFAULT '';
ALTER TABLE `saved_searches` ADD `alert_season` integer;
-- The cron's lookups: keyword and board 알림 by tab, 조건 알림 by tab (only rows with the 알림 on).
CREATE INDEX IF NOT EXISTS `saved_alerts` ON `saved_searches` (`alert_kind`,`keyword`) WHERE `alert` = 1;

-- 판매자 구독: one row per (member, followed member), 100 per member.
CREATE TABLE IF NOT EXISTS `follows` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`target_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`,`target_id`)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS `follows_target` ON `follows` (`target_id`);
-- '구독 허용' (on by default). Off stops every 구독 알림 about the member's posts and new follows.
ALTER TABLE `users` ADD `follow_allowed` integer NOT NULL DEFAULT 1;

-- 조건 알림 가격 내림 (프리미엄 and up): the price drops of the cron's window, by time.
CREATE INDEX IF NOT EXISTS `price_history_changed` ON `post_price_history` (`changed_at`);
