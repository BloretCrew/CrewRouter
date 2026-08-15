#!/usr/bin/env bash
# 分片回填 usage_records.request_source
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 从 config.json 读库配置（避免 config-loader 日志污染 stdout）
eval "$(node -e "
const fs=require('fs');
const c=JSON.parse(fs.readFileSync('./config.json','utf8'));
const d=c.database||{};
const out=(k,v)=>process.stdout.write('export '+k+'='+JSON.stringify(String(v))+';\\n');
out('PGHOST', d.host||'localhost');
out('PGPORT', d.port||5432);
out('PGDATABASE', d.name||'crewrouter');
out('PGUSER', d.user||'crewrouter');
out('PGPASSWORD', d.password||'');
")"

STEP="${STEP:-2000}"
SQL_FILE="$ROOT/server/scripts/backfill-request-source.sql"

echo "[backfill] DB=$PGUSER@$PGHOST:$PGPORT/$PGDATABASE step=$STEP"

psql -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(NULLIF(request_source,''),'unknown') src, COUNT(*) n
FROM usage_records GROUP BY 1 ORDER BY n DESC;
"

MIN_ID="$(psql -tA -c "
SELECT COALESCE(MIN(id),0)
FROM usage_records
WHERE request_source IS NULL OR request_source='' OR request_source='unknown';
" | tr -d '[:space:]')"
MAX_ID="$(psql -tA -c "
SELECT COALESCE(MAX(id),0)
FROM usage_records
WHERE request_source IS NULL OR request_source='' OR request_source='unknown';
" | tr -d '[:space:]')"
echo "[backfill] unknown id range: $MIN_ID .. $MAX_ID"

if [[ -z "$MIN_ID" || "$MIN_ID" == "0" && "$MAX_ID" == "0" ]]; then
  echo "[backfill] nothing to do"
  exit 0
fi

lo=$MIN_ID
while (( lo <= MAX_ID )); do
  hi=$((lo + STEP))
  echo "[backfill] $(date +%H:%M:%S) id [$lo, $hi) ..."
  psql -v ON_ERROR_STOP=1 -v lo="$lo" -v hi="$hi" -f "$SQL_FILE" >/tmp/backfill-batch.log
  # 显示本片更新后的小计
  psql -tA -c "
    SELECT string_agg(src||'='||n, ', ' ORDER BY n DESC)
    FROM (
      SELECT COALESCE(NULLIF(request_source,''),'unknown') src, COUNT(*) n
      FROM usage_records
      WHERE id >= $lo AND id < $hi
      GROUP BY 1
    ) s;
  " | sed 's/^/  slice: /'
  lo=$hi
done

echo "[backfill] done. final distribution:"
psql -c "
SELECT COALESCE(NULLIF(request_source,''),'unknown') src, COUNT(*) n
FROM usage_records GROUP BY 1 ORDER BY n DESC;
"
