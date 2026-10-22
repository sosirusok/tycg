-- 계정 정리 (the owner's request, 2026-10-22): members sign in with 네이버 로그인 only, so every account without a
-- Naver link (naver_id IS NULL: old ID/password accounts never linked, and withdrawn members) is deleted with
-- everything it made, and the manager account starts empty: its row, role, username (sosirusok) and password
-- stay; its bio, photo, Naver link, phone hash, 회원 정보 and all its content go. Members with a Naver link stay,
-- less what they shared with those accounts (their chats with them, 댓글 and 제시 on their posts). Notices and
-- settings stay. Children go before parents, so every statement holds with foreign keys on.
--
-- The accounts whose content goes (W): (SELECT id FROM users WHERE naver_id IS NULL OR role='manager').
-- Their posts (P): (SELECT id FROM posts WHERE author_id IN W). Their chats (C): (SELECT id FROM conversations
-- WHERE user_a IN W OR user_b IN W). The deleted accounts are W without the manager.
--
-- Photos in KV wait in kv_trash for the daily cleanup, as a removed upload's do.
INSERT OR IGNORE INTO `kv_trash` (`id`, `created_at`)
SELECT `id`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM `uploads`
WHERE `storage` = 'kv' AND `owner_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
-- 제시 (offers.conversation_id, sender_id and recipient_id do not cascade).
DELETE FROM `offers`
WHERE `sender_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `recipient_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'))
    OR `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `user_a` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager') OR `user_b` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
-- 신고 by or about them: filed by them, naming them, on their posts, chats or 댓글.
DELETE FROM `reports`
WHERE `reporter_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `target_user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'))
    OR `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `user_a` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager') OR `user_b` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'))
    OR `comment_id` IN (SELECT `id` FROM `comments` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
        OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')));
-- 댓글: the 답글 under their 댓글 first (a 답글 without its 댓글 never shows), then theirs and every 댓글 on their posts.
DELETE FROM `comments`
WHERE `parent_id` IN (SELECT `id` FROM `comments` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `comments`
WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
-- 거래 기록, 후기 and the trade log.
DELETE FROM `reviews`
WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `target_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `trades`
WHERE `seller_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `buyer_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `trade_log`
WHERE `actor_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `target_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `service_requests`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `partner_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
-- 알림: theirs, about their posts, and those a deleted account caused (the manager's grants to members stay).
DELETE FROM `notifications`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'))
    OR `actor_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL AND `role` != 'manager');
-- Post traces without a cascade (같은 매물 prints, post events, hourly views).
DELETE FROM `post_prints`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `post_events`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `post_views`
WHERE `post_id` IN (SELECT `id` FROM `posts` WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
-- Chats they are in, with every message (message_images cascade; applications.conversation_id becomes NULL).
DELETE FROM `messages`
WHERE `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `user_a` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager') OR `user_b` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager'));
DELETE FROM `conversations`
WHERE `user_a` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `user_b` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
-- Their posts (post_auto, favorites, history, tags, seasons, images, price history cascade).
DELETE FROM `posts`
WHERE `author_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
-- Everything kept per account.
DELETE FROM `sessions` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `favorites` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `history` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `drafts` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `saved_searches` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `follows`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `target_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `blocks`
WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager')
    OR `target_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `user_badges` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `user_grades` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `applications` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `automation` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `post_auto` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `push_subscriptions` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `push_queue` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `provider_profiles` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `sanctions` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `pii_grants` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `uploads` WHERE `owner_id` IN (SELECT `id` FROM `users` WHERE `naver_id` IS NULL OR `role` = 'manager');
DELETE FROM `reset_requests` WHERE `username` IN (SELECT `username` FROM `users` WHERE `naver_id` IS NULL AND `role` != 'manager');
-- The manager row stays with its role, username and password; the rest of its profile is cleared.
UPDATE `users` SET `bio` = '', `avatar_id` = NULL, `avatar_thumb` = NULL, `naver_id` = NULL, `naver_linked_at` = NULL, `phone_hash` = NULL, `pii` = NULL
WHERE `role` = 'manager';
-- The accounts themselves.
DELETE FROM `users` WHERE `naver_id` IS NULL AND `role` != 'manager';
