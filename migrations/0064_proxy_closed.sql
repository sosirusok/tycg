-- 대리 카테고리 종료 (2026-10-22): 대리 게임 (playing another member's account for pay) and its 알선 are against
-- 게임산업진흥법 제32조 제1항 제11호, so the 대리(구함)·대리(진행) boards (posts.kind proxy_request, proxy_offer) and
-- 대리 인증 (user_badges.badge 'proxy') end. Additive and safe while the previous Worker still serves: nothing
-- is deleted or renamed. The new Worker refuses new posts, edits, 끌올 and 광고 of those kinds and lists none
-- of them (listedKind), also one the previous Worker writes during the deploy.
--
-- Every visible post of a retired kind is hidden; its author and the manager see why. A post hidden before
-- keeps its own reason (탈퇴, a report reason). Such posts never had 제시 (only 판매 takes them).
UPDATE `posts` SET `hidden` = 1, `hidden_reason` = '대리 카테고리 종료'
WHERE `kind` IN ('proxy_request', 'proxy_offer') AND `hidden` = 0;
-- 자동 끌올 and a waiting '끌올 가능' 알림 stop for them (the switches stay off; nothing turns them on again).
UPDATE `post_auto` SET `bump` = 0, `bump_remind` = 0
WHERE (`bump` != 0 OR `bump_remind` != 0) AND `post_id` IN (SELECT `id` FROM `posts` WHERE `kind` IN ('proxy_request', 'proxy_offer'));
-- Waiting 대리 인증 applications are cancelled (the chat card then reads 취소). The user_badges rows stay as the
-- manager's record; no screen shows them (BADGES has no 'proxy').
UPDATE `applications` SET `status` = 'cancelled', `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE `kind` = 'badge' AND `target` = 'proxy' AND `status` = 'pending';
-- Saved searches and 알림 of the retired boards end too: their names read '대리(진행) · …', they can never fire
-- (no new post has the kind) and they would keep using the member's 알림 and 20 saved-search room. Turning
-- one on again is refused ('게시판을 선택해 주세요.'), so they are removed.
DELETE FROM `saved_searches`
WHERE `alert_kind` IN ('proxy_request', 'proxy_offer')
    OR ('&' || `query` || '&') LIKE '%&kind=proxy_request&%' OR ('&' || `query` || '&') LIKE '%&kind=proxy_offer&%';
-- A chat's '문의한 글' card keeps the title it was written with (messages.body); for these posts it reads
-- neutrally (read through messages_listing).
UPDATE `messages` SET `body` = '종료된 분류의 글'
WHERE `type` = 'listing' AND `reference_id` IN (SELECT CAST(`id` AS TEXT) FROM `posts` WHERE `kind` IN ('proxy_request', 'proxy_offer'));
-- 알림함 rows about them (their text holds the title, or '대리(진행) · …') go; the 알림함 keeps 60 days anyway.
DELETE FROM `notifications` WHERE `post_id` IN (SELECT `id` FROM `posts` WHERE `kind` IN ('proxy_request', 'proxy_offer'));
