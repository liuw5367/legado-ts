create table "reader"."reading_bookmarks" (
 user_id uuid not null, id uuid not null, book_id uuid not null,
 edition_key text not null, chapter_url text not null, data jsonb not null,
 constraint reading_bookmarks_data_check check (data->>'id' = id::text and data->>'userId' = user_id::text and data->>'bookId' = book_id::text and data->>'editionKey' = edition_key and data->>'chapterUrl' = chapter_url)
);
create unique index reading_bookmarks_user_id_idx on "reader"."reading_bookmarks" (user_id, id);
create index reading_bookmarks_chapter_idx on "reader"."reading_bookmarks" (user_id, book_id, edition_key, chapter_url);
create unique index reading_bookmarks_anchor_idx on "reader"."reading_bookmarks" (user_id, book_id, edition_key, chapter_url, (data->>'sourceFingerprint'), (data->'anchor'->'start')) where data->>'deletedAt' is null;
create table "reader"."reading_annotations" (
 user_id uuid not null, id uuid not null, book_id uuid not null,
 edition_key text not null, chapter_url text not null, data jsonb not null,
 constraint reading_annotations_color_check check (data->>'color' in ('pink','purple','blue','green','orange')),
 constraint reading_annotations_data_check check (data->>'id' = id::text and data->>'userId' = user_id::text and data->>'bookId' = book_id::text and data->>'editionKey' = edition_key and data->>'chapterUrl' = chapter_url)
);
create unique index reading_annotations_user_id_idx on "reader"."reading_annotations" (user_id, id);
create index reading_annotations_chapter_idx on "reader"."reading_annotations" (user_id, book_id, edition_key, chapter_url);
create unique index reading_annotations_anchor_idx on "reader"."reading_annotations" (user_id, book_id, edition_key, chapter_url, (data->>'sourceFingerprint'), (data->'anchor'->'start'), (data->'anchor'->'end')) where data->>'deletedAt' is null;
create index reading_annotations_time_idx on "reader"."reading_annotations" (user_id, (data->>'createdAt') desc, id desc);
alter table "reader"."reading_bookmarks" enable row level security;
alter table "reader"."reading_bookmarks" force row level security;
create policy reading_bookmarks_user on "reader"."reading_bookmarks" using (user_id = nullif(current_setting('app.user_id', true), '')::uuid) with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
alter table "reader"."reading_annotations" enable row level security;
alter table "reader"."reading_annotations" force row level security;
create policy reading_annotations_user on "reader"."reading_annotations" using (user_id = nullif(current_setting('app.user_id', true), '')::uuid) with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
