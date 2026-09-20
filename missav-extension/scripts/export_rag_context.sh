#!/bin/zsh
# export_rag_context.sh – Generate optimized RAG context for dynamic SQL generation
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

OUTPUT_FILE="${OUTPUT_DIR}/rag_context.json"
TEMP_RAW="${OUTPUT_DIR}/rag_context_raw.txt"
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

log INFO "Starting RAG context generation..."
log INFO "Database : $DB_PATH"
log INFO "Schema SQL: $SCHEMA_SQL"
log INFO "Output Dir: $OUTPUT_DIR"
log INFO "Output File: $OUTPUT_FILE"

# Sanity checks
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

log INFO "Extracting schema metadata..."
# Run discovery script with clean output mode
sqlite3 "$DB_PATH" \
    -cmd ".mode list" \
    -cmd ".separator '|'" \
    < "$SCHEMA_SQL" > "$TEMP_RAW" 2>/dev/null || true

if [[ ! -s "$TEMP_RAW" ]]; then
    log ERROR "Failed to extract schema data (output empty)"
    exit 1
fi

log INFO "Transforming raw output into structured RAG context..."
# Transform pipe-delimited output into LLM-optimized JSON using Python
python3 - "$TEMP_RAW" "$OUTPUT_FILE" << 'PYTHON_SCRIPT'
import sys
import json
from collections import defaultdict

raw_file = sys.argv[1]
output_file = sys.argv[2]

context = {
    "database_overview": {},
    "tables": {},
    "foreign_keys": [],
    "indexes": [],
    "query_patterns": [],
    "schema_summary": ""
}

current_section = None
with open(raw_file, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        parts = line.split('|')
        if len(parts) < 2:
            continue
        
        section = parts[0]
        
        if section == 'DATABASE_INFO':
            context["database_overview"] = {
                "total_tables": int(parts[1]) if len(parts) > 1 else 0,
                "total_views": int(parts[2]) if len(parts) > 2 else 0,
                "total_indexes": int(parts[3]) if len(parts) > 3 else 0
            }
        elif section == 'TABLES':
            table_name = parts[1]
            context["tables"][table_name] = {
                "create_statement": parts[2] if len(parts) > 2 else "",
                "type": parts[3] if len(parts) > 3 else "user",
                "columns": [],
                "row_count_estimate": None
            }
        elif section == 'COLUMNS':
            table_name = parts[1]
            if table_name in context["tables"]:
                col_info = {
                    "name": parts[3] if len(parts) > 3 else "",
                    "type": parts[4] if len(parts) > 4 else "",
                    "not_null": bool(int(parts[5])) if len(parts) > 5 and parts[5].isdigit() else False,
                    "default": parts[6] if len(parts) > 6 and parts[6] else None,
                    "primary_key_order": int(parts[7]) if len(parts) > 7 and parts[7].isdigit() else 0
                }
                context["tables"][table_name]["columns"].append(col_info)
        elif section == 'FOREIGN_KEYS':
            fk = {
                "table": parts[1],
                "source_column": parts[5] if len(parts) > 5 else "",
                "referenced_table": parts[4] if len(parts) > 4 else "",
                "referenced_column": parts[6] if len(parts) > 6 else "",
                "on_delete": parts[8] if len(parts) > 8 else "NO ACTION"
            }
            context["foreign_keys"].append(fk)
        elif section == 'INDEXES':
            idx = {
                "table": parts[1],
                "index_name": parts[2] if len(parts) > 2 else "",
                "is_unique": bool(int(parts[3])) if len(parts) > 3 and parts[3].isdigit() else False,
                "columns": parts[5] if len(parts) > 5 else ""
            }
            context["indexes"].append(idx)
        elif section == 'QUERY_PATTERNS':
            pattern = {
                "description": parts[1] if len(parts) > 1 else "",
                "example": parts[2] if len(parts) > 2 else ""
            }
            context["query_patterns"].append(pattern)
        elif section == 'SCHEMA_SUMMARY':
            # The summary may span multiple lines due to GROUP_CONCAT with CHAR(10)
            context["schema_summary"] = parts[1] if len(parts) > 1 else ""

# Post-process: attach FK and index info directly to tables for easier LLM consumption
fk_by_table = defaultdict(list)
for fk in context["foreign_keys"]:
    fk_by_table[fk["table"]].append(fk)

idx_by_table = defaultdict(list)
for idx in context["indexes"]:
    idx_by_table[idx["table"]].append(idx)

for table_name, table_info in context["tables"].items():
    table_info["foreign_keys"] = fk_by_table.get(table_name, [])
    table_info["indexes"] = idx_by_table.get(table_name, [])
    # Add quick-reference column names list
    table_info["column_names"] = [c["name"] for c in table_info["columns"]]
    # Identify primary key columns
    pk_cols = [c["name"] for c in table_info["columns"] if c["primary_key_order"] > 0]
    table_info["primary_key_columns"] = pk_cols

# Remove redundant top-level lists since they're now embedded in tables
del context["foreign_keys"]
del context["indexes"]

with open(output_file, 'w') as f:
    json.dump(context, f, indent=2, ensure_ascii=False)

print(f"Wrote {len(json.dumps(context))} bytes to {output_file}", file=sys.stderr)
PYTHON_SCRIPT

if [[ -s "$OUTPUT_FILE" ]]; then
    size=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    log INFO "Success! Generated RAG context ($size bytes)"
    log INFO "Preview:"
    head -n 30 "$OUTPUT_FILE"
else
    log ERROR "Output file is empty or was not created"
    exit 1
fi

log INFO "Done. Use '$OUTPUT_FILE' as RAG context for dynamic SQL generation."