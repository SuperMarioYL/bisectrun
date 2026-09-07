#!/usr/bin/env bash
set -euo pipefail
node dist/cli.js test/fixtures/failed-session.jsonl test/fixtures/good-session.jsonl --no-color
node dist/cli.js test/fixtures/failed-session.jsonl test/fixtures/good-session.jsonl --json
