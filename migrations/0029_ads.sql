-- 광고 (WP53). Additive only: three columns with defaults, two partial indexes and a guarded backfill.
-- The previous Worker never reads the new columns; while it still serves it keeps reading featured_at
-- for its old '프리미엄 매물' box, which the backfill below only fills with the members' own open posts.

-- featured_pin: 0 automatic (the newest open posts fill the member's 광고 slots), 1 '광고 고정' (always
-- in a slot), -1 '광고 빼기' (never an ad). featured_at stays the slot marker: set on create, 끌올 (manual
-- and automatic) and refills, trimmed to the grade's slots by the Worker.
ALTER TABLE `posts` ADD `featured_pin` integer NOT NULL DEFAULT 0;
-- First views that came from an ad (?from=ad), for '광고 유입 12' on 내 글.
ALTER TABLE `posts` ADD `promo_views` integer NOT NULL DEFAULT 0;
-- The manager's '광고 제외' switch: the member's posts are never shown as ads.
ALTER TABLE `users` ADD `ad_off` integer NOT NULL DEFAULT 0;

-- The ad reads go through the slot posts only: per tab (board box, 비슷한 매물, the home row) and per
-- member (the trim after a write).
CREATE INDEX IF NOT EXISTS `posts_ad` ON `posts` (`kind`, `featured_at`) WHERE featured_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS `posts_ad_author` ON `posts` (`author_id`, `featured_at`) WHERE featured_at IS NOT NULL;

-- Members who hold 프리미엄 or above from the manager (1 slot; 엘리트 and 관리자 3) and have no slot post
-- yet get their newest open posts as slots, so their ads show without a new 끌올. The manager's own
-- posts are left to the next write.
UPDATE `posts` SET `featured_at` = `bumped_at`
WHERE `featured_at` IS NULL AND `id` IN (
    SELECT x.`id` FROM (
        SELECT p.`id`, ROW_NUMBER() OVER (PARTITION BY p.`author_id` ORDER BY p.`bumped_at` DESC, p.`id` DESC) AS rn, a.slots
        FROM (
            SELECT g.`user_id`, CASE WHEN MAX(g.`rank`) >= 3 THEN 3 ELSE 1 END AS slots
            FROM `user_grades` g
            WHERE g.`source` = 'manager' AND g.`rank` >= 2
                AND (g.`expires_at` IS NULL OR g.`expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
            GROUP BY g.`user_id`
        ) a
        JOIN `posts` p INDEXED BY `posts_author_bumped` ON p.`author_id` = a.`user_id`
        WHERE p.`status` != 'closed' AND p.`hidden` = 0
            AND NOT EXISTS (SELECT 1 FROM `posts` f WHERE f.`author_id` = a.`user_id` AND f.`featured_at` IS NOT NULL AND f.`status` != 'closed')
    ) x WHERE x.rn <= x.slots
);
