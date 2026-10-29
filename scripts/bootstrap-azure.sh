#!/usr/bin/env bash
# One-time setup of the database roles on Azure, run by a member of the PostgreSQL admin group
# from inside the virtual network (for example a Container Apps job or a jump host):
#   scripts/bootstrap-azure.sh <key-vault-name> <postgres-host>
# Creates foundry (owner, migrations), foundry_app (the API: row-level security applies) and
# foundry_ml (read-only for the fault model) with the passwords Terraform put in Key Vault.
set -euo pipefail
kv="$1"; host="$2"
secret() { az keyvault secret show --vault-name "$kv" --name "$1" --query value -o tsv; }
pw() { secret "$1" | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#'; }
export PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"
user="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
psql "host=$host dbname=postgres user=$user sslmode=require" -v ON_ERROR_STOP=1 \
  -v owner="$(pw migration-database-url)" -v app="$(pw database-url)" -v ml="$(pw ml-database-url)" <<'SQL'
select format('create role foundry login password %L', :'owner') where not exists (select from pg_roles where rolname = 'foundry') \gexec
select format('create role foundry_app login password %L nobypassrls', :'app') where not exists (select from pg_roles where rolname = 'foundry_app') \gexec
select format('create role foundry_ml login password %L nobypassrls', :'ml') where not exists (select from pg_roles where rolname = 'foundry_ml') \gexec
alter database foundry owner to foundry;
SQL
echo "roles ready; now start the migrate job: az containerapp job start --name <prefix>-migrate --resource-group <rg>"
