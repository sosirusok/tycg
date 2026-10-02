-- 자동 끌올 and the automation settings (WP52). Additive only: two new tables, two columns with
-- defaults, indexes and guarded backfills sized by members with a grade and their open posts. The
-- previous Worker never reads the new tables or columns, so it keeps serving while this rolls out (its
-- new posts get touched_at NULL, which the new Worker reads as updated_at).

-- One row per member who has (or had) a paid grade or the 플러스 체험, plus the manager's own row
-- (made on first use, off). The row stays when a grade ends, so the settings come back with the next
-- grant. bump_next_at is when the tick looks at the member next (NULL: parked until a grant, a visit
-- or the switch wakes it). pause_reason is the last tick's state: '' running, 'away' (no visit for
-- 3 or 7 days), 'reply' (2 or more members waiting for a reply), 'busy' (the board was full),
-- 'idle' (no post off page 1), 'wallet' (2 or fewer 끌올 left). paused_at is set for 'away' and 'reply'.
-- auto_today counts this window's auto bumps for the fair share (reset by the daily cron).
-- templates … drop_every_h are for the later automation packages (quick replies, first reply, away
-- reply, matching, decline, price drop) and are not read yet.
CREATE TABLE IF NOT EXISTS `automation` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`bump_on` integer NOT NULL DEFAULT 1,
	`bump_new` integer NOT NULL DEFAULT 0,
	`bump_next_at` integer,
	`paused_at` integer,
	`pause_reason` text NOT NULL DEFAULT '',
	`auto_today` integer NOT NULL DEFAULT 0,
	`templates` text NOT NULL DEFAULT '[]',
	`first_on` integer NOT NULL DEFAULT 0,
	`first_text` text NOT NULL DEFAULT '',
	`away_on` integer NOT NULL DEFAULT 0,
	`away_from` integer,
	`away_to` integer,
	`away_text` text NOT NULL DEFAULT '',
	`away_until` integer,
	`match_on` integer NOT NULL DEFAULT 0,
	`decline_on` integer NOT NULL DEFAULT 0,
	`drop_step` integer,
	`drop_pct` integer,
	`drop_every_h` integer,
	`updated_at` integer NOT NULL DEFAULT 0
);
-- The tick's due members, oldest due first (members paused for 'away' leave the index until a visit).
CREATE INDEX IF NOT EXISTS `automation_due` ON `automation` (`bump_next_at`) WHERE `bump_on` = 1 AND `pause_reason` != 'away';

-- Per-post automation. bump=1: the post is in the member's 자동 끌올 list. bump_remind: when the
-- '끌올 가능' 알림 is due (0: none), for every grade. drop_* and match are for the later packages.
CREATE TABLE IF NOT EXISTS `post_auto` (
	`post_id` integer PRIMARY KEY NOT NULL REFERENCES `posts`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL,
	`bump` integer NOT NULL DEFAULT 0,
	`bump_remind` integer NOT NULL DEFAULT 0,
	`drop_on` integer NOT NULL DEFAULT 0,
	`drop_floor` integer,
	`drop_next_at` integer,
	`drop_count` integer NOT NULL DEFAULT 0,
	`drop_set_at` integer,
	`match` integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS `post_auto_user` ON `post_auto` (`user_id`) WHERE `bump` = 1;
CREATE INDEX IF NOT EXISTS `post_auto_remind` ON `post_auto` (`bump_remind`) WHERE `bump_remind` > 0;

-- Auto bumps are marked, so the per-tab cap tells them from new posts and manual 끌올. The cap reads
-- the last hour of events by time.
ALTER TABLE `post_events` ADD `auto` integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS `post_events_created` ON `post_events` (`created_at`);

-- The last time the author did something with the post (written, edited, 끌올, price change, a chat
-- message about it, '계속'). Auto bump skips posts untouched for 7 days.
ALTER TABLE `posts` ADD `touched_at` integer;
UPDATE `posts` SET `touched_at` = `updated_at` WHERE `status` != 'closed';

-- Current paid members and running trials get their row (on, due now; 새 글 자동 포함 on for 엘리트
-- and 관리자) and their most recently bumped open posts in the list: 플러스 1, 프리미엄 5, 엘리트 and
-- 관리자 all of them.
INSERT OR IGNORE INTO `automation` (`user_id`, `bump_on`, `bump_new`, `bump_next_at`, `updated_at`)
SELECT g.`user_id`, 1, CASE WHEN MAX(g.`rank`) >= 3 THEN 1 ELSE 0 END,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM `user_grades` g JOIN `users` u ON u.`id` = g.`user_id`
WHERE g.`rank` >= 1 AND (g.`expires_at` IS NULL OR g.`expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    AND u.`deleted_at` IS NULL AND u.`role` != 'manager'
GROUP BY g.`user_id`;

INSERT OR IGNORE INTO `post_auto` (`post_id`, `user_id`, `bump`)
SELECT x.`id`, x.`author_id`, 1 FROM (
    SELECT p.`id`, p.`author_id`, r.`rank`, ROW_NUMBER() OVER (PARTITION BY p.`author_id` ORDER BY p.`bumped_at` DESC, p.`id` DESC) AS rn
    FROM `posts` p JOIN (
        SELECT g.`user_id`, MAX(g.`rank`) AS `rank` FROM `user_grades` g
        WHERE g.`rank` >= 1 AND (g.`expires_at` IS NULL OR g.`expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
        GROUP BY g.`user_id`
    ) r ON r.`user_id` = p.`author_id`
    JOIN `automation` a ON a.`user_id` = p.`author_id`
    WHERE p.`status` != 'closed' AND p.`hidden` = 0
) x WHERE x.rn <= CASE WHEN x.`rank` >= 3 THEN 1000000 WHEN x.`rank` = 2 THEN 5 ELSE 1 END;
