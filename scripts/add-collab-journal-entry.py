"""Add 0050_collab_hub entry to drizzle journal."""
import json, time
JOURNAL = r'C:\Users\Wise AI\joycreate\JoyCreate\drizzle\meta\_journal.json'
with open(JOURNAL, 'r', encoding='utf-8') as f:
    j = json.load(f)
existing = [e for e in j['entries'] if e.get('tag') == '0050_collab_hub']
if existing:
    print("entry already present:", existing[0])
else:
    j['entries'].append({
        "idx": 50,
        "version": "6",
        "when": int(time.time() * 1000),
        "tag": "0050_collab_hub",
        "breakpoints": True,
    })
    with open(JOURNAL, 'w', encoding='utf-8') as f:
        json.dump(j, f, indent=2)
    print("added entry idx=50 tag=0050_collab_hub")
print(f"total entries: {len(j['entries'])}")
