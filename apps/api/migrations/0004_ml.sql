-- The fault model service reads charge points, status events and tickets in every country (it is
-- trained across the network) and nothing else.
grant usage on schema ev to foundry_ml;
grant select on ev.chargepoints, ev.status_events, ev.tickets to foundry_ml;
create policy ml_reads_all on ev.chargepoints for select to foundry_ml using (true);
create policy ml_reads_all on ev.status_events for select to foundry_ml using (true);
create policy ml_reads_all on ev.tickets for select to foundry_ml using (true);
