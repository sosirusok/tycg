-- 중개·가측 신청 (WP65). Additive only: a new table with its indexes and triggers, two posts columns and
-- one trades column with defaults. The previous Worker reads none of them; a trade record it writes
-- while this deploy rolls out still gets brokered=1 from the trigger below.

-- One request per row. month is the KST calendar month ('YYYY-MM') at creation: the free coupons used
-- this month are the rows of the current month with coupon=1 that are open or done, so the count
-- resets on the 1st 00:00 KST by construction and a cancelled request gives its coupon back.
CREATE TABLE IF NOT EXISTS `service_requests` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `user_id` text NOT NULL,
    `kind` text NOT NULL CHECK (`kind` IN ('broker', 'appraise')),
    `post_id` integer,
    `partner_id` text,
    `month` text NOT NULL,
    `coupon` integer NOT NULL DEFAULT 0,
    `status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open', 'done', 'cancelled')),
    -- 가측가 in 원 (appraise only).
    `price` integer,
    `note` text NOT NULL DEFAULT '',
    `created_at` integer NOT NULL,
    `decided_at` integer,
    `decided_by` text
);
CREATE INDEX IF NOT EXISTS `service_requests_user_month` ON `service_requests` (`user_id`, `month`);
CREATE INDEX IF NOT EXISTS `service_requests_status` ON `service_requests` (`status`, `created_at`);
-- One open request per kind per member: the only fair-use guard, the same for every grade.
CREATE UNIQUE INDEX IF NOT EXISTS `service_requests_one_open` ON `service_requests` (`user_id`, `kind`) WHERE `status` = 'open';
-- The broker lookup when a trade record is written (post and pair).
CREATE INDEX IF NOT EXISTS `service_requests_post` ON `service_requests` (`post_id`) WHERE `kind` = 'broker' AND `status` = 'done';

-- A decided request is final: its status changes only from 'open'.
CREATE TRIGGER IF NOT EXISTS `service_requests_final` BEFORE UPDATE OF `status` ON `service_requests`
WHEN OLD.`status` != 'open'
BEGIN
    SELECT RAISE(ABORT, 'service request already decided');
END;

-- 운영진 가측가: shown while the post was not edited after the appraisal (posts.updated_at <=
-- appraised_at). Edits never clear these, so the manager keeps the history.
ALTER TABLE `posts` ADD `appraised_price` integer;
ALTER TABLE `posts` ADD `appraised_at` integer;

-- 운영진 중개: the trade record of a post the manager brokered between the same two members.
ALTER TABLE `trades` ADD `brokered` integer NOT NULL DEFAULT 0;

-- A trade record written after the manager completed a 중개 on that post between its two members is
-- marked too, whichever Worker writes it.
CREATE TRIGGER IF NOT EXISTS `trades_brokered_on_insert` AFTER INSERT ON `trades`
WHEN EXISTS (SELECT 1 FROM `service_requests` r WHERE r.`kind` = 'broker' AND r.`status` = 'done' AND r.`post_id` = NEW.`post_id`
    AND ((r.`user_id` = NEW.`seller_id` AND r.`partner_id` = NEW.`buyer_id`) OR (r.`user_id` = NEW.`buyer_id` AND r.`partner_id` = NEW.`seller_id`)))
BEGIN
    UPDATE `trades` SET `brokered` = 1 WHERE `id` = NEW.`id`;
END;
