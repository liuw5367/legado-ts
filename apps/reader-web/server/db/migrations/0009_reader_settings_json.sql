alter table "reader"."reader_settings"
  add column if not exists "preferences" jsonb not null default '{"schemaVersion":1,"general":{"bookshelfSort":"addedAt"},"display":{"theme":"system","readingMode":"scroll","fontSize":18,"lineHeight":1.9,"marginTop":16,"marginRight":16,"marginBottom":16,"marginLeft":16}}'::jsonb;

update "reader"."reader_settings" set "updated_at" = now();

alter table "reader"."reader_settings"
  drop column if exists "theme",
  drop column if exists "reading_mode",
  drop column if exists "font_size",
  drop column if exists "line_height_units",
  drop column if exists "margin_top",
  drop column if exists "margin_right",
  drop column if exists "margin_bottom",
  drop column if exists "margin_left";
