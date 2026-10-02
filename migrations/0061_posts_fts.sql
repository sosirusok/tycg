-- 검색 (WP70): a full-text index over every post, so a search word of 3 or more characters reads only the
-- posts that hold it instead of every post. FTS5 with the trigram tokenizer (substring matches, case
-- folded): title, content (the body) and facts (every detail value and the author's nickname, spaces
-- removed, '|' between values, so '홍매화정예슬' also finds '홍매화 정예슬' like the LIKE search does).
-- Additive only: one virtual table and four triggers. The triggers keep it in step with every write,
-- also the previous Worker's during the rollout; posts.id is the rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS `posts_fts` USING fts5(title, content, facts, tokenize = 'trigram');

CREATE TRIGGER IF NOT EXISTS `posts_fts_insert` AFTER INSERT ON `posts` BEGIN
	INSERT INTO posts_fts(rowid, title, content, facts) VALUES (NEW.id, NEW.title, NEW.body,
		replace(COALESCE((SELECT group_concat(value, '|') FROM json_each(CASE WHEN json_valid(NEW.details) THEN NEW.details ELSE '{}' END)), '')
			|| '|' || COALESCE((SELECT nickname FROM users WHERE id = NEW.author_id), ''), ' ', ''));
END;

-- Only an edit of the text columns rewrites the row (끌올, 상태 and counters never do).
CREATE TRIGGER IF NOT EXISTS `posts_fts_update` AFTER UPDATE OF title, body, details ON `posts` BEGIN
	DELETE FROM posts_fts WHERE rowid = OLD.id;
	INSERT INTO posts_fts(rowid, title, content, facts) VALUES (NEW.id, NEW.title, NEW.body,
		replace(COALESCE((SELECT group_concat(value, '|') FROM json_each(CASE WHEN json_valid(NEW.details) THEN NEW.details ELSE '{}' END)), '')
			|| '|' || COALESCE((SELECT nickname FROM users WHERE id = NEW.author_id), ''), ' ', ''));
END;

CREATE TRIGGER IF NOT EXISTS `posts_fts_delete` AFTER DELETE ON `posts` BEGIN
	DELETE FROM posts_fts WHERE rowid = OLD.id;
END;

-- A new nickname (once in 30 days, or 회원 탈퇴) rewrites the facts of that member's posts.
CREATE TRIGGER IF NOT EXISTS `posts_fts_nickname` AFTER UPDATE OF nickname ON `users` WHEN NEW.nickname IS NOT OLD.nickname BEGIN
	DELETE FROM posts_fts WHERE rowid IN (SELECT id FROM posts WHERE author_id = NEW.id);
	INSERT INTO posts_fts(rowid, title, content, facts) SELECT p.id, p.title, p.body,
		replace(COALESCE((SELECT group_concat(value, '|') FROM json_each(CASE WHEN json_valid(p.details) THEN p.details ELSE '{}' END)), '')
			|| '|' || COALESCE(NEW.nickname, ''), ' ', '')
		FROM posts p WHERE p.author_id = NEW.id;
END;

-- Every existing post (the guard keeps a second run from adding rows twice).
INSERT INTO posts_fts(rowid, title, content, facts) SELECT p.id, p.title, p.body,
	replace(COALESCE((SELECT group_concat(value, '|') FROM json_each(CASE WHEN json_valid(p.details) THEN p.details ELSE '{}' END)), '')
		|| '|' || COALESCE(u.nickname, ''), ' ', '')
	FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id NOT IN (SELECT rowid FROM posts_fts);
