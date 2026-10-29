# The services on Azure Container Apps. Only the console is reachable from outside; it forwards
# /v1 and /auth to the API on the environment's internal network, so browser, cookie and CSP see
# one origin. Every secret is a Key Vault reference read with the apps' managed identity.

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.prefix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  tags                       = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_storage_account" "models" {
  name                     = "st${var.name}${var.environment}${local.suffix}"
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = "ZRS"
  min_tls_version          = "TLS1_2"
  tags                     = local.tags
}

resource "azurerm_storage_share" "models" {
  name               = "models"
  storage_account_id = azurerm_storage_account.models.id
  quota              = 5
}

resource "azurerm_container_app_environment_storage" "models" {
  name                         = "models"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.models.name
  share_name                   = azurerm_storage_share.models.name
  access_key                   = azurerm_storage_account.models.primary_access_key
  access_mode                  = "ReadWrite"
}

locals {
  registry = azurerm_container_registry.main.login_server
  kv       = { for k, v in azurerm_key_vault_secret.main : k => v.versionless_id }

  api_env = {
    NODE_ENV               = "production"
    PORT                   = "8080"
    PUBLIC_URL             = "https://${var.public_hostname}"
    CONSOLE_URL            = "https://${var.public_hostname}"
    ENTRA_TENANT_ID        = data.azurerm_client_config.current.tenant_id
    ENTRA_CLIENT_ID        = azuread_application.foundry.client_id
    ENTRA_AUTHORITY        = "https://login.microsoftonline.com"
    FAULT_MODEL_URL        = "http://${local.prefix}-fault-model"
    DEV_IDP                = "off"
    LOG_LEVEL              = "info"
    INVOCATIONS_PER_MINUTE = "120"
  }

  api_secrets = merge(
    {
      DATABASE_URL           = "database-url"
      MIGRATION_DATABASE_URL = "migration-database-url"
      REDIS_URL              = "redis-url"
      SESSION_SECRET         = "session-secret"
      ENTRA_CLIENT_SECRET    = "entra-client-secret"
    },
    var.use_claude ? { ANTHROPIC_API_KEY = "anthropic-api-key" } : {},
  )
}

resource "azurerm_container_app" "api" {
  name                         = "${local.prefix}-api"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.apps.id
  }

  dynamic "secret" {
    for_each = toset(values(local.api_secrets))
    content {
      name                = secret.value
      key_vault_secret_id = local.kv[secret.value]
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }

  ingress {
    external_enabled = false
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 2
    max_replicas = 10

    container {
      name   = "api"
      image  = "${local.registry}/foundry-api:${var.image_tag}"
      cpu    = 1
      memory = "2Gi"

      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secrets
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }

      readiness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/readyz"
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  depends_on = [azurerm_role_assignment.pull, azurerm_role_assignment.apps_secrets]
}

resource "azurerm_container_app" "fault_model" {
  name                         = "${local.prefix}-fault-model"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.apps.id
  }

  secret {
    name                = "ml-database-url"
    key_vault_secret_id = local.kv["ml-database-url"]
    identity            = azurerm_user_assigned_identity.apps.id
  }

  ingress {
    external_enabled = false
    target_port      = 8090
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "fault-model"
      image  = "${local.registry}/foundry-fault-model:${var.image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name        = "ML_DATABASE_URL"
        secret_name = "ml-database-url"
      }

      env {
        name  = "MODEL_FILE"
        value = "/model/fault-model.joblib"
      }

      volume_mounts {
        name = "models"
        path = "/model"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8090
        path      = "/healthz"
      }
    }

    volume {
      name         = "models"
      storage_name = azurerm_container_app_environment_storage.models.name
      storage_type = "AzureFile"
    }
  }

  depends_on = [azurerm_role_assignment.pull, azurerm_role_assignment.apps_secrets]
}

resource "azurerm_container_app" "console" {
  name                         = "${local.prefix}-console"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.apps.id
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 5

    container {
      name   = "console"
      image  = "${local.registry}/foundry-console:${var.image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "API_UPSTREAM"
        value = "http://${azurerm_container_app.api.name}"
      }
    }
  }

  depends_on = [azurerm_role_assignment.pull]
}

# Migrations run as a job before a new API revision takes traffic (the release pipeline starts it).
resource "azurerm_container_app_job" "migrate" {
  name                         = "${local.prefix}-migrate"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.apps.id
  }

  secret {
    name                = "migration-database-url"
    key_vault_secret_id = local.kv["migration-database-url"]
    identity            = azurerm_user_assigned_identity.apps.id
  }

  template {
    container {
      name    = "migrate"
      image   = "${local.registry}/foundry-api:${var.image_tag}"
      cpu     = 0.5
      memory  = "1Gi"
      command = ["/nodejs/bin/node", "dist/cli/migrate.js"]

      env {
        name        = "MIGRATION_DATABASE_URL"
        secret_name = "migration-database-url"
      }
    }
  }

  depends_on = [azurerm_role_assignment.pull, azurerm_role_assignment.apps_secrets]
}

# The fault model retrains nightly from operational data and writes the model to the share.
resource "azurerm_container_app_job" "train" {
  name                         = "${local.prefix}-train"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  replica_timeout_in_seconds   = 3600
  replica_retry_limit          = 1
  tags                         = local.tags

  schedule_trigger_config {
    cron_expression          = "17 2 * * *"
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.apps.id
  }

  secret {
    name                = "ml-database-url"
    key_vault_secret_id = local.kv["ml-database-url"]
    identity            = azurerm_user_assigned_identity.apps.id
  }

  template {
    container {
      name    = "train"
      image   = "${local.registry}/foundry-fault-model:${var.image_tag}"
      cpu     = 1
      memory  = "2Gi"
      command = ["python", "-m", "fault_model.train"]

      env {
        name        = "ML_DATABASE_URL"
        secret_name = "ml-database-url"
      }

      env {
        name  = "MODEL_FILE"
        value = "/model/fault-model.joblib"
      }

      env {
        name  = "REPORT_FILE"
        value = "/model/latest.json"
      }

      volume_mounts {
        name = "models"
        path = "/model"
      }
    }

    volume {
      name         = "models"
      storage_name = azurerm_container_app_environment_storage.models.name
      storage_type = "AzureFile"
    }
  }

  depends_on = [azurerm_role_assignment.pull, azurerm_role_assignment.apps_secrets]
}
