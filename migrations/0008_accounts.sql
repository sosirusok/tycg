-- Look-alike nickname check: nicknameKey() in worker/http.ts (NFKC, lower case, no spaces
-- or punctuation). There is no SQL backfill because SQLite cannot apply NFKC or strip the
-- same characters, so SQL-computed keys would not match the Worker's keys. The Worker fills
-- missing keys lazily before every check (ensureNicknameKeys), which also covers rows the
-- previous Worker writes while this migration is live.
ALTER TABLE `users` ADD `nickname_key` text;
CREATE INDEX `users_nickname_key` ON `users` (`nickname_key`);

-- The nickname before the latest change, shown on the profile for 90 days. A member can
-- change their nickname once every 30 days.
ALTER TABLE `users` ADD `prev_nickname` text DEFAULT '' NOT NULL;
ALTER TABLE `users` ADD `nickname_changed_at` integer;

-- 회원 탈퇴: the row stays so chats and offers keep their links, with the id, nickname,
-- password and bio replaced.
ALTER TABLE `users` ADD `deleted_at` integer;
