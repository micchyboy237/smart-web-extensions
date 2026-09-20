#!/bin/zsh
# generate_rag_context.sh – Extract DB schema and format as RAG-optimized JSON for LLM SQL generation
set -euo pipefail

# ========== Config ==========
DB_PATH="/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"
SCRIPT_DIR="${0:A:h}"
SCHEMA_SQL="${SCRIPT_DIR}/database_schema_discovery.sql"

# Dynamically resolve output dir
OUTPUT_DIR="${SCRIPT_DIR}/generated/rag_context"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

OUTPUT_FILE="${OUTPUT_DIR}/schema.json"
TEMP_RAW="${OUTPUT_DIR}/._raw_output.tmp"
# ============================

log() {
    local level="$1"; shift
    echo "[$(date '+%H:%M:%S')] [$level] $*" >&2
}

cleanup() { [[ -f "$TEMP_RAW" ]] && rm -f "$TEMP_RAW"; }
trap cleanup EXIT

# ---------- Sanity Checks ----------
if [[ ! -f "$DB_PATH" ]]; then log ERROR "DB not found: $DB_PATH"; exit 1; fi
if [[ ! -f "$SCHEMA_SQL" ]]; then log ERROR "SQL not found: $SCHEMA_SQL"; exit 1; fi
for cmd in sqlite3 python3; do
    command -v "$cmd" >/dev/null 2>&1 || { log ERROR "$cmd missing"; exit 1; }
done

log INFO "Extracting schema from SQLite..."

# Run discovery script in JSON mode
sqlite3 "$DB_PATH" \
    -cmd ".mode json" \
    -cmd ".headers on" \
    < "$SCHEMA_SQL" > "$TEMP_RAW" 2>/dev/null || true

if [[ ! -s "$TEMP_RAW" ]]; then
    log ERROR "Extraction failed (empty output)"
    exit 1
fi

log INFO "Transforming to Agent-Optimized JSON..."

python3 - "$TEMP_RAW" "$OUTPUT_FILE" << 'PYEOF'
import json, sys
from collections import defaultdict

raw_path = sys.argv[1]
out_path = sys.argv[2]

with open(raw_path) as f:
    content = f.read().strip()

# Parse multiple JSON arrays from sqlite3 output
arrays = []
decoder = json.JSONDecoder()
pos = 0
while pos < len(content):
    while pos < len(content) and content[pos] in ' \t\n\r': pos += 1
    if pos >= len(content): break
    try:
        obj, end = decoder.raw_decode(content, pos)
        arrays.append(obj)
        pos = end
    except json.JSONDecodeError:
        break

sections = defaultdict(list)
for arr in arrays:
    if isinstance(arr, list):
        for row in arr:
            sec = row.get("section")
            if sec: sections[sec].append(row)

# --- Build Structure ---
rag = {
    "database_overview": {},
    "tables": {},
    "query_patterns": []
}

# 1. Overview
if sections["DATABASE_INFO"]:
    rag["database_overview"] = sections["DATABASE_INFO"][0]

# 2. Tables & Columns
tables_map = {}
for row in sections.get("TABLES", []):
    tname = row.get("table_name")
    if tname:
        tables_map[tname] = {
            "create_statement": row.get("create_statement", ""),
            "columns": [],
            "foreign_keys": [],
            "indexes": []
        }

# Add Columns
for row in sections.get("COLUMNS", []):
    tname = row.get("table_name")
    if tname and tname in tables_map:
        col = {
            "name": row.get("column_name"),
            "type": row.get("data_type", "TEXT"),
            "nullable": row.get("is_not_null", 0) == 0,
            "pk_order": row.get("primary_key_order", 0)
        }
        if row.get("default_value") is not None:
            col["default"] = row["default_value"]
        tables_map[tname]["columns"].append(col)

# Add Foreign Keys
for row in sections.get("FOREIGN_KEYS", []):
    tname = row.get("table_name")
    if tname and tname in tables_map:
        tables_map[tname]["foreign_keys"].append({
            "source": row.get("source_column"),
            "target_table": row.get("referenced_table"),
            "target_col": row.get("referenced_column"),
            "on_delete": row.get("on_delete_action")
        })

# Add Indexes
for row in sections.get("INDEXES", []):
    tname = row.get("table_name")
    if tname and tname in tables_map:
        tables_map[tname]["indexes"].append({
            "name": row.get("index_name"),
            "unique": row.get("is_unique", 0) == 1,
            "columns": row.get("indexed_columns", "")
        })

# 3. Post-Process for LLM Efficiency
for tname, info in tables_map.items():
    # Quick lookup lists
    info["column_names"] = [c["name"] for c in info["columns"]]
    info["primary_keys"] = [c["name"] for c in info["columns"] if c["pk_order"] > 0]
    
    # Remove raw pk_order to save tokens, keep boolean is_pk if needed or just rely on list
    for c in info["columns"]:
        del c["pk_order"]

rag["tables"] = tables_map

# 4. Query Patterns
for row in sections.get("QUERY_PATTERNS", []):
    rag["query_patterns"].append({
        "pattern": row.get("pattern"),
        "example": row.get("example")
    })

with open(out_path, "w") as f:
    json.dump(rag, f, indent=2)

print(f"Generated {len(json.dumps(rag))} chars", file=sys.stderr)
PYEOF

if [[ -s "$OUTPUT_FILE" ]]; then
    log INFO "Success: $OUTPUT_FILE"
else
    log ERROR "Failed to generate JSON"
    exit 1
fi