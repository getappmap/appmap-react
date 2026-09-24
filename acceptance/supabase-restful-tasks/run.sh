#!/usr/bin/env bash
# One command: clean clone of supabase/supabase at the pinned SHA, then every
# acceptance check for the AppMap Deno recorder against its restful-tasks
# edge function. Exits non-zero if any check FAILs.
#
# Needs: node >= 22, git, curl, PostgreSQL server binaries (initdb/pg_ctl/psql),
# network access to github.com, jsr.io and registry.npmjs.org for the one-time
# downloads. Everything the app talks to runs on 127.0.0.1.
#
# Env knobs: WORK (scratch dir, default /tmp/acc-deno-work), DENO (deno binary),
# POSTGREST (postgrest binary), APPMAP_TOOLS (dir with @appland/appmap and
# @appland/appmap-validate installed), PGBIN (postgres bin dir).
set -euo pipefail

ACC=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$ACC/../.." && pwd)
export WORK=${WORK:-/tmp/acc-deno-work}
APP_REPO=https://github.com/supabase/supabase
APP_SHA=74a3be9aa8706755e05f7326f3d25472729cd977
APP_PATH=examples/edge-functions/supabase/functions/restful-tasks
mkdir -p "$WORK/bin"
export PATH="$WORK/bin:$PATH"

# --- tools -----------------------------------------------------------------
if [ -n "${DENO:-}" ]; then ln -sf "$DENO" "$WORK/bin/deno"; fi
if ! command -v deno >/dev/null; then
  echo "== installing deno (latest 2.x release binary)"
  curl -fsSL -o "$WORK/deno.zip" https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
  python3 -c "import zipfile;zipfile.ZipFile('$WORK/deno.zip').extractall('$WORK/bin')"
  chmod +x "$WORK/bin/deno"
fi
DENO=$(command -v deno)
export DENO

if [ -z "${POSTGREST:-}" ]; then
  if [ ! -x "$WORK/bin/postgrest" ]; then
    echo "== downloading PostgREST v12.2.12"
    curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v12.2.12/postgrest-v12.2.12-linux-static-x86-64.tar.xz | tar xJ -C "$WORK/bin"
  fi
  export POSTGREST="$WORK/bin/postgrest"
fi

if [ -z "${APPMAP_TOOLS:-}" ]; then
  export APPMAP_TOOLS="$WORK/appmap-tools"
  if [ ! -x "$APPMAP_TOOLS/node_modules/.bin/appmap-validate" ]; then
    echo "== installing official AppMap CLI + validator"
    mkdir -p "$APPMAP_TOOLS"
    (cd "$APPMAP_TOOLS" && npm init -y >/dev/null && npm i --silent @appland/appmap@latest @appland/appmap-validate@latest ajv@8)
  fi
fi
export APPMAP_TELEMETRY_DISABLED=true DENO_NO_UPDATE_CHECK=1

# recorder deps (babel for the build-time transform)
[ -d "$ROOT/node_modules/@babel/core" ] || (cd "$ROOT" && npm ci --silent)

# --- app at the pinned SHA (clean clone every run) ---------------------------
rm -rf "$WORK/supabase"
git init -q "$WORK/supabase"
git -C "$WORK/supabase" remote add origin "$APP_REPO"
git -C "$WORK/supabase" config core.sparseCheckout true
echo "$APP_PATH/" > "$WORK/supabase/.git/info/sparse-checkout"
git -C "$WORK/supabase" fetch -q --depth 1 --filter=blob:none origin "$APP_SHA"
git -C "$WORK/supabase" -c advice.detachedHead=false checkout -q FETCH_HEAD
test "$(git -C "$WORK/supabase" rev-parse HEAD)" = "$APP_SHA"

# --- local database: real Postgres + real PostgREST ------------------------
"$ACC/infra/db.sh" stop || true
rm -rf "$WORK/pgdata"
"$ACC/infra/db.sh" start
trap '"$ACC/infra/db.sh" stop' EXIT

echo "== versions"
deno --version | head -1
node --version
"$POSTGREST" --version
"$(printf '%s\n' /usr/lib/postgresql/*/bin | sort -V | tail -1)/postgres" --version
"$APPMAP_TOOLS/node_modules/.bin/appmap" --version
echo "repo HEAD $(git -C "$ROOT" rev-parse HEAD); recorder code last changed in $(git -C "$ROOT" log -1 --format=%H -- deno recorder); app $APP_SHA"

set +e
node "$ACC/harness.mjs" 2>&1 | tee "$WORK/harness.log"
rc=${PIPESTATUS[0]}
cp "$WORK/harness.log" "$ACC/evidence/run.log"
exit "$rc"
