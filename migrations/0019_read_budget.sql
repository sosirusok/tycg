-- Read and call budget (WP42). Additive only: indexes, two conversations columns with defaults, one
-- trigger and a one-time backfill. The previous Worker never reads the new columns; its message
-- inserts go through the trigger, so the unread counters stay right while it still serves (its
-- mark-read leaves a counter high until the next message or mark-read of the new Worker recounts it).

-- 내 글 찜 and chat counts (already created by 0010_trade_count_indexes; kept idempotent here).
CREATE INDEX IF NOT EXISTS `favorites_post` ON `favorites` (`post_id`);
CREATE INDEX IF NOT EXISTS `messages_listing` ON `messages` (`reference_id`, `conversation_id`) WHERE type = 'listing';
-- 최근 본 글 order and the post-delete cascade.
CREATE INDEX IF NOT EXISTS `history_post` ON `history` (`post_id`, `created_at`);
-- Board lists: one tab's category in 최신순 (the boards always name a category; a tab without one uses
-- posts_kind_bumped). The index also holds status, hidden and author_id, so the board count (up to
-- 301) reads the index only, and id, so 최신순 (bumped_at, id) needs no sort. Active lists filter
-- status!='closed' on these rows, so no separate status index is needed.
CREATE INDEX IF NOT EXISTS `posts_kind_category_bumped` ON `posts` (`kind`, `category`, `bumped_at`, `id`, `status`, `hidden`, `author_id`);
-- One author's posts in 최신순 (내 글, profile).
CREATE INDEX IF NOT EXISTS `posts_author_bumped` ON `posts` (`author_id`, `bumped_at`);
-- The post a chat is about (its latest post card or 제시), without walking every message of the chat.
CREATE INDEX IF NOT EXISTS `messages_about` ON `messages` (`conversation_id`, `id`) WHERE type IN ('listing', 'offer');
-- Members under 이용 정지 (few rows), so lists leave their posts out without joining users.
CREATE INDEX IF NOT EXISTS `users_suspended` ON `users` (`suspended_until`) WHERE suspended_until IS NOT NULL;

-- Unread messages per side of a chat: a_unread for user_a, b_unread for user_b. A post card
-- ('listing') never counts, as before.
ALTER TABLE `conversations` ADD `a_unread` integer DEFAULT 0 NOT NULL;
ALTER TABLE `conversations` ADD `b_unread` integer DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS `conversations_a_unread` ON `conversations` (`user_a`) WHERE a_unread > 0;
CREATE INDEX IF NOT EXISTS `conversations_b_unread` ON `conversations` (`user_b`) WHERE b_unread > 0;
CREATE INDEX IF NOT EXISTS `conversations_a_updated` ON `conversations` (`user_a`, `updated_at`);
CREATE INDEX IF NOT EXISTS `conversations_b_updated` ON `conversations` (`user_b`, `updated_at`);

-- Every new unread message adds one to the other side, whichever Worker or path inserts it.
CREATE TRIGGER IF NOT EXISTS `messages_unread_insert` AFTER INSERT ON `messages`
WHEN NEW.`read_at` IS NULL AND NEW.`type` != 'listing'
BEGIN
    UPDATE `conversations` SET
        `a_unread` = `a_unread` + (NEW.`sender_id` != `user_a`),
        `b_unread` = `b_unread` + (NEW.`sender_id` != `user_b`)
    WHERE `id` = NEW.`conversation_id`;
END;

-- The trigger exists before the backfill, and the backfill writes absolute values, so a message that
-- lands while this runs is counted once either way.
UPDATE `conversations` SET
    `a_unread` = (SELECT COUNT(*) FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`sender_id` != `conversations`.`user_a` AND m.`read_at` IS NULL AND m.`type` != 'listing'),
    `b_unread` = (SELECT COUNT(*) FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`sender_id` != `conversations`.`user_b` AND m.`read_at` IS NULL AND m.`type` != 'listing')
WHERE EXISTS(SELECT 1 FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`read_at` IS NULL);
