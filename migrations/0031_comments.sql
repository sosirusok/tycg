-- 댓글·답글 (WP55) for every grade. Additive only: one new table, its indexes and triggers, and two
-- columns with defaults. The previous Worker never reads or writes comments, inserts posts and reports
-- with explicit columns (the new ones take their defaults) and deletes posts with a plain DELETE (the
-- comments go with the post through the foreign key), so it keeps serving unchanged during the rollout.

-- One row per 댓글 or 답글. parent_id is the top-level 댓글 a 답글 belongs to (one level only). A deleted
-- 댓글 that still has 답글 stays as deleted_at (shown as '삭제된 댓글입니다.') with its body and photo
-- cleared; any other delete removes the row.
CREATE TABLE IF NOT EXISTS `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL REFERENCES `posts`(`id`) ON DELETE cascade,
	`author_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`parent_id` integer,
	`body` text NOT NULL,
	`image_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`deleted_at` integer
);
-- A post's 댓글 in 등록순.
CREATE INDEX IF NOT EXISTS `comments_post` ON `comments` (`post_id`,`id`);
-- 내 거래 '댓글' (newest first) and the 200 a KST day count.
CREATE INDEX IF NOT EXISTS `comments_author` ON `comments` (`author_id`,`created_at`);
-- The 답글 of a 댓글 (soft or hard delete, the reply list).
CREATE INDEX IF NOT EXISTS `comments_parent` ON `comments` (`parent_id`) WHERE `parent_id` IS NOT NULL;
-- A comment photo counts as in use (the unused-photo cleanup) and is served while its post is visible.
CREATE INDEX IF NOT EXISTS `comments_image` ON `comments` (`image_id`) WHERE `image_id` IS NOT NULL;

-- '댓글 3' on the cards and the detail page: live (not deleted) 댓글 and 답글, kept by triggers so every
-- insert, delete and soft delete updates it in the same transaction.
ALTER TABLE `posts` ADD `comment_count` integer NOT NULL DEFAULT 0;

CREATE TRIGGER IF NOT EXISTS `comments_count_insert` AFTER INSERT ON `comments`
WHEN NEW.`deleted_at` IS NULL
BEGIN
    UPDATE `posts` SET `comment_count` = `comment_count` + 1 WHERE `id` = NEW.`post_id`;
END;

CREATE TRIGGER IF NOT EXISTS `comments_count_delete` AFTER DELETE ON `comments`
WHEN OLD.`deleted_at` IS NULL
BEGIN
    UPDATE `posts` SET `comment_count` = MAX(`comment_count` - 1, 0) WHERE `id` = OLD.`post_id`;
END;

CREATE TRIGGER IF NOT EXISTS `comments_count_soft` AFTER UPDATE OF `deleted_at` ON `comments`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
    UPDATE `posts` SET `comment_count` = MAX(`comment_count` - 1, 0) WHERE `id` = NEW.`post_id`;
END;

-- 신고 of a 댓글: the comment and its text when it was reported (the manager still reads it after a delete).
ALTER TABLE `reports` ADD `comment_id` integer;
ALTER TABLE `reports` ADD `comment_body` text;
CREATE INDEX IF NOT EXISTS `reports_comment` ON `reports` (`comment_id`,`reporter_id`) WHERE `comment_id` IS NOT NULL;
