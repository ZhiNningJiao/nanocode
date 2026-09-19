# PROVENANCE: verbatim source copy (upstream not modified; only this header prepended)
# upstream: <HOST_HOME>/code/task-asset-fetch-0918/task_asset_fetch.py
# copied: 2026-09-18, task taskid_tools_nanocode_1410
# upstream_sha256: 5a110e9329c89c9932ef36173fca621cee85b8b15656dbb87176de8ae873c400
"""Bounded, read-only Meshy task file retrieval. No implicit credentials."""
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import socket
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class FetchError(Exception):
    def __init__(self, state, message):
        self.state = state
        super().__init__(message)


def endpoint(env, lane=None):
    if env == "prod":
        return "https://api.meshy.ai"
    if env == "staging":
        return "https://api.staging.meshy.ai"
    if not lane or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", lane):
        raise FetchError("invalid_input", "lane requires a valid explicit --lane name")
    return f"https://{lane}.api.staging.meshy.ai"


def task_id(value):
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise FetchError("invalid_input", "task ID must be a UUID") from None


def safe_key(key, allow_empty=False):
    if not key and allow_empty:
        return key
    if (not key or key.startswith("/") or "\\" in key or
            any(ord(c) < 32 for c in key) or
            any(p in ("", ".", "..") for p in key.rstrip("/").split("/"))):
        raise FetchError("invalid_input", "invalid task-relative object key")
    return key


def download_url(url, resolver=socket.getaddrinfo):
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower()
        allowed = (host == "assets.meshy.ai" or host.endswith(".meshy.ai") or
                   host == "cdn.taichi-graphics.com" or
                   re.fullmatch(r"(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?", host))
        if p.scheme != "https" or p.username or p.password or p.port not in (None, 443) or p.fragment or not allowed:
            raise FetchError("unsafe_url", "download URL is not a trusted HTTPS asset origin")
        addresses = resolver(host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise FetchError("unsafe_url", "asset host resolves to a non-public address")
    except (ValueError, socket.gaierror):
        raise FetchError("network", "asset host validation failed") from None
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_error(status, management=True):
    if status == 401:
        return FetchError("auth_required" if management else "download_auth_required", "HTTP 401; credential missing, expired or invalid")
    if status == 403:
        return FetchError("auth_rejected" if management else "download_auth_rejected", "HTTP 403; this request was rejected")
    if status == 404:
        return FetchError("not_found", "HTTP 404; task, object or route not found in this explicit environment")
    if status in (405, 501):
        return FetchError("unsupported", f"HTTP {status}; operation unsupported")
    if status == 429:
        return FetchError("rate_limited", "HTTP 429")
    return FetchError("http_error", f"HTTP {status}")


class HTTP:
    """Management redirects fail closed; asset redirects never receive credentials."""
    def __init__(self, seconds):
        self.deadline = time.monotonic() + seconds
        self.opener = urllib.request.build_opener(NoRedirect())

    def remaining(self):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise FetchError("timeout", "total time budget exhausted")
        return min(left, 15)

    def open(self, url, token=None):
        management = token is not None
        for _ in range(6):
            if not management:
                download_url(url)
            headers = {"Accept": "application/json"} if management else {}
            if management:
                headers["Authorization"] = "Bearer " + token
            try:
                return self.opener.open(urllib.request.Request(url, headers=headers), timeout=self.remaining())
            except urllib.error.HTTPError as e:
                status, location = e.code, e.headers.get("Location")
                e.close()
                if status in (301, 302, 303, 307, 308):
                    if management:
                        raise FetchError("unexpected_redirect", "management API redirected; no credential forwarded") from None
                    if not location:
                        raise FetchError("invalid_response", "redirect without Location") from None
                    url = urllib.parse.urljoin(url, location)
                    continue
                raise http_error(status, management) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise FetchError("network", "HTTP transport failed (URL suppressed)") from None
        raise FetchError("unsafe_url", "download redirect limit exceeded")

    def chunks(self, response):
        while True:
            self.remaining()
            try:
                chunk = response.read1(65536)
            except (OSError, TimeoutError, http.client.HTTPException):
                raise FetchError("network", "response read failed (URL suppressed)") from None
            if not chunk:
                return
            yield chunk

    def get_json(self, url, token):
        data = bytearray()
        with self.open(url, token) as response:
            for chunk in self.chunks(response):
                data.extend(chunk)
                if len(data) > 4 * 1024 * 1024:
                    raise FetchError("size_limit", "API response exceeds 4 MiB")
        try:
            return json.loads(data)
        except (ValueError, UnicodeError):
            raise FetchError("invalid_response", "API returned non-JSON content") from None


class Client:
    def __init__(self, base, token, http):
        self.base, self.token, self.http = base, token, http

    def get(self, task, operation, **query):
        url = self.base + "/misc/tasks/" + task + "/" + operation
        if query:
            url += "?" + urllib.parse.urlencode(query)
        doc = self.http.get_json(url, self.token)
        if not isinstance(doc, dict):
            raise FetchError("invalid_response", "API response must be an object")
        if operation == "info":
            # This endpoint returns the document itself, unlike files/signed-url.
            if not any(k in doc for k in ("Args", "Status", "Mode")):
                raise FetchError("invalid_response", "task info lacks expected fields")
            return doc
        if doc.get("code") != "OK":
            raise FetchError("api_error", "API envelope did not report code OK")
        if not isinstance(doc.get("result"), dict):
            raise FetchError("invalid_response", "API response lacks result object")
        return doc["result"]

    def listing(self, task, prefix, max_pages):
        entries, prefixes, cursor, seen = [], [], "", set()
        for _ in range(max_pages):
            page = self.get(task, "files", prefix=prefix, cursor=cursor)
            if not isinstance(page.get("entries"), list) or not isinstance(page.get("prefixes"), list):
                raise FetchError("invalid_response", "invalid files listing")
            for entry in page["entries"]:
                if not isinstance(entry, dict) or not isinstance(entry.get("key"), str) or not isinstance(entry.get("size"), int) or entry["size"] < 0:
                    raise FetchError("invalid_response", "invalid listing entry")
                entries.append({"key": safe_key(entry["key"]), "size": entry["size"]})
            for p in page["prefixes"]:
                if not isinstance(p, str):
                    raise FetchError("invalid_response", "invalid listing prefix")
                prefixes.append(safe_key(p))
            cursor = page.get("next_cursor", "")
            if not cursor:
                return {"entries": entries, "prefixes": prefixes, "recursive": False}
            if not isinstance(cursor, str) or cursor in seen:
                raise FetchError("invalid_response", "repeated or invalid pagination cursor")
            seen.add(cursor)
        raise FetchError("page_limit", "listing exceeded --max-pages; not complete")


def validate_file(path, key):
    suffix = PurePosixPath(key).suffix.lower()
    if suffix == ".glb":
        with path.open("rb") as f:
            header = f.read(12)
            if len(header) != 12 or header[:4] != b"glTF":
                raise FetchError("invalid_asset", "GLB magic/header invalid")
            _, version, length = struct.unpack("<4sII", header)
            if version != 2 or length != path.stat().st_size or length < 24 or length % 4:
                raise FetchError("invalid_asset", "GLB version/declared length invalid")
            index = 0
            while f.tell() < length:
                chunk_header = f.read(8)
                if len(chunk_header) != 8:
                    raise FetchError("invalid_asset", "GLB chunk header truncated")
                chunk_len, chunk_type = struct.unpack("<I4s", chunk_header)
                if chunk_len % 4 or f.tell() + chunk_len > length:
                    raise FetchError("invalid_asset", "GLB chunk alignment/bounds invalid")
                if index == 0:
                    if chunk_type != b"JSON" or chunk_len > 16 * 1024 * 1024:
                        raise FetchError("invalid_asset", "GLB first chunk must be JSON within 16 MiB")
                    try:
                        doc = json.loads(f.read(chunk_len))
                        valid = isinstance(doc, dict) and isinstance(doc.get("asset"), dict) and doc["asset"].get("version") == "2.0"
                    except (ValueError, UnicodeError):
                        valid = False
                    if not valid:
                        raise FetchError("invalid_asset", "GLB JSON chunk/asset.version invalid")
                else:
                    f.seek(chunk_len, 1)
                index += 1
        return "glb_structure_json_v2"
    if suffix == ".json":
        try:
            with path.open(encoding="utf-8") as f:
                json.load(f)
        except (ValueError, UnicodeError):
            raise FetchError("invalid_asset", "JSON parse failed") from None
        return "json_parse"
    return "bytes_only_format_unverified"


def fetch_file(client, task, key, target, byte_limit):
    if target.exists() or target.is_symlink():
        raise FetchError("output_exists", "refusing to overwrite local output")
    signed = client.get(task, "signed-url", key=key)
    if not isinstance(signed.get("url"), str):
        raise FetchError("invalid_response", "signed-url response lacks URL")
    digest, total = hashlib.sha256(), 0
    fd, name = tempfile.mkstemp(prefix=".partial-", dir=target.parent)
    partial = Path(name)
    try:
        with os.fdopen(fd, "wb") as f, client.http.open(signed["url"]) as response:
            size = response.headers.get("Content-Length")
            try:
                expected = int(size) if size is not None else None
            except ValueError:
                raise FetchError("invalid_response", "invalid Content-Length") from None
            if expected is not None and (expected < 0 or expected > byte_limit):
                raise FetchError("size_limit", "asset exceeds remaining byte budget")
            for chunk in client.http.chunks(response):
                total += len(chunk)
                if total > byte_limit:
                    raise FetchError("size_limit", "asset exceeds remaining byte budget")
                f.write(chunk)
                digest.update(chunk)
            if expected is not None and total != expected:
                raise FetchError("invalid_asset", "Content-Length does not match downloaded bytes")
        validation = validate_file(partial, key)
        # Atomic no-replace publication; unlike rename, link refuses an existing name.
        try:
            os.link(partial, target)
        except FileExistsError:
            raise FetchError("output_exists", "refusing to overwrite local output") from None
        return {"key": key, "local_file": target.name, "bytes": total,
                "sha256": digest.hexdigest(), "validation": validation, "role": "unverified"}
    finally:
        partial.unlink(missing_ok=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("task")
    p.add_argument("--env", required=True, choices=("prod", "staging", "lane"))
    p.add_argument("--lane")
    p.add_argument("--source-task", help="explicit source task; lineage remains unverified")
    p.add_argument("--out", required=True, help="new output directory; must not exist")
    auth = p.add_mutually_exclusive_group()
    auth.add_argument("--token-env", default="MESHY_TASK_TOKEN")
    auth.add_argument("--token-stdin", action="store_true")
    p.add_argument("--prefix", default="")
    p.add_argument("--key", action="append", default=[])
    p.add_argument("--max-pages", type=int, default=10)
    p.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    p.add_argument("--timeout", type=int, default=120)
    args = p.parse_args(argv)
    manifest = {"state": "started", "downloads": [], "role": "unverified", "real_asset_downloaded": False}
    out = None
    timer_active = False
    previous_handler = None
    try:
        requested = task_id(args.task)
        source = task_id(args.source_task) if args.source_task else requested
        base = endpoint(args.env, args.lane)
        if args.lane and args.env != "lane":
            raise FetchError("invalid_input", "--lane requires --env lane")
        if not (1 <= args.max_pages <= 100 and 1 <= args.max_bytes <= 2**31 and 1 <= args.timeout <= 1800 and len(args.key) <= 100):
            raise FetchError("invalid_input", "limits outside supported bounds")
        for key in args.key:
            safe_key(key)
            if key.endswith("/"):
                raise FetchError("invalid_input", "--key must be a file")
        safe_key(args.prefix, allow_empty=True)
        def timed_out(_signum, _frame):
            raise FetchError("timeout", "total time budget exhausted")
        previous_handler = signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, args.timeout)
        timer_active = True
        token = sys.stdin.readline(8192).strip() if args.token_stdin else os.environ.get(args.token_env, "").strip()
        if not token:
            raise FetchError("auth_required", "explicit msctl token required; no home credentials read")
        if not re.fullmatch(r"msctl_[A-Za-z0-9_-]+", token):
            raise FetchError("unsupported_auth", "expected an msctl_ access token, not an AIGW or user API key")
        candidate = Path(args.out).absolute()
        try:
            candidate.mkdir(mode=0o700, parents=False, exist_ok=False)
        except FileExistsError:
            raise FetchError("output_exists", "--out already exists; no files changed") from None
        out = candidate
        manifest.update(requested_task=requested, source_task=source, environment=args.env,
                        lane=args.lane, endpoint=base, source_lineage="explicit_unverified" if args.source_task else "same_task",
                        started_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        client = Client(base, token, HTTP(args.timeout))
        info = client.get(source, "info")
        # Deliberately omit UserID, Args, Result, URLs and other customer content.
        manifest["task_info"] = {k: info[k] for k in ("Mode", "Phase", "Status", "CreatedAt", "StartedAt", "FinishedAt")
                                 if isinstance(info.get(k), str) and re.fullmatch(r"[A-Za-z0-9_.:+ TZ-]{1,100}", info[k])}
        manifest["listing"] = client.listing(source, args.prefix, args.max_pages)
        remaining = args.max_bytes
        for index, key in enumerate(args.key):
            target = out / (f"asset-{index:03d}" + PurePosixPath(key).suffix.lower())
            item = fetch_file(client, source, key, target, remaining)
            remaining -= item["bytes"]
            manifest["downloads"].append(item)
        manifest["state"] = "downloaded" if args.key else "listed"
        manifest["real_asset_downloaded"] = bool(manifest["downloads"])
        code = 0
    except FetchError as e:
        manifest.update(state=e.state, error=str(e))
        code = 2
    except OSError:
        manifest.update(state="local_io_error", error="local filesystem operation failed")
        code = 2
    finally:
        if timer_active:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
    if out is not None:
        manifest["ended_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with (out / "manifest.json").open("x", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2, ensure_ascii=False)
                f.write("\n")
        except OSError:
            manifest.update(state="local_io_error", error="could not publish manifest")
            code = 2
    print(json.dumps({"state": manifest["state"], "error": manifest.get("error"),
                      "download_count": len(manifest["downloads"])}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
