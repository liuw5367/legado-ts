alter table "reader"."reader_settings"
  add column if not exists "reading_mode" text not null default 'scroll';

alter table "reader"."reader_settings"
  drop constraint if exists "reader_settings_reading_mode_check";

alter table "reader"."reader_settings"
  add constraint "reader_settings_reading_mode_check" check ("reading_mode" in ('scroll', 'paged'));
