output "console_fqdn" {
  description = "Point the custom domain (public_hostname) at this, then bind it to the console app"
  value       = azurerm_container_app.console.ingress[0].fqdn
}

output "registry" {
  description = "Push foundry-api, foundry-console and foundry-fault-model images here"
  value       = azurerm_container_registry.main.login_server
}

output "entra_client_id" {
  description = "The API's audience and the console's client id"
  value       = azuread_application.foundry.client_id
}

output "postgres_host" {
  description = "Private host name; run scripts/bootstrap-azure.sh from inside the network"
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "key_vault" {
  description = "Holds every secret the services read"
  value       = azurerm_key_vault.main.name
}
