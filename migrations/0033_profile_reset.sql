-- 프로필 사진 and 비밀번호 찾기 (WP59). Additive only: two NULL columns on users and one new table with
-- its index. The previous Worker never reads or writes any of them, so it keeps serving unchanged while
-- this rolls out (its member queries name their columns).

-- The 256px square photo (an uploads row the member owns; the unused-photo cleanup keeps it while it is
-- set) and its 64px inline copy (a data URI of at most 4,000 characters), which the post author box, the
-- chat list and the room header show without an image request. NULL: the initial-letter avatar.
ALTER TABLE `users` ADD `avatar_id` text;
ALTER TABLE `users` ADD `avatar_thumb` text;
-- The unused-photo check (worker/files.ts) and GET /api/images/:id look a photo up by avatar_id, once per
-- upload row they read; only members with a photo are indexed.
CREATE INDEX IF NOT EXISTS `users_avatar` ON `users` (`avatar_id`) WHERE `avatar_id` IS NOT NULL;

-- 비밀번호 찾기: a guest asks for a temporary password ('아이디' and '연락받을 곳'). Every request is stored,
-- for an existing id or not (the answer never tells which); the manager sees the pending ones with
-- whether the member exists, issues a temporary password and marks the request 'done'.
CREATE TABLE IF NOT EXISTS `reset_requests` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `username` text NOT NULL,
    `contact` text NOT NULL,
    `ip_hash` text NOT NULL,
    `status` text NOT NULL DEFAULT 'pending',
    `created_at` integer NOT NULL,
    `done_at` integer
);
-- The manager's list: pending requests, newest first.
CREATE INDEX IF NOT EXISTS `reset_requests_status` ON `reset_requests` (`status`, `created_at`);
