SELECT
    json_object(
        'code_count', counts.code_count,
        'total_videos', counts.total_videos,
        'items', json(counts.items_array)
    )
FROM (
    SELECT
        count(*) AS code_count,
        sum(cnt) AS total_videos,
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
