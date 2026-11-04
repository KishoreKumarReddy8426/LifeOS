import json
import urllib.parse
from pathlib import Path
import pandas as pd

SHEET_ID = "1NHnUz-DlmzCaFZFxY2b29feXY3jLSrZ9YbhMt0wBHpo"
SHEETS = {"daily":"Daily Tracker","study":"Study Tracker","podcast":"Podcast Tracker","health":"Health Tracker"}
OUTPUT = Path(__file__).resolve().parent.parent / "sheet_data.json"

def load_sheet(sheet_name):
    encoded_name = urllib.parse.quote(sheet_name, safe="")
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet={encoded_name}"
    return pd.read_csv(url).fillna("").to_dict(orient="records")

def main():
    data, failed = {}, []
    for key, sheet_name in SHEETS.items():
        try:
            data[key] = load_sheet(sheet_name)
            print(f"SUCCESS: {sheet_name} — {len(data[key])} rows")
        except Exception as exc:
            failed.append(sheet_name)
            print(f"FAILED: {sheet_name}: {exc}")
    if failed:
        raise SystemExit("Export failed; preserving existing JSON: " + ", ".join(failed))
    OUTPUT.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Export completed: {OUTPUT}")

if __name__ == "__main__":
    main()
