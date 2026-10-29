-- Cluster-level roles, created once per server by an administrator (Terraform does this on Azure).
-- foundry owns the schema and runs migrations; foundry_app is the API (row-level security applies);
-- foundry_ml is the fault model service (reads operational data across countries, writes nothing).
do $$
begin
  if not exists (select from pg_roles where rolname = 'foundry') then create role foundry login password 'foundry' createdb; end if;
  if not exists (select from pg_roles where rolname = 'foundry_app') then create role foundry_app login password 'foundry_app' nosuperuser nobypassrls; end if;
  if not exists (select from pg_roles where rolname = 'foundry_ml') then create role foundry_ml login password 'foundry_ml' nosuperuser nobypassrls; end if;
end $$;
