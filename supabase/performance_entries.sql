-- Supabase schema for storing revenue and cost records
create table if not exists public.performance_entries (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('revenue', 'cost')),
  subject text not null,
  amount numeric(18,2) not null,
  occurred_on date not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists performance_entries_owner_id_idx on public.performance_entries(owner_id);
create index if not exists performance_entries_occurred_on_idx on public.performance_entries(occurred_on desc, created_at desc);
