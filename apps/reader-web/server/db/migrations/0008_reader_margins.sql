alter table "reader"."reader_settings"
  add column if not exists "margin_top" integer not null default 16,
  add column if not exists "margin_right" integer not null default 16,
  add column if not exists "margin_bottom" integer not null default 16,
  add column if not exists "margin_left" integer not null default 16;

alter table "reader"."reader_settings"
  drop constraint if exists "reader_settings_margin_top_check",
  drop constraint if exists "reader_settings_margin_right_check",
  drop constraint if exists "reader_settings_margin_bottom_check",
  drop constraint if exists "reader_settings_margin_left_check";

alter table "reader"."reader_settings"
  add constraint "reader_settings_margin_top_check" check ("margin_top" between 0 and 64),
  add constraint "reader_settings_margin_right_check" check ("margin_right" between 0 and 64),
  add constraint "reader_settings_margin_bottom_check" check ("margin_bottom" between 0 and 64),
  add constraint "reader_settings_margin_left_check" check ("margin_left" between 0 and 64);
