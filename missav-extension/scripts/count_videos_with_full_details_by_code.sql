-- Count videos with full details, grouped by code.
-- "Full details" = details IS NOT NULL, release_date IS NOT NULL, and
-- genres IS NOT NULL (with at least one genre).
-- Matches the `completion_filter=complete` definition in serve_missav.py.
SELECT
    code,
    COUNT(*) FILTER (
        WHERE details IS NOT NULL
          AND release_date IS NOT NULL
          AND genres IS NOT NULL
          AND cardinality(genres) > 0
    ) AS with_full_details,
    COUNT(*) AS total_videos,
    ROUND(
        100.0 * COUNT(*) FILTER (
            WHERE details IS NOT NULL
              AND release_date IS NOT NULL
              AND genres IS NOT NULL
              AND cardinality(genres) > 0
        )
        / NULLIF(COUNT(*), 0),
        2
    ) AS pct_with_full_details
FROM public.videos
WHERE code IN ('sprd', 'juq')
GROUP BY code
ORDER BY code;