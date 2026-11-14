#!/bin/bash
# Env produksi + unit systemd untuk jadwalin (web port 3100, worker). Dijalankan di server:
#   ssh frz@HOST 'bash -s' < infra/deploy/server-app.sh
# Membaca rahasia dari ~/jadwalin/shared/* (db.pass, smtp.key, turnstile.*, s3.*), menulis web.env/worker.env (600).
# Tidak mencetak rahasia. Idempoten; BETTER_AUTH_SECRET dibuat sekali. Layanan di-enable, dijalankan oleh release.sh.
set -euo pipefail
SH=/home/$USER/jadwalin/shared
DOMAIN=${DOMAIN:-jadwalin.id}
SMTP_LOGIN=${SMTP_LOGIN:?isi SMTP_LOGIN (login SMTP Brevo)}
for f in db.pass smtp.key turnstile.site turnstile.secret s3.keyid s3.secret; do [ -s "$SH/$f" ] || { echo "kurang: $SH/$f" >&2; exit 1; }; done
umask 077
[ -s "$SH/auth.secret" ] || openssl rand -base64 32 | tr -d '\n' > "$SH/auth.secret"
LOGIN_ENC=${SMTP_LOGIN//@/%40}
common() {
cat <<ENV
NODE_ENV=production
DATABASE_URL=postgres://jadwalin:$(cat $SH/db.pass)@127.0.0.1:5432/jadwalin
REDIS_URL=redis://127.0.0.1:6379
BETTER_AUTH_SECRET=$(cat $SH/auth.secret)
BETTER_AUTH_URL=https://$DOMAIN
S3_REGION=garage
S3_BUCKET=jadwalin.files
S3_ACCESS_KEY_ID=$(cat $SH/s3.keyid)
S3_SECRET_ACCESS_KEY=$(cat $SH/s3.secret)
S3_FORCE_PATH_STYLE=true
EMAIL_FROM="jadwalin <noreply@$DOMAIN>"
SMTP_URL=smtp://$LOGIN_ENC:$(cat $SH/smtp.key)@smtp-relay.brevo.com:587
NEXT_PUBLIC_TURNSTILE_SITE_KEY=$(cat $SH/turnstile.site)
TURNSTILE_SECRET_KEY=$(cat $SH/turnstile.secret)
TRUST_PROXY=cloudflare
LOG_LEVEL=info
ENV
}
{ common; echo "S3_ENDPOINT=https://$DOMAIN"; echo "PORT=3100"; echo "HOSTNAME=127.0.0.1"; } > "$SH/web.env"
{ common; echo "S3_ENDPOINT=http://127.0.0.1:3900"; } > "$SH/worker.env"
chmod 600 "$SH/web.env" "$SH/worker.env"
echo "env ditulis: web.env ($(wc -l < $SH/web.env) baris), worker.env ($(wc -l < $SH/worker.env) baris)"

unit() { # nama deskripsi workdir exec envfile memmax
sudo -n tee /etc/systemd/system/$1.service >/dev/null <<UNIT
[Unit]
Description=$2
After=network-online.target postgresql.service redis-server.service garage.service
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$3
EnvironmentFile=$SH/$5
ExecStart=$4
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
MemoryMax=$6

[Install]
WantedBy=multi-user.target
UNIT
}
NODE=$(command -v node)
unit jadwalin-web "jadwalin web (Next.js)" /home/$USER/jadwalin/current/web/apps/web "$NODE --max-old-space-size=320 server.js" web.env 450M
unit jadwalin-worker "jadwalin worker (antrean, cron)" /home/$USER/jadwalin/current/worker "$NODE --max-old-space-size=160 main.mjs" worker.env 220M
sudo -n systemctl daemon-reload
sudo -n systemctl enable jadwalin-web jadwalin-worker >/dev/null 2>&1
echo "unit systemd terpasang (belum dijalankan)"
