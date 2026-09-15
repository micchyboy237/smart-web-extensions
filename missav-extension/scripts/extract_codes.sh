sqlite3 /Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3 \
  "SELECT json_group_array(json_object('code', code, 'count', cnt)) FROM (SELECT string_value as code, COUNT(*) as cnt FROM embedding_metadata WHERE key = 'code' AND string_value IS NOT NULL AND string_value != '' GROUP BY string_value ORDER BY COUNT(*) DESC);" | \
  python3 -m json.tool > code_counts.json