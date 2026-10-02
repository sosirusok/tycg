-- 자동 가격 내리기 (WP56). Additive only: one column (NULL for every existing row) and two partial
-- indexes. The settings (automation.drop_step, drop_pct, drop_every_h, decline_on) and the per-post
-- setup (post_auto.drop_on, drop_floor, drop_next_at, drop_count, drop_set_at) came with 0028 and were
-- never written by the previous Worker, so it keeps serving unchanged while this rolls out.

-- When the tick last looked at the setup (a drop or a hold). A 제시 or a chat message from another
-- member after this time holds the next drop; NULL means since drop_set_at (the switch).
ALTER TABLE `post_auto` ADD `drop_checked_at` integer;

-- The tick's due setups, earliest first.
CREATE INDEX IF NOT EXISTS `post_auto_drop_due` ON `post_auto` (`drop_next_at`) WHERE `drop_on` = 1;
-- A member's running setups, newest switch first (the allowance after a lower grade, and the 5-post check).
CREATE INDEX IF NOT EXISTS `post_auto_drop_user` ON `post_auto` (`user_id`, `drop_set_at`) WHERE `drop_on` = 1;
