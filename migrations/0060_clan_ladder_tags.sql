-- 클랜 래더 and 특징 태그 (WP70). Additive only: three new tables and their indexes. The previous Worker never
-- reads or writes them and deletes posts with a plain DELETE (the rows go with the post through the
-- foreign key), so it keeps serving unchanged during the rollout.
--
-- The clan's own ladder seasons: 판매, 구매 (the wanted ladder, as post_seasons holds a 구매 post's wishes)
-- and the offered side of 교환 on clan posts. tier is a clan tier (bronze … champion).
CREATE TABLE IF NOT EXISTS `post_clan_seasons` (
	`post_id` integer NOT NULL,
	`tier` text NOT NULL,
	`season` integer NOT NULL,
	PRIMARY KEY (`post_id`, `tier`, `season`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `post_clan_seasons_search` ON `post_clan_seasons` (`tier`, `season`);
-- The clan ladder a 교환 post wants in return ('클랜에서 클랜 구함', '계정에서 클랜 구함'), kept apart like
-- post_wanted_seasons, since a 클랜 ↔ 클랜 exchange has a clan ladder on both sides.
CREATE TABLE IF NOT EXISTS `post_wanted_clan_seasons` (
	`post_id` integer NOT NULL,
	`tier` text NOT NULL,
	`season` integer NOT NULL,
	PRIMARY KEY (`post_id`, `tier`, `season`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `post_wanted_clan_seasons_search` ON `post_wanted_clan_seasons` (`tier`, `season`);
-- 특징 태그 ('#불새상류'): a copy of details.featureTags for the board's '태그' filter and the most used tags.
CREATE TABLE IF NOT EXISTS `post_tags` (
	`post_id` integer NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY (`post_id`, `tag`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `post_tags_tag` ON `post_tags` (`tag`);
