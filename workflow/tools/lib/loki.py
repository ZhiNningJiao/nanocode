"""Loki query helper for the retab A/B — thin wrapper over the SRE Grafana MCP.

Same transport as ~/codex_work/loki_mcp.sh (OPS_HANDBOOK §2 方案2), but returns
parsed rows so callers can aggregate instead of eyeballing 70KB of JSON.
"""

import datetime
import json
import os
import sys
import urllib.request

KEYPATH = os.path.expanduser("~/.config/meshy-aigw.key")
URL = "https://aigw.meshy.team/mcp/"


def _rpc(method, params, rid=1):
    key = open(KEYPATH).read().strip()
    req = urllib.request.Request(
        URL,
        data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    body = urllib.request.urlopen(req, timeout=180).read().decode()
    for line in body.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:])
    return json.loads(body)


def query(logql, start=None, end=None, hours=6.0, limit=100):
    """Run LogQL. start/end are datetime or RFC3339 str; else last `hours`."""
    _rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "retab", "version": "1"}})
    now = datetime.datetime.now(datetime.timezone.utc)
    def fmt(x, dflt):
        if x is None:
            return dflt.strftime("%Y-%m-%dT%H:%M:%SZ")
        if isinstance(x, str):
            return x
        return x.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    s = fmt(start, now - datetime.timedelta(hours=hours))
    e = fmt(end, now)
    r = _rpc("tools/call", {"name": "Grafana_Cloud_SRE-query_loki_logs", "arguments": {
        "datasourceUid": "grafanacloud-logs", "logql": logql, "limit": limit,
        "startRfc3339": s, "endRfc3339": e}}, 2)
    if r.get("error"):
        raise RuntimeError("MCP-ERR " + json.dumps(r["error"])[:400])
    out = []
    for c in r.get("result", {}).get("content", []):
        txt = c.get("text", "")
        try:
            out.append(json.loads(txt))
        except Exception:
            out.append({"_raw": txt})
    return out


def rows(logql, **kw):
    """Flatten a log query into [(ts_ns:int, line:str, labels:dict), ...] ascending."""
    res = []
    for blob in query(logql, **kw):
        for d in blob.get("data", []) or []:
            if "line" not in d:
                continue
            ts = d["timestamp"]
            if isinstance(ts, str):
                ts = ts.strip('"')
            res.append((int(ts), d["line"], d.get("labels", {})))
    res.sort()
    return res


if __name__ == "__main__":
    q = sys.argv[1]
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 6
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    for ts, line, lab in rows(q, hours=hours, limit=limit):
        t = datetime.datetime.fromtimestamp(ts / 1e9, datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        print(t, "|", lab.get("service", "")[:44], "|", line.rstrip()[:400])
