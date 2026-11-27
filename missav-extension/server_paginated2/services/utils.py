# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server_paginated2/services/utils.py
import base64
import hashlib
import json
import re
from functools import lru_cache
from typing import List, Optional, Tuple, Union

from fastapi import HTTPException
from jet.adapters.llama_cpp.config import EMBED_MODEL, EMBED_QUERY_PREFIX
from jet.adapters.llama_cpp.embed_utils import embed
from models.schemas.video import (
    GroupedSearchRequest,
    HybridRequest,
    SearchRequest,
    SimilarRequest,
)

# Fixed imports: GenreCodeInput comes from types.common
from models.types.common import GenreCodeInput

_PREFIX_RE = re.compile(r"^\s*([A-Za-z0-9]+)-\d+\s*[:\-\u2013\u2014]?\s*")


def _strip_code_prefix(text: Optional[str], code: str) -> Optional[str]:
    if not text or not code:
        return text
    m = _PREFIX_RE.match(text)
    if not m:
        return text
    if m.group(1).lower() != code.lower():
        return text
    return text[m.end() :].lstrip()


def clean_fields(
    title: Optional[str], details: Optional[str], code: str
) -> Tuple[Optional[str], Optional[str]]:
    return (_strip_code_prefix(title, code), _strip_code_prefix(details, code))


def normalize_list_input(val: GenreCodeInput) -> Optional[List[str]]:
    if val is None:
        return None
    out: List[str] = []
    if isinstance(val, str):
        out.extend(s.strip() for s in val.split(",") if s.strip())
    else:
        for item in val:
            if not isinstance(item, str):
                continue
            out.extend(s.strip() for s in item.split(",") if s.strip())
    return out or None


def fingerprint(req: Union[SearchRequest, SimilarRequest, HybridRequest]) -> str:
    genre_list = normalize_list_input(getattr(req, "genre", None))
    code_list = normalize_list_input(getattr(req, "code", None))
    filter_parts = [
        getattr(req, "query", ""),
        sorted(genre_list) if genre_list else None,
        getattr(req, "genres_mode", "any"),
        sorted(code_list) if code_list else None,
        getattr(req, "min_release_date", None),
        getattr(req, "max_release_date", None),
        getattr(req, "min_similarity", None),
        getattr(req, "sort", None),
        getattr(req, "order", None),
        getattr(req, "completion_filter", "all"),
        getattr(req, "video_id", None),
    ]
    filter_str = "|".join(str(x) for x in filter_parts)
    return hashlib.sha256(filter_str.encode()).hexdigest()[:12]


def encode_cursor(sort_key: Optional[Union[float, str]], last_id: str, fp: str) -> str:
    payload = {
        "k": sort_key if sort_key is None else str(sort_key),
        "i": last_id,
        "f": fp,
    }
    raw = json.dumps(payload, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str, fp: str) -> Tuple[Optional[str], str]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        sort_key = data.get("k")
        last_id = str(data["i"])
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if data.get("f") != fp:
        raise HTTPException(status_code=400, detail="Cursor does not match filters")
    return sort_key, last_id


@lru_cache(maxsize=256)
def embed_query(text: str) -> tuple:
    return tuple(
        embed(
            text=text,
            model=EMBED_MODEL,
            return_format="list",
            show_progress=False,
            prefix=EMBED_QUERY_PREFIX,
        )
    )


def to_float_list(value) -> List[float]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    for attr in ("to_list", "tolist"):
        fn = getattr(value, attr, None)
        if callable(fn):
            return [float(x) for x in fn()]
    fn = getattr(value, "to_numpy", None)
    if callable(fn):
        return [float(x) for x in fn().tolist()]
    try:
        return [float(x) for x in memoryview(value).cast("f")]
    except Exception:
        pass
    if isinstance(value, str):
        s = value.strip().strip("[]")
        return [float(x) for x in s.split(",") if x.strip()]
    raise TypeError(f"Unsupported embedding value: type={type(value).__name__}")


def normalize_episode(episode: str) -> str:
    ep = (episode or "").strip()
    if ep.isdigit():
        return ep.zfill(8)
    return ep.lower()


def grouped_fingerprint(req: GroupedSearchRequest) -> str:
    genre_list = normalize_list_input(req.genre)
    code_list = normalize_list_input(req.code)
    parts = [
        req.query or "",
        req.video_id or "",
        sorted(genre_list) if genre_list else None,
        req.genres_mode,
        sorted(code_list) if code_list else None,
        req.min_release_date,
        req.max_release_date,
        req.completion_filter,
        req.min_similarity,
        round(float(req.diversity), 6),
        int(req.fetch_k) if req.fetch_k is not None else None,
    ]
    return hashlib.sha256("|".join(str(x) for x in parts).encode()).hexdigest()[:12]


def encode_grouped_cursor(
    anchor: Optional[Tuple[Optional[float], str, str]], offset: int, fp: str
) -> str:
    payload = {
        "a": [anchor[0], anchor[1], anchor[2]] if anchor else None,
        "o": int(offset),
        "f": fp,
    }
    raw = json.dumps(payload, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_grouped_cursor(
    cursor: str, fp: str
) -> Tuple[Optional[Tuple[Optional[float], str, str]], int]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        a = data.get("a")
        anchor = None
        if a is not None:
            dist = None if a[0] is None else float(a[0])
            anchor = (dist, str(a[1]), str(a[2]))
        offset = int(data.get("o", 0))
        if offset < 0:
            raise ValueError("negative offset")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if data.get("f") != fp:
        raise HTTPException(
            status_code=400, detail="Cursor does not match current filters"
        )
    return anchor, offset
