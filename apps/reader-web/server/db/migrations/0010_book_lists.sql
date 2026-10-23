create table "reader"."book_lists" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "type" text not null default 'booklist' check ("type" in ('booklist', 'shelf_group')),
  "name" text not null,
  "description" text not null default '' check (char_length("description") <= 2000),
  "is_public" boolean not null default false,
  "custom_order" integer not null default 0 check ("custom_order" >= 0),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  check (char_length(trim("name")) between 1 and case when "type" = 'shelf_group' then 30 else 100 end),
  check ("type" <> 'shelf_group' or ("name" not in ('全部', '默认') and "description" = '' and not "is_public"))
);
create index "book_lists_user_updated_idx" on "reader"."book_lists" ("user_id", "type", "updated_at" desc, "id" desc);
create index "book_lists_user_order_idx" on "reader"."book_lists" ("user_id", "type", "custom_order", "created_at", "id");
create unique index "book_lists_group_name_idx" on "reader"."book_lists" ("user_id", "name") where "type" = 'shelf_group';
create table "reader"."book_list_items" (
  "user_id" uuid not null,
  "book_list_id" uuid not null,
  "book_id" uuid not null,
  "description" text not null default '' check (char_length("description") <= 2000),
  "added_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create unique index "book_list_items_identity_idx" on "reader"."book_list_items" ("user_id", "book_list_id", "book_id");
create index "book_list_items_order_idx" on "reader"."book_list_items" ("user_id", "book_list_id", "added_at" desc, "book_id" desc);
create index "book_list_items_book_idx" on "reader"."book_list_items" ("user_id", "book_id");
alter table "reader"."bookshelf" add column "group_id" uuid;
create index "bookshelf_user_group_idx" on "reader"."bookshelf" ("user_id", "group_id");
alter table "reader"."book_lists" enable row level security;
alter table "reader"."book_lists" force row level security;
create policy "book_lists_user_isolation" on "reader"."book_lists"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
alter table "reader"."book_list_items" enable row level security;
alter table "reader"."book_list_items" force row level security;
create policy "book_list_items_user_isolation" on "reader"."book_list_items"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
