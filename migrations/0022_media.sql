-- Photos at cafe scale (WP45, decisions item 6). Additive only: posts, uploads and reports columns with
-- NULL or a default, two new tables, indexes, triggers and backfills sized by the uploads. The previous
-- Worker never reads the new columns or tables; its upload inserts, cleanup deletes and post deletes
-- still go through the triggers, so the site totals and the delete hold stay right while it serves.

-- The inline list thumbnail (a 176px WebP data URI of the 대표 photo, ≤ 6,000 chars) and 조회수.
ALTER TABLE `posts` ADD `thumb` text;
ALTER TABLE `posts` ADD `view_count` integer DEFAULT 0 NOT NULL;
-- The daily cleanup clears old thumbnails through this index (only rows that still hold one).
CREATE INDEX IF NOT EXISTS `posts_thumb` ON `posts` (`bumped_at`) WHERE thumb IS NOT NULL;

-- KV keys waiting to be deleted under the daily KV delete budget (settings 'sys:kv_deletes').
CREATE TABLE IF NOT EXISTS `kv_trash` (
    `id` text PRIMARY KEY NOT NULL,
    `created_at` integer NOT NULL
) WITHOUT ROWID;

-- A deleted post's photos are kept for the manager until keep_until (30 days); the unused-photo
-- cleanup skips them until then.
ALTER TABLE `uploads` ADD `keep_until` integer;
-- Photos the R2 mover still has to copy (KV rows first, then D1).
CREATE INDEX IF NOT EXISTS `uploads_movable` ON `uploads` (`storage`, `id`) WHERE storage IN ('d1', 'kv');

-- The photos of a reported post, kept on the report when the post is deleted, so the manager can still
-- look at them from 신고 while the uploads are held.
ALTER TABLE `reports` ADD `post_images` text;
CREATE INDEX IF NOT EXISTS `reports_post` ON `reports` (`post_id`) WHERE post_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS `posts_delete_hold` BEFORE DELETE ON `posts`
WHEN OLD.`images` != '[]'
BEGIN
    UPDATE `uploads` SET `keep_until` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 2592000000
    WHERE `id` IN (SELECT `value` FROM json_each(OLD.`images`));
    UPDATE `reports` SET `post_images` = OLD.`images` WHERE `post_id` = OLD.`id`;
END;

-- Site photo totals per storage ('r2', 'kv', 'd1'), kept by triggers, so an upload reads one row per
-- storage instead of summing every upload of the site.
CREATE TABLE IF NOT EXISTS `upload_totals` (
    `storage` text PRIMARY KEY NOT NULL,
    `bytes` integer DEFAULT 0 NOT NULL,
    `rows` integer DEFAULT 0 NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS `upload_totals_insert` AFTER INSERT ON `uploads`
BEGIN
    INSERT INTO `upload_totals` (`storage`, `bytes`, `rows`) VALUES (NEW.`storage`, NEW.`size`, 1)
    ON CONFLICT (`storage`) DO UPDATE SET `bytes` = `bytes` + excluded.`bytes`, `rows` = `rows` + 1;
END;

CREATE TRIGGER IF NOT EXISTS `upload_totals_delete` AFTER DELETE ON `uploads`
BEGIN
    UPDATE `upload_totals` SET `bytes` = MAX(0, `bytes` - OLD.`size`), `rows` = MAX(0, `rows` - 1) WHERE `storage` = OLD.`storage`;
END;

CREATE TRIGGER IF NOT EXISTS `upload_totals_update` AFTER UPDATE OF `size`, `storage` ON `uploads`
BEGIN
    UPDATE `upload_totals` SET `bytes` = MAX(0, `bytes` - OLD.`size`), `rows` = MAX(0, `rows` - 1) WHERE `storage` = OLD.`storage`;
    INSERT INTO `upload_totals` (`storage`, `bytes`, `rows`) VALUES (NEW.`storage`, NEW.`size`, 1)
    ON CONFLICT (`storage`) DO UPDATE SET `bytes` = `bytes` + excluded.`bytes`, `rows` = `rows` + 1;
END;

-- The triggers exist before the backfill, and the backfill writes absolute values, so an upload that
-- lands while this runs is counted once either way.
INSERT INTO `upload_totals` (`storage`, `bytes`, `rows`)
SELECT `storage`, COALESCE(SUM(`size`), 0), COUNT(*) FROM `uploads` WHERE true GROUP BY `storage`
ON CONFLICT (`storage`) DO UPDATE SET `bytes` = excluded.`bytes`, `rows` = excluded.`rows`;
