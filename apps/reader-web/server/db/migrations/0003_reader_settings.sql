create table if not exists "reader"."reader_settings" (
  "user_id" uuid primary key,
  "theme" text not null default 'system',
  "font_size" integer not null default 18,
  "line_height_units" integer not null default 190,
  "updated_at" timestamptz not null default now(),
  constraint "reader_settings_theme_check" check ("theme" in ('system', 'light', 'dark')),
  constraint "reader_settings_font_size_check" check ("font_size" between 15 and 28),
  constraint "reader_settings_line_height_check" check ("line_height_units" between 140 and 260)
);

alter table "reader"."reader_settings" enable row level security;
alter table "reader"."reader_settings" force row level security;

drop policy if exists "reader_settings_user_isolation" on "reader"."reader_settings";
create policy "reader_settings_user_isolation" on "reader"."reader_settings"
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
