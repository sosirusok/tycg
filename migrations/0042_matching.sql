-- 자동 매칭 (WP58). Additive only: one partial index and a guarded backfill of a column the previous
-- Worker never reads or writes (automation.match_on and post_auto.match came with 0028 and stayed 0), so
-- it keeps serving unchanged while this rolls out.

-- Tick B's matchers: the members with '자동 매칭' on (worker/match.ts reads them INDEXED BY this index).
CREATE INDEX IF NOT EXISTS `automation_match` ON `automation` (`user_id`) WHERE `match_on` = 1;

-- '자동 매칭' is on from the grant, like 자동 끌올: the current 프리미엄, 엘리트 and 관리자 members get it on.
-- (A grant from now on turns it on in the same batch; the switch is on the 자동화 tab's 알림 card.)
UPDATE `automation` SET `match_on` = 1
WHERE `match_on` = 0 AND `user_id` IN (
    SELECT g.`user_id` FROM `user_grades` g
    WHERE g.`rank` >= 2 AND (g.`expires_at` IS NULL OR g.`expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
