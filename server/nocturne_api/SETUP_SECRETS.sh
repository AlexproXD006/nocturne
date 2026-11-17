#!/bin/bash
# SETUP_SECRETS.sh — run this once to create the Nocturne secrets file.
# Bare-metal (systemd) installs only; for Docker use the repo-root .env.example instead.
# Run as root (or the service user). The file is owned by the service user, mode 0600.
# Edit NOCTURNE_PUBLIC_URL / NOCTURNE_CORS_ORIGINS below to your own domain afterwards.
set -euo pipefail

SERVICE_USER=musicserver
ENV_FILE=/opt/music-server/.nocturne.env

if [ -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE already exists. Remove it first if you want to regenerate."
  exit 1
fi

JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
MEDIA_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")

cat > "$ENV_FILE" <<EOF
# Nocturne secrets — keep this file at mode 0600, owned by $SERVICE_USER.
# Never commit this file to git.

NOCTURNE_JWT_SECRET=${JWT_SECRET}
NOCTURNE_MEDIA_SECRET=${MEDIA_SECRET}

# Public URL — must match what the browser sees (https://music.example.com)
NOCTURNE_PUBLIC_URL=https://music.example.com

# DB path (Nocturne's own database, separate from NOVA's library.db)
NOCTURNE_DB_PATH=/music/nocturne.db

# Directory for the hosted web build
NOCTURNE_WEB_DIR=/opt/nocturne/web

# CORS origins (Nocturne desktop/Android + web)
NOCTURNE_CORS_ORIGINS=app://nocturne,capacitor://localhost,https://localhost,https://music.example.com

# Trusted proxy IPs (NPM sends X-Forwarded-For from this IP)
NOCTURNE_TRUSTED_PROXIES=127.0.0.1

# First-run admin (only used if no accounts exist — delete after first login)
# NOCTURNE_ADMIN_USER=admin
# NOCTURNE_ADMIN_PASS=changeme_set_a_strong_password_here

EOF

chmod 0600 "$ENV_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE" 2>/dev/null || true
echo "Created $ENV_FILE (mode 0600)"
echo ""
echo "IMPORTANT: Set NOCTURNE_ADMIN_USER and NOCTURNE_ADMIN_PASS in $ENV_FILE"
echo "before starting the server for the first time, then comment them out after"
echo "the first login."
echo ""
echo "Next: add  EnvironmentFile=/opt/music-server/.nocturne.env  to the"
echo "[Service] section of /etc/systemd/system/music-server.service,"
echo "then run:  systemctl daemon-reload"
