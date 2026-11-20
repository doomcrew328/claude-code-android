#!/usr/bin/env bash
# LEASELINE data refresh. Run from the root of a gh-pages checkout.
#  - daily: rig activity (AER ST49, last 30 days) + wells licensed since the last ST37 snapshot
#  - when AER publishes a new ST37 well list (monthly): rebuild data/wells.bin.gz + wellnames.txt.gz
set -euo pipefail
ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -I dev/scripts/build_daily.py "$WORK/daily" "$ROOT/data" 30

ST37=https://static.aer.ca/prd/documents/sts/st37/ST_37_Excel.zip
LM="$(curl -sIL "$ST37" | grep -i '^last-modified' | tail -1 | cut -d' ' -f2- | tr -d '\r' || true)"
OLD="$(python3 -c "import json;print(json.load(open('data/meta.json')).get('st37_lm',''))" 2>/dev/null || true)"
if [ -n "$LM" ] && [ "$LM" != "$OLD" ]; then
  echo "ST37 changed ($OLD -> $LM): rebuilding well database"
  curl -sL "$ST37" -o "$WORK/st37.zip"
  mkdir -p "$WORK/st37" && (cd "$WORK/st37" && unzip -q -o ../st37.zip)
  SRC="$(dirname "$(find "$WORK/st37" -name 'ST37_SH.xlsx' | head -1)")"
  python3 -I dev/scripts/st37_extract.py "$SRC" "$WORK/tsv"
  python3 -I dev/scripts/pack_wells.py "$WORK/tsv" "$ROOT/data"
  python3 -I dev/scripts/build_daily.py "$WORK/daily" "$ROOT/data" 30   # new-licence list against the fresh snapshot
  python3 - "$LM" <<'PY'
import json, sys
m = json.load(open('data/meta.json'))
m['st37_lm'] = sys.argv[1]
json.dump(m, open('data/meta.json', 'w'), indent=1)
PY
fi
echo "refresh done"
