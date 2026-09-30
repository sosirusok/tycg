-- Verification badges (대리 인증, 본인 인증, 신용인). A member can hold several.
CREATE TABLE `user_badges` (
	`user_id` text NOT NULL,
	`badge` text NOT NULL,
	`granted_by` text,
	`granted_at` integer NOT NULL,
	PRIMARY KEY (`user_id`, `badge`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Grade grants. The effective grade is the highest-ranked grant that has not
-- expired, so a permanent 플러스 remains after a 6-month 프리미엄 ends.
CREATE TABLE `user_grades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`grade` text NOT NULL,
	`rank` integer NOT NULL,
	`expires_at` integer,
	`granted_by` text,
	`granted_at` integer NOT NULL,
	`application_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `user_grades_user` ON `user_grades` (`user_id`, `rank`);

-- Applications are sent through a 1:1 chat with the manager, who approves them.
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`plan` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`conversation_id` text,
	`note` text DEFAULT '' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `applications_status` ON `applications` (`status`, `created_at`);
CREATE INDEX `applications_user` ON `applications` (`user_id`, `created_at`);
CREATE UNIQUE INDEX `applications_pending_unique` ON `applications` (`user_id`, `kind`, `target`) WHERE status = 'pending';

-- Manager-editable settings such as the deposit notice and the latest ladder season.
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);

-- Photos sent in chat (upload ids, JSON array).
ALTER TABLE `messages` ADD `attachments` text DEFAULT '[]' NOT NULL;

-- Photo bytes when no R2 bucket is bound, as base64 text (D1 returns BLOBs as
-- number arrays, which costs too much CPU to read). Rows are limited to 2 MB.
CREATE TABLE `upload_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade
);
-- Where each photo is stored, so enabling R2 later keeps older D1 photos readable.
ALTER TABLE `uploads` ADD `storage` text DEFAULT 'r2' NOT NULL;
