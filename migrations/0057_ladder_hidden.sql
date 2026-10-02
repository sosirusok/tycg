-- 시즌 비공개 (WP68): ladder emblems of a known tier whose season the seller keeps private ('마스터 시즌
-- 비공개 2'), on 판매 and the offered side of 교환 (account posts only). Additive only: one new table and
-- its index. The previous Worker never reads or writes it; it edits a post's ladders by rewriting
-- post_seasons only (these rows stay as they are) and deletes posts with a plain DELETE (the rows go with
-- the post through the foreign key), so it keeps serving unchanged during the rollout.
CREATE TABLE IF NOT EXISTS `post_ladder_hidden` (
	`post_id` integer NOT NULL,
	`tier` text NOT NULL,
	`count` integer NOT NULL CHECK (`count` BETWEEN 1 AND 99),
	PRIMARY KEY (`post_id`, `tier`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE cascade
);
-- The search side: a filter that covers every season of a tier ('모든 시즌 마스터') also finds these.
CREATE INDEX IF NOT EXISTS `post_ladder_hidden_tier` ON `post_ladder_hidden` (`tier`);
