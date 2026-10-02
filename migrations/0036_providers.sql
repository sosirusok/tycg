-- 중개 인증·가측 인증 and the '중개/가측' tab (WP66), and the one-time 등급 축하 창. Additive only: one new table
-- with its indexes, triggers that keep its copies current, and one users column with a default. The previous
-- Worker never reads or writes any of them (it cannot grant the two new 인증), so it keeps serving unchanged
-- while this rolls out; the WP65 service_requests table and the posts/trades columns stay as they are.

-- One row per member and kind, created when the manager grants 중개 인증 ('broker') or 가측 인증 ('appraiser')
-- (the user_badges trigger below), kept when the 인증 is taken back (the 소개 survives a later grant).
-- intro: the member's 소개, at most 25 characters stored (프리미엄 shows 12, 플러스 none); active: '받는 중'.
-- The listing reads this row and the member's users row only (about 2 rows per provider, WP42 budget), so
-- what it needs from other tables is copied here by triggers, whichever Worker writes:
--   grades       [[rank, expires_at], ...] of the member's manager grants (never the 무료 체험);
--   elite_until  when the member's last 엘리트 or 관리자 grant ends (9e15: permanent, 0: none), for the home
--                popup's index;
--   badges       the member's 인증 ids (the listing needs its own kind's 인증; cards show 본인 and 신용인);
--   review_count the member's live 후기 (not removed, on a trade that was not removed).
CREATE TABLE IF NOT EXISTS `provider_profiles` (
    `user_id` text NOT NULL,
    `type` text NOT NULL CHECK (`type` IN ('broker', 'appraiser')),
    `intro` text NOT NULL DEFAULT '',
    `active` integer NOT NULL DEFAULT 1,
    `updated_at` integer NOT NULL,
    `grades` text NOT NULL DEFAULT '[]',
    `elite_until` integer NOT NULL DEFAULT 0,
    `badges` text NOT NULL DEFAULT '[]',
    `review_count` integer NOT NULL DEFAULT 0,
    PRIMARY KEY (`user_id`, `type`)
);
-- The tab: one kind's rows with '받는 중' on.
CREATE INDEX IF NOT EXISTS `provider_profiles_list` ON `provider_profiles` (`type`, `active`);
-- The home popup: listed rows of members holding 엘리트 or 관리자 now (elite_until > now).
CREATE INDEX IF NOT EXISTS `provider_profiles_elite` ON `provider_profiles` (`elite_until`) WHERE `active` = 1;

-- The grant creates the row (or turns '받는 중' on again for a returning provider) with its copies filled in.
CREATE TRIGGER IF NOT EXISTS `provider_badge_insert` AFTER INSERT ON `user_badges`
BEGIN
    INSERT INTO `provider_profiles` (`user_id`, `type`, `intro`, `active`, `updated_at`, `grades`, `elite_until`, `badges`, `review_count`)
    SELECT NEW.`user_id`, NEW.`badge`, '', 1, NEW.`granted_at`,
        (SELECT json_group_array(json_array(g.`rank`, g.`expires_at`)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager'),
        COALESCE((SELECT MAX(COALESCE(g.`expires_at`, 9000000000000000)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager' AND g.`rank` >= 3), 0),
        '[]',
        (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = NEW.`user_id` AND rv.`removed_at` IS NULL
            AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL))
    WHERE NEW.`badge` IN ('broker', 'appraiser')
    ON CONFLICT (`user_id`, `type`) DO UPDATE SET `active` = 1, `updated_at` = excluded.`updated_at`;
    UPDATE `provider_profiles` SET `badges` = (SELECT json_group_array(b.`badge`) FROM `user_badges` b WHERE b.`user_id` = NEW.`user_id`) WHERE `user_id` = NEW.`user_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_badge_delete` AFTER DELETE ON `user_badges`
BEGIN
    UPDATE `provider_profiles` SET `badges` = (SELECT json_group_array(b.`badge`) FROM `user_badges` b WHERE b.`user_id` = OLD.`user_id`) WHERE `user_id` = OLD.`user_id`;
END;

-- Grants, renewals, expiry changes and 회수 refresh the grade copies.
CREATE TRIGGER IF NOT EXISTS `provider_grades_insert` AFTER INSERT ON `user_grades`
BEGIN
    UPDATE `provider_profiles` SET
        `grades` = (SELECT json_group_array(json_array(g.`rank`, g.`expires_at`)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager'),
        `elite_until` = COALESCE((SELECT MAX(COALESCE(g.`expires_at`, 9000000000000000)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager' AND g.`rank` >= 3), 0)
    WHERE `user_id` = NEW.`user_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_grades_update` AFTER UPDATE OF `user_id`, `grade`, `rank`, `expires_at`, `source` ON `user_grades`
BEGIN
    UPDATE `provider_profiles` SET
        `grades` = (SELECT json_group_array(json_array(g.`rank`, g.`expires_at`)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager'),
        `elite_until` = COALESCE((SELECT MAX(COALESCE(g.`expires_at`, 9000000000000000)) FROM `user_grades` g WHERE g.`user_id` = NEW.`user_id` AND g.`source` = 'manager' AND g.`rank` >= 3), 0)
    WHERE `user_id` = NEW.`user_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_grades_delete` AFTER DELETE ON `user_grades`
BEGIN
    UPDATE `provider_profiles` SET
        `grades` = (SELECT json_group_array(json_array(g.`rank`, g.`expires_at`)) FROM `user_grades` g WHERE g.`user_id` = OLD.`user_id` AND g.`source` = 'manager'),
        `elite_until` = COALESCE((SELECT MAX(COALESCE(g.`expires_at`, 9000000000000000)) FROM `user_grades` g WHERE g.`user_id` = OLD.`user_id` AND g.`source` = 'manager' AND g.`rank` >= 3), 0)
    WHERE `user_id` = OLD.`user_id`;
END;

-- 후기 written, removed or deleted, and trades removed or deleted, refresh the 후기 count of the members involved.
CREATE TRIGGER IF NOT EXISTS `provider_reviews_insert` AFTER INSERT ON `reviews`
BEGIN
    UPDATE `provider_profiles` SET `review_count` = (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = NEW.`target_id` AND rv.`removed_at` IS NULL
        AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL)) WHERE `user_id` = NEW.`target_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_reviews_update` AFTER UPDATE OF `removed_at` ON `reviews`
BEGIN
    UPDATE `provider_profiles` SET `review_count` = (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = NEW.`target_id` AND rv.`removed_at` IS NULL
        AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL)) WHERE `user_id` = NEW.`target_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_reviews_delete` AFTER DELETE ON `reviews`
BEGIN
    UPDATE `provider_profiles` SET `review_count` = (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = OLD.`target_id` AND rv.`removed_at` IS NULL
        AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL)) WHERE `user_id` = OLD.`target_id`;
END;
CREATE TRIGGER IF NOT EXISTS `provider_trades_update` AFTER UPDATE OF `removed_at` ON `trades`
BEGIN
    UPDATE `provider_profiles` SET `review_count` = (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = `provider_profiles`.`user_id` AND rv.`removed_at` IS NULL
        AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL)) WHERE `user_id` IN (NEW.`seller_id`, NEW.`buyer_id`);
END;
CREATE TRIGGER IF NOT EXISTS `provider_trades_delete` AFTER DELETE ON `trades`
BEGIN
    UPDATE `provider_profiles` SET `review_count` = (SELECT COUNT(*) FROM `reviews` rv WHERE rv.`target_id` = `provider_profiles`.`user_id` AND rv.`removed_at` IS NULL
        AND EXISTS (SELECT 1 FROM `trades` lt WHERE lt.`id` = rv.`trade_id` AND lt.`removed_at` IS NULL)) WHERE `user_id` IN (OLD.`seller_id`, OLD.`buyer_id`);
END;

-- 등급 축하 창: the public grade rank (manager grants only, never the 무료 체험) the member was last shown or
-- told about. A rise above it shows the window once; the member's answer stores the new rank. Members who
-- already hold a grade start at it, so this deploy celebrates nobody.
ALTER TABLE `users` ADD `celebrated_rank` integer NOT NULL DEFAULT 0;
UPDATE `users` SET `celebrated_rank` = COALESCE((SELECT MAX(g.`rank`) FROM `user_grades` g WHERE g.`user_id` = `users`.`id` AND g.`source` = 'manager'
        AND (g.`expires_at` IS NULL OR g.`expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))), 0)
    WHERE EXISTS (SELECT 1 FROM `user_grades` g WHERE g.`user_id` = `users`.`id` AND g.`source` = 'manager');
