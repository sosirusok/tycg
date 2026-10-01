-- 끌올 지갑 (WP40). Additive only: two users columns with defaults. Each member holds up to M 끌올
-- that refill one every R minutes (일반 3 · 4시간, 플러스 4 · 3시간, 프리미엄 6 · 2시간, 엘리트·관리자
-- 8 · 1시간). The Worker reads the wallet as MIN(M, bump_tokens + (now - bump_at) / R), so both
-- columns at 0 mean a full wallet for every member and no backfill is needed. The previous Worker
-- never reads these columns.
ALTER TABLE `users` ADD `bump_tokens` integer DEFAULT 0 NOT NULL;
ALTER TABLE `users` ADD `bump_at` integer DEFAULT 0 NOT NULL;
