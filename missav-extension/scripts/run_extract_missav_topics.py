"""Extract KeyNMF topics from MissAV documents and save inputs and outputs."""

import json
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import topicwizard
from jet.adapters.llama_cpp.chunking_utils import truncate_texts
from jet.adapters.llama_cpp.config import EMBED_MODEL
from jet.adapters.turftopic.embed import LlamaCppEncoder
from jet.libs.bertopic.examples.mock import load_missav_videos
from jet.wordnet.keywords.helpers import preprocess_texts
from jet.wordnet.n_grams import score_documents_by_ngrams
from rich.console import Console
from rich.table import Table
from topicwizard.figures.documents import document_map
from topicwizard.figures.topics import topic_barcharts, topic_map
from turftopic import KeyNMF
from turftopic.vectorizers.spacy import NounPhraseCountVectorizer

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

INPUT_FILE = OUTPUT_DIR / "input_documents.json"
PREROCESSED_DOCS_FILE = OUTPUT_DIR / "preprocessed_documents.json"
SCORED_DOCS_FILE = OUTPUT_DIR / "scored_documents.json"
SORTED_INPUT_FILE = OUTPUT_DIR / "sorted_input_documents.json"
TOPICS_FILE = OUTPUT_DIR / "topics.json"
TOPICS_CSV = OUTPUT_DIR / "topics.csv"
DOCUMENT_TOPICS_FILE = OUTPUT_DIR / "document_topics.json"
REPRESENTATIVE_DOCS_FILE = OUTPUT_DIR / "representative_documents.json"
TOPIC_BARCHARTS_FILE = OUTPUT_DIR / "topic_barcharts.html"
REPRESENTATIVE_TOP_K = 10
TOPIC_MAP_FILE = OUTPUT_DIR / "topic_map.html"
DOCUMENT_MAP_FILE = OUTPUT_DIR / "document_map.html"

saved_files: list[Path] = []


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    saved_files.append(path)


def write_figure(path: Path, figure) -> None:
    figure.write_html(path, include_plotlyjs="cdn")
    saved_files.append(path)


console.print("📄 Loading documents...")
docs = load_missav_videos(code=["juc"])
docs = truncate_texts(
    docs, model=EMBED_MODEL, max_tokens=128, valid_sentences_only=True
)
corpus = [d for d in docs if d.strip()]
console.print(f"   Loaded {len(corpus)} documents")

write_json(
    INPUT_FILE,
    {
        "total_documents": len(corpus),
        "documents": [{"index": i, "content": doc} for i, doc in enumerate(corpus)],
    },
)
console.print(f"💾 Saved input documents ({len(corpus)})")


preprocessed_corpus = preprocess_texts(corpus)
write_json(
    PREROCESSED_DOCS_FILE,
    {
        "total_documents": len(corpus),
        "documents": [
            {"index": i, "content": doc} for i, doc in enumerate(preprocessed_corpus)
        ],
    },
)
console.print(f"💾 Saved preprocessed documents ({len(preprocessed_corpus)})")

results = score_documents_by_ngrams(
    preprocessed_corpus,
    min_words=1,
    max_words=3,
    min_doc_count=2,
)
write_json(
    SCORED_DOCS_FILE,
    results,
)
console.print(f"💾 Saved scored documents ({len(results)})")

sorted_corpus = [corpus[r["index"]] for r in results]  # map to original doc
# sorted_corpus = [r["text"] for r in results]  # use preprocessed text

write_json(
    SORTED_INPUT_FILE,
    {
        "total_documents": len(sorted_corpus),
        "documents": [
            {"index": i, "content": doc} for i, doc in enumerate(sorted_corpus)
        ],
    },
)
console.print(f"💾 Saved sorted input documents ({len(sorted_corpus)})")

corpus = sorted_corpus
corpus = corpus[:100]  # Temp limit

console.print("Initializing NounPhraseCountVectorizer...")
vectorizer = NounPhraseCountVectorizer("en_core_web_sm", min_df=1)

console.print("Initializing LlamaCppEncoder...")
encoder = LlamaCppEncoder(model=EMBED_MODEL, batch_size=64)

console.print("Fitting KeyNMF model with noun-phrase vectorizer...")
model = KeyNMF(n_components=5, vectorizer=vectorizer, encoder=encoder)
document_topic_matrix = model.fit_transform(corpus)

representative_topics = []
for topic_id, topic_scores in enumerate(np.asarray(document_topic_matrix).T):
    ranked = [
        int(index) for index in np.argsort(-topic_scores) if topic_scores[index] > 0
    ]
    chosen = ranked[:REPRESENTATIVE_TOP_K]
    representative_topics.append(
        {
            "topic_id": topic_id,
            "count": len(chosen),
            "documents": [
                {
                    "index": index,
                    "score": float(topic_scores[index]),
                    "content": corpus[index],
                }
                for index in chosen
            ],
        }
    )
representative_by_topic = {item["topic_id"]: item for item in representative_topics}

topics = []
for topic_id, words in model.get_topics(top_k=10):
    topic_id = int(topic_id)
    topics.append(
        {
            "topic_id": topic_id,
            "representative_document_count": representative_by_topic[topic_id]["count"],
            "words": [{"word": word, "score": float(score)} for word, score in words],
        }
    )
write_json(TOPICS_FILE, {"n_topics": len(topics), "topics": topics})
write_json(
    REPRESENTATIVE_DOCS_FILE,
    {"top_k": REPRESENTATIVE_TOP_K, "topics": representative_topics},
)
model.topics_df(top_k=10, show_scores=True).to_csv(TOPICS_CSV, index=False)
saved_files.append(TOPICS_CSV)

topic_names = [str(name) for name in model.topic_names]
document_topics = []
for index, scores in enumerate(document_topic_matrix):
    top_index = int(scores.argmax())
    document_topics.append(
        {
            "index": index,
            "topic_id": top_index,
            "topic_name": topic_names[top_index],
            "scores": [float(score) for score in scores],
        }
    )
write_json(
    DOCUMENT_TOPICS_FILE,
    {
        "topic_names": topic_names,
        "n_documents": len(document_topics),
        "documents": document_topics,
    },
)
console.print(f"💾 Saved {len(topics)} topics and document assignments")

topic_table = Table(title="Extracted topics", show_lines=True)
topic_table.add_column("ID", justify="right", style="blue")
topic_table.add_column("Rep. docs", justify="right", style="green")
topic_table.add_column("Top words", style="magenta", max_width=80)
for topic in topics:
    words = ", ".join(item["word"] for item in topic["words"][:8])
    topic_table.add_row(
        str(topic["topic_id"]),
        str(topic["representative_document_count"]),
        words,
    )
console.print(topic_table)

console.print("Preparing topic visualization...")
topic_data = model.prepare_topic_data(corpus)
rep_counts = [item["count"] for item in representative_topics]

barcharts = topic_barcharts(topic_data)
for annotation, count in zip(barcharts.layout.annotations, rep_counts):
    annotation.text = f"{annotation.text}<br>({count} representative docs)"
write_figure(TOPIC_BARCHARTS_FILE, barcharts)

topic_map_fig = topic_map(topic_data)
topic_map_fig.update_traces(
    text=[
        f"<b>{name}</b><br>{count} docs"
        for name, count in zip(topic_data["topic_names"], rep_counts)
    ],
    hovertemplate="%{text}<extra></extra>",
    hoverinfo="text",
)
write_figure(TOPIC_MAP_FILE, topic_map_fig)

represented_by = [[] for _ in corpus]
for item in representative_topics:
    for document in item["documents"]:
        represented_by[document["index"]].append(str(item["topic_id"]))
document_metadata = pd.DataFrame(
    {
        "preview": [doc[:160].replace("\n", " ") for doc in corpus],
        "representative_of": [
            ", ".join(topic_ids) if topic_ids else "—" for topic_ids in represented_by
        ],
    }
)
write_figure(
    DOCUMENT_MAP_FILE,
    document_map(topic_data, document_metadata=document_metadata),
)
console.print("💾 Saved visualization figures")

console.print("\n[bold green]📂 Saved files:[/bold green]")
for path in saved_files:
    console.print(
        f"   [bold bright_blue][link=file://{path.resolve()}]{path.name}[/link][/bold bright_blue]"
    )

console.print("\nLaunching TopicWizard...")
topicwizard.visualize(topic_data=topic_data)
