-- Chat polls read offers and applications by conversation.
CREATE INDEX `applications_conversation` ON `applications` (`conversation_id`, `created_at`);
CREATE INDEX `offers_conversation` ON `offers` (`conversation_id`);
-- Unread counts only look at unread messages.
CREATE INDEX `messages_unread` ON `messages` (`conversation_id`, `sender_id`) WHERE read_at IS NULL;
CREATE INDEX `uploads_owner` ON `uploads` (`owner_id`, `created_at`);
CREATE INDEX `uploads_storage_size` ON `uploads` (`storage`, `size`);

-- A manager decision writes its id here. The grant and chat message in the same
-- batch are inserted only when this decision is the one that changed the row.
ALTER TABLE `applications` ADD `decision_id` text;

-- Ladders that an exchange post wants in return (the offered account's ladders stay in post_seasons).
CREATE TABLE `post_wanted_seasons` (
	`post_id` integer NOT NULL,
	`tier` text NOT NULL,
	`season` integer NOT NULL,
	PRIMARY KEY (`post_id`, `tier`, `season`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `wanted_seasons_search` ON `post_wanted_seasons` (`tier`, `season`);

-- Which post or chat message uses each photo, so a photo lookup does not scan every post.
CREATE TABLE `post_images` (
	`post_id` integer NOT NULL,
	`upload_id` text NOT NULL,
	PRIMARY KEY (`post_id`, `upload_id`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `post_images_upload` ON `post_images` (`upload_id`);
INSERT OR IGNORE INTO `post_images` (`post_id`, `upload_id`)
	SELECT p.id, j.value FROM posts p, json_each(p.images) j WHERE json_valid(p.images) AND j.type = 'text';

CREATE TABLE `message_images` (
	`message_id` integer NOT NULL,
	`upload_id` text NOT NULL,
	PRIMARY KEY (`message_id`, `upload_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `message_images_upload` ON `message_images` (`upload_id`);
INSERT OR IGNORE INTO `message_images` (`message_id`, `upload_id`)
	SELECT m.id, j.value FROM messages m, json_each(m.attachments) j WHERE json_valid(m.attachments) AND j.type = 'text';
