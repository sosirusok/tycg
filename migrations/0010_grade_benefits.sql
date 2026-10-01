-- Grade benefits: 끌올 (bump), board and home promotion, and the post caps.
-- Boards sort 최신순 by bumped_at; created_at stays the true posting time. Posts the previous
-- Worker writes while this migration is live get bumped_at=0; the new Worker copies created_at
-- into them on its first list per isolate and in the daily cleanup.
ALTER TABLE `posts` ADD `bumped_at` integer DEFAULT 0 NOT NULL;
UPDATE `posts` SET `bumped_at` = `created_at`;
ALTER TABLE `posts` ADD `bump_count` integer DEFAULT 0 NOT NULL;
-- When the author turned on 게시판 상단 노출; NULL when off. 거래완료 clears it.
ALTER TABLE `posts` ADD `featured_at` integer;
-- titleKey() of the title (letters and digits only, NFKC, lower case) for the same-title check.
-- SQLite cannot apply NFKC, so older rows are filled in by the Worker (daily cleanup).
ALTER TABLE `posts` ADD `title_key` text DEFAULT '' NOT NULL;
CREATE INDEX `posts_title_key_missing` ON `posts` (`id`) WHERE title_key = '';
CREATE INDEX `posts_kind_bumped` ON `posts` (`kind`, `bumped_at`);
CREATE INDEX `posts_bumped` ON `posts` (`bumped_at`);
CREATE INDEX `posts_featured` ON `posts` (`featured_at`) WHERE featured_at IS NOT NULL;
CREATE INDEX `posts_author_status` ON `posts` (`author_id`, `status`);

-- New posts and bumps per member, for the daily caps and the deleted-title wait. post_id has no
-- foreign key on purpose: deleting a post must not refund the quota. Rows older than 2 days are
-- removed by the daily cleanup.
CREATE TABLE `post_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`post_id` integer,
	`kind` text NOT NULL,
	`title_key` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `post_events_user` ON `post_events` (`user_id`, `kind`, `created_at`);
CREATE INDEX `post_events_title` ON `post_events` (`user_id`, `title_key`, `created_at`);

-- When the daily cron sent the "grade ends in 7 days" chat message for this grant.
ALTER TABLE `user_grades` ADD `reminded_at` integer;
