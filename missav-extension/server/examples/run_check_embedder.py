"""
Check if the analysis embedder is ready for topic extraction.

Usage:
    python run_check_embedder.py
"""

import argparse

from config import init_config

init_config()
from rich.console import Console
from services.analysis_service import check_embedder, get_topic_count

console = Console()

parser = argparse.ArgumentParser(
    description="Check if analysis embedder and data are ready for topic extraction."
)
args = parser.parse_args()

console.print("🔍 [Step 1/2] Checking embedder availability...")
ready = check_embedder()

console.print("📊 [Step 2/2] Checking existing data...")
video_count = get_topic_count()  # won't have topics yet, but verifies service works

if ready:
    console.print("\n✅ [bold green]Analysis embedder is ready![/bold green]")
    console.print("   You can now run run_extract_topics.py to extract topics.")
else:
    console.print("\n❌ [bold red]Analysis embedder is NOT ready.[/bold red]")
    console.print("   Make sure ChromaDB has videos with embeddings stored.")
    console.print("   Run ingestion first, then try again.")
