-- Added in the phase B review, after 0008_accounts and 0010_grade_benefits were already applied to
-- local databases, so it has its own file (it sorts after 0010_grade_benefits; 0011 belongs to WP20).
-- The previous Worker changes a nickname without touching nickname_key. Clearing the key then
-- lets ensureNicknameKeys compute the right one, so the look-alike check never protects an old name.
CREATE TRIGGER `users_nickname_key_reset` AFTER UPDATE OF `nickname` ON `users`
WHEN NEW.`nickname` IS NOT OLD.`nickname` AND NEW.`nickname_key` IS OLD.`nickname_key`
BEGIN
    UPDATE `users` SET `nickname_key` = NULL WHERE `id` = NEW.`id`;
END;
