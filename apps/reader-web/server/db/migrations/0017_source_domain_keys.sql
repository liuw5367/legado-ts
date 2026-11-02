alter table reader.user_sources add column domain_key text;
create index user_sources_user_domain_enabled_idx
  on reader.user_sources (user_id, domain_key, enabled)
  where deleted = false;
