-- A 6-month renewal now extends the member's latest-ending 6-month row of that grade. Rows the
-- earlier code stacked are folded into that row by 0010_stacked_grades_merge.

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
