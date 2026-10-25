insert into reader.source_execution_slots(slot_id)
select generate_series(9,20)
on conflict (slot_id) do nothing;
