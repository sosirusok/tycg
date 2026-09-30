-- A 6-month renewal now extends the member's latest-ending 6-month row of that grade. Rows the
-- earlier code stacked stay as they are: they hold the manager's record of each grant, and the
-- latest-ending row already carries the stacked end date, so they change no one's access.

-- Defense in depth: only the manager account ('manager') grants grades and badges. The Worker
-- checks this too (grantGradeStatements, assertBadgeGranter); these triggers refuse any other
-- granted_by, NULL included. The update trigger names only the grant columns, so flags such as
-- a reminder timestamp can still be updated. Deletes (회수) are not affected.
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
