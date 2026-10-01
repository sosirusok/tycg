-- R3 step 2 review fixes. Additive only: BEFORE triggers next to the 0021 print triggers, a kv_trash
-- column with a default and two triggers, a trades column with a default, a partial index, and a repair
-- of post images that are not valid JSON. The previous Worker reads none of the new columns; its
-- deletes, completions and KV trash rows go through the new triggers while it serves.

-- 같은 매물: the place a gone listing held. 0021 stored created_at for a post never bumped, but a post
-- the wallet-empty allowance placed below other posts (bumped_at < created_at, bump_count 0) held that
-- lower place, and a relist inside the gap then came back near the top for free. The place is now
-- MIN(created_at, bumped_at) for such a post (a '새 글 우선' post, 1 hour ahead, still gives
-- created_at). These BEFORE triggers stamp the print first, so the 0021 AFTER triggers, which only touch
-- a print whose gone_at is still NULL, leave it alone. A post whose bumped_at the previous Worker left
-- at 0 keeps created_at.
CREATE TRIGGER IF NOT EXISTS `post_prints_deleted_place` BEFORE DELETE ON `posts`
BEGIN
    UPDATE `post_prints` SET
        `gone_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        `anchor_at` = CASE
            WHEN OLD.`bump_count` = 0 AND OLD.`bumped_at` > 0 THEN MIN(OLD.`created_at`, OLD.`bumped_at`)
            WHEN OLD.`bump_count` = 0 THEN OLD.`created_at`
            ELSE MIN(OLD.`bumped_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) END,
        `hidden` = OLD.`hidden`,
        `hidden_reason` = OLD.`hidden_reason`
    WHERE `post_id` = OLD.`id` AND `gone_at` IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS `post_prints_closed_place` BEFORE UPDATE OF `status` ON `posts`
WHEN NEW.`status` = 'closed' AND OLD.`status` IS NOT 'closed'
BEGIN
    UPDATE `post_prints` SET
        `gone_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        `anchor_at` = CASE
            WHEN NEW.`bump_count` = 0 AND NEW.`bumped_at` > 0 THEN MIN(NEW.`created_at`, NEW.`bumped_at`)
            WHEN NEW.`bump_count` = 0 THEN NEW.`created_at`
            ELSE MIN(NEW.`bumped_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) END,
        `hidden` = NEW.`hidden`,
        `hidden_reason` = NEW.`hidden_reason`
    WHERE `post_id` = NEW.`id` AND `gone_at` IS NULL;
END;

-- KV keys waiting in kv_trash still use KV space. Each row keeps the photo's size (looked up while the
-- uploads row still exists: every path inserts the trash row before deleting or moving the upload), and
-- upload_totals 'kv_trash' sums them, so the KV site guard counts them.
ALTER TABLE `kv_trash` ADD `size` integer DEFAULT 0 NOT NULL;

CREATE TRIGGER IF NOT EXISTS `kv_trash_insert` AFTER INSERT ON `kv_trash`
BEGIN
    UPDATE `kv_trash` SET `size` = COALESCE((SELECT `size` FROM `uploads` WHERE `id` = NEW.`id`), 0) WHERE `id` = NEW.`id`;
    INSERT INTO `upload_totals` (`storage`, `bytes`, `rows`) VALUES ('kv_trash', COALESCE((SELECT `size` FROM `uploads` WHERE `id` = NEW.`id`), 0), 1)
    ON CONFLICT (`storage`) DO UPDATE SET `bytes` = `bytes` + excluded.`bytes`, `rows` = `rows` + 1;
END;

CREATE TRIGGER IF NOT EXISTS `kv_trash_delete` AFTER DELETE ON `kv_trash`
BEGIN
    UPDATE `upload_totals` SET `bytes` = MAX(0, `bytes` - OLD.`size`), `rows` = MAX(0, `rows` - 1) WHERE `storage` = 'kv_trash';
END;

-- Rows already waiting have no known size (their uploads are gone): they are counted as rows only.
INSERT INTO `upload_totals` (`storage`, `bytes`, `rows`)
SELECT 'kv_trash', 0, COUNT(*) FROM `kv_trash` WHERE true
ON CONFLICT (`storage`) DO UPDATE SET `rows` = excluded.`rows`;

-- 거금 backing that came from the partner's accepted 제시 (capped), shown apart in MemberPanel.
ALTER TABLE `trades` ADD `backing_offer` integer DEFAULT 0 NOT NULL;

-- 사용량 '어제 같은 매물 다시 등록' counts relists of one day without scanning every post.
CREATE INDEX IF NOT EXISTS `posts_relist_created` ON `posts` (`created_at`) WHERE relist = 1;

-- posts_delete_hold (0022) and the photo retention read posts.images with json_each and
-- json_array_length, which fail on text that is not JSON (0006 guarded against such rows). The Worker
-- always writes JSON arrays, so any such row is a leftover; it becomes '[]' so it can still be deleted.
UPDATE `posts` SET `images` = '[]' WHERE NOT json_valid(`images`);
