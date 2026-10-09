alter table "reader"."search_runs" add column if not exists "source_ids" jsonb not null default '[]'::jsonb;
alter table "reader"."search_runs" add column if not exists "source_states" jsonb not null default '[]'::jsonb;
alter table "reader"."search_runs" add column if not exists "operation_id" text;
alter table "reader"."search_runs" add column if not exists "progress_completed" integer not null default 0;
alter table "reader"."search_runs" add column if not exists "progress_total" integer not null default 0;

update "reader"."search_runs"
set "source_ids" = jsonb_build_array("source_id"),
    "progress_total" = 1
where jsonb_array_length("source_ids") = 0;
