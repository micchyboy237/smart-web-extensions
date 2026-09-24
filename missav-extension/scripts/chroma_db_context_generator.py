import json
import sqlite3
from datetime import datetime
from typing import Any, Dict, List


class ChromaDBContextGenerator:
    """Generate comprehensive RAG context from Chroma DB SQLite for LLM queries."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = None

    def connect(self):
        """Establish database connection."""
        try:
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row
            print(f"✓ Connected to Chroma DB: {self.db_path}")
        except Exception as e:
            raise ConnectionError(f"Failed to connect to database: {e}")

    def disconnect(self):
        """Close database connection."""
        if self.conn:
            self.conn.close()
            print("✓ Database connection closed")

    def get_all_tables(self) -> List[str]:
        """Get list of all tables in the database."""
        cursor = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        return [row["name"] for row in cursor.fetchall()]

    def get_table_schema(self, table_name: str) -> str:
        """Get CREATE TABLE statement for a specific table."""
        cursor = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        )
        result = cursor.fetchone()
        return result["sql"] if result else None

    def get_table_columns(self, table_name: str) -> List[Dict]:
        """Get column information for a table using PRAGMA."""
        cursor = self.conn.execute(f"PRAGMA table_info({table_name})")
        columns = []
        for row in cursor.fetchall():
            columns.append(
                {
                    "cid": row["cid"],
                    "name": row["name"],
                    "type": row["type"],
                    "notnull": row["notnull"],
                    "default_value": row["dflt_value"],
                    "pk": row["pk"],
                }
            )
        return columns

    def get_row_count(self, table_name: str) -> int:
        """Get row count for a specific table."""
        try:
            cursor = self.conn.execute(f"SELECT COUNT(*) as cnt FROM [{table_name}]")
            return cursor.fetchone()["cnt"]
        except:
            return 0

    def get_collections_info(self) -> List[Dict[str, Any]]:
        """Extract detailed information about all collections."""
        collections = []

        try:
            cursor = self.conn.execute("""
                SELECT 
                    c.id,
                    c.name,
                    c.config_json_str,
                    c.schema_str,
                    c.dimension,
                    d.name as database_name,
                    t.id as tenant_id
                FROM collections c
                JOIN databases d ON c.database_id = d.id
                JOIN tenants t ON d.tenant_id = t.id
            """)

            for row in cursor.fetchall():
                config = {}
                if row["config_json_str"]:
                    try:
                        config = json.loads(row["config_json_str"])
                    except json.JSONDecodeError:
                        config = {"raw": row["config_json_str"]}

                schema = {}
                if row["schema_str"]:
                    try:
                        schema = json.loads(row["schema_str"])
                    except json.JSONDecodeError:
                        schema = {"raw": row["schema_str"]}

                metadata_cursor = self.conn.execute(
                    """
                    SELECT key, str_value, int_value, float_value, bool_value
                    FROM collection_metadata
                    WHERE collection_id = ?
                """,
                    (row["id"],),
                )

                metadata = {}
                for meta_row in metadata_cursor.fetchall():
                    value = self._get_typed_value(
                        meta_row["str_value"],
                        meta_row["int_value"],
                        meta_row["float_value"],
                        meta_row["bool_value"],
                    )
                    if value is not None:
                        metadata[meta_row["key"]] = value

                segments_cursor = self.conn.execute(
                    """
                    SELECT id, type, scope
                    FROM segments
                    WHERE collection = ?
                """,
                    (row["id"],),
                )

                segments = []
                for seg in segments_cursor.fetchall():
                    count_cursor = self.conn.execute(
                        "SELECT COUNT(*) as cnt FROM embeddings WHERE segment_id = ?",
                        (seg["id"],),
                    )
                    embedding_count = count_cursor.fetchone()["cnt"]

                    segments.append(
                        {
                            "id": seg["id"],
                            "type": seg["type"],
                            "scope": seg["scope"],
                            "embedding_count": embedding_count,
                        }
                    )

                collections.append(
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "dimension": row["dimension"],
                        "database": row["database_name"],
                        "tenant_id": row["tenant_id"],
                        "configuration": config,
                        "schema": schema,
                        "metadata": metadata,
                        "segments": segments,
                        "total_embeddings": sum(s["embedding_count"] for s in segments),
                    }
                )

        except sqlite3.OperationalError as e:
            print(f"⚠ Could not query collections table: {e}")

        return collections

    def _get_typed_value(self, str_val, int_val, float_val, bool_val):
        """Extract the actual value from typed columns."""
        if str_val is not None:
            return str_val
        elif int_val is not None:
            return int_val
        elif float_val is not None:
            return float_val
        elif bool_val is not None:
            return bool(bool_val)
        return None

    def _get_metadata_value(self, row: sqlite3.Row) -> Any:
        """Extract the actual value from typed metadata columns."""
        return self._get_typed_value(
            row["string_value"],
            row["int_value"],
            row["float_value"],
            row["bool_value"],
        )

    def get_sample_metadata(
        self, collection_name: str = None, limit: int = 5
    ) -> List[Dict]:
        """Get sample metadata from embeddings with proper typed value extraction."""
        samples = []

        try:
            query = """
                SELECT 
                    e.id,
                    e.segment_id,
                    em.key,
                    em.string_value,
                    em.int_value,
                    em.float_value,
                    em.bool_value
                FROM embeddings e
                LEFT JOIN embedding_metadata em ON e.id = em.id
            """

            params = []
            if collection_name:
                query += """
                    JOIN segments s ON e.segment_id = s.id
                    JOIN collections c ON s.collection = c.id
                    WHERE c.name = ?
                """
                params.append(collection_name)

            query += f" ORDER BY e.id LIMIT {limit * 10}"

            cursor = self.conn.execute(query, params)

            current_doc = None
            doc_metadata = {}

            for row in cursor.fetchall():
                doc_id = row["id"]

                if doc_id != current_doc:
                    if current_doc is not None and doc_metadata:
                        samples.append(
                            {
                                "id": current_doc,
                                "segment_id": doc_metadata.get("segment_id"),
                                "metadata": doc_metadata.get("metadata", {}),
                            }
                        )

                    current_doc = doc_id
                    doc_metadata = {"segment_id": row["segment_id"], "metadata": {}}

                if row["key"]:
                    value = self._get_metadata_value(row)
                    if value is not None:
                        doc_metadata["metadata"][row["key"]] = value

            if current_doc is not None and doc_metadata:
                samples.append(
                    {
                        "id": current_doc,
                        "segment_id": doc_metadata.get("segment_id"),
                        "metadata": doc_metadata.get("metadata", {}),
                    }
                )

            samples = samples[:limit]

        except sqlite3.OperationalError as e:
            print(f"⚠ Could not query embeddings: {e}")

        return samples

    def get_metadata_keys_summary(self) -> Dict[str, Dict[str, int]]:
        """Get summary of all metadata keys and their value types."""
        summary = {}

        try:
            cursor = self.conn.execute("""
                SELECT 
                    key,
                    COUNT(*) as total_count,
                    COUNT(string_value) as string_count,
                    COUNT(int_value) as int_count,
                    COUNT(float_value) as float_count,
                    COUNT(bool_value) as bool_count
                FROM embedding_metadata
                GROUP BY key
                ORDER BY total_count DESC
            """)

            for row in cursor.fetchall():
                summary[row["key"]] = {
                    "total_count": row["total_count"],
                    "value_types": {
                        "string": row["string_count"],
                        "int": row["int_count"],
                        "float": row["float_count"],
                        "bool": row["bool_count"],
                    },
                }
        except sqlite3.OperationalError as e:
            print(f"⚠ Could not query metadata summary: {e}")

        return summary

    def generate_full_context(self) -> str:
        """Generate comprehensive RAG context string for LLM."""
        self.connect()

        context_parts = []

        context_parts.append("=" * 80)
        context_parts.append("CHROMA DATABASE SCHEMA & METADATA CONTEXT")
        context_parts.append(f"Generated: {datetime.now().isoformat()}")
        context_parts.append("=" * 80)
        context_parts.append("")

        tables = self.get_all_tables()
        context_parts.append("## DATABASE OVERVIEW")
        context_parts.append(f"Total Tables: {len(tables)}")
        context_parts.append(f"Tables: {', '.join(tables)}")
        context_parts.append("")

        context_parts.append("## TABLE SCHEMAS")
        context_parts.append("-" * 80)
        for table in tables:
            schema = self.get_table_schema(table)
            count = self.get_row_count(table)
            columns = self.get_table_columns(table)

            context_parts.append(f"\n### Table: {table} ({count} rows)")
            context_parts.append(f"```sql\n{schema}\n```")

            context_parts.append("\n**Columns:**")
            for col in columns:
                pk_marker = " [PK]" if col["pk"] else ""
                nullable = "" if col["notnull"] else " (nullable)"
                context_parts.append(
                    f"- `{col['name']}`: {col['type']}{pk_marker}{nullable}"
                )
        context_parts.append("")

        collections = self.get_collections_info()
        if collections:
            context_parts.append("## COLLECTIONS")
            context_parts.append("-" * 80)
            for coll in collections:
                context_parts.append(f"\n### Collection: {coll['name']}")
                context_parts.append(f"- ID: {coll['id']}")
                context_parts.append(f"- Dimension: {coll['dimension']}")
                context_parts.append(f"- Database: {coll['database']}")
                context_parts.append(f"- Total Embeddings: {coll['total_embeddings']}")

                if coll["metadata"]:
                    context_parts.append(
                        f"- Metadata: {json.dumps(coll['metadata'], indent=2)}"
                    )

                if coll["configuration"]:
                    context_parts.append(
                        f"- Configuration: {json.dumps(coll['configuration'], indent=2)}"
                    )

                if coll["schema"]:
                    context_parts.append(
                        f"- Schema: {json.dumps(coll['schema'], indent=2)}"
                    )

                context_parts.append("\nSegments:")
                for seg in coll["segments"]:
                    context_parts.append(
                        f"  - Type: {seg['type']}, Scope: {seg['scope']}, "
                        f"Embeddings: {seg['embedding_count']}"
                    )
            context_parts.append("")
        else:
            context_parts.append("## COLLECTIONS")
            context_parts.append("-" * 80)
            context_parts.append("\n⚠ No collections found or query failed")
            context_parts.append("")

        metadata_summary = self.get_metadata_keys_summary()
        if metadata_summary:
            context_parts.append("## METADATA KEYS SUMMARY")
            context_parts.append("-" * 80)
            context_parts.append("\nAvailable metadata fields for filtering:\n")
            for key, info in metadata_summary.items():
                types_present = [
                    t for t, count in info["value_types"].items() if count > 0
                ]
                context_parts.append(
                    f"- **`{key}`** ({info['total_count']} occurrences)"
                )
                context_parts.append(f"  - Value types: {', '.join(types_present)}")
            context_parts.append("")

        if collections:
            context_parts.append("## SAMPLE METADATA STRUCTURE")
            context_parts.append("-" * 80)
            first_collection = collections[0]["name"]
            samples = self.get_sample_metadata(first_collection, limit=5)

            if samples:
                context_parts.append(f"Sample from collection '{first_collection}':")
                for i, sample in enumerate(samples, 1):
                    context_parts.append(f"\nDocument {i}:")
                    context_parts.append(f"  ID: {sample['id']}")
                    context_parts.append(f"  Segment: {sample['segment_id']}")
                    if sample["metadata"]:
                        context_parts.append(
                            f"  Metadata Keys: {list(sample['metadata'].keys())}"
                        )
                        context_parts.append(
                            f"  Metadata: {json.dumps(sample['metadata'], indent=4)}"
                        )
            else:
                context_parts.append(
                    f"No sample metadata found for collection '{first_collection}'"
                )
            context_parts.append("")

        context_parts.append("## QUERY GUIDANCE FOR DYNAMIC CHROMA QUERIES")
        context_parts.append("-" * 80)

        available_fields = []
        if metadata_summary:
            for key, info in metadata_summary.items():
                types_present = [
                    t for t, count in info["value_types"].items() if count > 0
                ]
                available_fields.append(f"{key} ({', '.join(types_present)})")

        guidance_text = f"""
When constructing Chroma DB queries based on user questions:

1. **Identify Collection**: Use collection names above to determine which collection to query
2. **Available Metadata Fields**: {", ".join(available_fields) if available_fields else "None found"}
3. **Dimension Awareness**: Note vector dimensions for embedding compatibility
4. **Segment Types**: Different segments may store different data types (vectors, metadata, documents)

Example Query Pattern:
```python
collection = client.get_collection(name="{{collection_name}}")
results = collection.query(
    query_texts=[user_query],
    n_results=5,
    where={{  # Filter using metadata keys found above
        "video_id": "heyzo-3472",
        "code": "1USTD6W"
    }},
    where_document={{  # Full-text search on document content
        "$contains": "keyword"
    }}
)
```

**Note**: Based on your schema, common metadata fields include:
- `video_id`: Unique video ID (string) - e.g., "heyzo-3472"
- `code`: Video code identifier (string) - e.g., "1USTD6W"
- `episode`: Episode number (stored as string) - e.g., "3472"
- `url`: Video URL (string)
- `thumbnail`: Thumbnail URL (string)
- `preview`: Preview URL (string)
- `text`: Text content/description (string)
- `chroma:document`: Document content (string)
- `id`: Internal ID (string)

**Important**: All metadata values are stored as strings in your database, even numeric fields like `episode`.
Use string comparisons in filters unless you convert them in your application logic.
"""
        context_parts.append(guidance_text)

        context_parts.append("=" * 80)

        self.disconnect()

        return "\n".join(context_parts)


if __name__ == "__main__":
    import shutil
    from pathlib import Path

    OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    DB_PATH = "/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"

    generator = ChromaDBContextGenerator(DB_PATH)
    context = generator.generate_full_context()

    output_file = OUTPUT_DIR / "chroma_db_context.txt"
    with open(output_file, "w") as f:
        f.write(context)

    print(f"\nPreview (first 2000 chars):\n{context[:2000]}...")
    print(f"\n✓ Context saved to {output_file}")
