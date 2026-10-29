# PostgreSQL (the record of everything, with row-level security), Redis (budgets, rate limits,
# the answer cache and sessions), and Key Vault for every secret the services read.

resource "azurerm_key_vault" "main" {
  name                       = "kv-${var.name}-${var.environment}-${local.suffix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 30
  tags                       = local.tags
}

resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "apps_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

resource "random_password" "postgres_admin" {
  length  = 32
  special = false
}

# the three database roles of scripts/bootstrap-db.sql, with generated passwords
resource "random_password" "role" {
  for_each = toset(["foundry", "foundry_app", "foundry_ml"])
  length   = 32
  special  = false
}

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "psql-${local.prefix}-${local.suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  version                       = "16"
  sku_name                      = "GP_Standard_D2ds_v5"
  storage_mb                    = 65536
  backup_retention_days         = 14
  zone                          = "1"
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "pgadmin"
  administrator_password        = random_password.postgres_admin.result
  tags                          = local.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = true
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.postgres_high_availability ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "admins" {
  server_name         = azurerm_postgresql_flexible_server.main.name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = var.postgres_admin_group.object_id
  principal_name      = var.postgres_admin_group.name
  principal_type      = "Group"
}

resource "azurerm_postgresql_flexible_server_database" "foundry" {
  name      = "foundry"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_redis_cache" "main" {
  name                          = "redis-${local.prefix}-${local.suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  capacity                      = 1
  family                        = "C"
  sku_name                      = "Standard"
  minimum_tls_version           = "1.2"
  non_ssl_port_enabled          = false
  public_network_access_enabled = false
  redis_version                 = "6"
  tags                          = local.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-${local.prefix}-redis"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "redis"
    private_connection_resource_id = azurerm_redis_cache.main.id
    subresource_names              = ["redisCache"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }
}

locals {
  pg_host = azurerm_postgresql_flexible_server.main.fqdn

  secrets = merge(
    {
      "database-url"           = "postgres://foundry_app:${random_password.role["foundry_app"].result}@${local.pg_host}:5432/foundry?sslmode=require"
      "migration-database-url" = "postgres://foundry:${random_password.role["foundry"].result}@${local.pg_host}:5432/foundry?sslmode=require"
      "ml-database-url"        = "postgres://foundry_ml:${random_password.role["foundry_ml"].result}@${local.pg_host}:5432/foundry?sslmode=require"
      "redis-url"              = "rediss://:${azurerm_redis_cache.main.primary_access_key}@${azurerm_redis_cache.main.hostname}:${azurerm_redis_cache.main.ssl_port}"
      "session-secret"         = random_password.session.result
      "entra-client-secret"    = azuread_application_password.console.value
      "postgres-admin"         = random_password.postgres_admin.result
    },
    var.use_claude ? { "anthropic-api-key" = var.anthropic_api_key } : {},
  )

  secret_names = concat(
    ["database-url", "migration-database-url", "ml-database-url", "redis-url", "session-secret", "entra-client-secret", "postgres-admin"],
    var.use_claude ? ["anthropic-api-key"] : [],
  )
}

resource "azurerm_key_vault_secret" "main" {
  for_each     = toset(local.secret_names)
  name         = each.key
  value        = local.secrets[each.key]
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
}
