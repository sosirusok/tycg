-- 최근 접속: when the member last made a signed-in request. currentUser writes it at most once per
-- 10 minutes (only when it is NULL or older), so it costs no extra write on most requests. A plain
-- nullable column, so the previous Worker keeps working while this migration is live; members it
-- serves meanwhile simply show no 최근 접속 until their next request reaches the new Worker.
ALTER TABLE `users` ADD `last_seen_at` integer;
