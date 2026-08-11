#!/bin/sh

compose_project_name=somnibot-prod
compose_file="$deploy_path/docker-compose.prod.yml"
compose_override_file="$deploy_path/.somnibot/launcher-tailscale-funnel.compose.yml"

production_compose() {
  if [ -f "$compose_override_file" ]; then
    docker compose \
      --project-name "$compose_project_name" \
      --project-directory "$deploy_path" \
      -f "$compose_file" \
      -f "$compose_override_file" \
      "$@"
  else
    docker compose \
      --project-name "$compose_project_name" \
      --project-directory "$deploy_path" \
      -f "$compose_file" \
      "$@"
  fi
}
