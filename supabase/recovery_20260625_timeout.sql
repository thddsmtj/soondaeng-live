-- Soondaeng Supabase timeout recovery
-- 1) Make a full backup first. This keeps the original users/products/keywords/snapshots row.
create table if not exists public.soondaeng_state_backup_20260625_timeout as
select *
from public.soondaeng_state;

-- 2) Keep only the latest 7 snapshot date groups in the live state row.
-- This preserves members, approvals, products, keywords, notices, and settings.
-- It only reduces data.snapshots so login/admin queries stop timing out.
update public.soondaeng_state as s
set data = jsonb_set(
  s.data,
  '{snapshots}',
  coalesce((
    with snapshot_rows as (
      select
        item.value as snapshot,
        case
          when nullif(item.value->>'dateKey', '') is not null then item.value->>'dateKey'
          when (item.value->>'checkedAt') ~ '^[0-9]+$'
            then to_char(to_timestamp(((item.value->>'checkedAt')::numeric / 1000)) at time zone 'Asia/Seoul', 'YYYY-MM-DD')
          else null
        end as snapshot_day
      from jsonb_array_elements(coalesce(s.data->'snapshots', '[]'::jsonb)) as item(value)
    ),
    recent_days as (
      select snapshot_day
      from snapshot_rows
      where snapshot_day is not null
      group by snapshot_day
      order by snapshot_day desc
      limit 7
    )
    select jsonb_agg(snapshot order by snapshot_day, case when (snapshot->>'checkedAt') ~ '^[0-9]+$' then (snapshot->>'checkedAt')::numeric else 0 end)
    from snapshot_rows
    where snapshot_day in (select snapshot_day from recent_days)
  ), '[]'::jsonb),
  true
)
where s.id = 'main';

-- 3) If step 2 itself times out, use this emergency command after confirming
-- the backup table above was created. This restores login fastest, but removes
-- live snapshot history from the main row. The backup table still has a copy.
-- update public.soondaeng_state
-- set data = jsonb_set(data, '{snapshots}', '[]'::jsonb, true)
-- where id = 'main';
