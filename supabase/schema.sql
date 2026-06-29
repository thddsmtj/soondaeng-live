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

create table if not exists public.soondaeng_snapshots (
  id text primary key,
  collection_id text not null,
  user_id text not null default '',
  product_id text not null default '',
  keyword_id text not null default '',
  term text not null default '',
  status text not null default 'completed',
  checked_at bigint not null,
  date_key text not null,
  items jsonb not null default '[]'::jsonb,
  api_calls integer not null default 0,
  error text not null default '',
  source text not null default '',
  slot_key text not null default '',
  graph_eligible boolean not null default false,
  deleted_user_id text not null default '',
  deleted_user_email text not null default '',
  deleted_user_phone text not null default '',
  deleted_user_store_name text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists soondaeng_snapshots_date_key_idx
  on public.soondaeng_snapshots (date_key);

create index if not exists soondaeng_snapshots_checked_at_idx
  on public.soondaeng_snapshots (checked_at);

create index if not exists soondaeng_snapshots_user_checked_idx
  on public.soondaeng_snapshots (user_id, checked_at);

create index if not exists soondaeng_snapshots_product_checked_idx
  on public.soondaeng_snapshots (product_id, checked_at);

create index if not exists soondaeng_snapshots_keyword_checked_idx
  on public.soondaeng_snapshots (keyword_id, checked_at);
