#!/usr/bin/env bash
# Local stand-in for `supabase start` for the edge-functions example app:
# real PostgreSQL + real GoTrue (supabase/auth) + real PostgREST, all on
# 127.0.0.1. Nothing here talks to a deployed service.
#
# usage: stack.sh start|stop|reset
#   env: WORK (scratch dir), APPDIR (supabase checkout), PGBIN, POSTGREST,
#        GOTRUE (supabase/auth binary; its migrations/ dir must sit next to it)
#
# The JWT secret is the well-known local-dev secret the Supabase CLI uses,
# because the app's own src/utils/supabaseClient.js falls back to the CLI's
# well-known local anon key (signed with it) when no env is set. Using it
# means the app runs with no .env file at all.
set -euo pipefail
WORK=${WORK:?WORK must be set}
APPDIR=${APPDIR:-$WORK/supabase}
PGBIN=${PGBIN:-$(printf '%s\n' /usr/lib/postgresql/*/bin | sort -V | tail -1)}
PGPORT=${PGPORT:-54339}
PGRST_PORT=${PGRST_PORT:-54340}
GOTRUE_PORT=${GOTRUE_PORT:-54341}
POSTGREST=${POSTGREST:?POSTGREST must point at a postgrest binary}
GOTRUE=${GOTRUE:?GOTRUE must point at a supabase/auth binary}
JWT_SECRET=${JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}
MIGRATIONS=$APPDIR/examples/edge-functions/supabase/migrations
PGDATA=$WORK/pgdata
RUNAS=()
if [ "$(id -u)" = 0 ]; then RUNAS=(runuser -u postgres --); fi
PSQL=(psql -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
export PGOPTIONS="-c client_min_messages=warning"

# What the supabase/postgres image sets up before any project migration runs:
# the API roles, the auth schema, and default grants on public so tables a
# migration creates are reachable through PostgREST (RLS still applies).
platform_sql() {
cat <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'authpass'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth;
create schema if not exists extensions;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL
}

wait_http() { for _ in $(seq 1 100); do curl -s -o /dev/null "$1" && return 0; sleep 0.2; done; return 1; }

gotrue_env() {
  GOTRUE_ENV=(GOTRUE_DB_DRIVER=postgres
    DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/postgres?sslmode=disable&search_path=auth"
    GOTRUE_DB_MIGRATIONS_PATH="$(dirname "$GOTRUE")/migrations"
    GOTRUE_API_HOST=127.0.0.1 PORT="$GOTRUE_PORT"
    API_EXTERNAL_URL=http://localhost:54321/auth/v1 GOTRUE_SITE_URL=http://127.0.0.1:3300
    GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated
    GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
    GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_DISABLE_SIGNUP=false
    GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_LOG_LEVEL=warn)
}

start_services() {
  # GoTrue: its own migrations into the auth schema, then serve.
  gotrue_env
  env "${GOTRUE_ENV[@]}" "$GOTRUE" migrate > "$WORK/gotrue-migrate.log" 2>&1 ||
    { echo "gotrue migrate failed"; cat "$WORK/gotrue-migrate.log"; exit 1; }
  nohup env "${GOTRUE_ENV[@]}" "$GOTRUE" serve > "$WORK/gotrue.log" 2>&1 &
  echo $! > "$WORK/gotrue.pid"
  wait_http "http://127.0.0.1:$GOTRUE_PORT/health" || { echo "gotrue did not start"; cat "$WORK/gotrue.log"; exit 1; }
}

start_postgrest() {
  cat > "$WORK/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authpass@127.0.0.1:$PGPORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $PGRST_PORT
CONF
  nohup "$POSTGREST" "$WORK/postgrest.conf" > "$WORK/postgrest.log" 2>&1 &
  echo $! > "$WORK/postgrest.pid"
  wait_http "http://127.0.0.1:$PGRST_PORT/" || { echo "postgrest did not start"; cat "$WORK/postgrest.log"; exit 1; }
}

apply_migrations() {
  # Every migration the example project ships, in order, unmodified --
  # what `supabase db reset` would apply.
  for f in "$MIGRATIONS"/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null; done
}

case "${1:-}" in
  start)
    mkdir -p "$WORK"
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"
    [ "$(id -u)" = 0 ] && chown postgres "$PGDATA"
    "${RUNAS[@]}" "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres >/dev/null
    "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -l "$PGDATA/log" -w start >/dev/null
    platform_sql | "${PSQL[@]}" >/dev/null
    start_services
    apply_migrations
    start_postgrest
    ;;
  reset)
    # Fresh users between runs: truncate auth + app tables, keep schema.
    "${PSQL[@]}" -c "truncate auth.users cascade; truncate public.users;" >/dev/null
    ;;
  stop)
    for p in gotrue postgrest; do
      [ -f "$WORK/$p.pid" ] && kill "$(cat "$WORK/$p.pid")" 2>/dev/null || true
      rm -f "$WORK/$p.pid"
    done
    [ -d "$PGDATA" ] && "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop|reset"; exit 2;;
esac
