#!/bin/zsh
# export_codes.sh – Export unique codes from chroma.sqlite3 as prettified JSON

set -euo pipefail

# ========== Config ==========
DB_PATH="/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"
OUTPUT_FILE="codes.json"
# ============================

log() {
    local level="$1"
    shift
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
}

log INFO "Starting export..."
log INFO "Database : $DB_PATH"
log INFO "Output   : $OUTPUT_FILE"

# Sanity checks
if [[ ! -f "$DB_PATH" ]]; then
    log ERROR "Database not found: $DB_PATH"
    exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
    log ERROR "sqlite3 is not installed or not in PATH"
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    log ERROR "python3 is not installed or not in PATH"
    exit 1
fi

log INFO "Running query..."

# Run query → prettify → save
sqlite3 "$DB_PATH" <<EOF | python3 -m json.tool > "$OUTPUT_FILE"
.mode list
.separator ""
SELECT
    json_object(
        'length', counts.length,
        'total', counts.total_count,
        'items', json(counts.items_array)
    )
FROM (
    SELECT
        count(*) AS length,
        sum(cnt) AS total_count,
        json_group_array(json_object('code', code, 'count', cnt)) AS items_array
    FROM (
        SELECT
            string_value AS code,
            count(*) AS cnt
        FROM embedding_metadata
        WHERE
            key = 'code'
            AND string_value IS NOT NULL
            AND string_value != ''
        GROUP BY string_value
        ORDER BY count(*) DESC
    )
) AS counts;
EOF

# Verify result
if [[ -s "$OUTPUT_FILE" ]]; then
    local size
    size=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    log INFO "Success! Wrote $size bytes to $OUTPUT_FILE"
    log INFO "Preview (first 15 lines):"
    head -n 15 "$OUTPUT_FILE"
else
    log ERROR "Output file is empty or was not created"
    exit 1
fi

log INFO "Done."