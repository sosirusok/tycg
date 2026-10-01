-- 찜한 글 '가격 내림': the post's price when the member saved it, so a price raised and then lowered
-- again is compared with what the member actually saw. A nullable column: favorites the previous
-- Worker saves while this migration is live (and every older one) hold NULL, and the Worker then
-- falls back to the price history.
ALTER TABLE `favorites` ADD `saved_price` integer;
