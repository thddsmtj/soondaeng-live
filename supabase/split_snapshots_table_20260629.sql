-- Soondaeng: move rank snapshots out of the main JSON state.
-- Run this BEFORE deploying the matching server.js update.
-- This keeps users/products/keywords in public.soondaeng_state and stores rank collections here.

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

-- Copy the currently live JSON snapshots into the new table.
-- This intentionally migrates only the current live state, not the large archived backup table.
with raw_snapshots as (
  select item.value as snapshot
  from public.soondaeng_state state
  cross join lateral jsonb_array_elements(coalesce(state.data->'snapshots', '[]'::jsonb)) as item(value)
  where state.id = 'main'
),
normalized as (
  select
    coalesce(nullif(snapshot->>'collectionId', ''), md5(snapshot::text)) as collection_id,
    snapshot
  from raw_snapshots
),
grouped as (
  select
    collection_id,
    max(coalesce(snapshot->>'userId', '')) as user_id,
    max(coalesce(snapshot->>'productId', '')) as product_id,
    max(coalesce(snapshot->>'keywordId', '')) as keyword_id,
    max(coalesce(snapshot->>'term', '')) as term,
    case
      when bool_or(coalesce(snapshot->>'status', '') = 'error') then 'error'
      else 'completed'
    end as status,
    max(coalesce(nullif(snapshot->>'checkedAt', ''), '0')::bigint) as checked_at,
    max(coalesce(nullif(snapshot->>'dateKey', ''), to_char(to_timestamp(coalesce(nullif(snapshot->>'checkedAt', ''), '0')::bigint / 1000) at time zone 'Asia/Seoul', 'YYYY-MM-DD'))) as date_key,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', coalesce(snapshot->>'id', md5(snapshot::text)),
          'rank', nullif(snapshot->>'rank', '')::integer,
          'itemKey', coalesce(snapshot->>'itemKey', ''),
          'productName', coalesce(snapshot->>'productName', ''),
          'productUrl', coalesce(snapshot->>'productUrl', ''),
          'storeName', coalesce(snapshot->>'storeName', ''),
          'image', coalesce(snapshot->>'image', ''),
          'price', coalesce(snapshot->>'price', ''),
          'productNaverId', coalesce(snapshot->>'productNaverId', '')
        )
        order by coalesce(nullif(snapshot->>'rank', '')::integer, 9999)
      ) filter (where coalesce(snapshot->>'status', '') = 'completed'),
      '[]'::jsonb
    ) as items,
    sum(coalesce(nullif(snapshot->>'apiCalls', ''), '0')::integer) as api_calls,
    max(coalesce(snapshot->>'error', '')) as error,
    max(coalesce(snapshot->>'source', '')) as source,
    max(coalesce(snapshot->>'slotKey', '')) as slot_key,
    bool_or(coalesce(snapshot->>'graphEligible', 'false') = 'true') as graph_eligible,
    max(coalesce(snapshot->>'deletedUserId', '')) as deleted_user_id,
    max(coalesce(snapshot->>'deletedUserEmail', '')) as deleted_user_email,
    max(coalesce(snapshot->>'deletedUserPhone', '')) as deleted_user_phone,
    max(coalesce(snapshot->>'deletedUserStoreName', '')) as deleted_user_store_name
  from normalized
  group by collection_id
)
insert into public.soondaeng_snapshots (
  id,
  collection_id,
  user_id,
  product_id,
  keyword_id,
  term,
  status,
  checked_at,
  date_key,
  items,
  api_calls,
  error,
  source,
  slot_key,
  graph_eligible,
  deleted_user_id,
  deleted_user_email,
  deleted_user_phone,
  deleted_user_store_name
)
select
  collection_id,
  collection_id,
  user_id,
  product_id,
  keyword_id,
  term,
  status,
  checked_at,
  date_key,
  items,
  api_calls,
  error,
  source,
  slot_key,
  graph_eligible,
  deleted_user_id,
  deleted_user_email,
  deleted_user_phone,
  deleted_user_store_name
from grouped
where checked_at > 0
on conflict (id) do nothing;

-- Keep the live state light. The old full backup table remains untouched.
update public.soondaeng_state
set
  data = jsonb_set(data, '{snapshots}', '[]'::jsonb, true),
  updated_at = now()
where id = 'main';

-- Keep only the latest rolling 7 Seoul date groups in the new snapshot table.
delete from public.soondaeng_snapshots
where date_key < to_char((now() at time zone 'Asia/Seoul')::date - interval '6 days', 'YYYY-MM-DD');

select
  (select jsonb_array_length(data->'users') from public.soondaeng_state where id = 'main') as users,
  (select jsonb_array_length(data->'products') from public.soondaeng_state where id = 'main') as products,
  (select jsonb_array_length(data->'snapshots') from public.soondaeng_state where id = 'main') as live_json_snapshots,
  (select count(*) from public.soondaeng_snapshots) as snapshot_collections;
