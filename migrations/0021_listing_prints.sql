-- 같은 매물 and the new-post allowance (WP44, decisions item 1a). Additive only: three uploads columns,
-- one posts column with a default, a new table without foreign keys, indexes, two triggers and a
-- backfill sized by the open posts. The previous Worker never reads the new columns or the table; its
-- deletes and completions still stamp post_prints through the triggers while it serves.

-- Photo hashes the browser sends (advisory: X-Photo-Hash '<compressed>,<original>', SHA-256 hex) and the
-- last time a lookup reused the photo (the unused-photo cleanup counts from it).
ALTER TABLE `uploads` ADD `hash` text;
ALTER TABLE `uploads` ADD `src_hash` text;
ALTER TABLE `uploads` ADD `touched_at` integer;
-- One upload per original per member, so picking the same photo again reuses the stored one.
CREATE UNIQUE INDEX IF NOT EXISTS `uploads_owner_src` ON `uploads` (`owner_id`, `src_hash`) WHERE src_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS `uploads_hash` ON `uploads` (`hash`) WHERE hash IS NOT NULL;
-- The cross-account check also looks up originals across members.
CREATE INDEX IF NOT EXISTS `uploads_src_hash` ON `uploads` (`src_hash`) WHERE src_hash IS NOT NULL;

-- A post written as a 끌올 of a listing the author completed or deleted within 7 days.
ALTER TABLE `posts` ADD `relist` integer DEFAULT 0 NOT NULL;

-- One row per post: the title key, the canonical listing fields (shared/listing.ts), up to 12 photo
-- keys, and once the post is completed or deleted, when (gone_at), its place (anchor_at) and whether the
-- manager had hidden it. Rows outlive the post (no foreign key) and are removed 7 days after gone_at.
CREATE TABLE IF NOT EXISTS `post_prints` (
    `post_id` integer PRIMARY KEY,
    `user_id` text NOT NULL,
    `kind` text NOT NULL,
    `category` text NOT NULL,
    `title_key` text DEFAULT '' NOT NULL,
    `fields` text,
    `fields_hash` text,
    `photos` text DEFAULT '[]' NOT NULL,
    `anchor_at` integer,
    `hidden` integer DEFAULT 0 NOT NULL,
    `hidden_reason` text DEFAULT '' NOT NULL,
    `gone_at` integer
);
CREATE INDEX IF NOT EXISTS `post_prints_user` ON `post_prints` (`user_id`, `kind`, `post_id`);
CREATE INDEX IF NOT EXISTS `post_prints_fields` ON `post_prints` (`fields_hash`) WHERE fields_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS `post_prints_gone` ON `post_prints` (`gone_at`) WHERE gone_at IS NOT NULL;
-- Rows the daily cleanup still has to fill (backfilled rows, fields NULL).
CREATE INDEX IF NOT EXISTS `post_prints_unfilled` ON `post_prints` (`post_id`) WHERE fields IS NULL;

-- A deleted post keeps its print: when it went, its place (created_at before any 끌올, else the last
-- 끌올 time, never in the future) and the manager's hiding. A print already gone (completed, then
-- deleted) keeps its first gone_at.
CREATE TRIGGER IF NOT EXISTS `post_prints_deleted` AFTER DELETE ON `posts`
BEGIN
    UPDATE `post_prints` SET
        `gone_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        `anchor_at` = CASE WHEN OLD.`bump_count` = 0 THEN OLD.`created_at` ELSE MIN(OLD.`bumped_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) END,
        `hidden` = OLD.`hidden`,
        `hidden_reason` = OLD.`hidden_reason`
    WHERE `post_id` = OLD.`id` AND `gone_at` IS NULL;
END;
-- The same when a post is completed (완료 is final, so this fires once per post).
CREATE TRIGGER IF NOT EXISTS `post_prints_closed` AFTER UPDATE OF `status` ON `posts`
WHEN NEW.`status` = 'closed' AND OLD.`status` IS NOT 'closed'
BEGIN
    UPDATE `post_prints` SET
        `gone_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        `anchor_at` = CASE WHEN NEW.`bump_count` = 0 THEN NEW.`created_at` ELSE MIN(NEW.`bumped_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) END,
        `hidden` = NEW.`hidden`,
        `hidden_reason` = NEW.`hidden_reason`
    WHERE `post_id` = NEW.`id` AND `gone_at` IS NULL;
END;

-- Open posts get a print now; their fields and photo keys are filled by the daily cleanup (fields NULL
-- until then, so only the title can match them meanwhile).
INSERT OR IGNORE INTO `post_prints` (`post_id`, `user_id`, `kind`, `category`, `title_key`, `fields`)
SELECT `id`, `author_id`, `kind`, `category`, `title_key`, NULL FROM `posts` WHERE `status` != 'closed';
