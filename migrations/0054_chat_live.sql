-- 채팅 즉시 전송 (WP69). Additive only: one nullable column and one partial unique index. The previous
-- Worker names its message columns and never writes cid (NULL), so its inserts never meet the index.

-- The client's id for a message it shows before the server answers (낙관적 전송). The room matches the
-- server copy by it, and a repeated send of the same cid (a retry, a double tap) writes nothing: the
-- index refuses a second row, so the first one is returned instead.
ALTER TABLE `messages` ADD `cid` text;
CREATE UNIQUE INDEX IF NOT EXISTS `messages_cid` ON `messages` (`conversation_id`, `sender_id`, `cid`) WHERE `cid` IS NOT NULL;
