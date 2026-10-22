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
