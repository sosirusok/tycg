-- Photo totals per member (WP40 review). Additive only: two users columns with defaults, three
-- triggers and a one-time backfill. The upload check reads these two numbers instead of counting and
-- summing every upload row of the member on each upload (the Free plan's read budget), and the R2
-- per-member quota (1GB, tier table) uses upload_bytes. The previous Worker never reads the columns;
-- its upload inserts and cleanup deletes still go through the triggers, so the totals stay right while
-- it serves.
ALTER TABLE `users` ADD `upload_bytes` integer DEFAULT 0 NOT NULL;
ALTER TABLE `users` ADD `upload_rows` integer DEFAULT 0 NOT NULL;

CREATE TRIGGER `uploads_totals_insert` AFTER INSERT ON `uploads`
BEGIN
    UPDATE `users` SET `upload_bytes` = `upload_bytes` + NEW.`size`, `upload_rows` = `upload_rows` + 1 WHERE `id` = NEW.`owner_id`;
END;

CREATE TRIGGER `uploads_totals_delete` AFTER DELETE ON `uploads`
BEGIN
    UPDATE `users` SET `upload_bytes` = MAX(0, `upload_bytes` - OLD.`size`), `upload_rows` = MAX(0, `upload_rows` - 1) WHERE `id` = OLD.`owner_id`;
END;

CREATE TRIGGER `uploads_totals_update` AFTER UPDATE OF `size`, `owner_id` ON `uploads`
BEGIN
    UPDATE `users` SET `upload_bytes` = MAX(0, `upload_bytes` - OLD.`size`), `upload_rows` = MAX(0, `upload_rows` - 1) WHERE `id` = OLD.`owner_id`;
    UPDATE `users` SET `upload_bytes` = `upload_bytes` + NEW.`size`, `upload_rows` = `upload_rows` + 1 WHERE `id` = NEW.`owner_id`;
END;

-- The triggers exist before the backfill, and the backfill writes absolute values, so an upload that
-- lands while this runs is counted once either way.
UPDATE `users` SET
    `upload_bytes` = COALESCE((SELECT SUM(`size`) FROM `uploads` WHERE `owner_id` = `users`.`id`), 0),
    `upload_rows` = (SELECT COUNT(*) FROM `uploads` WHERE `owner_id` = `users`.`id`)
WHERE EXISTS(SELECT 1 FROM `uploads` WHERE `owner_id` = `users`.`id`);
