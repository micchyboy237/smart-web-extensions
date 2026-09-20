#!/bin/zsh
# generate_rag_context.sh – Extract DB schema and format as RAG-optimized JSON for LLM SQL generation
set -euo pipefail

# ========== Config ==========
DB_PATH="/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"
SCHEMA_SQL="/Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/scripts/database_schema_discovery.sql"

# Dynamically resolve output dir equivalent to: Path(__file__).parent / "generated" / Path(__file__).stem
SCRIPT_DIR="${0:A:h}"
SCRIPT_STEM="${0:A:t:r}"
OUTPUT_DIR="${SCRIPT_DIR}/generated/${SCRIPT_STEM}"

# Recreate output directory (equivalent to shutil.rmtree + mkdir)
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

OUTPUT_FILE="${OUTPUT_DIR}/rag_schema_context.json"
TEMP_RAW="${OUTPUT_DIR}/._rag_raw_output.tmp"
# ============================

log() {
    local level="$1"
    shift
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" >&2
}

cleanup() {
    [[ -f "$TEMP_RAW" ]] && rm -f "$TEMP_RAW"
}
trap cleanup EXIT

# ---------- Sanity checks ----------
if [[ ! -f "$DB_PATH" ]]; then
    log ERROR "Database not found: $DB_PATH"
    exit 1
fi
if [[ ! -f "$SCHEMA_SQL" ]]; then
    log ERROR "Schema SQL file not found: $SCHEMA_SQL"
    exit 1
fi

for cmd in sqlite3 python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log ERROR "$cmd is not installed or not in PATH"
        exit 1
    fi
done

log INFO "Generating RAG schema context..."
log INFO "Database : $DB_PATH"
log INFO "SQL File : $SCHEMA_SQL"
log INFO "Output Dir: $OUTPUT_DIR"
log INFO "Output File: $OUTPUT_FILE"

# ---------- Step 1: Run discovery SQL in JSON mode ----------
log INFO "Extracting schema metadata..."
sqlite3 "$DB_PATH" \
    -cmd ".mode json" \
    -cmd ".headers on" \
    < "$SCHEMA_SQL" > "$TEMP_RAW" 2>/dev/null || true

if [[ ! -s "$TEMP_RAW" ]]; then
    log ERROR "Schema extraction produced no output"
    exit 1
fi

# ---------- Step 2: Transform raw JSON arrays into RAG-optimized structure ----------
log INFO "Transforming to RAG-optimized JSON..."
python3 - "$TEMP_RAW" "$OUTPUT_FILE" << 'PYEOF'
import json, sys, re
from collections import defaultdict

raw_path = sys.argv[1]
out_path = sys.argv[2]

with open(raw_path) as f:
    content = f.read().strip()

# sqlite3 .mode json outputs multiple JSON arrays back-to-back; split them
arrays = []
decoder = json.JSONDecoder()
pos = 0
while pos < len(content):
    # skip whitespace between arrays
    while pos < len(content) and content[pos] in ' \t\n\r':
        pos += 1
    if pos >= len(content):
        break
    obj, end = decoder.raw_decode(content, pos)
    arrays.append(obj)
    pos = end

# Index rows by section
sections = defaultdict(list)
for arr in arrays:
    if isinstance(arr, list):
        for row in arr:
            sec = row.get("section", "")
            if sec:
                sections[sec].append(row)

# --- Build RAG context structure ---
rag = {}

# Database overview
if sections["DATABASE_INFO"]:
    info = sections["DATABASE_INFO"][0]
    rag["database_overview"] = {
        "total_tables": info.get("total_tables"),
        "total_views": info.get("total_views"),
        "total_indexes": info.get("total_indexes"),
    }

# Tables with full CREATE statements
tables = {}
for row in sections.get("TABLES", []):
    tname = row.get("table_name", "")
    if tname:
        tables[tname] = {
            "create_statement": row.get("create_statement", ""),
            "table_type": row.get("table_type", "user"),
        }

# Columns grouped by table
columns_by_table = defaultdict(list)
for row in sections.get("COLUMNS", []):
    tname = row.get("table_name", "")
    if tname:
        col = {
            "name": row.get("column_name"),
            "type": row.get("data_type", ""),
            "nullable": row.get("is_not_null", 0) == 0,
            "primary_key_order": row.get("primary_key_order", 0),
        }
        dv = row.get("default_value")
        if dv is not None:
            col["default"] = dv
        columns_by_table[tname].append(col)

# Foreign keys grouped by table
fk_by_table = defaultdict(list)
for row in sections.get("FOREIGN_KEYS", []):
    tname = row.get("table_name", "")
    if tname:
        fk_by_table[tname].append({
            "source_column": row.get("source_column"),
            "referenced_table": row.get("referenced_table"),
            "referenced_column": row.get("referenced_column"),
            "on_delete": row.get("on_delete_action"),
            "on_update": row.get("on_update_action"),
        })

# Indexes grouped by table
idx_by_table = defaultdict(list)
for row in sections.get("INDEXES", []):
    tname = row.get("table_name", "")
    if tname:
        idx_by_table[tname].append({
            "name": row.get("index_name"),
            "unique": row.get("is_unique", 0) == 1,
            "columns": row.get("indexed_columns", ""),
        })

# Merge everything into per-table entries
for tname in sorted(tables.keys()):
    entry = tables[tname]
    entry["columns"] = columns_by_table.get(tname, [])
    entry["foreign_keys"] = fk_by_table.get(tname, [])
    entry["indexes"] = idx_by_table.get(tname, [])

rag["tables"] = tables

# Query patterns
patterns = []
for row in sections.get("QUERY_PATTERNS", []):
    patterns.append({
        "pattern": row.get("pattern", ""),
        "example": row.get("example", ""),
    })
if patterns:
    rag["query_patterns"] = patterns

# Write output
with open(out_path, "w") as f:
    json.dump(rag, f, indent=2)

print(f"Wrote {len(json.dumps(rag))} chars to {out_path}", file=sys.stderr)
PYEOF

# ---------- Verify ----------
if [[ -s "$OUTPUT_FILE" ]]; then
    size=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    log INFO "Success! Wrote $size bytes to $OUTPUT_FILE"
    log INFO "Preview:"
    head -n 30 "$OUTPUT_FILE"
else
    log ERROR "Output file is empty or was not created"
    exit 1
fi

log INFO "Done."