-- What the API's runtime role may do. No DELETE on audit, no UPDATE on approvals, nothing on
-- the operational tables beyond reading them and adding ticket comments.
grant usage on schema foundry, ev to foundry_app;
grant select, insert, update on foundry.people, foundry.apps, foundry.app_versions, foundry.confirmations, foundry.api_tokens to foundry_app;
grant select, insert on foundry.approvals, foundry.audit, foundry.invocations, foundry.outbound to foundry_app;
grant select, insert, update, delete on foundry.app_records to foundry_app;
grant usage on all sequences in schema foundry, ev to foundry_app;
grant select on all tables in schema ev to foundry_app;
grant insert on ev.ticket_comments to foundry_app;
