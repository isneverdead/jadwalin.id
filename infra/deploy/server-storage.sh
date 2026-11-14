#!/bin/bash
# Penyimpanan berkas S3 di server sendiri (Garage, satu berkas biner), pengganti R2 bila tanpa kartu.
#   ssh frz@HOST 'bash -s' < infra/deploy/server-storage.sh
# Idempoten. Garage hanya mendengarkan 127.0.0.1; akses publik lewat Caddy pada path /<bucket>/* (path-style,
# satu origin dengan aplikasi sehingga CORS tidak diperlukan). Kunci akses disimpan di ~/jadwalin/shared (600), tidak dicetak.
set -euo pipefail
GARAGE_VERSION=v2.5.0
BUCKET=jadwalin.files           # titik di nama bucket mustahil bentrok dengan slug usaha
KEYNAME=jadwalin-app
SHARED=/home/$USER/jadwalin/shared
BIN=/usr/local/bin/garage

echo "== unduh garage $GARAGE_VERSION"
if [ ! -x "$BIN" ]; then
  T=$(mktemp)
  curl -fsSL -o "$T" "https://garagehq.deuxfleurs.fr/_releases/$GARAGE_VERSION/x86_64-unknown-linux-musl/garage"
  head -c 4 "$T" | grep -q "ELF" || { echo "bukan berkas ELF, dibatalkan" >&2; exit 1; }
  chmod +x "$T"; "$T" --version >/dev/null
  echo "sha256: $(sha256sum "$T" | cut -d' ' -f1)"
  sudo -n install -m 755 "$T" "$BIN"; rm -f "$T"
fi
"$BIN" --version | head -1

echo "== pengguna + konfigurasi"
id garage >/dev/null 2>&1 || sudo -n useradd --system --home /var/lib/garage --shell /usr/sbin/nologin garage
if [ ! -f /etc/garage.toml ]; then
  RPC=$(openssl rand -hex 32)
  sudo -n tee /etc/garage.toml >/dev/null <<TOML
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$RPC"

[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:3900"
TOML
  sudo -n chown root:garage /etc/garage.toml; sudo -n chmod 640 /etc/garage.toml
fi
sudo -n tee /etc/systemd/system/garage.service >/dev/null <<'UNIT'
[Unit]
Description=Garage (S3 storage untuk jadwalin)
After=network-online.target
Wants=network-online.target

[Service]
User=garage
Group=garage
ExecStart=/usr/local/bin/garage -c /etc/garage.toml server
Restart=on-failure
RestartSec=3
StateDirectory=garage
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=300M

[Install]
WantedBy=multi-user.target
UNIT
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now garage >/dev/null 2>&1
for i in $(seq 1 20); do sudo -n "$BIN" -c /etc/garage.toml status >/dev/null 2>&1 && break; sleep 1; done

echo "== layout (satu node)"
G="sudo -n $BIN -c /etc/garage.toml"
if ! $G layout show 2>/dev/null | grep -q "dc1"; then
  NODE=$($G node id -q 2>/dev/null | cut -d@ -f1)
  $G layout assign -z dc1 -c 5G "$NODE" >/dev/null
  $G layout apply --version 1 >/dev/null
fi
$G status | sed -n 1,6p

echo "== bucket + kunci"
$G bucket info "$BUCKET" >/dev/null 2>&1 || $G bucket create "$BUCKET" >/dev/null
if [ ! -f "$SHARED/s3.secret" ]; then
  OUT=$($G key create "$KEYNAME")
  (umask 077
   printf '%s' "$(echo "$OUT" | awk '/Key ID:/{print $3}')" > "$SHARED/s3.keyid"
   printf '%s' "$(echo "$OUT" | awk '/Secret key:/{print $3}')" > "$SHARED/s3.secret")
fi
$G bucket allow --read --write --owner "$BUCKET" --key "$KEYNAME" >/dev/null
echo "keyid: $(wc -c < $SHARED/s3.keyid) char, secret: $(wc -c < $SHARED/s3.secret) char"
$G bucket info "$BUCKET" | sed -n 1,8p
echo "== selesai"; free -m | sed -n 2p
