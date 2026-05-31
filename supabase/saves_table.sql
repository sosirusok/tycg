-- 신우 키우기 — 클라우드 세이브 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN 하면
-- 로그인 사용자의 진행상황이 기기 간 자동 동기화됩니다.

create table if not exists public.saves (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.saves enable row level security;

-- 본인 데이터만 읽기/쓰기 가능 (RLS)
drop policy if exists "saves_select_own" on public.saves;
create policy "saves_select_own" on public.saves
  for select using (auth.uid() = user_id);

drop policy if exists "saves_insert_own" on public.saves;
create policy "saves_insert_own" on public.saves
  for insert with check (auth.uid() = user_id);

drop policy if exists "saves_update_own" on public.saves;
create policy "saves_update_own" on public.saves
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
