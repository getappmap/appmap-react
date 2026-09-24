#!/usr/bin/env bash
# One command: clean clone of supabase/supabase at the pinned SHA, then the
# full-stack acceptance run -- the edge-functions example React app in real
# Chromium, calling its select-from-table-with-auth-rls Deno function, both
# recorded, joined by appmap-link -- and checks A-J plus L (the cross-map
# link). Exits non-zero if any check is not PASS (J is MEASURED).
#
# Needs: node >= 22, git, curl, python3, PostgreSQL server binaries
# (initdb/pg_ctl/psql), network access to github.com, jsr.io and
# registry.npmjs.org for the one-time downloads. Everything the app talks to
# runs on 127.0.0.1; no deployed service is called.
#
# Env knobs: WORK (scratch dir, default /tmp/acc-fullstack-work; must be
# readable by the postgres user when run as root), DENO (deno binary),
# POSTGREST, GOTRUE (supabase/auth binary with migrations/ beside it),
# CHROME (Chromium executable; default: /opt/pw-browsers if present, else
# Playwright's own download), PGBIN (postgres bin dir).
set -uo pipefail

ACC=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$ACC/../.." && pwd)
export WORK=${WORK:-/tmp/acc-fullstack-work}
APP_REPO=https://github.com/supabase/supabase
APP_SHA=74a3be9aa8706755e05f7326f3d25472729cd977
GOTRUE_VERSION=v2.177.0
POSTGREST_VERSION=v12.2.12
APPMAP_CLI_VERSION=3.204.0
VALIDATE_VERSION=2.5.1
PLAYWRIGHT_VERSION=1.56.1
mkdir -p "$WORK/bin"
export PATH="$WORK/bin:$PATH"
export APPMAP_TELEMETRY_DISABLED=true DENO_NO_UPDATE_CHECK=1
SETUP_NOTES=()
setup_ok=1
fail_setup() { setup_ok=0; SETUP_NOTES+=("$1"); echo "== SETUP FAILED: $1"; }

# --- ports: refuse to run next to something else on them ----------------------
for port in 54321 54339 54340 54341 18100 3300; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is already in use (another acceptance run?); stop it first" >&2
    exit 2
  fi
done

# --- tools -------------------------------------------------------------------
if [ -n "${DENO:-}" ]; then ln -sf "$DENO" "$WORK/bin/deno"; fi
if ! command -v deno >/dev/null; then
  echo "== installing deno (latest 2.x release binary)"
  curl -fsSL -o "$WORK/deno.zip" https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip &&
    python3 -c "import zipfile;zipfile.ZipFile('$WORK/deno.zip').extractall('$WORK/bin')" && chmod +x "$WORK/bin/deno" ||
    fail_setup "deno download"
fi

if [ -z "${POSTGREST:-}" ]; then
  if [ ! -x "$WORK/bin/postgrest" ]; then
    echo "== downloading PostgREST $POSTGREST_VERSION"
    curl -fsSL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x86-64.tar.xz" |
      tar xJ -C "$WORK/bin" || fail_setup "postgrest download"
  fi
  export POSTGREST="$WORK/bin/postgrest"
fi

if [ -z "${GOTRUE:-}" ]; then
  if [ ! -x "$WORK/gotrue/auth" ]; then
    echo "== downloading GoTrue (supabase/auth) $GOTRUE_VERSION"
    mkdir -p "$WORK/gotrue"
    curl -fsSL "https://github.com/supabase/auth/releases/download/$GOTRUE_VERSION/auth-$GOTRUE_VERSION-x86.tar.gz" |
      tar xz -C "$WORK/gotrue" || fail_setup "gotrue download"
  fi
  export GOTRUE="$WORK/gotrue/auth"
fi

export APPMAP_TOOLS="$WORK/tools"
if [ ! -x "$APPMAP_TOOLS/node_modules/.bin/appmap" ] || [ ! -d "$APPMAP_TOOLS/node_modules/playwright-core" ]; then
  echo "== installing official AppMap CLI + validator, playwright-core"
  mkdir -p "$APPMAP_TOOLS"
  (cd "$APPMAP_TOOLS" && { [ -f package.json ] || npm init -y >/dev/null; } &&
    npm install --no-audit --no-fund --silent "@appland/appmap@$APPMAP_CLI_VERSION" \
      "@appland/appmap-validate@$VALIDATE_VERSION" "playwright-core@$PLAYWRIGHT_VERSION") || fail_setup "tools install"
fi
if [ -z "${CHROME:-}" ] && [ -x /opt/pw-browsers/chromium-1194/chrome-linux/chrome ]; then
  export CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
fi

# recorder deps (babel for the build-time transform) at the recorder repo root
[ -d "$ROOT/node_modules/@babel/core" ] || (cd "$ROOT" && npm ci --no-audit --no-fund --silent) || fail_setup "recorder npm ci"
VITE_VERSION=$(node -p "require('$ROOT/node_modules/vite/package.json').version")

# --- app at the pinned SHA (clean clone every run) ---------------------------
echo "== cloning $APP_REPO @ $APP_SHA (sparse: examples/edge-functions app + function)"
rm -rf "$WORK/supabase"
git init -q "$WORK/supabase"
git -C "$WORK/supabase" remote add origin "$APP_REPO"
git -C "$WORK/supabase" config core.sparseCheckout true
cat > "$WORK/supabase/.git/info/sparse-checkout" <<EOF
examples/edge-functions/app/
examples/edge-functions/supabase/functions/select-from-table-with-auth-rls/
examples/edge-functions/supabase/functions/_shared/
examples/edge-functions/supabase/migrations/
examples/edge-functions/supabase/config.toml
EOF
git -C "$WORK/supabase" fetch -q --depth 1 --filter=blob:none origin "$APP_SHA" &&
  git -C "$WORK/supabase" -c advice.detachedHead=false checkout -q FETCH_HEAD || fail_setup "clone"
[ "$(git -C "$WORK/supabase" rev-parse HEAD 2>/dev/null)" = "$APP_SHA" ] || fail_setup "app HEAD is not $APP_SHA"
APP="$WORK/supabase/examples/edge-functions/app"

echo "== installing the app (npm install --legacy-peer-deps: its documented npm install fails on npm >= 7)"
(cd "$APP" && npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps > "$WORK/app-npm-install.log" 2>&1) ||
  fail_setup "app npm install (see $WORK/app-npm-install.log)"
echo "== adding vite@$VITE_VERSION and the recorder as dev dependencies"
(cd "$APP" && npm install -D --no-audit --no-fund --ignore-scripts --legacy-peer-deps "vite@$VITE_VERSION" "file:$ROOT/recorder" \
  > "$WORK/app-npm-add.log" 2>&1) || fail_setup "adding vite + recorder"
cp "$ACC"/app-config/*.mjs "$APP/"

# --- local stack: Postgres + GoTrue + PostgREST --------------------------------
export APPDIR="$WORK/supabase"
"$ACC/infra/stack.sh" stop >/dev/null 2>&1 || true
"$ACC/infra/stack.sh" start || fail_setup "local stack (postgres/gotrue/postgrest) did not start"
trap '"$ACC/infra/stack.sh" stop' EXIT

echo "== versions"
deno --version | head -1
node --version
"$POSTGREST" --version 2>/dev/null | head -1
"$GOTRUE" version 2>/dev/null | head -1
"$APPMAP_TOOLS/node_modules/.bin/appmap" --version
echo "repo HEAD $(git -C "$ROOT" rev-parse HEAD); recorder code last changed in $(git -C "$ROOT" log -1 --format=%H -- recorder deno linker); app $APP_SHA"

note="clean sparse clone at $APP_SHA; npm install --legacy-peer-deps; vite@$VITE_VERSION + recorder added as dev deps; GoTrue $GOTRUE_VERSION, PostgREST $POSTGREST_VERSION"
[ ${#SETUP_NOTES[@]} -gt 0 ] && note="$note; FAILED: ${SETUP_NOTES[*]}"
python3 -c "import json,sys; json.dump({'ok': sys.argv[1] == '1', 'note': sys.argv[2]}, open(sys.argv[3], 'w'))" "$setup_ok" "$note" "$WORK/setup.json"
if [ "$setup_ok" != 1 ]; then
  echo "A FAIL (setup): $note"
  exit 1
fi

node "$ACC/harness.mjs" 2>&1 | tee "$WORK/harness.log"
rc=${PIPESTATUS[0]}
cp "$WORK/harness.log" "$ACC/evidence/run.log" 2>/dev/null
exit $rc
