# Dynamically resolve output dir equivalent to: Path(__file__).parent / "generated" / Path(__file__).stem
SCRIPT_DIR="${0:A:h}"
SCRIPT_STEM="${0:A:t:r}"
OUTPUT_DIR="${SCRIPT_DIR}/generated/${SCRIPT_STEM}"

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="${OUTPUT_DIR}/videos.json"

psql -h localhost -p 5432 -U postgres -d missav_db1 \
  -Atq -o "$OUTPUT_FILE" \
  -c "
SELECT jsonb_pretty(json_agg(t)::jsonb)
FROM (
  SELECT
      v.code,
      v.episode,

      -- Representative id / video_id: prefer the "normal" (non-uncensored,
      -- non-engsub) video; fall back to uncensored, then engsub.
      (
        array_agg(v.id ORDER BY
          CASE
            WHEN v.url NOT LIKE '%-uncensored-leak'
             AND v.url NOT LIKE '%-english-subtitle' THEN 0
            WHEN v.url LIKE '%-uncensored-leak'        THEN 1
            ELSE 2
          END,
          v.id
        )
      )[1]                                                                 AS id,

      (
        array_agg(v.video_id ORDER BY
          CASE
            WHEN v.url NOT LIKE '%-uncensored-leak'
             AND v.url NOT LIKE '%-english-subtitle' THEN 0
            WHEN v.url LIKE '%-uncensored-leak'        THEN 1
            ELSE 2
          END,
          v.id
        )
      )[1]                                                                 AS video_id,

      count(DISTINCT v.id)                                                 AS video_count,

      -- Representative metadata
      (array_agg(v.title ORDER BY length(v.title) ASC NULLS LAST))[1]      AS title,
      (array_agg(v.thumbnail ORDER BY v.id))[1]                            AS thumbnail,
      (array_agg(v.preview   ORDER BY v.id))[1]                            AS preview,
      (array_agg(v.details   ORDER BY v.id))[1]                            AS details,

      -- Single representative release date
      (array_agg(v.release_date ORDER BY
          CASE
            WHEN v.url NOT LIKE '%-uncensored-leak'
             AND v.url NOT LIKE '%-english-subtitle' THEN 0
            WHEN v.url LIKE '%-uncensored-leak'        THEN 1
            ELSE 2
          END,
          v.id
        )
      )[1]                                                                 AS release_date,

      -- Merged, deduplicated genres
      array_agg(DISTINCT g.genre)
        FILTER (WHERE g.genre IS NOT NULL AND g.genre <> '')               AS genres,

      -- Bookkeeping
      min(v.created_at)                                                    AS created_at,
      max(v.updated_at)                                                    AS updated_at,

      -- URL, split by suffix (one string each, first match)
      (array_agg(v.url ORDER BY v.id)
        FILTER (WHERE v.url NOT LIKE '%-uncensored-leak'
                   AND v.url NOT LIKE '%-english-subtitle'))[1]            AS url,
      (array_agg(v.url ORDER BY v.id)
        FILTER (WHERE v.url LIKE '%-uncensored-leak'))[1]                  AS url_uncnsrd,
      (array_agg(v.url ORDER BY v.id)
        FILTER (WHERE v.url LIKE '%-english-subtitle'))[1]                 AS url_engsub

  FROM public.videos v
  LEFT JOIN LATERAL unnest(v.genres) AS g(genre) ON true
  WHERE
      v.code IN ('ssni', 'ssis', 'snis')
      AND btrim(v.code)    <> ''
      AND btrim(v.episode) <> ''
      AND v.details is not null
  GROUP BY
      v.code,
      v.episode
  ORDER BY
      v.code,
      v.episode
  LIMIT 20
) t;
"

echo "Saved to: ${OUTPUT_FILE}"