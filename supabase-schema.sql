create table if not exists public.fitness_tracker_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.fitness_tracker_state enable row level security;

drop policy if exists "Users can read their tracker state" on public.fitness_tracker_state;
create policy "Users can read their tracker state"
on public.fitness_tracker_state
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert their tracker state" on public.fitness_tracker_state;
create policy "Users can insert their tracker state"
on public.fitness_tracker_state
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update their tracker state" on public.fitness_tracker_state;
create policy "Users can update their tracker state"
on public.fitness_tracker_state
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete their tracker state" on public.fitness_tracker_state;
create policy "Users can delete their tracker state"
on public.fitness_tracker_state
for delete
to authenticated
using (auth.uid() = user_id);

create table if not exists public.fitness_tracker_garmin_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.fitness_tracker_garmin_sync enable row level security;

drop policy if exists "Users can read their Garmin sync" on public.fitness_tracker_garmin_sync;
create policy "Users can read their Garmin sync"
on public.fitness_tracker_garmin_sync
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert their Garmin sync" on public.fitness_tracker_garmin_sync;
create policy "Users can insert their Garmin sync"
on public.fitness_tracker_garmin_sync
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update their Garmin sync" on public.fitness_tracker_garmin_sync;
create policy "Users can update their Garmin sync"
on public.fitness_tracker_garmin_sync
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete their Garmin sync" on public.fitness_tracker_garmin_sync;
create policy "Users can delete their Garmin sync"
on public.fitness_tracker_garmin_sync
for delete
to authenticated
using (auth.uid() = user_id);
