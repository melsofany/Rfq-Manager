#!/bin/sh
# One entrypoint for every Chatwoot process, on compose and on Render.
#
# Defining migrate/web/worker ONCE is the point: a deploy that runs a different
# command from the one we tested is a deploy we have not tested. Compose calls
# this script for its migrate/web/worker services and Render calls it for its
# pre-deploy and start commands, so both paths execute the same lines.
#
#   ./bin/entrypoint.sh migrate   run migrations, verify, exit
#   ./bin/entrypoint.sh web       serve HTTP (Puma)
#   ./bin/entrypoint.sh worker    run Sidekiq
set -e

ROLE="${1:-web}"
echo "[entrypoint] role=${ROLE}"

# `db:chatwoot_prepare` reports SUCCESS even when it created nothing: it
# short-circuits on a half-applied schema, and an interrupted first run leaves
# exactly that state. A "successful" install then boots an app that cannot
# serve. Asking the database directly is the only proof, so the table count is
# read back and the process fails closed on anything it cannot parse.
#
# The count comes from a SENTINEL line rather than the raw stream: Rails logs to
# stdout too, so capturing everything yields a string like
# "W, [2026-...] INFO -- ... 110" and the numeric test then fails with "out of
# range". A failing test inside `if` does NOT trip `set -e`, so that shape
# silently reported success — the exact bug this guard exists to catch.
run_migrate() {
  echo "[migrate] preparing the Chatwoot schema"
  bundle exec rails db:chatwoot_prepare

  count=$(bundle exec rails runner \
    'puts "CORTOBA_TABLES=#{ActiveRecord::Base.connection.tables.size}"' 2>/dev/null \
    | grep -o 'CORTOBA_TABLES=[0-9]*' | tail -1 | cut -d= -f2)

  if [ -z "$count" ]; then
    echo "[migrate] tables present: <unparsable>"
  else
    echo "[migrate] tables present: $count"
  fi

  case "$count" in
    ''|*[!0-9]*)
      echo "[migrate] FAILED: could not read the table count from the database." >&2
      exit 1
      ;;
  esac
  if [ "$count" -lt 50 ]; then
    echo "[migrate] FAILED: only $count tables — the schema was not applied." >&2
    echo "[migrate] If this is a half-prepared database, drop it and re-deploy." >&2
    exit 1
  fi
  echo "[migrate] schema ready"
}

# Wait until the schema is really there, then return. The WORKER uses this
# instead of migrating: two processes preparing a FRESH database at the same
# time race, and the loser dies with
#   PG::DuplicateObject: constraint "fk_rails_c3b3935057" ... already exists
# (reproduced locally against a clean pgvector database). Exactly one migrator is
# what removes that race, so the worker waits for the web service instead of
# competing with it.
wait_for_schema() {
  i=0
  while [ "$i" -lt 60 ]; do
    count=$(bundle exec rails runner \
      'puts "CORTOBA_TABLES=#{ActiveRecord::Base.connection.tables.size}"' 2>/dev/null \
      | grep -o 'CORTOBA_TABLES=[0-9]*' | tail -1 | cut -d= -f2)
    case "$count" in
      ''|*[!0-9]*) ;;
      *) [ "$count" -ge 50 ] && { echo "[worker] schema ready ($count tables)"; return 0; } ;;
    esac
    i=$((i + 1))
    echo "[worker] waiting for the schema ($i/60)"
    sleep 5
  done
  echo "[worker] FAILED: the schema never became ready." >&2
  exit 1
}

case "$ROLE" in
  migrate)
    run_migrate
    ;;
  web)
    # The ONE migrator. A web process that starts against an unprepared schema
    # serves 500s, so it prepares the database before serving. `CORTOBA_SKIP_MIGRATE`
    # exists for a deploy that migrates in a separate step.
    [ "${CORTOBA_SKIP_MIGRATE:-0}" = "1" ] || run_migrate
    exec bundle exec rails s -b 0.0.0.0 -p "${PORT:-3000}"
    ;;
  worker)
    # Never migrates — see wait_for_schema. It blocks until the web service has
    # prepared the database, so a first deploy cannot race.
    [ "${CORTOBA_SKIP_MIGRATE:-0}" = "1" ] || wait_for_schema
    exec bundle exec sidekiq -C config/sidekiq.yml
    ;;
  *)
    echo "[entrypoint] unknown role: $ROLE (expected migrate|web|worker)" >&2
    exit 1
    ;;
esac
