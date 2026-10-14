#!/usr/bin/env sh
# 전체 테스트: 샘플 생성 → JS 파서/URL/Worker 테스트 → Python CLI 테스트
set -e
cd "$(dirname "$0")/.."
python3 tests/gen_fixtures.py
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p "test_*.py"
