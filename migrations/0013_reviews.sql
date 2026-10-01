-- 거래 후기 and a verified trade count (WP23). After a post is set to 거래완료 its author names the
-- member they traded with (one trade per post); both of them may then leave one 후기 within 30 days.
-- The trade count on a profile is the number of trades the member took part in as seller or buyer.
-- trades.post_id has no foreign key, so deleting the post keeps the trade and its 후기 (the count
-- stays honest). Only new tables and indexes, so the previous Worker keeps working while this
-- migration is live: it never reads or writes them.
CREATE TABLE `trades` (
    `id` text PRIMARY KEY,
    `post_id` integer NOT NULL UNIQUE,
    `seller_id` text NOT NULL,
    `buyer_id` text NOT NULL,
    `price` integer,
    `created_at` integer NOT NULL
);
CREATE TABLE `reviews` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `trade_id` text NOT NULL REFERENCES `trades`(`id`) ON DELETE cascade,
    `author_id` text NOT NULL,
    `target_id` text NOT NULL,
    `good` integer NOT NULL,
    `tags` text NOT NULL DEFAULT '[]',
    `text` text NOT NULL DEFAULT '',
    `created_at` integer NOT NULL,
    UNIQUE (`trade_id`, `author_id`)
);
CREATE INDEX `reviews_target` ON `reviews` (`target_id`, `created_at`);
-- The trade count reads both sides, and a chat reads the trades between its two members.
CREATE INDEX `trades_seller` ON `trades` (`seller_id`, `buyer_id`);
CREATE INDEX `trades_buyer` ON `trades` (`buyer_id`, `seller_id`);
