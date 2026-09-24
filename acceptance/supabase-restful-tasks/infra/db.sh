#!/usr/bin/env bash
# Local PostgreSQL 16 + PostgREST for the restful-tasks acceptance run.
# usage: db.sh start|stop|reset   (WORK dir from env, default /tmp/acc-deno-work)
set -euo pipefail
WORK=${WORK:-/tmp/acc-deno-work}
PGBIN=${PGBIN:-$(printf '%s\n' /usr/lib/postgresql/*/bin | sort -V | tail -1)}
PGPORT=${PGPORT:-54329}
PGRST_PORT=${PGRST_PORT:-54330}
POSTGREST=${POSTGREST:-/root/tools/postgrest}
JWT_SECRET=${JWT_SECRET:-acceptance-local-jwt-secret-at-least-32-chars}
PGDATA=$WORK/pgdata
RUNAS=()
if [ "$(id -u)" = 0 ]; then RUNAS=(runuser -u postgres --); fi

schema_sql() {
cat <<SQL
drop table if exists public.tasks;
create table public.tasks (id bigserial primary key, name text not null, status int not null default 0);
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'authpass'; end if;
end \$\$;
grant anon, authenticated to authenticator;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant usage, select on sequence public.tasks_id_seq to authenticated;
insert into public.tasks (name, status) values ('seed-1',0),('seed-2',0),('seed-3',0);
SQL
}

case "${1:-}" in
  start)
    mkdir -p "$WORK"
    if [ ! -d "$PGDATA" ]; then
      mkdir -p "$PGDATA"; [ "$(id -u)" = 0 ] && chown postgres "$PGDATA"
      "${RUNAS[@]}" "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres >/dev/null
    fi
    "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -l "$PGDATA/log" -w start >/dev/null
    schema_sql | PGOPTIONS="-c client_min_messages=warning" psql -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null
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
    for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PGRST_PORT/" >/dev/null && break; sleep 0.2; done
    curl -sf "http://127.0.0.1:$PGRST_PORT/" >/dev/null || { echo "postgrest did not start"; cat "$WORK/postgrest.log"; exit 1; }
    ;;
  reset)
    schema_sql | PGOPTIONS="-c client_min_messages=warning" psql -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null
    # PostgREST caches the schema; ask it to reload.
    psql -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "notify pgrst, 'reload schema'" >/dev/null
    sleep 0.5
    ;;
  stop)
    [ -f "$WORK/postgrest.pid" ] && kill "$(cat "$WORK/postgrest.pid")" 2>/dev/null || true
    rm -f "$WORK/postgrest.pid"
    [ -d "$PGDATA" ] && "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop|reset"; exit 2;;
esac
