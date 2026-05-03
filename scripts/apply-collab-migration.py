"""Inspect __drizzle_migrations table schema and apply collab_hub migration manually."""
import sqlite3, sys, os, hashlib, time

DB = r'C:\Users\Wise AI\AppData\Roaming\joycreate\sqlite.db'
SQL_FILE = r'C:\Users\Wise AI\joycreate\JoyCreate\drizzle\0046_collab_hub.sql'

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

print("=== __drizzle_migrations schema ===")
for r in db.execute("PRAGMA table_info(__drizzle_migrations)").fetchall():
    print(f"  {r['name']:20s} {r['type']}")

print("\n=== existing rows ===")
for r in db.execute("SELECT * FROM __drizzle_migrations ORDER BY id").fetchall():
    print(f"  id={r['id']} hash={r['hash'][:16]}... created_at={r['created_at']}")

print("\n=== checking existing collab tables ===")
for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_collab%'").fetchall():
    print(f"  exists: {r['name']}")

# Read SQL file, split on '--> statement-breakpoint'
with open(SQL_FILE, 'r', encoding='utf-8') as f:
    sql = f.read()

statements = [s.strip() for s in sql.split('--> statement-breakpoint') if s.strip()]
print(f"\n=== applying {len(statements)} statements from 0046_collab_hub.sql ===")
for i, stmt in enumerate(statements):
    first_line = stmt.split('\n')[0][:80]
    try:
        db.executescript(stmt)
        print(f"  [{i+1}/{len(statements)}] OK   {first_line}")
    except sqlite3.OperationalError as e:
        print(f"  [{i+1}/{len(statements)}] SKIP {first_line}  ({e})")

db.commit()
print("\n=== verifying tables ===")
for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_collab%' ORDER BY name").fetchall():
    cnt = db.execute(f"SELECT COUNT(*) FROM {r['name']}").fetchone()[0]
    print(f"  {r['name']:40s} rows={cnt}")

# Register in __drizzle_migrations so drizzle's runtime migrator skips it
hash_val = hashlib.sha256(sql.encode('utf-8')).hexdigest()
existing = db.execute("SELECT 1 FROM __drizzle_migrations WHERE hash = ?", (hash_val,)).fetchone()
if existing:
    print(f"\n=== already registered with hash {hash_val[:16]}... ===")
else:
    db.execute("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", (hash_val, int(time.time() * 1000)))
    db.commit()
    print(f"\n=== registered migration with hash {hash_val[:16]}... ===")
