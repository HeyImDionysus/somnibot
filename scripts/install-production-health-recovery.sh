#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-production-health-recovery.sh must run as root" >&2
  exit 77
fi

deploy_path=${1:-}
case "$deploy_path" in
  /*) ;;
  *) echo "usage: $0 /absolute/deploy/path" >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./-]*) echo "deploy path contains unsafe characters" >&2; exit 64 ;;
  */../*|*/..) echo "deploy path must not contain parent traversal" >&2; exit 64 ;;
esac

source_script="$deploy_path/scripts/production-health-recover.sh"
if [ ! -f "$source_script" ]; then
  echo "recovery script not found at $source_script" >&2
  exit 66
fi
backup_script="$deploy_path/scripts/backup-production-valkey.sh"
restore_script="$deploy_path/scripts/restore-production-valkey.sh"
for required_script in "$backup_script" "$restore_script"; do
  [ -f "$required_script" ] || { echo "production script not found: $required_script" >&2; exit 66; }
done

for command_name in docker flock logger systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 69
  }
done

install -d -m 0755 /usr/local/lib/somnibot
install -m 0755 "$source_script" /usr/local/lib/somnibot/production-health-recover.sh
install -m 0755 "$backup_script" /usr/local/lib/somnibot/backup-production-valkey.sh
install -m 0755 "$restore_script" /usr/local/lib/somnibot/restore-production-valkey.sh
install -d -m 0700 /var/lib/somnibot-health-recovery
install -d -m 0700 /var/backups/somnibot/valkey

escaped_deploy_path=$(printf '%s' "$deploy_path" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > /etc/systemd/system/somnibot-health-recovery.service <<EOF
[Unit]
Description=SomniBot production health recovery
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/somnibot/production-health-recover.sh "$escaped_deploy_path"
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
EOF

cat > /etc/systemd/system/somnibot-health-recovery.timer <<'EOF'
[Unit]
Description=Check and recover unhealthy SomniBot services

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
RandomizedDelaySec=10s
Persistent=true
Unit=somnibot-health-recovery.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/somnibot-valkey-backup.service <<EOF
[Unit]
Description=SomniBot validated Valkey backup
Requires=docker.service
After=docker.service somnibot-health-recovery.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/somnibot/backup-production-valkey.sh "$escaped_deploy_path"
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
EOF

cat > /etc/systemd/system/somnibot-valkey-backup.timer <<'EOF'
[Unit]
Description=Create a daily validated SomniBot Valkey backup

[Timer]
OnBootSec=15min
OnCalendar=daily
RandomizedDelaySec=30min
Persistent=true
Unit=somnibot-valkey-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now somnibot-health-recovery.timer
systemctl enable --now somnibot-valkey-backup.timer
systemctl start somnibot-health-recovery.service
systemctl start somnibot-valkey-backup.service
