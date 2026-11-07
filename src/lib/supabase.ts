import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface Meal {
  id: string;
  food_name: string;
  calories: number;
  meal_date: string; // YYYY-MM-DD
  image_url?: string | null;
  created_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

let clientInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabasePublishableKey) {
    return null;
  }
  if (!clientInstance) {
    clientInstance = createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: false,
      },
    });
  }
  return clientInstance;
}

export const MEALS_TABLE_SQL = `create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  food_name text not null,
  calories integer not null,
  meal_date date not null default current_date,
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_meals_meal_date on public.meals (meal_date);

alter table public.meals enable row level security;

drop policy if exists "Allow public select on meals" on public.meals;
create policy "Allow public select on meals" on public.meals for select using (true);

drop policy if exists "Allow public insert on meals" on public.meals;
create policy "Allow public insert on meals" on public.meals for insert with check (true);

drop policy if exists "Allow public delete on meals" on public.meals;
create policy "Allow public delete on meals" on public.meals for delete using (true);`;
