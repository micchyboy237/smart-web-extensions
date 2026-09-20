#!/bin/zsh
# export_codes.sh – Export unique codes from chroma.sqlite3 as prettified JSON
set -euo pipefail

# ========== Config ==========
DB_PATH="/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"
SQL_FILE="/Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/scripts/display_codes.sql"
OUTPUT_FILE="codes.json"
# ============================

log() {
    local level="$1"
    shift
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
}

log INFO "Starting export..."
log INFO "Database : $DB_PATH"
log INFO "SQL File : $SQL_FILE"
log INFO "Output   : $OUTPUT_FILE"

# Sanity checks
if [[ ! -f "$DB_PATH" ]]; then
    log ERROR "Database not found: $DB_PATH"
    exit 1
fi

if [[ ! -f "$SQL_FILE" ]]; then
    log ERROR "SQL file not found: $SQL_FILE"
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

log INFO "Loading query from $SQL_FILE ..."
# Load the SQL content into a variable
SQL_QUERY=$(< "$SQL_FILE")

log INFO "Running query..."
# Run query → prettify → save
# We use -cmd ".mode list" and ".separator "" to ensure clean output for piping
sqlite3 "$DB_PATH" -cmd ".mode list" -cmd ".separator ''" "$SQL_QUERY" | python3 -m json.tool > "$OUTPUT_FILE"

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