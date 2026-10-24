alter table reader.search_runs add column operation_lease_until timestamptz;
alter table reader.user_sources add column source_uuid uuid not null default gen_random_uuid();
create unique index user_sources_uuid_idx on reader.user_sources(source_uuid);
alter table reader.user_sources add column import_link_id uuid;
alter table reader.user_sources add column current_import_item_id uuid;
create table reader.source_import_links (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, url_key text not null, encrypted_url text not null, display_url text not null, sort_order integer not null, created_at timestamptz not null default now()
);
create unique index source_import_links_url_idx on reader.source_import_links(user_id,url_key);
create index source_import_links_order_idx on reader.source_import_links(user_id,sort_order);
create table reader.source_import_settings(user_id uuid primary key, revision text not null);
create table reader.source_import_batches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, preview_id uuid not null unique, link_id uuid not null, selection jsonb not null, imported_at timestamptz not null default now(),
 imported integer not null, new_count integer not null, updated_count integer not null, restored_count integer not null, skipped_count integer not null, unselected_count integer not null,
 undo_status text not null default 'none' check (undo_status in ('none','partial','all')), undone_at timestamptz, invalidated_at timestamptz, invalidated_reason text
);
create index source_import_batches_time_idx on reader.source_import_batches(user_id,imported_at);
create table reader.source_import_items (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, batch_id uuid not null, source_uuid uuid, source_id text not null, name text not null, source_group text,
 action text not null check (action in ('new','update','restore','skipped','unselected')), reason text not null, display_url text not null, encrypted_origin text not null, before_snapshot text, after_revision text, undo_revision text, undone_at timestamptz
);
create index source_import_items_batch_idx on reader.source_import_items(user_id,batch_id,id);
create index source_import_items_source_idx on reader.source_import_items(user_id,source_uuid);
create table reader.source_import_undo_operations (
 user_id uuid not null, idempotency_key uuid not null, batch_id uuid not null, selection text not null, result jsonb not null, created_at timestamptz not null default now()
);
create unique index source_import_undo_key_idx on reader.source_import_undo_operations(user_id,idempotency_key);
-- 槽位只存调度元数据，不向客户端开放；服务端跨账号统计才能限制多实例总负载。
create table reader.source_execution_slots(slot_id integer primary key, user_id uuid, operation_id uuid, lease_token uuid, lease_until timestamptz);
insert into reader.source_execution_slots(slot_id) select generate_series(1,8);
do $$ declare table_name text; begin
 foreach table_name in array array['source_import_links','source_import_settings','source_import_batches','source_import_items','source_import_undo_operations'] loop
  execute format('alter table reader.%I enable row level security',table_name);
  execute format('alter table reader.%I force row level security',table_name);
  execute format('create policy %I on reader.%I using (user_id = nullif(current_setting(''app.user_id'',true),'''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'',true),'''')::uuid)',table_name || '_user_isolation',table_name);
 end loop;
end $$;
