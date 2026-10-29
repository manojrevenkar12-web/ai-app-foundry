# The Entra ID application: the API's audience, the console's confidential client for sign-in,
# the four app roles, the group claim, and the Graph permission used when a token has too many
# groups to carry them (overage). App roles are assigned to groups, never to individuals.

locals {
  roles = {
    "Foundry.User"     = "Use apps published to you"
    "Foundry.Builder"  = "Build apps; publish tier 0 apps; approve tier 1 apps of others"
    "Foundry.Reviewer" = "Approve tier 2 apps; see every app's review"
    "Foundry.Admin"    = "Disable apps, read the audit log, manage the catalogue"
  }

  role_assignments = flatten([
    for role, groups in var.role_groups : [for g in groups : { role = role, group = g }]
  ])
}

data "azuread_application_published_app_ids" "well_known" {}

data "azuread_service_principal" "graph" {
  client_id = data.azuread_application_published_app_ids.well_known.result["MicrosoftGraph"]
}

resource "random_uuid" "role" {
  for_each = local.roles
}

resource "random_uuid" "scope" {}

resource "azuread_application" "foundry" {
  display_name            = "Foundry (${var.environment})"
  sign_in_audience        = "AzureADMyOrg"
  group_membership_claims = ["SecurityGroup"]

  api {
    requested_access_token_version = 2

    oauth2_permission_scope {
      id                         = random_uuid.scope.result
      value                      = "access_as_user"
      type                       = "User"
      enabled                    = true
      admin_consent_display_name = "Use Foundry"
      admin_consent_description  = "Lets the console call the Foundry API as the signed-in person"
      user_consent_display_name  = "Use Foundry"
      user_consent_description   = "Lets the console call the Foundry API as you"
    }
  }

  dynamic "app_role" {
    for_each = local.roles
    content {
      id                   = random_uuid.role[app_role.key].result
      value                = app_role.key
      display_name         = app_role.key
      description          = app_role.value
      allowed_member_types = ["User"]
      enabled              = true
    }
  }

  optional_claims {
    access_token {
      name = "groups"
    }
  }

  web {
    redirect_uris = ["https://${var.public_hostname}/auth/callback"]
  }

  required_resource_access {
    resource_app_id = data.azuread_application_published_app_ids.well_known.result["MicrosoftGraph"]

    resource_access {
      id   = data.azuread_service_principal.graph.app_role_ids["GroupMember.Read.All"]
      type = "Role"
    }
  }
}

resource "azuread_application_identifier_uri" "api" {
  application_id = azuread_application.foundry.id
  identifier_uri = "api://${azuread_application.foundry.client_id}"
}

resource "azuread_service_principal" "foundry" {
  client_id                    = azuread_application.foundry.client_id
  app_role_assignment_required = true
}

# admin consent for the Graph application permission
resource "azuread_app_role_assignment" "graph_groups" {
  app_role_id         = data.azuread_service_principal.graph.app_role_ids["GroupMember.Read.All"]
  principal_object_id = azuread_service_principal.foundry.object_id
  resource_object_id  = data.azuread_service_principal.graph.object_id
}

resource "azuread_app_role_assignment" "groups" {
  for_each = { for a in local.role_assignments : "${a.role}:${a.group}" => a }

  app_role_id         = azuread_service_principal.foundry.app_role_ids[each.value.role]
  principal_object_id = each.value.group
  resource_object_id  = azuread_service_principal.foundry.object_id
}

resource "azuread_application_password" "console" {
  application_id = azuread_application.foundry.id
  display_name   = "console sign-in (${var.environment})"
}
