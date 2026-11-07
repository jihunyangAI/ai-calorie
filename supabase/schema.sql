-- Supabase SQL Editor에서 실행해 주세요 (meals 테이블 생성 및 권한 설정)
create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  food_name text not null,
  calories integer not null,
  meal_date date not null default current_date,
  image_url text,
  created_at timestamptz not null default now()
);

-- 날짜별 조회 성능 향상을 위한 인덱스
create index if not exists idx_meals_meal_date on public.meals (meal_date);

-- RLS(Row Level Security) 활성화 및 공개 읽기/쓰기/삭제 정책 허용
alter table public.meals enable row level security;

drop policy if exists "Allow public select on meals" on public.meals;
create policy "Allow public select on meals"
  on public.meals for select
  using (true);

drop policy if exists "Allow public insert on meals" on public.meals;
create policy "Allow public insert on meals"
  on public.meals for insert
  with check (true);

drop policy if exists "Allow public delete on meals" on public.meals;
create policy "Allow public delete on meals"
  on public.meals for delete
  using (true);
