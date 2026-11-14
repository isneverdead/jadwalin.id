#!/bin/bash
# Rilis dari Mac ke server (tanpa Docker, tanpa build di server).
#   NEXT_PUBLIC_TURNSTILE_SITE_KEY=... infra/deploy/release.sh frz@HOST
# 1) build web standalone  2) bundel worker  3) unggah ke ~/jadwalin/releases/<waktu>  4) pindahkan symlink `current`, restart.
# Migrasi database dijalankan terpisah dari Mac lewat terowongan SSH SEBELUM rilis ini (maju-saja).
set -euo pipefail
HOST=${1:?contoh: infra/deploy/release.sh frz@103.226.139.61}
cd "$(dirname "$0")/../.."
: "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:?site key Turnstile wajib (tertanam saat build)}"
REL=$(date +%Y%m%d%H%M%S)
STAGE=$(mktemp -d)

echo "== build web"
(cd apps/web && rm -rf .next-rel && BUILD_STANDALONE=1 NEXT_DIST_DIR=.next-rel NODE_ENV=production node_modules/.bin/next build >/dev/null)
cp -R apps/web/.next-rel/standalone "$STAGE/web"
mkdir -p "$STAGE/web/apps/web/.next-rel"
cp -R apps/web/.next-rel/static "$STAGE/web/apps/web/.next-rel/static"

echo "== bundel worker"
mkdir -p "$STAGE/worker"
ESB=$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)
(cd apps/worker && "../../$ESB" src/main.ts --bundle --platform=node --format=esm --target=node22 --outfile="$STAGE/worker/main.mjs" \
  --banner:js="import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);" --log-level=warning)

echo "== unggah $REL"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf - . | ssh -o BatchMode=yes "$HOST" "mkdir -p ~/jadwalin/releases/$REL && tar -C ~/jadwalin/releases/$REL -xzf -"
rm -rf "$STAGE"
ssh -o BatchMode=yes "$HOST" "set -e; cd ~/jadwalin; ln -sfn releases/$REL current; sudo -n systemctl restart jadwalin-web jadwalin-worker; ls -1dt releases/* | tail -n +4 | xargs -r rm -rf; echo release aktif: $REL"
