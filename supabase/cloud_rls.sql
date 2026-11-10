-- Supabase Row Level Security for Hisab cloud data.
--
-- Run this in the Supabase SQL editor after migration 0004. It is idempotent.
--
-- The Next.js API uses a direct Postgres connection (table owner) and is not
-- constrained by these policies. They protect any direct Supabase client /
-- PostgREST access and provide defense-in-depth for account isolation.
--
-- Every policy is scoped through `auth.uid()`:
--   * a user may read rows of a business they belong to;
--   * writes are limited to the same business;
--   * backups and backup settings are owner-only;
--   * sync_changes is read-only for clients (triggers write it as definer).

create or replace function public.hisab_auth_uid()
returns uuid
language sql
stable
as $$ select auth.uid() $$;

create or replace function public.hisab_is_member(p_business uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from businesses b
      where b.id = p_business
        and b.owner_auth_user_id = auth.uid()
    )
    or exists (
      select 1
      from memberships m
      join users u on u.id = m.user_id
      where m.business_id = p_business
        and u.auth_user_id = auth.uid()
    );
$$;

create or replace function public.hisab_owns_business(p_business uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from businesses b
      where b.id = p_business
        and b.owner_auth_user_id = auth.uid()
    )
    or exists (
      select 1
      from memberships m
      join users u on u.id = m.user_id
      where m.business_id = p_business
        and m.role = 'owner'
        and u.auth_user_id = auth.uid()
    );
$$;

revoke all on function public.hisab_auth_uid() from public;
revoke all on function public.hisab_is_member(uuid) from public;
revoke all on function public.hisab_owns_business(uuid) from public;
grant execute on function public.hisab_is_member(uuid) to authenticated;
grant execute on function public.hisab_owns_business(uuid) to authenticated;

-- ---------------------------------------------------------------- businesses
alter table public.businesses enable row level security;
drop policy if exists hisab_businesses_select on public.businesses;
drop policy if exists hisab_businesses_insert on public.businesses;
drop policy if exists hisab_businesses_update on public.businesses;
drop policy if exists hisab_businesses_delete on public.businesses;
create policy hisab_businesses_select on public.businesses
  for select to authenticated using (public.hisab_is_member(id));
create policy hisab_businesses_insert on public.businesses
  for insert to authenticated with check (owner_auth_user_id = auth.uid());
create policy hisab_businesses_update on public.businesses
  for update to authenticated
  using (public.hisab_owns_business(id))
  with check (public.hisab_owns_business(id));
create policy hisab_businesses_delete on public.businesses
  for delete to authenticated using (public.hisab_owns_business(id));

-- --------------------------------------------------------------------- users
-- Direct clients may only see and edit their own profile row. Member lists are
-- served by the trusted API, never by exposing password hashes over PostgREST.
alter table public.users enable row level security;
drop policy if exists hisab_users_select on public.users;
drop policy if exists hisab_users_update on public.users;
create policy hisab_users_select on public.users
  for select to authenticated using (auth_user_id = auth.uid());
create policy hisab_users_update on public.users
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- -------------------------------------------------------- global read tables
alter table public.permissions enable row level security;
drop policy if exists hisab_permissions_select on public.permissions;
create policy hisab_permissions_select on public.permissions
  for select to authenticated using (true);

alter table public.subscription_plans enable row level security;
drop policy if exists hisab_plans_select on public.subscription_plans;
create policy hisab_plans_select on public.subscription_plans
  for select to authenticated using (true);

-- ------------------------------------------------------- generic business RLS
-- All tables with a direct business_id column get member-scoped read/write
-- policies. The special cloud/sync tables are handled explicitly below.
do $$
declare
  t text;
  excluded text[] := array[
    'businesses',
    'cloud_backups',
    'cloud_backup_settings',
    'sync_changes',
    'sync_cursors',
    'sync_operations'
  ];
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'business_id'
      and tb.table_type = 'BASE TABLE'
      and not (c.table_name = any (excluded))
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists hisab_member_select on public.%I', t);
    execute format('drop policy if exists hisab_member_insert on public.%I', t);
    execute format('drop policy if exists hisab_member_update on public.%I', t);
    execute format('drop policy if exists hisab_member_delete on public.%I', t);
    execute format(
      'create policy hisab_member_select on public.%I for select to authenticated using (public.hisab_is_member(business_id))',
      t
    );
    execute format(
      'create policy hisab_member_insert on public.%I for insert to authenticated with check (public.hisab_is_member(business_id))',
      t
    );
    execute format(
      'create policy hisab_member_update on public.%I for update to authenticated using (public.hisab_is_member(business_id)) with check (public.hisab_is_member(business_id))',
      t
    );
    execute format(
      'create policy hisab_member_delete on public.%I for delete to authenticated using (public.hisab_is_member(business_id))',
      t
    );
  end loop;
end;
$$;

-- --------------------------------------------------------- indirect children
-- Child tables without business_id are scoped through their parent row.
do $$
declare
  specs text[][] := array[
    array['role_permissions', 'roles', 'role_id'],
    array['membership_permission_overrides', 'memberships', 'membership_id'],
    array['product_units', 'products', 'product_id'],
    array['unit_conversions', 'products', 'product_id'],
    array['stocktaking_items', 'stocktaking_sessions', 'session_id'],
    array['sale_items', 'sales', 'sale_id'],
    array['purchase_items', 'purchases', 'purchase_id'],
    array['journal_lines', 'journal_entries', 'entry_id']
  ];
  i integer;
begin
  for i in 1 .. array_length(specs, 1) loop
    execute format('alter table public.%I enable row level security', specs[i][1]);
    execute format('drop policy if exists hisab_member_select on public.%I', specs[i][1]);
    execute format('drop policy if exists hisab_member_insert on public.%I', specs[i][1]);
    execute format('drop policy if exists hisab_member_update on public.%I', specs[i][1]);
    execute format('drop policy if exists hisab_member_delete on public.%I', specs[i][1]);
    execute format(
      'create policy hisab_member_select on public.%I for select to authenticated
         using (exists (select 1 from public.%I p where p.id = public.%I.%I and public.hisab_is_member(p.business_id)))',
      specs[i][1], specs[i][2], specs[i][1], specs[i][3]
    );
    execute format(
      'create policy hisab_member_insert on public.%I for insert to authenticated
         with check (exists (select 1 from public.%I p where p.id = public.%I.%I and public.hisab_is_member(p.business_id)))',
      specs[i][1], specs[i][2], specs[i][1], specs[i][3]
    );
    execute format(
      'create policy hisab_member_update on public.%I for update to authenticated
         using (exists (select 1 from public.%I p where p.id = public.%I.%I and public.hisab_is_member(p.business_id)))
         with check (exists (select 1 from public.%I p where p.id = public.%I.%I and public.hisab_is_member(p.business_id)))',
      specs[i][1], specs[i][2], specs[i][1], specs[i][3], specs[i][2], specs[i][1], specs[i][3]
    );
    execute format(
      'create policy hisab_member_delete on public.%I for delete to authenticated
         using (exists (select 1 from public.%I p where p.id = public.%I.%I and public.hisab_is_member(p.business_id)))',
      specs[i][1], specs[i][2], specs[i][1], specs[i][3]
    );
  end loop;
end;
$$;

-- ------------------------------------------------------------- sync tables
alter table public.sync_changes enable row level security;
drop policy if exists hisab_sync_changes_select on public.sync_changes;
create policy hisab_sync_changes_select on public.sync_changes
  for select to authenticated using (public.hisab_is_member(business_id));
-- No insert/update/delete policy: clients cannot forge change rows. The
-- security-definer trigger and the trusted API write them.

alter table public.sync_cursors enable row level security;
drop policy if exists hisab_sync_cursors_all on public.sync_cursors;
create policy hisab_sync_cursors_all on public.sync_cursors
  for all to authenticated
  using (public.hisab_is_member(business_id))
  with check (public.hisab_is_member(business_id));

alter table public.sync_operations enable row level security;
drop policy if exists hisab_sync_operations_select on public.sync_operations;
create policy hisab_sync_operations_select on public.sync_operations
  for select to authenticated using (public.hisab_is_member(business_id));
-- Writes go through the API only.

-- ------------------------------------------------------------ cloud backups
alter table public.cloud_backup_settings enable row level security;
drop policy if exists hisab_cloud_settings_all on public.cloud_backup_settings;
create policy hisab_cloud_settings_all on public.cloud_backup_settings
  for all to authenticated
  using (public.hisab_owns_business(business_id))
  with check (public.hisab_owns_business(business_id));

alter table public.cloud_backups enable row level security;
drop policy if exists hisab_cloud_backups_all on public.cloud_backups;
create policy hisab_cloud_backups_all on public.cloud_backups
  for all to authenticated
  using (public.hisab_owns_business(business_id))
  with check (public.hisab_owns_business(business_id));

-- --------------------------------------------------------- platform tables
-- Explicitly deny direct client access.
alter table public.platform_admins enable row level security;
alter table public.platform_audit_logs enable row level security;
