SELECT
    COUNT(*) FILTER (WHERE release_date IS NOT NULL) AS sprd_with_release_date,
    COUNT(*) AS total_videos,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE release_date IS NOT NULL)
        / NULLIF(COUNT(*), 0),
        2
    ) AS pct_with_release_date
FROM public.videos
WHERE code = 'sprd';
