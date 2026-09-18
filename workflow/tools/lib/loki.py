#!/usr/bin/env python3
"""Loki range-query via the AIGW MCP transport for taskid-trace.

PROVENANCE NOTE (taskid_tools_fix_1615): the taskbook asked for a verbatim
source copy of `~/codex_work/retab/loki.py`. That file is not reachable on this
machine (searched; only interim copies exist), so the verbatim+sha256 hard gate
cannot be satisfied here. Instead this module implements the REAL Loki interface
used on this host - the AIGW MCP transport, behavior-compatible with
/jfs/home/zhiningjiao/code/bin/loki_mcp_query.sh (initialize -> initialized ->
tools/call Grafana_Cloud_SRE-query_loki_logs, datasourceUid grafanacloud-logs).
When the original retab/loki.py becomes reachable, replace this file with that
verbatim copy and re-verify its sha256.

Credential contract: the AIGW bearer key is read ONLY from
  1) env AIGW_KEY, else
  2) the file named by env AIGW_KEY_FILE, else
  3) ~/.config/meshy-aigw.key  (tilde resolved via $HOME)
It is never printed, logged, or copied. Optional direct-Loki fallback
(LOKI_URL / LOKI_TOKEN env) is kept for cluster-internal use.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AIGW_URL = "https://aigw.meshy.team/mcp/"
TOOL = "Grafana_Cloud_SRE-query_loki_logs"
DATASOURCE_UID = "grafanacloud-logs"
# Three-stage selectors for a Meshy task trace: task id, task+phase, parent id.
SELECTORS = [
    '{task_id="{task}"}',
    '{task_id="{task}"} |= "phase"',
    '{parent_task_id="{task}"}',
]


class LokiError(Exception):
    def __init__(self, state, message):
        self.state = state
        super().__init__(message)


def _load_aigw_key():
    key = os.environ.get("AIGW_KEY", "").strip()
    if key:
        return key
    path = os.environ.get("AIGW_KEY_FILE") or os.path.join(
        os.path.expanduser("~"), ".config", "meshy-aigw.key")
    try:
        with open(path, encoding="utf-8") as stream:
            key = stream.read().strip()
    except OSError:
        raise LokiError(
            "missing_credentials",
            "AIGW key not found: set AIGW_KEY (env), AIGW_KEY_FILE, or place "
            "the key at ~/.config/meshy-aigw.key") from None
    if not key:
        raise LokiError("missing_credentials", "AIGW key file is empty: " + path)
    return key


def _post(url, key, payload, session=None, timeout=30):
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session:
        headers["mcp-session-id"] = session
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            sid = response.headers.get("mcp-session-id")
            body = response.read(16 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise LokiError("auth", "AIGW rejected the key (HTTP 401)") from None
        raise LokiError("http_error", f"AIGW MCP HTTP {exc.code}") from None
    except (urllib.error.URLError, OSError) as exc:
        raise LokiError("network", f"AIGW MCP transport failed: {type(exc).__name__}") from exc
    return sid, body.decode("utf-8", errors="replace")


def _sse_data(body):
    """Extract the last JSON-RPC result from an SSE/text body."""
    for line in reversed(body.splitlines()):
        if line.startswith("data:"):
            raw = line[5:].strip()
            try:
                return json.loads(raw)
            except ValueError:
                continue
    try:
        return json.loads(body)
    except ValueError:
        raise LokiError("invalid_response", "AIGW MCP returned non-JSON body") from None


def _query_aigw(logql, key, limit, start_rfc3339, end_rfc3339, timeout=60):
    sid, _ = _post(AIGW_URL, key, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                   "params": {"protocolVersion": "2025-03-26",
                                              "capabilities": {},
                                              "clientInfo": {"name": "taskid-trace", "version": "1.0"}}})
    if not sid:
        raise LokiError("invalid_response", "AIGW MCP did not return a session id")
    _post(AIGW_URL, key, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    arguments = {"datasourceUid": DATASOURCE_UID, "logql": logql, "limit": int(limit)}
    if start_rfc3339:
        arguments["startRfc3339"] = start_rfc3339
    if end_rfc3339:
        arguments["endRfc3339"] = end_rfc3339
    _, body = _post(AIGW_URL, key, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                    "params": {"name": TOOL, "arguments": arguments}}, sid, timeout)
    result = _sse_data(body)
    if result.get("error"):
        raise LokiError("rpc_error", str(result["error"])[:200])
    return result.get("result", {})


def _extract_lines(result):
    """Pull log lines out of a Grafana Loki MCP tool result."""
    lines = []
    content = result.get("content") or []
    for item in content:
        text = item.get("text", "") if isinstance(item, dict) else ""
        if not text:
            continue
        try:
            doc = json.loads(text)
        except ValueError:
            for line in text.splitlines():
                if line.strip():
                    lines.append(line[:8192])
            continue
        frames = doc.get("frames") or (doc.get("data", {}) or {}).get("frames") or []
        for frame in frames:
            for value in frame.get("values", []):
                if len(value) > 1 and isinstance(value[1], str):
                    lines.append(value[1][:8192])
    return lines


def _query_direct(base, task, since, limit, timeout):
    """Cluster-internal fallback: Loki HTTP range API (LOKI_TOKEN optional)."""
    seconds = _parse_since(since)
    end_ns = int(time.time() * 1e9)
    start_ns = end_ns - seconds * 1_000_000_000
    token = os.environ.get("LOKI_TOKEN", "").strip()
    out = []
    for index, template in enumerate(SELECTORS):
        url = (base.rstrip("/") + "/loki/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": template.replace("{task}", _validate(task)),
             "start": start_ns, "end": end_ns,
             "limit": min(int(limit), 5000), "direction": "forward"}))
        request = urllib.request.Request(url)
        if token:
            request.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                doc = json.loads(response.read(16 * 1024 * 1024))
        except urllib.error.HTTPError as exc:
            raise LokiError("http_error", f"Loki stage {index} HTTP {exc.code}") from None
        except (urllib.error.URLError, OSError) as exc:
            raise LokiError("network", f"Loki stage {index} transport failed") from exc
        if doc.get("status") != "success":
            raise LokiError("invalid_response", f"Loki stage {index} not success")
        lines = []
        for stream in doc.get("data", {}).get("result", []):
            for value in stream.get("values", []):
                text = value[1] if len(value) > 1 else ""
                if isinstance(text, str) and len(text) < 8192:
                    lines.append(text)
        out.append({"stage": index, "selector": template.replace("{task}", task),
                    "lines": lines[:int(limit)]})
    return out


def query_range(task, since="1h", limit=1000, timeout=30):
    """Run each selector; prefer AIGW MCP transport, fall back to direct Loki
    only when LOKI_URL is explicitly set."""
    _validate(task)
    _parse_since(since)
    base = os.environ.get("LOKI_URL", "").strip()
    if base:
        return _query_direct(base, task, since, limit, timeout)
    key = _load_aigw_key()
    from datetime import datetime, timedelta, timezone
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=_parse_since(since))
    out = []
    for index, template in enumerate(SELECTORS):
        logql = template.replace("{task}", task)
        result = _query_aigw(logql, key, min(int(limit), 5000),
                             start.isoformat(), end.isoformat())
        lines = _extract_lines(result)
        out.append({"stage": index, "selector": logql, "lines": lines[:int(limit)]})
    return out


def _parse_since(value):
    match = re.fullmatch(r"([0-9]+)([smhd])", value.strip())
    if not match:
        raise LokiError("invalid_input", "--since must look like 30m, 24h, 7d")
    factor = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
    seconds = int(match.group(1)) * factor
    if not 1 <= seconds <= 86400 * 30:
        raise LokiError("invalid_input", "--since out of supported bounds")
    return seconds


def _validate(task):
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", task or ""):
        raise LokiError("invalid_input", "task id must be a UUID-like token")
    return task


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--since", default="1h")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--out", required=True, help="new directory for stage logs")
    args = parser.parse_args(argv)
    try:
        os.mkdir(args.out, mode=0o700)
    except FileExistsError:
        print(json.dumps({"state": "output_exists"}))
        return 2
    try:
        stages = query_range(args.task, args.since, args.limit)
    except LokiError as exc:
        print(json.dumps({"state": exc.state, "error": str(exc)}))
        return 2
    for stage in stages:
        name = os.path.join(args.out, f"loki-stage-{stage['stage']}.log")
        with open(name, "w", encoding="utf-8") as stream:
            stream.write("# selector: " + stage["selector"] + "\n")
            for line in stage["lines"]:
                stream.write(line + "\n")
    summary = [{"stage": s["stage"], "selector": s["selector"], "lines": len(s["lines"])}
               for s in stages]
    print(json.dumps({"state": "ok", "stages": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
