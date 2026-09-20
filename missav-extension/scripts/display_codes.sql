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
