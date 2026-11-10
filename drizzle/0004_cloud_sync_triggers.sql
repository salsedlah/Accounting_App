-- 0004: generic cloud change capture + backfill.
--
-- Every table that belongs to a business gets an AFTER INSERT/UPDATE/DELETE
-- trigger that appends a row to `sync_changes`. Rows are only captured when
-- the business has a verified Supabase Auth owner (`owner_auth_user_id`) or an
-- owner membership linked to `auth_user_id`. Legacy/unlinked businesses are
-- deliberately skipped: cloud sync must never be enabled without a verified
-- identity.
--
-- This migration is written to be applied manually (Supabase SQL editor or
-- `npm run db:push`). It is idempotent and safe to re-run.
--
-- Statement breakpoint markers are required between top-level statements: the
-- Drizzle migrator splits migration files on them, and PGlite cannot execute
-- multiple commands in one prepared statement.

create or replace function hisab_sync_record_id(p_table text, p_row jsonb)
returns text
language plpgsql
immutable
as $$
begin
  if p_row ? 'id' then
    return p_row->>'id';
  end if;
  if p_table = 'role_permissions' then
    return coalesce(p_row->>'role_id', '') || ':' || coalesce(p_row->>'permission_key', '');
  end if;
  if p_table = 'membership_permission_overrides' then
    return coalesce(p_row->>'membership_id', '') || ':' || coalesce(p_row->>'permission_key', '');
  end if;
  return md5(p_row::text);
end;
$$;
--> statement-breakpoint

create or replace function hisab_sync_business_id(p_table text, p_row jsonb)
returns uuid
language plpgsql
stable
as $$
declare
  v_business uuid;
begin
  if p_table = 'businesses' then
    return nullif(p_row->>'id', '')::uuid;
  end if;
  if p_row ? 'business_id' then
    return nullif(p_row->>'business_id', '')::uuid;
  end if;

  if p_table = 'sale_items' then
    select business_id into v_business from public.sales where id = nullif(p_row->>'sale_id', '')::uuid;
  elsif p_table = 'purchase_items' then
    select business_id into v_business from public.purchases where id = nullif(p_row->>'purchase_id', '')::uuid;
  elsif p_table = 'journal_lines' then
    select business_id into v_business from public.journal_entries where id = nullif(p_row->>'entry_id', '')::uuid;
  elsif p_table = 'role_permissions' then
    select business_id into v_business from public.roles where id = nullif(p_row->>'role_id', '')::uuid;
  elsif p_table = 'membership_permission_overrides' then
    select business_id into v_business from public.memberships where id = nullif(p_row->>'membership_id', '')::uuid;
  elsif p_table in ('product_units', 'unit_conversions') then
    select business_id into v_business from public.products where id = nullif(p_row->>'product_id', '')::uuid;
  elsif p_table = 'stocktaking_items' then
    select business_id into v_business from public.stocktaking_sessions where id = nullif(p_row->>'session_id', '')::uuid;
  end if;

  return v_business;
exception
  when invalid_text_representation then
    return null;
end;
$$;
--> statement-breakpoint

create or replace function hisab_sync_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_business uuid;
  v_user uuid;
  v_device text;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_business := hisab_sync_business_id(tg_table_name, v_row);
  if v_business is null then
    return null;
  end if;

  select coalesce(
           b.owner_auth_user_id,
           (
             select u.auth_user_id
             from public.memberships m
             join public.users u on u.id = m.user_id
             where m.business_id = v_business
               and m.role = 'owner'
               and u.auth_user_id is not null
             limit 1
           )
         )
    into v_user
    from public.businesses b
   where b.id = v_business;

  -- No verified Supabase identity => do not create a cloud change.
  if v_user is null then
    return null;
  end if;

  v_device := nullif(current_setting('hisab.device_id', true), '');

  insert into public.sync_changes
    (business_id, user_id, table_name, record_id, operation, payload, changed_at, device_id)
  values
    (v_business, v_user, tg_table_name, hisab_sync_record_id(tg_table_name, v_row),
     lower(tg_op), v_row, now(), v_device);

  return null;
end;
$$;
--> statement-breakpoint

do $$
declare
  t text;
  tables text[] := array[
    'businesses',
    'business_subscriptions',
    'business_feature_overrides',
    'subscription_payments',
    'subscription_history',
    'roles',
    'role_permissions',
    'memberships',
    'membership_permission_overrides',
    'warehouses',
    'units',
    'product_categories',
    'suppliers',
    'customers',
    'products',
    'product_units',
    'unit_conversions',
    'inventory_movements',
    'inventory_balances',
    'inventory_lots',
    'stock_transfers',
    'stocktaking_sessions',
    'stocktaking_items',
    'sales',
    'sale_items',
    'purchases',
    'purchase_items',
    'payments',
    'customer_accounts',
    'supplier_accounts',
    'cashboxes',
    'cash_transactions',
    'expenses',
    'accounts',
    'journal_entries',
    'journal_lines',
    'invoice_sequences',
    'audit_logs',
    'notification_events'
  ];
begin
  foreach t in array tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('drop trigger if exists hisab_sync_capture on public.%I', t);
    execute format(
      'create trigger hisab_sync_capture after insert or update or delete on public.%I
       for each row execute function hisab_sync_capture()',
      t
    );
  end loop;
end;
$$;
--> statement-breakpoint

-- One-time backfill for businesses that have never produced a change row.
-- This makes the first device pull a complete snapshot without duplicating
-- rows for businesses that are already syncing.
do $$
declare
  t text;
  b uuid;
  v_user uuid;
  tables text[] := array[
    'businesses',
    'business_subscriptions',
    'business_feature_overrides',
    'subscription_payments',
    'subscription_history',
    'roles',
    'role_permissions',
    'memberships',
    'membership_permission_overrides',
    'warehouses',
    'units',
    'product_categories',
    'suppliers',
    'customers',
    'products',
    'product_units',
    'unit_conversions',
    'inventory_movements',
    'inventory_balances',
    'inventory_lots',
    'stock_transfers',
    'stocktaking_sessions',
    'stocktaking_items',
    'sales',
    'sale_items',
    'purchases',
    'purchase_items',
    'payments',
    'customer_accounts',
    'supplier_accounts',
    'cashboxes',
    'cash_transactions',
    'expenses',
    'accounts',
    'journal_entries',
    'journal_lines',
    'invoice_sequences',
    'audit_logs',
    'notification_events'
  ];
begin
  for b in select id from public.businesses loop
    if exists (select 1 from public.sync_changes where business_id = b) then
      continue;
    end if;

    select coalesce(
             biz.owner_auth_user_id,
             (
               select u.auth_user_id
               from public.memberships m
               join public.users u on u.id = m.user_id
               where m.business_id = b
                 and m.role = 'owner'
                 and u.auth_user_id is not null
               limit 1
             )
           )
      into v_user
      from public.businesses biz
     where biz.id = b;

    if v_user is null then
      continue;
    end if;

    foreach t in array tables loop
      if to_regclass(format('public.%I', t)) is null then
        continue;
      end if;
      execute format(
        'insert into public.sync_changes
           (business_id, user_id, table_name, record_id, operation, payload, changed_at)
         select $1, $2, %L, hisab_sync_record_id(%L, to_jsonb(x)), ''insert'', to_jsonb(x), now()
         from public.%I x
         where hisab_sync_business_id(%L, to_jsonb(x)) = $1',
        t, t, t, t
      ) using b, v_user;
    end loop;
  end loop;
end;
$$;
