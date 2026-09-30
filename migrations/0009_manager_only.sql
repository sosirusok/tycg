-- A 6-month renewal now extends the member's one unexpired 6-month row of that grade. Rows
-- stacked by the earlier code are merged first: the latest-ending row already carries the stacked
-- end date, so dropping the earlier unexpired rows of the same grade does not shorten any access.
DELETE FROM `user_grades`
WHERE `expires_at` IS NOT NULL AND `expires_at` > strftime('%s','now')*1000
AND EXISTS (
    SELECT 1 FROM `user_grades` g2
    WHERE g2.`user_id` = `user_grades`.`user_id` AND g2.`grade` = `user_grades`.`grade` AND g2.`expires_at` > `user_grades`.`expires_at`
);

-- Defense in depth: only the manager account ('manager') grants grades and badges. The Worker
-- checks this too (grantGradeStatements, assertBadgeGranter); these triggers refuse any other
-- granted_by, NULL included. The update trigger names only the grant columns, so flags such as
-- a reminder timestamp can still be updated. Deletes (회수, 탈퇴) are not affected.
CREATE TRIGGER `user_grades_manager_only` BEFORE INSERT ON `user_grades`
WHEN NEW.`granted_by` IS NOT 'manager'
BEGIN
    SELECT RAISE(ABORT, 'manager only');
END;

CREATE TRIGGER `user_grades_manager_only_update` BEFORE UPDATE OF `user_id`, `grade`, `rank`, `expires_at`, `granted_by` ON `user_grades`
WHEN NEW.`granted_by` IS NOT 'manager'
BEGIN
    SELECT RAISE(ABORT, 'manager only');
END;

CREATE TRIGGER `user_badges_manager_only` BEFORE INSERT ON `user_badges`
WHEN NEW.`granted_by` IS NOT 'manager'
BEGIN
    SELECT RAISE(ABORT, 'manager only');
END;
