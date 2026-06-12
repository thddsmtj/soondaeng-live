create table if not exists public.soondaeng_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.soondaeng_state (id, data)
values (
  'main',
  '{"users":[],"sessions":{},"products":[],"snapshots":[],"meta":{}}'::jsonb
)
on conflict (id) do nothing;
