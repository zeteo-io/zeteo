#!/bin/sh
# Run by the postgres image on first start: the schema, its rows and the
# read-only login, whose password comes from the environment.
set -eu
psql -v ON_ERROR_STOP=1 -v reader_password="$SOURCE_READER_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /e2e-source/init.sql
