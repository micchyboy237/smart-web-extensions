-- ============================================================================
-- Database Schema Discovery Script for LLM RAG Context
-- Purpose: Extract comprehensive database metadata to provide context for 
--          dynamically generating SQL queries
-- Usage: Run this script against your SQLite database to get schema info
-- Output: Structured metadata about tables, columns, relationships, and indexes
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. DATABASE OVERVIEW
-- ----------------------------------------------------------------------------

-- Get database size and basic info
SELECT
    'DATABASE_INFO' AS section,
    COUNT(*) AS total_tables,
    (
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'view'
    ) AS total_views,
    (
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index'
    ) AS total_indexes
FROM sqlite_master
WHERE type = 'table';

-- ----------------------------------------------------------------------------
-- 2. COMPLETE TABLE LIST WITH METADATA
-- ----------------------------------------------------------------------------

-- List all tables with their creation SQL
SELECT
    'TABLES' AS section,
    name AS table_name,
    sql AS create_statement,
    CASE
        WHEN name LIKE 'sqlite_%' THEN 'system'
        ELSE 'user'
    END AS table_type
FROM sqlite_master
WHERE type = 'table'
ORDER BY name;

-- ----------------------------------------------------------------------------
-- 3. DETAILED COLUMN INFORMATION FOR ALL TABLES
-- ----------------------------------------------------------------------------

-- Query to get all columns across all tables at once using PRAGMA table-valued functions
-- Note: PRAGMA_TABLE_INFO returns columns: cid, name, type, notnull, dflt_value, pk
-- Using quoted identifiers to avoid reserved keyword issues
SELECT
    'COLUMNS' AS section,
    m.name AS table_name,
    p.cid AS column_id,
    p.name AS column_name,
    p.type AS data_type,
    p."notnull" AS is_not_null,
    p.dflt_value AS default_value,
    p.pk AS primary_key_order
FROM sqlite_master AS m,
    PRAGMA_TABLE_INFO(m.name) AS p
WHERE
    m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, p.cid;

-- ----------------------------------------------------------------------------
-- 4. FOREIGN KEY RELATIONSHIPS
-- ----------------------------------------------------------------------------

-- Get all foreign key constraints
-- Note: PRAGMA_FOREIGN_KEY_LIST returns: id, seq, table, from, to, on_update, on_delete, match
SELECT
    'FOREIGN_KEYS' AS section,
    m.name AS table_name,
    f.id AS fk_id,
    f.seq,
    f.table AS referenced_table,
    f."from" AS source_column,
    f."to" AS referenced_column,
    f.on_update AS on_update_action,
    f.on_delete AS on_delete_action
FROM sqlite_master AS m,
    PRAGMA_FOREIGN_KEY_LIST(m.name) AS f
WHERE
    m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, f.id, f.seq;

-- ----------------------------------------------------------------------------
-- 5. INDEX INFORMATION
-- ----------------------------------------------------------------------------

-- List all indexes with their details
-- Note: PRAGMA_INDEX_LIST returns: seq, name, unique, origin, partial
-- Note: PRAGMA_INDEX_INFO returns: seqno, cid, name
SELECT
    'INDEXES' AS section,
    m.tbl_name AS table_name,
    i.name AS index_name,
    i."unique" AS is_unique,
    i.origin AS index_origin,
    GROUP_CONCAT(ii.name, ', ') AS indexed_columns
FROM sqlite_master AS m,
    PRAGMA_INDEX_LIST(m.tbl_name) AS i,
    PRAGMA_INDEX_INFO(i.name) AS ii
WHERE
    m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%'
GROUP BY m.tbl_name, i.name, i."unique", i.origin
ORDER BY m.tbl_name, i.name;

-- ----------------------------------------------------------------------------
-- 6. TABLE STATISTICS (ROW COUNTS)
-- ----------------------------------------------------------------------------

-- Dynamic row counts for all user tables
-- This generates individual COUNT queries for each table
SELECT
    'TABLE_STATISTICS' AS section,
    name AS table_name,
    (
        SELECT COUNT(*) FROM sqlite_master
        WHERE name = sm.name AND type = 'table'
    ) AS dummy_check
FROM sqlite_master AS sm
WHERE
    type = 'table'
    AND name NOT LIKE 'sqlite_%'
ORDER BY name;

-- Note: For actual row counts, you need to query each table individually.
-- Use this Python snippet instead:
-- for table in tables:
--     count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

-- ----------------------------------------------------------------------------
-- 7. VIEW DEFINITIONS
-- ----------------------------------------------------------------------------

-- List all views with their SQL definitions
SELECT
    'VIEWS' AS section,
    name AS view_name,
    sql AS view_definition
FROM sqlite_master
WHERE type = 'view'
ORDER BY name;

-- ----------------------------------------------------------------------------
-- 8. SAMPLE DATA (First 5 rows from each table)
-- ----------------------------------------------------------------------------

-- Template for sampling data (execute per table)
-- SELECT 'SAMPLE_DATA: your_table_name' as info, * FROM your_table_name LIMIT 5;

-- ----------------------------------------------------------------------------
-- 9. COMPREHENSIVE SCHEMA SUMMARY (Recommended for RAG)
-- ----------------------------------------------------------------------------

-- This query creates a human-readable summary perfect for LLM context
-- Using quoted identifiers for reserved keywords
SELECT
    'SCHEMA_SUMMARY' AS section,
    GROUP_CONCAT(
        'Table: ' || m.name
        || ' | Columns: ' || (
            SELECT
                GROUP_CONCAT(
                    p.name || '(' || p.type || ')'
                    || CASE WHEN p.pk > 0 THEN '[PK]' ELSE '' END
                    || CASE WHEN p."notnull" > 0 THEN '[NOT NULL]' ELSE '' END
                    || CASE WHEN p.dflt_value IS NOT NULL THEN '[DEFAULT:' || p.dflt_value || ']' ELSE '' END,
                    '; '
                )
            FROM PRAGMA_TABLE_INFO(m.name) AS p
        )
        || ' | Foreign Keys: ' || COALESCE((
            SELECT
                GROUP_CONCAT(
                    f."from" || ' -> ' || f.table || '.' || f."to", '; '
                )
            FROM PRAGMA_FOREIGN_KEY_LIST(m.name) AS f
        ), 'None')
        || ' | Indexes: ' || COALESCE((
            SELECT
                GROUP_CONCAT(
                    il.name || '('
                    || (SELECT GROUP_CONCAT(ii.name, ', ') FROM PRAGMA_INDEX_INFO(il.name) AS ii),
                    '; '
                )
            FROM PRAGMA_INDEX_LIST(m.name) AS il
        ), 'None'),
        CHAR(10)
    ) AS schema_description
FROM sqlite_master AS m
WHERE
    m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%';

-- ----------------------------------------------------------------------------
-- 10. QUERY TEMPLATES AND COMMON PATTERNS
-- ----------------------------------------------------------------------------

-- Document common query patterns based on schema
SELECT
    'QUERY_PATTERNS' AS section,
    'Use JOIN when querying related tables via foreign keys' AS pattern,
    'Example: SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id'
        AS example
UNION ALL
SELECT
    'QUERY_PATTERNS',
    'Use WHERE clause for filtering specific records',
    'Example: SELECT * FROM users WHERE age > 18 AND status = "active"'
UNION ALL
SELECT
    'QUERY_PATTERNS',
    'Use GROUP BY with aggregate functions for summaries',
    'Example: SELECT department, COUNT(*) FROM employees GROUP BY department'
UNION ALL
SELECT
    'QUERY_PATTERNS',
    'Use ORDER BY for sorted results',
    'Example: SELECT * FROM products ORDER BY price DESC LIMIT 10';

-- ============================================================================
-- END OF SCHEMA DISCOVERY SCRIPT
-- ============================================================================

-- NOTES FOR LLM CONTEXT GENERATION:
-- 1. Run sections 2, 3, 4, and 5 to get complete schema information
-- 2. Format the output as structured text or JSON for better RAG performance
-- 3. Include sample data (section 8) to help LLM understand data patterns
-- 4. Section 6 provides table names; use application code for actual row counts
-- 5. Consider adding business logic documentation as comments
