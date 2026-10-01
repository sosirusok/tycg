-- Added in the phase C review, after the other 0010 files were already applied to local databases,
-- so it has its own file (it sorts after 0010_stacked_grades_merge; 0011 belongs to WP20).
-- 내 글 counts each post's 찜 and the chats started from it. favorites is keyed (user_id, post_id)
-- and messages only by conversation, so both reads scanned the whole table; deleting a post (its
-- favorites cascade) scanned favorites too. Indexes only, so the previous Worker keeps working.
CREATE INDEX IF NOT EXISTS `favorites_post` ON `favorites` (`post_id`);
CREATE INDEX IF NOT EXISTS `messages_listing` ON `messages` (`reference_id`, `conversation_id`) WHERE type = 'listing';
