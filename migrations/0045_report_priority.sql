-- 신고 처리 순서 (WP60, decisions item 5g). Additive only: one nullable column, two indexes and a guarded
-- backfill of that column. reports.status is plain text, so the new '기각' outcome ('dismissed') needs no
-- rebuild; the previous Worker reads any status other than 'pending' as handled and never reads
-- decided_at, so it keeps serving unchanged while this rolls out.

-- When the manager decided the report (처리 완료 or 기각); NULL while it waits.
ALTER TABLE `reports` ADD `decided_at` integer;

-- The reporter's reports and 기각 of the last 30 days ('신고 30일 4 · 기각 1' and the 2-기각 rule).
CREATE INDEX IF NOT EXISTS `reports_reporter` ON `reports` (`reporter_id`, `created_at`);

-- The manager's '처리' list: the last 50 decided reports, newest decision first.
CREATE INDEX IF NOT EXISTS `reports_decided` ON `reports` (`decided_at`) WHERE `status` != 'pending';

-- Reports handled before this column existed keep their filing time as the decision time, so the '처리'
-- list orders them too. No row is 'dismissed' yet, so the 2-기각 rule starts from nothing.
UPDATE `reports` SET `decided_at` = `created_at` WHERE `status` != 'pending' AND `decided_at` IS NULL;
