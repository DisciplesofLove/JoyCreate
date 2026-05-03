import sqlite3, sys
db = sqlite3.connect(r'C:\Users\Wise AI\AppData\Roaming\joycreate\sqlite.db')
db.row_factory = sqlite3.Row
tabs = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
print("=== agent/collab tables ===")
for t in tabs:
    if 'collab' in t or t.startswith('agent'):
        cnt = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t:40s}  rows={cnt}")
print("\n=== agents rows ===")
for r in db.execute("SELECT id, name, type, status FROM agents").fetchall():
    print(f"  id={r['id']} name={r['name']} type={r['type']} status={r['status']}")
print("\n=== drizzle migrations applied ===")
try:
    rows = db.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 5").fetchall()
    for r in rows:
        print(f"  {r['hash'][:16]}... at {r['created_at']}")
except Exception as e:
    print(f"  (no __drizzle_migrations table: {e})")
