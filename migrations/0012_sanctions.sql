-- Member reports and 이용 정지 (WP22). A report names a post (post_id) or a member
-- (target_user_id, with the chat it happened in as conversation_id); reports.post_id is already
-- nullable. users.suspended_until is when a suspension ends (9e15 for 영구); NULL or a past time
-- means none. sanctions keeps every suspension and clear the manager made (days 0 = 영구,
-- NULL = 해제). Only nullable columns, a column with a default and a new table, so the previous
-- Worker keeps working while this migration is live: it never reads or writes them.
ALTER TABLE `reports` ADD `target_user_id` text;
ALTER TABLE `reports` ADD `conversation_id` text;
ALTER TABLE `users` ADD `suspended_until` integer;
ALTER TABLE `users` ADD `suspend_reason` text NOT NULL DEFAULT '';
CREATE TABLE `sanctions` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `user_id` text NOT NULL,
    `days` integer,
    `reason` text NOT NULL,
    `by_id` text NOT NULL,
    `created_at` integer NOT NULL
);
CREATE INDEX `sanctions_user` ON `sanctions` (`user_id`, `created_at`);
CREATE INDEX `reports_target` ON `reports` (`target_user_id`);
