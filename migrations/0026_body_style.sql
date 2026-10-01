-- 글자 꾸미기 (WP49). Additive only: one posts column with a default. The previous Worker neither reads
-- nor writes it; a post it edits while this deploy rolls out keeps its old ranges, which no longer match
-- the body's length and hash (n, h), so readers see that post plain until its next save.

-- Style ranges over the plain body: '' or {"v":1,"n":<UTF-16 length>,"h":<FNV-1a 32 hex>,"m":[[start,end,code]]}
-- (shared/richtext.ts). Never HTML.
ALTER TABLE `posts` ADD `body_style` text NOT NULL DEFAULT '';
