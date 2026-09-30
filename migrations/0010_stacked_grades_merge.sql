-- Added in the phase B review, after 0009_manager_only and 0010_grade_benefits were already applied
-- to local databases, so it has its own file (it sorts after 0010_nickname_key_reset; 0011 belongs to WP20).
-- Before WP09 a second 6-month grant added a new row ending 6 months after the latest end, so a
-- member could hold two unexpired 6-month rows of one grade. A renewal now extends only the
-- latest-ending row and 회수 removes one row, so the earlier-ending stacked rows are deleted here.
-- The latest-ending row already carries the whole paid period, so no one loses access.
-- 회수 in the Worker also removes every unexpired 6-month row of that grade, which covers a row
-- the previous Worker stacks while a deploy runs.
DELETE FROM `user_grades`
WHERE `expires_at` IS NOT NULL
  AND `expires_at` > strftime('%s','now')*1000
  AND EXISTS (
    SELECT 1 FROM `user_grades` g2
    WHERE g2.`user_id` = `user_grades`.`user_id`
      AND g2.`grade` = `user_grades`.`grade`
      AND g2.`expires_at` > `user_grades`.`expires_at`
  );
