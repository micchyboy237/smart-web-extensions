-- Get all distinct metadata keys
SELECT DISTINCT key
FROM embedding_metadata
ORDER BY key;

-- Get sample documents with their metadata (all types)
SELECT
    e.id,
    em.key,
    em.string_value,
    em.int_value,
    em.float_value,
    em.bool_value,
    c.name AS collection_name
FROM embeddings AS e
INNER JOIN segments AS s ON e.segment_id = s.id
INNER JOIN collections AS c ON s.collection = c.id
LEFT JOIN embedding_metadata AS em ON e.id = em.id
LIMIT 50;

-- Get metadata as a consolidated view (COALESCE to get the actual value)
SELECT
    e.id,
    em.key,
    c.name AS collection_name,
    COALESCE(
        em.string_value,
        CAST(em.int_value AS TEXT),
        CAST(em.float_value AS TEXT),
        CAST(em.bool_value AS TEXT)
    ) AS value
FROM embeddings AS e
INNER JOIN segments AS s ON e.segment_id = s.id
INNER JOIN collections AS c ON s.collection = c.id
LEFT JOIN embedding_metadata AS em ON e.id = em.id
LIMIT 50;

-- Get complete metadata for specific documents
-- SELECT 
--     e.id,
--     GROUP_CONCAT(em.key || '=' || COALESCE(em.string_value, CAST(em.int_value AS TEXT), CAST(em.float_value AS TEXT), CAST(em.bool_value AS TEXT)), ', ') AS metadata_summary
-- FROM embeddings e
-- INNER JOIN segments s ON e.segment_id = s.id
-- INNER JOIN collections c ON s.collection = c.id
-- LEFT JOIN embedding_metadata em ON e.id = em.id
-- WHERE c.name = 'your_collection_name'
-- GROUP BY e.id
-- LIMIT 10;
