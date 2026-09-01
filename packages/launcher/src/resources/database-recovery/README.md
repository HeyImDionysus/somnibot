# Supabase database recovery dump assets

These unmodified dump scripts are vendored from Supabase CLI v2.114.0,
commit `181bc4a7466559393fbf3bc31b7cfc5e74d81cf2`, under the accompanying MIT
`LICENSE`. They are not a generic full-cluster PostgreSQL backup.

## Provenance

- [Schema dump](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/migration/scripts/dump_schema.sh)
- [Data dump](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/migration/scripts/dump_data.sh)
- [Role dump](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/migration/scripts/dump_role.sh)
- [Environment recipe and managed-schema exclusions](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/migration/dump.go)
- [PostgreSQL 15 image](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/config/constants.go)
- [PostgreSQL 17 image](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/pkg/config/templates/Dockerfile)
- [Upstream license](https://github.com/supabase/cli/blob/181bc4a7466559393fbf3bc31b7cfc5e74d81cf2/apps/cli-go/LICENSE)
- [Supabase backup and restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

`descriptor.json` fixes the source revision, SHA-256 of each LF-terminated
script, environment recipe, and client image for supported server majors 15
and 17. The data variant uses PostgreSQL COPY output, matching the upstream
library default and CLI `--use-copy`. When present, Supabase CLI migration
history is captured separately as both schema and data.

## Execution and scope

SomniBot uses its own bounded Docker runner, not the Supabase CLI launcher.
The runner requires an already-cached image, resolves its immutable image ID,
disables pulls and Docker SQL logs, applies explicit resource limits, and
streams attached stdout into private, size-limited artifacts. It passes
database credentials only through child environment variables. No database
server is started by the dump client, and no host bind mount or persistent
Docker volume is needed.

Upstream filtering intentionally excludes managed schemas from schema
creation, reserved roles and role passwords, and extension-owned or internal
data as specified in the descriptor and scripts. Restoring requires a
separately designated unused Supabase database with compatible managed
components. Storage database metadata is not a backup of physical Storage
objects. A successful database rehearsal does not establish a Valkey
restore, a complete application recovery, or measured RPO/RTO.

Do not edit the scripts in place or refresh image tags independently. An
upstream update requires re-verifying the source, license, hashes,
environment recipe, resource adapter and restore compatibility. Preserve LF
line endings; `.gitattributes` already enforces them for `*.sh`.
