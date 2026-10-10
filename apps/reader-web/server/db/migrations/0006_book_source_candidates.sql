create table if not exists "reader"."book_source_candidates" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null,
  "book_id" uuid not null,
  "source_id" text not null,
  "source_fingerprint" text not null,
  "book_url" text not null,
  "candidate" jsonb not null,
  "updated_at" timestamptz not null default now()
);
create unique index if not exists "book_source_candidates_identity_idx" on "reader"."book_source_candidates" ("user_id", "book_id", "source_id", "source_fingerprint", "book_url");
create index if not exists "book_source_candidates_user_book_idx" on "reader"."book_source_candidates" ("user_id", "book_id");
alter table "reader"."book_source_candidates" enable row level security;
alter table "reader"."book_source_candidates" force row level security;
drop policy if exists "book_source_candidates_user_isolation" on "reader"."book_source_candidates";
create policy "book_source_candidates_user_isolation" on "reader"."book_source_candidates"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
