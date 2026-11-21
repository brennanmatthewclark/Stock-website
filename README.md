# Personal Stock Dashboard

A static website (index.html) fed by a daily Python job (fetch_data.py) that pulls data from Yahoo Finance via `yfinance`.
Hosted free on GitHub Pages and refreshed by a GitHub Actions workflow on weekdays after the US market closes.

Files: `index.html` (the dashboard) - `fetch_data.py` (daily data job) - `tickers.txt` (your watchlist) - `requirements.txt`
and `.github/workflows/update.yml` (the automation; created on GitHub by pasting).

Add or remove stocks by editing `tickers.txt` on GitHub and committing; the workflow runs automatically on every commit.

Run on your own computer:
    pip install -r requirements.txt
    python fetch_data.py            (or: python fetch_data.py --demo   for fake sample data)
    python -m http.server           then open http://localhost:8000

Notes: yfinance is unofficial; Yahoo may change fields or block requests (the page then shows "-" or keeps the last good data
marked "stale"). Data is delayed and for personal research only, not investment advice. The P/E history is one snapshot per day,
saved in data/pe_history.json, so the history chart fills in over time.
