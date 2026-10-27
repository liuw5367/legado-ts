alter table "reader"."toc_snapshots"
  add column if not exists "truncated" boolean not null default false;
