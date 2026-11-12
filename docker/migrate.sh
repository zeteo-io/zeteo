#!/bin/sh
# Brings the database up to date by applying migrations. Run once per deploy —
# compose's `migrate` service, a Kubernetes Job, or by hand — not on every
# replica's start. Runs from the package directory, where the image puts it.
set -e

echo "Running database migrations..." >&2
npx prisma migrate deploy
