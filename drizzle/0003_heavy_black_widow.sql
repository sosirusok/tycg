CREATE TABLE `post_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`price` integer NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_history_post` ON `post_price_history` (`post_id`,`id`);
--> statement-breakpoint
-- Preserve old listings while moving proxy work out of buy/sell subcategories.
UPDATE posts SET kind = CASE WHEN kind = 'buy' THEN 'proxy_request' ELSE 'proxy_offer' END,
    category = CASE
        WHEN instr(details, '이벤트') > 0 THEN 'event'
        WHEN instr(details, '스토리') > 0 OR instr(details, '재화') > 0 THEN 'story'
        ELSE 'ladder' END
WHERE category = 'service';
--> statement-breakpoint
UPDATE posts SET category = 'goods_coupon' WHERE category IN ('goods', 'coupon');
--> statement-breakpoint
UPDATE posts SET category = 'other' WHERE category = 'duo';
--> statement-breakpoint
-- A historic '2대 이상' cannot be converted into an exact count.
UPDATE posts SET details = json_set(details, '$.ownerCount', '1')
WHERE category = 'account' AND kind != 'buy' AND json_extract(details, '$.firstOwner') = '1대 주인'
    AND json_extract(details, '$.ownerCount') IS NULL;
--> statement-breakpoint
-- Legacy purchase nickname fields were requirements, so carry them into ranges.
UPDATE posts SET details = json_set(details,
    '$.nicknameCharsMin', json_extract(details, '$.nicknameChars'),
    '$.nicknameCharsMax', json_extract(details, '$.nicknameChars'))
WHERE category = 'account' AND kind = 'buy' AND json_extract(details, '$.nicknameChars') IS NOT NULL;
--> statement-breakpoint
UPDATE posts SET details = json_set(details, '$.nicknameRanks', substr(json_array(json_extract(details, '$.nicknameRank')), 1))
WHERE category = 'account' AND kind = 'buy' AND json_extract(details, '$.nicknameRank') IN ('R', 'S', 'A', 'B', '잡');
--> statement-breakpoint
UPDATE posts SET details = json_set(details, '$.maxOwners', '1')
WHERE category = 'account' AND kind = 'buy' AND json_extract(details, '$.firstOwner') = '1대 주인';
--> statement-breakpoint
UPDATE posts SET details = json_remove(details, '$.level', '$.labLevel', '$.humanSkins', '$.zombieSkins',
    '$.gas', '$.minerals', '$.ownerCount', '$.currentOffer', '$.nicknameChars', '$.nicknameRank',
    '$.firstOwner', '$.integrated', '$.passwordChange', '$.phoneChange', '$.recordStatus', '$.ownership',
    '$.accountType', '$.emblems', '$.rides', '$.progress', '$.joined', '$.rareSkins')
WHERE category = 'account' AND kind = 'buy';
