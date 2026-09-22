"""SQLite 场景存储:保存 / 恢复命名场景。"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH", str(Path.cwd() / "scheduler.db"))


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scenarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )


def save_scenario(name: str, scenario: dict) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    payload = json.dumps(scenario, ensure_ascii=False)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO scenarios (name, payload, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET payload = excluded.payload,
                                            updated_at = excluded.updated_at
            """,
            (name, payload, now),
        )
        row = conn.execute(
            "SELECT id, name, updated_at FROM scenarios WHERE name = ?", (name,)
        ).fetchone()
    return dict(row)


def list_scenarios() -> list:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at FROM scenarios ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_scenario(sid: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, payload, updated_at FROM scenarios WHERE id = ?", (sid,)
        ).fetchone()
    if not row:
        return None
    out = dict(row)
    out["scenario"] = json.loads(out.pop("payload"))
    return out


def delete_scenario(sid: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM scenarios WHERE id = ?", (sid,))
        return cur.rowcount > 0
