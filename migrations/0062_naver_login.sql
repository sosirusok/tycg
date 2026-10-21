-- 네이버 로그인: members sign in with their Naver account. naver_id is the per-app user id from
-- /v1/nid/me (response.id); naver_linked_at is when it was linked (a new sign-up or 기존 계정 연결).
-- Additive only: two nullable columns and a partial unique index, so the previous Worker keeps working.
ALTER TABLE `users` ADD `naver_id` text;
ALTER TABLE `users` ADD `naver_linked_at` integer;
CREATE UNIQUE INDEX IF NOT EXISTS `users_naver_id_unique` ON `users` (`naver_id`) WHERE `naver_id` IS NOT NULL;
