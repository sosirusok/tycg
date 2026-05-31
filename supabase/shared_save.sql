-- 신우 키우기 — "모두 같은 진행상황" 공유 저장 (임시 단일 계정 방식)
-- Supabase 대시보드 → SQL Editor 에 그대로 붙여넣고 RUN 하면,
-- 링크에 접속하는 누구나 같은 진행상황으로 이어서 플레이됩니다.

create table if not exists public.shared_save (
  id         int primary key,
  data       jsonb,
  updated_at timestamptz default now()
);

alter table public.shared_save enable row level security;

-- 익명(anon) 사용자가 이 표를 읽고 쓸 수 있게 허용 (공유 저장이므로 의도된 것)
drop policy if exists "shared_all" on public.shared_save;
create policy "shared_all" on public.shared_save
  for all to anon using (true) with check (true);

-- 단일 행 준비
insert into public.shared_save (id, data) values (1, '{}'::jsonb)
  on conflict (id) do nothing;
