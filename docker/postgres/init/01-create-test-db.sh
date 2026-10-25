#!/bin/sh
# Creates a separate database for integration tests next to the dev database.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE DATABASE coobra_test OWNER "$POSTGRES_USER";
SQL
