#!/bin/bash
# Persiapan server (Ubuntu + Postgres + Caddy yang sudah ada). Dijalankan di server sebagai user ber-sudo:
#   ssh frz@HOST 'bash -s' < infra/deploy/server-prepare.sh
# Idempoten dan hanya menambah: database/role jadwalin, Redis lokal, satu file Caddy, folder aplikasi.
# Tidak mengubah konfigurasi aplikasi lain. Tidak mencetak rahasia.
set -euo pipefail
APP_DIR=/home/$USER/jadwalin
PSQL="sudo -n -u postgres psql -v ON_ERROR_STOP=1 -Atq"

echo "== folder"
mkdir -p "$APP_DIR"/{releases,shared,logs}
chmod 700 "$APP_DIR/shared"

echo "== database"
if ! $PSQL -c "select 1 from pg_roles where rolname='jadwalin'" | grep -q 1; then
  PASS=$(openssl rand -hex 24)
  (umask 077; printf '%s' "$PASS" > "$APP_DIR/shared/db.pass")
  $PSQL -c "CREATE ROLE jadwalin LOGIN CREATEROLE PASSWORD '$PASS' CONNECTION LIMIT 25"
  # Migrasi membuat jadwalin_app/jadwalin_worker (NOLOGIN); pemilik harus boleh SET ROLE ke keduanya (PG16+).
  $PSQL -c "ALTER ROLE jadwalin SET createrole_self_grant = 'set,inherit'"
  echo "role jadwalin dibuat"
fi
if ! $PSQL -c "select 1 from pg_database where datname='jadwalin'" | grep -q 1; then
  $PSQL -c "CREATE DATABASE jadwalin OWNER jadwalin ENCODING 'UTF8'"
  echo "database jadwalin dibuat"
fi
$PSQL -d jadwalin -c "REVOKE ALL ON DATABASE jadwalin FROM PUBLIC"
# Pastikan Postgres tidak menerima login sandi dari internet (periksa, tidak diubah).
if sudo -n grep -E "^host\s+all\s+all\s+(0\.0\.0\.0/0|::/0)" /etc/postgresql/*/main/pg_hba.conf >/dev/null 2>&1; then
  echo "PERINGATAN: pg_hba membuka login dari internet; batasi sebelum produksi." >&2
fi

echo "== redis"
if ! command -v redis-server >/dev/null; then
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server >/tmp/redis-install.log 2>&1 || { tail -5 /tmp/redis-install.log; exit 1; }
fi
CONF=/etc/redis/redis.conf
sudo -n cp --update=none "$CONF" "$CONF.bak-jadwalin"
sudo -n sed -i -E 's/^bind .*/bind 127.0.0.1 -::1/; s/^protected-mode .*/protected-mode yes/; s/^# ?maxmemory <bytes>/maxmemory 64mb/; s/^# ?maxmemory-policy .*/maxmemory-policy noeviction/' "$CONF"
sudo -n grep -qE '^maxmemory 64mb' "$CONF" || echo 'maxmemory 64mb' | sudo -n tee -a "$CONF" >/dev/null
sudo -n grep -qE '^maxmemory-policy noeviction' "$CONF" || echo 'maxmemory-policy noeviction' | sudo -n tee -a "$CONF" >/dev/null
sudo -n systemctl enable redis-server >/dev/null 2>&1 || true
sudo -n systemctl restart redis-server
redis-cli ping

echo "== caddy (hanya Cloudflare + localhost boleh mengakses origin jadwalin.id)"
RANGES=$( (curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6) | tr '\n' ' ' | sed 's/  */ /g')
test "$(echo "$RANGES" | wc -w)" -gt 10
TMP=$(mktemp)
cat > "$TMP" <<CADDY
# jadwalin.id (dibuat oleh infra/deploy/server-prepare.sh). TRUST_PROXY=cloudflare mensyaratkan DNS berstatus "Proxied".
jadwalin.id, www.jadwalin.id {
	@notcf not remote_ip 127.0.0.1 ::1 $RANGES
	handle @notcf {
		respond "Akses langsung ditolak" 403
	}

	encode zstd gzip
	request_body {
		max_size 12MB
	}

	# Penyimpanan berkas (Garage) path-style: /jadwalin.files/<kunci>; Host asli tetap diteruskan (tanda tangan S3).
	handle /jadwalin.files/* {
		reverse_proxy 127.0.0.1:3900
	}

	handle {
		reverse_proxy 127.0.0.1:3100 {
			# IP klien hanya dari cf-connecting-ip; jangan percaya x-forwarded-for dari luar.
			header_up -X-Forwarded-For
		}
	}
	log {
		output file /var/log/caddy/jadwalin.access.log {
			roll_size 20MiB
			roll_keep 5
		}
	}
}
CADDY
sudo -n install -m 644 "$TMP" /etc/caddy/conf.d/jadwalin.caddy
rm -f "$TMP"
sudo -n mkdir -p /var/log/caddy && sudo -n chown caddy:caddy /var/log/caddy 2>/dev/null || true
sudo -n caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && echo "caddy: konfigurasi valid" || { echo "caddy: konfigurasi TIDAK valid, file dihapus"; sudo -n rm -f /etc/caddy/conf.d/jadwalin.caddy; exit 1; }
sudo -n systemctl reload caddy
echo "== selesai"; free -m | sed -n 2p
