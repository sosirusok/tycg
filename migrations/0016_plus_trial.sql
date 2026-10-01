-- 플러스 7일 무료 체험 (WP41). Additive only: two users columns, one user_grades column with a
-- default, two indexes, the event window as settings rows and three triggers. The previous Worker
-- keeps working while it still serves: its grade inserts name no source and get 'manager'.

-- Where a grade row came from: 'manager' (every grant so far) or 'trial'. The source never changes.
ALTER TABLE `user_grades` ADD `source` text DEFAULT 'manager' NOT NULL;
-- When the member closed the sign-up event popup (it shows once per account).
ALTER TABLE `users` ADD `trial_popup_at` integer;
-- Set once, when a trial is granted, and never cleared, so a 회수 never brings the trial back.
-- -1 marks a sign-up refused by the per-address cap (no trial, ever).
ALTER TABLE `users` ADD `trial_at` integer;

CREATE INDEX `user_grades_trial` ON `user_grades` (`user_id`) WHERE `source` = 'trial';
CREATE INDEX `users_created` ON `users` (`created_at`);

-- The event window, from the moment this migration is applied to 23:59:59.999 KST on the 7th day
-- after the apply day. 'sys:' keys are never sent to the app; the manager can move the end.
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('sys:trial_start', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('sys:trial_end', (CAST(strftime('%s', 'now', '+9 hours', 'start of day', '+8 days') AS INTEGER) - 32400) * 1000 - 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- A trial row is allowed only as 플러스 rank 1 without an application, ending exactly 7 days after
-- the account was created, for an account created inside the window (a missing setting means
-- closed), that never had a trial (trial_at IS NULL) and holds no other trial row. The manager-only
-- triggers of 0009 still apply on top (granted_by 'manager').
CREATE TRIGGER `user_grades_trial_rule` BEFORE INSERT ON `user_grades`
WHEN NEW.`source` IS NOT 'manager'
BEGIN
    SELECT RAISE(ABORT, 'trial rule')
    WHERE NOT COALESCE((
        NEW.`source` = 'trial' AND NEW.`grade` = 'plus' AND NEW.`rank` = 1 AND NEW.`application_id` IS NULL
        AND NEW.`expires_at` = (SELECT `created_at` FROM `users` WHERE `id` = NEW.`user_id`) + 604800000
        AND (SELECT `created_at` FROM `users` WHERE `id` = NEW.`user_id`) >= COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'sys:trial_start'), 9e18)
        AND (SELECT `created_at` FROM `users` WHERE `id` = NEW.`user_id`) <= COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'sys:trial_end'), -1)
        AND EXISTS(SELECT 1 FROM `users` WHERE `id` = NEW.`user_id` AND `trial_at` IS NULL)
        AND NOT EXISTS(SELECT 1 FROM `user_grades` WHERE `user_id` = NEW.`user_id` AND `source` = 'trial')
    ), 0);
END;

CREATE TRIGGER `user_grades_source_fixed` BEFORE UPDATE OF `source` ON `user_grades`
BEGIN
    SELECT RAISE(ABORT, 'source fixed');
END;

-- A trial can be shortened (지금 마감) but never extended or made permanent.
CREATE TRIGGER `user_grades_trial_no_extend` BEFORE UPDATE OF `expires_at` ON `user_grades`
WHEN OLD.`source` = 'trial' AND (NEW.`expires_at` IS NULL OR NEW.`expires_at` > OLD.`expires_at`)
BEGIN
    SELECT RAISE(ABORT, 'trial no extend');
END;
