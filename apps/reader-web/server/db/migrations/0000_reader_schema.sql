create extension if not exists "pgcrypto";
create schema if not exists "reader";

create table if not exists "reader"."sources" (
  "source_id" text primary key,
  "fingerprint" text not null,
  "raw_source" jsonb not null,
  "normalized_source" jsonb not null,
  "enabled" boolean not null default true,
  "custom_order" integer not null default 0,
  "updated_at" timestamptz not null default now()
);
create index if not exists "sources_enabled_order_idx" on "reader"."sources" ("enabled", "custom_order");

create table if not exists "reader"."books" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "name" text not null,
  "author" text,
  "intro" text,
  "cover_url" text,
  "active_edition_key" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "books_user_updated_idx" on "reader"."books" ("user_id", "updated_at");

create table if not exists "reader"."book_editions" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "edition_key" text not null,
  "source_id" text not null,
  "source_fingerprint" text not null,
  "book_url" text not null,
  "metadata" jsonb not null,
  "variable" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "book_editions_user_edition_unique" unique ("user_id", "edition_key")
);
create index if not exists "book_editions_user_book_idx" on "reader"."book_editions" ("user_id", "book_id");

create table if not exists "reader"."reading_records" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "edition_key" text not null,
  "chapter_id" text not null,
  "chapter_url" text not null,
  "chapter_index" integer not null,
  "title" text not null,
  "toc_revision" text,
  "paragraph_index" integer not null default 0,
  "offset" integer not null default 0,
  "version" integer not null default 0,
  "last_read_at" timestamptz not null default now(),
  constraint "reading_records_user_book_edition_unique" unique ("user_id", "book_id", "edition_key")
);
create index if not exists "reading_records_user_recent_idx" on "reader"."reading_records" ("user_id", "last_read_at");

create table if not exists "reader"."search_runs" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "keyword" text not null,
  "source_id" text not null,
  "source_fingerprint" text,
  "status" text not null,
  "candidates" jsonb not null default '[]'::jsonb,
  "cursor" jsonb,
  "next_cursor" jsonb,
  "version" integer not null default 0,
  "cancelled" boolean not null default false,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "search_runs_user_updated_idx" on "reader"."search_runs" ("user_id", "updated_at");

create table if not exists "reader"."toc_snapshots" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "edition_key" text not null,
  "source_fingerprint" text not null,
  "revision" text not null,
  "chapters" jsonb not null,
  "book_patch" jsonb not null,
  "book_after" jsonb,
  "updated_at" timestamptz not null default now(),
  constraint "toc_snapshots_user_edition_unique" unique ("user_id", "edition_key")
);
create index if not exists "toc_snapshots_user_book_idx" on "reader"."toc_snapshots" ("user_id", "book_id");

create table if not exists "reader"."chapter_contents" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "edition_key" text not null,
  "chapter_id" text not null,
  "toc_revision" text not null,
  "source_fingerprint" text not null,
  "content" jsonb not null,
  "updated_at" timestamptz not null default now(),
  constraint "chapter_contents_user_identity_unique" unique ("user_id", "edition_key", "toc_revision", "chapter_id")
);

create table if not exists "reader"."source_runtime_state" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "source_id" text not null,
  "source_fingerprint" text not null,
  "encrypted_state" text not null,
  "version" integer not null default 0,
  "lease_token" text,
  "lease_until" timestamptz,
  "updated_at" timestamptz not null default now(),
  constraint "source_runtime_user_source_unique" unique ("user_id", "source_id", "source_fingerprint")
);
create index if not exists "source_runtime_lease_idx" on "reader"."source_runtime_state" ("lease_until");

-- Sources are deployment-owned. User-owned records are protected by the API's
-- transaction-local app.user_id setting and the policies below.
alter table "reader"."books" enable row level security;
alter table "reader"."book_editions" enable row level security;
alter table "reader"."reading_records" enable row level security;
alter table "reader"."search_runs" enable row level security;
alter table "reader"."toc_snapshots" enable row level security;
alter table "reader"."chapter_contents" enable row level security;
alter table "reader"."source_runtime_state" enable row level security;
alter table "reader"."books" force row level security;
alter table "reader"."book_editions" force row level security;
alter table "reader"."reading_records" force row level security;
alter table "reader"."search_runs" force row level security;
alter table "reader"."toc_snapshots" force row level security;
alter table "reader"."chapter_contents" force row level security;
alter table "reader"."source_runtime_state" force row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['books', 'book_editions', 'reading_records', 'search_runs', 'toc_snapshots', 'chapter_contents', 'source_runtime_state'] loop
    execute format('drop policy if exists %I_user_isolation on "reader".%I', table_name, table_name);
    execute format(
      'create policy %I_user_isolation on "reader".%I using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      table_name,
      table_name
    );
  end loop;
end $$;
