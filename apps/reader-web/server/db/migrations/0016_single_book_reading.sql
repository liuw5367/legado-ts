ALTER TABLE reader.books ADD COLUMN latest_chapter_index integer;
ALTER TABLE reader.books ADD COLUMN latest_chapter_name text;
ALTER TABLE reader.books ADD COLUMN current_chapter_index integer;
ALTER TABLE reader.books ADD COLUMN current_chapter_name text;
-- 明确清除旧的分来源进度，不执行历史数据迁移或回填。
TRUNCATE TABLE reader.reading_records;
ALTER TABLE reader.reading_records DROP CONSTRAINT reading_records_user_book_edition_unique;
CREATE UNIQUE INDEX reading_records_user_book_idx ON reader.reading_records (user_id, book_id);
