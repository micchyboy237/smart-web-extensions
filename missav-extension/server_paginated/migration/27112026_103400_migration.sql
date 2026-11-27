-- Add a vector column for semantic search
ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX IF NOT EXISTS idx_topics_embedding ON public.topics USING hnsw (
    embedding vector_cosine_ops
);

-- Add a text search vector for keyword/name search
ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS search_vector tsvector;
UPDATE public.topics SET
    search_vector = to_tsvector('english', coalesce(
        name, ''
    )
    || ' '
    || (
        SELECT string_agg(tw.word, ' ') FROM public.topic_words AS tw
        WHERE tw.topic_id = public.topics.id
    ));
CREATE INDEX IF NOT EXISTS idx_topics_search ON public.topics USING gin (
    search_vector
);

-- Trigger to keep search_vector updated when words change (optional but recommended)
CREATE OR REPLACE FUNCTION update_topic_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('english', COALESCE(NEW.name, '') || ' ' || (SELECT string_agg(word, ' ') FROM public.topic_words tw WHERE tw.topic_id = NEW.id));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_topic_search_vector
BEFORE INSERT OR UPDATE OF name ON public.topics
FOR EACH ROW EXECUTE FUNCTION update_topic_search_vector();
