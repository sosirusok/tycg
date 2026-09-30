-- Why the manager hid a post. Only its author and the manager see it; unhiding clears it.
ALTER TABLE `posts` ADD `hidden_reason` text DEFAULT '' NOT NULL;

-- Price history now holds only strictly falling prices above the current one, so
-- edits 60, 50, 40 show ~~60~~ ~~50~~ 40 and a later rise drops the entries it passes.
-- Entries at or below the current price go first, then any entry followed by an equal or higher one.
DELETE FROM `post_price_history`
WHERE `price` <= (SELECT `price` FROM `posts` WHERE `posts`.`id` = `post_price_history`.`post_id`);

DELETE FROM `post_price_history`
WHERE EXISTS (
    SELECT 1 FROM `post_price_history` h2
    WHERE h2.`post_id` = `post_price_history`.`post_id` AND h2.`id` > `post_price_history`.`id` AND h2.`price` >= `post_price_history`.`price`
);
