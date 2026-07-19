from config import init_config

init_config()

from services.chroma_service import search

query = "amazing videos"
top_k = 5
diversity = 0.5

# Normal, deterministic diverse search
results = search(query, top_k=top_k, diversity=diversity)
print("Normal, deterministic diverse search:")
for i, res in enumerate(results, 1):
    print(f"#{i} {res['metadata']['video_id']} {res['score']:.3f}")

# First shuffle
shuffled_1 = search(query, top_k=top_k, diversity=diversity, shuffle_seed=1)
print("\nFirst shuffle (shuffle_seed=1):")
for i, res in enumerate(shuffled_1, 1):
    print(f"#{i} {res['metadata']['video_id']} {res['score']:.3f}")

# Different shuffle
shuffled_2 = search(query, top_k=top_k, diversity=diversity, shuffle_seed=2)
print("\nDifferent shuffle (shuffle_seed=2):")
for i, res in enumerate(shuffled_2, 1):
    print(f"#{i} {res['metadata']['video_id']} {res['score']:.3f}")

# Reproducing the exact same shuffle again
same_as_1 = search(
    query, top_k=top_k, diversity=diversity, shuffle_seed=1
)  # == shuffled_1
print("\nReproducing shuffle_seed=1 (should match first shuffle):")
for i, res in enumerate(same_as_1, 1):
    print(f"#{i} {res['metadata']['video_id']} {res['score']:.3f}")
