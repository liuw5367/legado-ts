create table if not exists "reader"."bookshelf" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "added_at" timestamptz not null default now(),
  constraint "bookshelf_user_book_unique" unique ("user_id", "book_id")
);
create index if not exists "bookshelf_user_added_idx" on "reader"."bookshelf" ("user_id", "added_at");

create table if not exists "reader"."search_history" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "search_id" uuid not null,
  "keyword" text not null,
  "source_ids" jsonb not null default '[]'::jsonb,
  "status" text not null,
  "result_count" integer not null default 0,
  "summary" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz,
  constraint "search_history_user_search_unique" unique ("user_id", "search_id")
);
create index if not exists "search_history_user_updated_idx" on "reader"."search_history" ("user_id", "updated_at");

alter table "reader"."bookshelf" enable row level security;
alter table "reader"."bookshelf" force row level security;
alter table "reader"."search_history" enable row level security;
alter table "reader"."search_history" force row level security;

create policy "bookshelf_user_isolation" on "reader"."bookshelf"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy "search_history_user_isolation" on "reader"."search_history"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
