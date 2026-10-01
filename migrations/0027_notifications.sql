-- 알림함 (WP50). Additive only: one new table and its indexes. The previous Worker never reads or writes
-- it, so it keeps serving unchanged while this deploy rolls out (its events simply write no 알림).

-- One row per 알림. ref names the event's target (a post id, an application id, a grade row), so the
-- partial unique index below keeps one unread row per (member, type, target): a repeated event writes
-- nothing until the member reads that row. post_id and actor_id are plain values (no foreign key): a
-- deleted post or member leaves the row readable.
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`type` text NOT NULL,
	`ref` text NOT NULL DEFAULT '',
	`post_id` integer,
	`actor_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);
-- The list (newest first) and the per-day cap of 100 rows per member.
CREATE INDEX `notifications_user` ON `notifications` (`user_id`,`created_at`);
-- The header count (at most 99 rows read).
CREATE INDEX `notifications_unread` ON `notifications` (`user_id`) WHERE `read_at` IS NULL;
CREATE UNIQUE INDEX `notifications_open` ON `notifications` (`user_id`,`type`,`ref`) WHERE `read_at` IS NULL;
-- The daily cleanup's age limits (14 days once read, 60 days for any row).
CREATE INDEX `notifications_created` ON `notifications` (`created_at`);
-- The daily cleanup's 플러스 무료 체험 reminders read only trial rows near or past their end.
CREATE INDEX `user_grades_trial_end` ON `user_grades` (`expires_at`) WHERE `source`='trial';
