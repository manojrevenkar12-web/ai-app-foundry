variable "name" {
  description = "Short name used in resource names"
  type        = string
  default     = "foundry"
}

variable "environment" {
  description = "dev, test or prod"
  type        = string
  default     = "dev"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "germanywestcentral"
}

variable "public_hostname" {
  description = "The console's host name (a custom domain on the console container app), used for the sign-in redirect"
  type        = string
}

variable "image_tag" {
  description = "Tag of the api, console and fault-model images in the registry"
  type        = string
  default     = "latest"
}

variable "postgres_admin_group" {
  description = "Entra group whose members administer PostgreSQL (object id and display name)"
  type = object({
    object_id = string
    name      = string
  })
}

variable "role_groups" {
  description = "Entra groups that receive each Foundry app role, by role value"
  type        = map(list(string))
  default     = {}
}

variable "postgres_high_availability" {
  description = "Zone-redundant standby for PostgreSQL (recommended for prod)"
  type        = bool
  default     = false
}

variable "use_claude" {
  description = "Route the model aliases to Claude; false keeps the simulated provider"
  type        = bool
  default     = false
}

variable "anthropic_api_key" {
  description = "Key for Claude, used when use_claude is true"
  type        = string
  default     = ""
  sensitive   = true
}
