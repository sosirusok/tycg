-- 거래 후기 review fixes. A trade the post author records counts only once the other member confirms
-- it by leaving their own 후기 (trades.confirmed_at); until then the author cannot review them either.
-- trades.author_id is who recorded it (rows without one predate this step and count as confirmed).
-- The manager removes a 후기 or a whole trade by stamping removed_at instead of deleting the row, so
-- UNIQUE(post_id) and UNIQUE(trade_id,author_id) still stop a second trade or a rewritten 후기;
-- removed rows leave every count and list. Only nullable columns, so the previous Worker keeps
-- working while this migration is live: it never reads or writes these tables.
ALTER TABLE `trades` ADD `author_id` text;
ALTER TABLE `trades` ADD `confirmed_at` integer;
ALTER TABLE `trades` ADD `removed_at` integer;
ALTER TABLE `reviews` ADD `removed_at` integer;
