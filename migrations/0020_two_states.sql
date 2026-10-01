-- Two post states and a final 완료 (WP43, decisions item 2). Additive, plus one owner-mandated data
-- change: 예약중 is retired, so every 'reserved' post becomes 거래중 ('open'). The accepted 제시 rows
-- stay as they are (accepting no longer touches the post).
-- While the previous Worker still serves, its 예약중 writes silently stay open (the reserved triggers)
-- and its reopen of a 완료 post fails (closed is final), which is the owner rule from now on.
UPDATE `posts` SET `status` = 'open' WHERE `status` = 'reserved';

-- When the post was completed. Readers use COALESCE(closed_at, updated_at) for posts closed before.
ALTER TABLE `posts` ADD `closed_at` integer;
CREATE INDEX IF NOT EXISTS `posts_closed_at` ON `posts` (`closed_at`) WHERE closed_at IS NOT NULL;

-- Any write of 'reserved' (an old Worker or client) reads as 'open'. recursive_triggers is off by
-- default in SQLite, so the nested UPDATE does not fire these triggers again.
CREATE TRIGGER IF NOT EXISTS `posts_reserved_update` AFTER UPDATE OF `status` ON `posts`
WHEN NEW.`status` = 'reserved'
BEGIN
    UPDATE `posts` SET `status` = 'open' WHERE `id` = NEW.`id`;
END;
CREATE TRIGGER IF NOT EXISTS `posts_reserved_insert` AFTER INSERT ON `posts`
WHEN NEW.`status` = 'reserved'
BEGIN
    UPDATE `posts` SET `status` = 'open' WHERE `id` = NEW.`id`;
END;

-- 완료 is final: nothing turns a closed post back (no reopen, no 예약중), whichever Worker writes.
CREATE TRIGGER IF NOT EXISTS `posts_closed_final` BEFORE UPDATE OF `status` ON `posts`
WHEN OLD.`status` = 'closed' AND NEW.`status` IS NOT 'closed'
BEGIN
    SELECT RAISE(ABORT, 'closed is final');
END;

-- The completion time, stamped once by any writer that closes the post.
CREATE TRIGGER IF NOT EXISTS `posts_closed_at` AFTER UPDATE OF `status` ON `posts`
WHEN NEW.`status` = 'closed' AND OLD.`status` IS NOT 'closed'
BEGIN
    UPDATE `posts` SET `closed_at` = COALESCE(`closed_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE `id` = NEW.`id`;
END;

-- What the trade was about, kept even when the post is deleted later: the post's kind, category,
-- title and season tags, and the backing (the highest price the post listed, the MAX of a 구매, or the
-- highest 제시 the partner made), which caps what the trade adds to 거금.
ALTER TABLE `trades` ADD `kind` text NOT NULL DEFAULT '';
ALTER TABLE `trades` ADD `category` text NOT NULL DEFAULT '';
ALTER TABLE `trades` ADD `title` text NOT NULL DEFAULT '';
ALTER TABLE `trades` ADD `tags` text NOT NULL DEFAULT '[]';
ALTER TABLE `trades` ADD `backing` integer;

-- Trade record requests ('ask', at most 3 per post) and denials ('denied': actor = the member who
-- answered 거래 아님, target = the requester), for the limits and the manager's member panel.
CREATE TABLE IF NOT EXISTS `trade_log` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `post_id` integer NOT NULL,
    `actor_id` text NOT NULL,
    `target_id` text NOT NULL,
    `event` text NOT NULL,
    `created_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `trade_log_post` ON `trade_log` (`post_id`);
CREATE INDEX IF NOT EXISTS `trade_log_target` ON `trade_log` (`target_id`, `event`);
