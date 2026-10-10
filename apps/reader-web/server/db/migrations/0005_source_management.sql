create table if not exists "reader"."user_sources" (
  "user_id" uuid not null,
  "source_id" text not null,
  "fingerprint" text not null,
  "raw_source" jsonb not null,
  "normalized_source" jsonb not null,
  "enabled" boolean not null default true,
  "custom_order" integer not null default 0,
  "deleted" boolean not null default false,
  "revision" text not null,
  "updated_at" timestamptz not null default now(),
  constraint "user_sources_identity_unique" unique ("user_id", "source_id")
);
create index if not exists "user_sources_user_enabled_idx" on "reader"."user_sources" ("user_id", "enabled", "deleted");

create table if not exists "reader"."source_import_previews" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "source_url" text not null,
  "candidates" jsonb not null,
  "expires_at" timestamptz not null,
  "consumed_candidate_ids" jsonb not null default '[]'::jsonb,
  "consumed_result" jsonb,
  "created_at" timestamptz not null default now()
);
create index if not exists "source_import_previews_user_expiry_idx" on "reader"."source_import_previews" ("user_id", "expires_at");

alter table "reader"."user_sources" enable row level security;
alter table "reader"."user_sources" force row level security;
alter table "reader"."source_import_previews" enable row level security;
alter table "reader"."source_import_previews" force row level security;

drop policy if exists "user_sources_user_isolation" on "reader"."user_sources";
create policy "user_sources_user_isolation" on "reader"."user_sources"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
drop policy if exists "source_import_previews_user_isolation" on "reader"."source_import_previews";
create policy "source_import_previews_user_isolation" on "reader"."source_import_previews"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
