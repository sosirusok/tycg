-- 같은 휴대전화번호 중복 가입 방지: phone_hash is an HMAC-SHA256 (PHONE_HASH_KEY) of the member's
-- normalized Naver mobile number (01012345678). The number itself is never stored. Not unique: accounts
-- made before this change may share a number; only new sign-ups are refused.
ALTER TABLE `users` ADD `phone_hash` text;
CREATE INDEX IF NOT EXISTS `users_phone_hash` ON `users` (`phone_hash`) WHERE `phone_hash` IS NOT NULL;
