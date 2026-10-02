-- 웹 푸시 (WP64). Additive only: two new tables, their indexes and one trigger. The previous Worker never
-- reads or writes the tables, and the trigger queues a push only for a member with a subscription, which
-- only this Worker creates, so the queue stays empty while the previous Worker still serves.

-- One row per browser that turned on '알림 켜기'. endpoint is the push service address of that browser;
-- p256dh and auth are kept as the browser sent them (the pushes carry no payload, so they are not used).
-- A 404 or 410 from the push service deletes the row; other failures count up, and the 5th deletes it.
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`endpoint` text NOT NULL UNIQUE,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`fail_count` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
CREATE INDEX `push_user` ON `push_subscriptions` (`user_id`);

-- Members waiting for a push from tick B (worker/push.ts pushJob), oldest first. One row per member: the
-- service worker shows the newest unread 알림 or chat, so one push covers every 알림 that came meanwhile.
CREATE TABLE `push_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `push_queue_created` ON `push_queue` (`created_at`);
CREATE UNIQUE INDEX `push_queue_user` ON `push_queue` (`user_id`);

-- The 알림 that reach many members at once go through the queue: 키워드 알림 (keyword), 판매자 구독
-- (follow), 조건 알림 (condition), 자동 매칭 (match), 찜 가격 내림 (fav_price), 끌올 가능 (bump_ready),
-- 같은 매물 (same_listing), the weekly 자동 끌올 check (auto_stale) and the 플러스 무료 체험 reminders
-- (grade_end rows whose ref ends in ':soon' or ':end'). 게시판 새 글 알림 (board) never pushes. 채팅, 제시,
-- 댓글 and 답글 are pushed right after their request instead (worker/push.ts pushAfter).
-- A row is only written for a member with a subscription, and only one per member (INSERT OR IGNORE).
CREATE TRIGGER `notifications_push` AFTER INSERT ON `notifications`
WHEN NEW.`type` IN ('keyword','follow','condition','match','fav_price','bump_ready','same_listing','auto_stale')
	OR (NEW.`type`='grade_end' AND (NEW.`ref` LIKE '%:soon' OR NEW.`ref` LIKE '%:end'))
BEGIN
	INSERT OR IGNORE INTO `push_queue`(`user_id`,`created_at`)
		SELECT NEW.`user_id`,NEW.`created_at` WHERE EXISTS(SELECT 1 FROM `push_subscriptions` WHERE `user_id`=NEW.`user_id`);
END;
