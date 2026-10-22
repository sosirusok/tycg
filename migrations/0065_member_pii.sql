-- 네이버 회원 정보: 제공 정보 회원이름, 연락처 이메일, 출생연도, 휴대전화번호 (all 필수 at 네이버 개발자센터). users.pii holds
-- them as one AES-GCM value (worker/pii.ts: key from PHONE_HASH_KEY by HKDF, info 'zg-pii-v1'), base64 of
-- iv|ciphertext of {name,email,birthyear,phone}; never plain text. Only GET me/info (the member), manage/info
-- (the manager) and member-info (a 관리자 the manager allowed, the allowed fields only) decrypt it. phone_hash
-- (0063) stays the 중복 가입 check. Additive: one nullable column and one new table.
ALTER TABLE `users` ADD `pii` text;
-- 관리자 열람 권한: which of the four fields a 관리자-grade member may see (a JSON array of 'name', 'email',
-- 'birthyear', 'phone'), set by the manager in 회원 정보. It reads only while the member holds the 관리자 grade.
CREATE TABLE IF NOT EXISTS `pii_grants` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`fields` text NOT NULL,
	`granted_at` integer NOT NULL
);
