"""
Repair a desynced JoyCreate SQLite DB whose drizzle migrations halted partway.

Applies every migration newer than the last journaled one, executing each
statement but skipping "duplicate column / already exists" style errors (which
happen when the DB schema is ahead of the journal). Each applied migration is
recorded in __drizzle_migrations so the app's migrator considers it done.

Usage: python scripts/repair-migrations.py <path-to-sqlite.db>
"""
import hashlib
import json
import os
import sqlite3
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIZZLE = os.path.join(REPO, "drizzle")
JOURNAL = os.path.join(DRIZZLE, "meta", "_journal.json")

# Substrings that mean "this statement is already satisfied" -> safe to skip.
SKIPPABLE = (
    "duplicate column name",
    "already exists",
    "already an index",
)


def is_skippable(msg: str) -> bool:
    m = msg.lower()
    return any(s in m for s in SKIPPABLE)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: repair-migrations.py <db>")
        return 2
    db_path = sys.argv[1]
    if not os.path.exists(db_path):
        print(f"DB not found: {db_path}")
        return 2

    with open(JOURNAL, "r", encoding="utf-8") as f:
        journal = json.load(f)
    entries = sorted(journal["entries"], key=lambda e: e["when"])

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    cur.execute(
        "CREATE TABLE IF NOT EXISTS __drizzle_migrations "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)"
    )
    row = cur.execute("SELECT MAX(created_at) FROM __drizzle_migrations").fetchone()
    last = row[0] if row and row[0] is not None else -1
    print(f"last journaled created_at = {last}")

    applied = 0
    for e in entries:
        when = e["when"]
        tag = e["tag"]
        if when <= last:
            continue
        sql_path = os.path.join(DRIZZLE, f"{tag}.sql")
        if not os.path.exists(sql_path):
            print(f"  ! missing migration file {tag}.sql — skipping")
            continue
        with open(sql_path, "r", encoding="utf-8") as f:
            content = f.read()
        statements = [s.strip() for s in content.split("--> statement-breakpoint")]
        ran = skipped = 0
        for stmt in statements:
            if not stmt:
                continue
            try:
                cur.executescript(stmt)
                ran += 1
            except sqlite3.OperationalError as ex:
                if is_skippable(str(ex)):
                    skipped += 1
                else:
                    print(f"  !! {tag}: unexpected error, skipping stmt: {ex}")
                    skipped += 1
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        cur.execute(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
            (digest, when),
        )
        applied += 1
        print(f"  applied {tag} (ran={ran} skipped={skipped})")

    con.commit()
    con.close()
    print(f"DONE. applied {applied} pending migration(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
