#!/usr/bin/env python3
"""
LanceDB Bridge - Node.js <-> Python LanceDB bridge via stdin/stdout JSON protocol.

Commands (JSON on stdin, JSON response on stdout):
  {"cmd": "ensure_table", "db_path": "...", "table": "...", "dim": 1024}
  {"cmd": "upsert", "db_path": "...", "table": "...", "records": [{chunk_id, video_id, video_url, video_title, chunk_index, start_seconds, end_seconds, text, segment_ids, vector, language, created_at}]}
  {"cmd": "search", "db_path": "...", "table": "...", "query_vector": [...], "top_k": 5, "video_id": null}
  {"cmd": "delete_by_video", "db_path": "...", "table": "...", "video_id": "..."}
  {"cmd": "list_videos", "db_path": "...", "table": "..."}
  {"cmd": "get_stats", "db_path": "...", "table": "..."}
  {"cmd": "get_video", "db_path": "...", "table": "...", "video_id": "..."}

Usage from Node.js:
  spawn("python3", ["lancedb_bridge.py"])
  Write JSON command to stdin, read JSON response from stdout.
"""

import json
import sys
import os

def main():
    request = json.loads(sys.stdin.read())
    cmd = request.get("cmd")

    try:
        import lancedb
        import pyarrow as pa
    except ImportError as e:
        print(json.dumps({"error": f"Missing Python dependencies: {e}. Install: pip install lancedb pyarrow"}))
        return

    db_path = request.get("db_path", ".")
    table_name = request.get("table", "video_kb")

    if cmd == "ensure_table":
        result = ensure_table(db_path, table_name, request.get("dim", 1024))
        print(json.dumps(result))

    elif cmd == "upsert":
        result = upsert_records(db_path, table_name, request.get("records", []))
        print(json.dumps(result))

    elif cmd == "search":
        result = search_similar(
            db_path, table_name,
            request.get("query_vector", []),
            request.get("top_k", 5),
            request.get("video_id"),
        )
        print(json.dumps(result))

    elif cmd == "delete_by_video":
        result = delete_by_video(db_path, table_name, request.get("video_id", ""))
        print(json.dumps(result))

    elif cmd == "list_videos":
        result = list_videos(db_path, table_name)
        print(json.dumps(result))

    elif cmd == "get_stats":
        result = get_stats(db_path, table_name)
        print(json.dumps(result))

    elif cmd == "get_video":
        result = get_video(db_path, table_name, request.get("video_id", ""))
        print(json.dumps(result))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))


def get_schema(dim):
    return pa.schema([
        pa.field("chunk_id", pa.string()),
        pa.field("video_id", pa.string()),
        pa.field("video_url", pa.string()),
        pa.field("video_title", pa.string()),
        pa.field("chunk_index", pa.int32()),
        pa.field("start_seconds", pa.float32()),
        pa.field("end_seconds", pa.float32()),
        pa.field("text", pa.string()),
        pa.field("segment_ids", pa.list_(pa.string())),
        pa.field("vector", pa.list_(pa.float32(), dim)),
        pa.field("language", pa.string()),
        pa.field("created_at", pa.int64()),
    ])


def ensure_table(db_path, table_name, dim):
    db = lancedb.connect(db_path)
    try:
        db.open_table(table_name)
        return {"ok": True, "existed": True}
    except Exception:
        schema = get_schema(dim)
        db.create_table(table_name, schema=schema)
        return {"ok": True, "existed": False}


def upsert_records(db_path, table_name, records):
    db = lancedb.connect(db_path)
    table = db.open_table(table_name)

    for record in records:
        # Delete existing chunks for this video_id first (upsert semantics)
        # LanceDB doesn't have native upsert, so delete + add
        video_id = record.get("video_id")
        if video_id:
            try:
                table.delete(f'video_id = "{video_id}"')
            except Exception:
                pass  # table may be empty

    # Convert records to arrow table
    schema = table.schema
    data = {
        "chunk_id": [r["chunk_id"] for r in records],
        "video_id": [r["video_id"] for r in records],
        "video_url": [r["video_url"] for r in records],
        "video_title": [r["video_title"] for r in records],
        "chunk_index": [r.get("chunk_index", 0) for r in records],
        "start_seconds": [r.get("start_seconds", 0.0) for r in records],
        "end_seconds": [r.get("end_seconds", 0.0) for r in records],
        "text": [r.get("text", "") for r in records],
        "segment_ids": [r.get("segment_ids", []) for r in records],
        "vector": [r["vector"] for r in records],
        "language": [r.get("language", "") for r in records],
        "created_at": [r.get("created_at", 0) for r in records],
    }

    arrow_table = pa.Table.from_pydict(data, schema=schema)
    table.add(arrow_table)

    return {"ok": True, "count": len(records)}


def search_similar(db_path, table_name, query_vector, top_k, video_id=None):
    db = lancedb.connect(db_path)
    table = db.open_table(table_name)

    query = table.search(query_vector).limit(top_k)
    if video_id:
        query = query.where(f'video_id = "{video_id}"')

    results = query.to_list()

    return {
        "results": [{
            "chunk_id": r.get("chunk_id", ""),
            "video_id": r.get("video_id", ""),
            "video_url": r.get("video_url", ""),
            "video_title": r.get("video_title", ""),
            "start_seconds": float(r.get("start_seconds", 0)),
            "end_seconds": float(r.get("end_seconds", 0)),
            "text": r.get("text", ""),
            "segment_ids": r.get("segment_ids", []),
            "score": float(r.get("_distance", 0)),
        } for r in results]
    }


def delete_by_video(db_path, table_name, video_id):
    db = lancedb.connect(db_path)
    table = db.open_table(table_name)
    table.delete(f'video_id = "{video_id}"')
    return {"ok": True, "video_id": video_id}


def list_videos(db_path, table_name):
    db = lancedb.connect(db_path)
    table = db.open_table(table_name)
    df = table.to_pandas()

    videos = []
    if len(df) > 0:
        grouped = df.groupby("video_id").agg({
            "video_url": "first",
            "video_title": "first",
            "chunk_id": "count",
            "start_seconds": "min",
            "end_seconds": "max",
            "language": "first",
            "created_at": "first",
        }).reset_index()

        for _, row in grouped.iterrows():
            videos.append({
                "video_id": row["video_id"],
                "video_url": row["video_url"],
                "video_title": row["video_title"],
                "chunk_count": int(row["chunk_id"]),
                "duration_start": float(row["start_seconds"]),
                "duration_end": float(row["end_seconds"]),
                "language": row["language"],
                "created_at": int(row["created_at"]),
            })

    return {"videos": videos}


def get_stats(db_path, table_name):
    db = lancedb.connect(db_path)
    try:
        table = db.open_table(table_name)
        count = table.count_rows()
        return {"total_chunks": count, "table": table_name}
    except Exception:
        return {"total_chunks": 0, "table": table_name}


def get_video(db_path, table_name, video_id):
    db = lancedb.connect(db_path)
    table = db.open_table(table_name)
    df = table.search().where(f'video_id = "{video_id}"').to_pandas()

    chunks = []
    for _, row in df.iterrows():
        chunks.append({
            "chunk_id": row.get("chunk_id", ""),
            "chunk_index": int(row.get("chunk_index", 0)),
            "start_seconds": float(row.get("start_seconds", 0)),
            "end_seconds": float(row.get("end_seconds", 0)),
            "text": row.get("text", ""),
            "segment_ids": row.get("segment_ids", []),
        })

    chunks.sort(key=lambda c: c["chunk_index"])

    return {
        "video_id": video_id,
        "chunks": chunks,
        "chunk_count": len(chunks),
    }


if __name__ == "__main__":
    main()
