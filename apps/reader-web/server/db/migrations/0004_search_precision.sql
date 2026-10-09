alter table "reader"."search_runs"
  add column if not exists "precision" boolean not null default false;
