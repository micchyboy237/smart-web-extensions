import json

import chroma_service


def main():
    query = "amazing videos"
    top_k = 20
    where = None
    where_document = None

    all_count = chroma_service.get_count()

    search_results = chroma_service.search(
        query,
        top_k,
        where,
        where_document,
    )

    print(
        f"Search results:\n{json.dumps(search_results, indent=1, ensure_ascii=False)}"
    )
    print(f"All count: {all_count}")
    print(f"Results count: {len(search_results)}")


if __name__ == "__main__":
    main()
