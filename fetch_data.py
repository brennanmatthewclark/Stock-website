#!/usr/bin/env python3
"""Daily data fetch for the personal stock dashboard.

Reads tickers.txt, pulls data from Yahoo Finance through the yfinance library and writes
two static files the website reads:

    <out>/stocks.json      latest snapshot for every ticker
    <out>/pe_history.json  one row per ticker per day (builds up over time)

Usage
    python fetch_data.py                      # real data -> data/
    python fetch_data.py --demo               # fake data, no network

Design notes
    * One bad ticker never breaks the run. If a ticker fails, yesterday's data for it is kept
      and flagged "stale".
    * If EVERY ticker fails (Yahoo outage / blocked IP) the script exits non-zero so the CI
      pipeline fails and the previously deployed site stays untouched.
    * History survives between runs because the data/ folder is committed back to the repository
      by the GitHub Actions workflow (on GitLab it is restored from the previous job artifact instead).
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import random
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

HISTORY_LIMIT = 1500  # rows per ticker (~6 years of daily snapshots)


# --------------------------------------------------------------------------- helpers
def num(x, nd: int | None = None):
    """float or None. Turns NaN / inf / strings like 'Infinity' / numpy types into clean JSON."""
    try:
        if x is None:
            return None
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, nd) if nd is not None else v


def pos(x, nd: int | None = None):
    """Like num() but None for zero/negative (P/E and EPS-based ratios are meaningless then)."""
    v = num(x, nd)
    return v if v is not None and v > 0 else None


def txt(x):
    return x.strip() if isinstance(x, str) and x.strip() else None


def iso(x) -> str | None:
    if x is None:
        return None
    try:
        return x.isoformat()[:10]
    except AttributeError:
        s = str(x)[:10]
        return s if s and s != "NaT" else None


def read_tickers(path: Path) -> list[str]:
    seen, out = set(), []
    for line in path.read_text().splitlines():
        t = line.split("#")[0].strip().upper()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def dump_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, allow_nan=False, separators=(",", ":")))
    tmp.replace(path)


# --------------------------------------------------------------------------- extraction
PERIOD_LABELS = {"0q": "Current Qtr", "+1q": "Next Qtr", "0y": "Current Year", "+1y": "Next Year"}
EXCHANGES = {"NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NYQ": "NYSE", "ASE": "NYSE", "PCX": "NYSE"}


def estimate_rows(df, year_ago_col: str) -> list[dict]:
    rows: list[dict] = []
    if df is None or getattr(df, "empty", True):
        return rows
    for period, r in df.iterrows():
        period = str(period)
        rows.append({
            "period": period,
            "label": PERIOD_LABELS.get(period, period),
            "avg": num(r.get("avg")),
            "low": num(r.get("low")),
            "high": num(r.get("high")),
            "analysts": (int(r["numberOfAnalysts"]) if num(r.get("numberOfAnalysts")) is not None else None),
            "yearAgo": num(r.get(year_ago_col)),
            "growth": num(r.get("growth"), 4),
        })
    return rows


def financial_rows(t) -> list[dict]:
    """Last ~5 fiscal years: revenue, gross profit, operating income, net income, EPS, free cash flow."""
    inc, cf = t.income_stmt, t.cashflow

    def pick(df, names, col):
        if df is None or getattr(df, "empty", True) or col not in df.columns:
            return None
        for n in names:
            if n in df.index:
                v = num(df.at[n, col])
                if v is not None:
                    return v
        return None

    rows = []
    if inc is None or getattr(inc, "empty", True):
        return rows
    for col in sorted(inc.columns):  # oldest -> newest
        row = {
            "year": str(col)[:4],
            "end": iso(col),
            "revenue": pick(inc, ["Total Revenue", "Operating Revenue"], col),
            "grossProfit": pick(inc, ["Gross Profit"], col),
            "operatingIncome": pick(inc, ["Operating Income", "Total Operating Income As Reported"], col),
            "netIncome": pick(inc, ["Net Income", "Net Income Common Stockholders"], col),
            "eps": pick(inc, ["Diluted EPS", "Basic EPS"], col),
            "fcf": pick(cf, ["Free Cash Flow"], col),
        }
        if any(row[k] is not None for k in ("revenue", "netIncome", "operatingIncome")):
            rows.append(row)
    return rows[-5:]


def analyst_block(t, info) -> dict:
    a = {
        "rating": txt(info.get("recommendationKey")),
        "ratingMean": num(info.get("recommendationMean"), 2),
        "numAnalysts": int(info["numberOfAnalystOpinions"]) if num(info.get("numberOfAnalystOpinions")) is not None else None,
        "targetLow": num(info.get("targetLowPrice"), 2),
        "targetMean": num(info.get("targetMeanPrice"), 2),
        "targetMedian": num(info.get("targetMedianPrice"), 2),
        "targetHigh": num(info.get("targetHighPrice"), 2),
        "breakdown": None,
        "recent": [],
    }
    try:
        rs = t.recommendations_summary
        if rs is not None and len(rs):
            r = rs.iloc[0]  # current month
            a["breakdown"] = {k: int(num(r.get(k)) or 0) for k in ("strongBuy", "buy", "hold", "sell", "strongSell")}
    except Exception:
        pass
    try:
        ud = t.upgrades_downgrades
        if ud is not None and len(ud):
            for idx, r in ud.sort_index(ascending=False).head(10).iterrows():
                a["recent"].append({
                    "date": iso(idx),
                    "firm": txt(r.get("Firm")),
                    "action": txt(r.get("Action")),
                    "from": txt(r.get("FromGrade")),
                    "to": txt(r.get("ToGrade")),
                    "target": pos(r.get("currentPriceTarget"), 2),
                    "priorTarget": pos(r.get("priorPriceTarget"), 2),
                })
    except Exception:
        pass
    return a


def next_earnings(t, eps_est_rows) -> dict:
    out = {"date": None, "eps": None, "revenue": None}
    try:
        cal = t.calendar
        if isinstance(cal, dict):
            today = dt.date.today()
            dates = [d for d in (cal.get("Earnings Date") or []) if hasattr(d, "isoformat")]
            upcoming = sorted(d for d in dates if (d.date() if isinstance(d, dt.datetime) else d) >= today)
            if upcoming:
                out["date"] = iso(upcoming[0])
            out["eps"] = num(cal.get("Earnings Average"), 2)
            out["revenue"] = num(cal.get("Revenue Average"))
    except Exception:
        pass
    if out["eps"] is None:  # fall back to current-quarter consensus
        for r in eps_est_rows:
            if r["period"] == "0q":
                out["eps"] = r["avg"]
    return out


def safe(fn, default):
    try:
        return fn()
    except Exception:
        return default


def fetch_one(ticker: str, yf) -> dict:
    t = yf.Ticker(ticker)
    info = t.info or {}
    price = num(info.get("currentPrice") or info.get("regularMarketPrice"), 2)
    if price is None:
        price = safe(lambda: num(t.fast_info["last_price"], 2), None)
    if price is None:
        raise RuntimeError("no price returned")

    trailing_eps, forward_eps = num(info.get("trailingEps"), 2), num(info.get("forwardEps"), 2)
    pe = pos(info.get("trailingPE"), 2) or (pos(price / trailing_eps, 2) if trailing_eps and trailing_eps > 0 else None)
    fwd = pos(info.get("forwardPE"), 2) or (pos(price / forward_eps, 2) if forward_eps and forward_eps > 0 else None)

    eps_rows = safe(lambda: estimate_rows(t.earnings_estimate, "yearAgoEps"), [])
    rev_rows = safe(lambda: estimate_rows(t.revenue_estimate, "yearAgoRevenue"), [])

    return {
        "ticker": ticker,
        "name": txt(info.get("longName")) or txt(info.get("shortName")) or ticker,
        "sector": txt(info.get("sector")) or "Equities",
        "industry": txt(info.get("industry")),
        "price": price,
        "low52": num(info.get("fiftyTwoWeekLow"), 2),
        "high52": num(info.get("fiftyTwoWeekHigh"), 2),
        "marketCap": num(info.get("marketCap")),
        "pe": pe,
        "fwdPe": fwd,
        "peg": pos(info.get("trailingPegRatio") or info.get("pegRatio"), 2),
        "trailingEps": trailing_eps,
        "forwardEps": forward_eps,
        "dividendYield": num(info.get("dividendYield"), 4),
        "nextEarnings": next_earnings(t, eps_rows),
        "analyst": analyst_block(t, info),
        "estimates": {"earnings": eps_rows, "revenue": rev_rows},
        "financials": safe(lambda: financial_rows(t), []),
        "financeSlug": f"{ticker}:{EXCHANGES.get(str(info.get('exchange')), 'NASDAQ')}",
        "saSlug": ticker.lower().replace("-", "."),
        "asOf": dt.date.today().isoformat(),
        "stale": False,
    }


# --------------------------------------------------------------------------- demo data
def demo_stock(ticker: str) -> dict:
    r = random.Random(ticker)
    price = round(r.uniform(40, 600), 2)
    eps = round(price / r.uniform(12, 45), 2)
    fwd_eps = round(eps * r.uniform(1.05, 1.3), 2)
    base_rev = r.uniform(20e9, 300e9)
    fin = []
    for i, y in enumerate(range(dt.date.today().year - 5, dt.date.today().year)):
        rev = base_rev * (1.09 ** i)
        fin.append({"year": str(y), "end": f"{y}-12-31", "revenue": rev, "grossProfit": rev * 0.55,
                    "operatingIncome": rev * 0.28, "netIncome": rev * 0.22, "eps": round(eps * (1.1 ** (i - 4)), 2),
                    "fcf": rev * 0.2})
    cur = fin[-1]["revenue"]
    est = lambda p, lbl, avg, g: {"period": p, "label": lbl, "avg": avg, "low": avg * 0.95, "high": avg * 1.05,
                                  "analysts": r.randint(18, 45), "yearAgo": avg / (1 + g), "growth": g}
    mean_t = price * r.uniform(0.95, 1.3)
    return {
        "ticker": ticker, "name": f"Demo Company {ticker}", "sector": r.choice(["Technology", "Consumer", "Healthcare"]),
        "industry": "Demo", "price": price, "low52": round(price * 0.7, 2), "high52": round(price * 1.15, 2),
        "marketCap": price * 1e9, "pe": round(price / eps, 2), "fwdPe": round(price / fwd_eps, 2), "peg": 1.8,
        "trailingEps": eps, "forwardEps": fwd_eps, "dividendYield": 0.006,
        "nextEarnings": {"date": (dt.date.today() + dt.timedelta(days=r.randint(5, 60))).isoformat(),
                         "eps": round(eps / 4, 2), "revenue": cur / 4},
        "analyst": {"rating": r.choice(["buy", "buy", "strong_buy", "hold"]), "ratingMean": round(r.uniform(1.4, 2.8), 2),
                    "numAnalysts": r.randint(20, 50), "targetLow": round(mean_t * 0.75, 2), "targetMean": round(mean_t, 2),
                    "targetMedian": round(mean_t, 2), "targetHigh": round(mean_t * 1.3, 2),
                    "breakdown": {"strongBuy": r.randint(5, 15), "buy": r.randint(10, 25), "hold": r.randint(3, 12),
                                  "sell": r.randint(0, 3), "strongSell": r.randint(0, 2)},
                    "recent": [{"date": (dt.date.today() - dt.timedelta(days=i * 6)).isoformat(), "firm": f"Demo Bank {i}",
                                "action": r.choice(["main", "up", "down", "init"]), "from": "Hold", "to": "Buy",
                                "target": round(mean_t * 1.02, 2), "priorTarget": round(mean_t * 0.95, 2)} for i in range(1, 7)]},
        "estimates": {
            "earnings": [est("0q", "Current Qtr", eps / 4, 0.12), est("+1q", "Next Qtr", eps / 4 * 1.05, 0.11),
                         est("0y", "Current Year", eps * 1.08, 0.08), est("+1y", "Next Year", fwd_eps * 1.12, 0.14)],
            "revenue": [est("0q", "Current Qtr", cur / 4, 0.09), est("+1q", "Next Qtr", cur / 4 * 1.03, 0.09),
                        est("0y", "Current Year", cur * 1.09, 0.09), est("+1y", "Next Year", cur * 1.2, 0.1)]},
        "financials": fin,
        "financeSlug": f"{ticker}:NASDAQ", "saSlug": ticker.lower(),
        "asOf": dt.date.today().isoformat(), "stale": False,
    }


def demo_history(stock: dict, days: int = 120) -> list[dict]:
    r = random.Random(stock["ticker"] + "h")
    pe, fwd, price = stock["pe"], stock["fwdPe"], stock["price"]
    rows = []
    for i in range(days, 0, -1):
        pe *= 1 + r.uniform(-0.012, 0.012)
        fwd *= 1 + r.uniform(-0.012, 0.012)
        price *= 1 + r.uniform(-0.012, 0.012)
        rows.append({"d": (dt.date.today() - dt.timedelta(days=i)).isoformat(), "price": round(price, 2),
                     "pe": round(pe, 2), "fwd": round(fwd, 2)})
    return rows


# --------------------------------------------------------------------------- CI plumbing
def fetch_previous_from_gitlab(dest: Path) -> None:
    """Download yesterday's deployed data from the last successful `pages` job's artifacts.

    Works with a private project and private Pages because it authenticates with CI_JOB_TOKEN.
    Silently does nothing outside GitLab CI or when no earlier run exists (first run).
    """
    api, pid, tok = os.environ.get("CI_API_V4_URL"), os.environ.get("CI_PROJECT_ID"), os.environ.get("CI_JOB_TOKEN")
    if not (api and pid and tok):
        return
    ref = os.environ.get("CI_DEFAULT_BRANCH", "main")
    url = f"{api}/projects/{pid}/jobs/artifacts/{ref}/download?job=pages"
    try:
        req = urllib.request.Request(url, headers={"JOB-TOKEN": tok})
        with urllib.request.urlopen(req, timeout=60) as resp:
            z = zipfile.ZipFile(io.BytesIO(resp.read()))
        for name in ("public/data/stocks.json", "public/data/pe_history.json"):
            if name in z.namelist():
                (dest / Path(name).name).write_bytes(z.read(name))
        print("Loaded previous data from last pages artifact")
    except Exception as e:  # first run, expired artifact, etc.
        print(f"No previous artifact available ({e}); starting fresh")


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default="tickers.txt")
    ap.add_argument("--out", default="data")
    ap.add_argument("--demo", action="store_true", help="write fake data (no network); the site shows a DEMO banner")
    ap.add_argument("--pause", type=float, default=1.5, help="seconds between tickers (be polite to Yahoo)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tickers = read_tickers(Path(args.tickers))
    if not tickers:
        print("tickers.txt is empty", file=sys.stderr)
        return 1

    if not args.demo and not ((out / "stocks.json").exists() and (out / "pe_history.json").exists()):
        fetch_previous_from_gitlab(out)
    prev_payload = load_json(out / "stocks.json", {})
    prev = {s["ticker"]: s for s in prev_payload.get("stocks", []) if not prev_payload.get("demo")}
    history = {} if (args.demo or prev_payload.get("demo")) else load_json(out / "pe_history.json", {})

    stocks, errors = [], {}
    if args.demo:
        for tk in tickers:
            s = demo_stock(tk)
            stocks.append(s)
            history[tk] = demo_history(s)
    else:
        import yfinance as yf  # imported late so --demo works without it

        for i, tk in enumerate(tickers):
            err = None
            for attempt in range(3):
                try:
                    stocks.append(fetch_one(tk, yf))
                    err = None
                    break
                except Exception as e:  # network, rate limit, unknown ticker...
                    err = f"{type(e).__name__}: {e}"
                    time.sleep(4 * (attempt + 1))
            if err:
                errors[tk] = err
                if tk in prev:
                    old = dict(prev[tk])
                    old["stale"] = True
                    stocks.append(old)
                print(f"[{tk}] FAILED -> {err}" + (" (kept previous data)" if tk in prev else ""), file=sys.stderr)
            else:
                print(f"[{tk}] ok  price={stocks[-1]['price']}  pe={stocks[-1]['pe']}  fwd={stocks[-1]['fwdPe']}")
            if i < len(tickers) - 1:
                time.sleep(args.pause)

    fresh = [s for s in stocks if not s.get("stale")]
    if not args.demo and not fresh:
        print("Every ticker failed; leaving the deployed site unchanged.", file=sys.stderr)
        return 1

    # daily snapshot -> history (only for freshly fetched tickers)
    today = dt.date.today().isoformat()
    for s in fresh:
        rows = [r for r in history.get(s["ticker"], []) if r.get("d") != today]
        rows.append({"d": today, "price": s["price"], "pe": s["pe"], "fwd": s["fwdPe"]})
        history[s["ticker"]] = rows[-HISTORY_LIMIT:]
    for tk in list(history):  # drop history of removed tickers
        if tk not in tickers:
            del history[tk]

    dump_json(out / "stocks.json", {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "demo": args.demo,
        "errors": errors,
        "stocks": stocks,
    })
    dump_json(out / "pe_history.json", history)
    print(f"Wrote {len(stocks)} stocks ({len(errors)} errors) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
