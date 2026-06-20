#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

POSTGRES_E2E_DATABASE_URL="${POSTGRES_E2E_DATABASE_URL:-postgres://demo:demo@127.0.0.1:55432/nest_batch_postgres_e2e}"
KAFKA_E2E_HOST="${KAFKA_E2E_HOST:-127.0.0.1}"
KAFKA_E2E_PORT="${KAFKA_E2E_PORT:-9092}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for compose e2e tests." >&2
  exit 1
fi

docker compose up -d postgres-e2e kafka

for attempt in $(seq 1 60); do
  if docker compose exec -T postgres-e2e pg_isready -U demo -d nest_batch_postgres_e2e >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker compose ps
    echo "Postgres did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

for attempt in $(seq 1 60); do
  if docker compose exec -T kafka kafka-broker-api-versions --bootstrap-server localhost:9092 >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker compose ps
    echo "Kafka did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

(
  cd packages/kafka
  RUN_KAFKA_E2E=1 \
    KAFKA_E2E_HOST="$KAFKA_E2E_HOST" \
    KAFKA_E2E_PORT="$KAFKA_E2E_PORT" \
    pnpm exec vitest run tests/e2e.test.ts
)

(
  cd packages/kafka
  RUN_KAFKA_E2E=1 \
    KAFKA_E2E_HOST="$KAFKA_E2E_HOST" \
    KAFKA_E2E_PORT="$KAFKA_E2E_PORT" \
    pnpm exec vitest run tests/kafka-runtime.test.ts
)

(
  cd packages/postgresql
  RUN_POSTGRES_E2E=1 \
    POSTGRES_E2E_DATABASE_URL="$POSTGRES_E2E_DATABASE_URL" \
    pnpm exec vitest run --config vitest.e2e.config.ts
)
