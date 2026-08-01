#!/usr/bin/env python3
"""
secretary_resurrect.py — 秘书自动梯度复活模块（v4 草稿：两段式 + 动态选池）

消费一期产出的判死信号 ~/codex_work/SECRETARY_DOWN，两段式复活（E 项，主人 2026-07-31 定纲）：
  stage-1 先把复活单甩给 Noa（k3-resident tmux / k3_resident_inbox 任务文件契约），
  等 noa_timeout（默认 300s）；Noa 完成（done flag）→ 史官不重复动作；
  Noa 超时/未接单/k3-resident 不存在 → stage-2 史官自动复活兜底。
stage-2 梯度（C 项 v4 动态选池，替代 v3 固定五级 GRADIENT）：四池（T1~T4）按 usage_snap
实时用量选最空闲且未死的 Fable 池——先比 fable%/5h%，都紧比 reset5h/resetfb 谁先到；
限额类死亡跳过死池；全 Fable 池不可用 → Codex 末梯兜底。
上下文三层（预防性 compact / 搬尸 resume / 兜底交接包），收尾改住址+重启史官+
改飞书桥+飞书报主人。另有 --compact-patrol 入口做预防性 compact。

权威 spec：~/code/worker-core/SECRETARY_MIGRATION.md；
提案母本：~/codex_work/REPORT_secmig_audit.md C 项（四池动态选池）+ E 项（两段式）。
绝不修改 waker_core.py / wake-secretary.py（一期领地）。

入口：
  secretary_resurrect.py                 # 复活（受 DRY_RUN=1 / --dry-run 控制）
  secretary_resurrect.py --compact-patrol # 预防性 compact（crontab 每小时）
  secretary_resurrect.py --selftest       # 离线单测
  secretary_resurrect.py --drill          # DRY_RUN 全梯度三分支演练日志
"""

import argparse
import datetime as _dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

HOME = os.path.expanduser("~")
CODE_DIR = os.path.join(HOME, "code")
CODEX_WORK = os.path.join(HOME, "codex_work")

CHAT_ID = "«FEISHU_CHAT_ID»"
NTFY_URL = "http://«INTERNAL_HOST»/zhiningwork"

# v4：四池 Fable 候选 + Codex 末梯兜底（C 项，替代 v3 固定五级 GRADIENT——已删，
# 固定顺序不再硬编码；T1/T2 Opus 两梯被 v4 spec「Codex 末梯兜底」覆盖，一并下线）。
FABLE_POOLS = [
    {"team": "T1", "config": ".claude",        "model": "claude-fable-5",   "gate": "fable"},
    {"team": "T2", "config": ".claude-team2",  "model": "claude-fable-5",   "gate": "fable"},
    {"team": "T3", "config": ".claude-team3",  "model": "claude-fable-5",   "gate": "fable"},
    {"team": "T4", "config": ".claude-team4",  "model": "claude-fable-5",   "gate": "fable"},
]

CODEX_TIER = {"name": "Codex5.6", "type": "codex", "team": "CODEX", "config": None,
              "model": "gpt-5.6", "gate": "codex"}

# D-3 哨兵行（usage-snap.sh 在 token 过期/宕机/异常 HTTP/结构异常时写裸词而非用量行）：
# 命中即「无有效快照」，不当数字解析（C 项选池依赖本站数据可靠性）。
SNAP_SENTINEL_RE = re.compile(r'\b(SNAP_ERR|AUTH_EXPIRED|API_DOWN|API_BADSHAPE|HTTP_\w+)\b')

QUOTA_RE = re.compile(
    r"429|rate[\s_.-]?limit|too many requests|usage[\s_.-]?limit|quota|"
    r"out of (?:credits|usage)|5[\s.-]?hour limit|weekly limit|resets_at|"
    r"(?:monthly|org(?:anization)?[\s_.-]?)?spend limit|credit balance|"
    r"insufficient credit|monthly limit", re.I)


def _log_file() -> str:
    return os.environ.get("RESURRECT_LOG_FILE", os.path.join(CODEX_WORK, "resurrect.log"))


def log(msg: str) -> None:
    line = f"[{_dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        lf = _log_file()
        d = os.path.dirname(lf)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(lf, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


@dataclass
class Cfg:
    dry: bool = False
    safe: bool = False
    down_file: str = os.path.join(CODEX_WORK, "SECRETARY_DOWN")
    home_env: str = os.path.join(CODE_DIR, "secretary-home.env")
    snap_log: str = os.path.join(CODEX_WORK, "usage_snap.log")
    snap_sh: str = os.path.join(CODE_DIR, "usage-snap.sh")
    waker_sh: str = os.path.join(CODE_DIR, "waker.sh")
    wake_sh: str = os.path.join(CODE_DIR, "wake-secretary.sh")
    feishu_unit: str = os.path.join(HOME, ".config", "systemd", "user", "feishu-secretary-bridge.service")
    lark_cli: str = os.path.expanduser("~/.local/lib/npm-global/bin/lark-cli")
    codex_cli: str = os.path.expanduser("~/.local/lib/npm-global/bin/codex")
    ntfy_url: str = NTFY_URL
    chat_id: str = CHAT_ID
    port: str = "9476"
    project: str = "d1ffad35-5204-4280-9f82-ccadf6e40fe0"
    secretary_cwd: str = HOME
    # E2E 隔离用：非空时，梯度梯队的 config(".claude"/".claude-team2") 解析为
    # <config_root>/<config> 而非 <HOME>/<config>，避免 --safe 真跑时把假 jsonl
    # 写进真实秘书配置目录。生产留空即可。
    config_root: str = ""
    resume_max_mb: float = 2.0
    compact_min_mb: float = 6.0
    compact_cooldown_h: float = 4.0
    stale_snap_min: float = 40.0
    inactivity_min: float = 15.0
    quota_gate: float = 90.0
    codex_probe_timeout: float = 60.0
    # E 项两段式 stage-1（Noa 复活执行权）参数字段
    noa_timeout: float = 300.0          # stage-1 Noa 执行超时（5min，--noa-timeout 可参数化）
    noa_inbox: str = os.path.join(CODEX_WORK, "k3_resident_inbox")  # k3_resident.mjs 契约目录
    noa_tmux: str = "k3-resident"
    noa_done_flag: str = os.path.join(CODEX_WORK, "FLAG_noa_resurrect_done")      # Noa 完成信号
    noa_progress_flag: str = os.path.join(CODEX_WORK, "FLAG_noa_resurrect_running")  # Noa 接单信号
    http: Callable[..., Any] = field(default=None)


def _run(cmd, *, dry: bool, cwd=None, timeout=None, check=False, capture=True, env=None):
    """执行或打印（dry）。capture=True 返回 (rc, stdout+stderr)；False 直接继承终端。"""
    if dry:
        log(f"[DRY] would run: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
        return (0, "")
    log(f"[run] {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    try:
        p = subprocess.run(cmd, cwd=cwd, timeout=timeout, check=False,
                            shell=isinstance(cmd, str),
                            text=True, capture_output=capture, env=env)
    except subprocess.TimeoutExpired:
        return (124, "TIMEOUT")
    out = ((p.stdout or "") + (p.stderr or "")) if capture else ""
    if check and p.returncode != 0:
        raise RuntimeError(f"cmd failed rc={p.returncode}: {out[:300]}")
    return (p.returncode, out)


def _http_real(method: str, url: str, payload: Optional[dict] = None, *, timeout: float = 10.0):
    """用 curl 发 HTTP，返回 (status:int, parsed_json_or_text:str)。"""
    cmd = ["curl", "-sS", "--max-time", str(int(timeout)), "-w", "\n%{http_code}",
           "-X", method, url]
    if payload is not None:
        cmd += ["-H", "Content-Type: application/json",
                "-d", json.dumps(payload)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    text = p.stdout or ""
    if "\n" in text:
        body, code = text.rsplit("\n", 1)
    else:
        body, code = text, str(p.returncode)
    try:
        code_i = int(code)
    except ValueError:
        code_i = 0
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        parsed = body
    return code_i, parsed


def parse_secretary_home(path: str) -> dict:
    """解析 ~/code/secretary-home.env 的 export KEY="VALUE" 行。"""
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("chmod") or line.startswith("#"):
                continue
            m = re.match(r'(?:export\s+)?(\w+)=(.+)$', line)
            if m:
                v = m.group(2).strip().strip('"').strip("'")
                out[m.group(1)] = v
    return out


def cwd_slug(cwd: str) -> str:
    """claude project-dir slug：cwd 中 '/' 和 '.' → '-'。"""
    return re.sub(r'[/.]', '-', cwd or "")


def secretary_jsonl(home_env: dict, cfg: Cfg) -> Optional[str]:
    """找秘书会话 jsonl：<CONFIG_DIR>/projects/<slug>/<session_prefix>-*.jsonl，取最新。"""
    cfg_dir = home_env.get("SECRETARY_CONFIG_DIR", os.path.join(HOME, ".claude"))
    session = home_env.get("SECRETARY_SESSION", "")
    slug = cwd_slug(home_env.get("SECRETARY_CWD") or cfg.secretary_cwd)
    jdir = os.path.join(cfg_dir, "projects", slug)
    prefix = session.split("-")[0] if session else ""
    pat = os.path.join(jdir, (prefix + "-*.jsonl") if prefix else "*.jsonl")
    files = glob.glob(pat)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def jsonl_inactivity_age(path: Optional[str]) -> Optional[float]:
    """jsonl 最后 mtime 距今秒数。None=找不到。"""
    if not path or not os.path.isfile(path):
        return None
    return max(0.0, time.time() - os.path.getmtime(path))


def parse_secretary_down(path: str, home_env: dict) -> dict:
    """容忍式解析 SECRETARY_DOWN。返回 {time, team, cause, summary, raw}。

    cause ∈ {'QUOTA','CRASH'}。容忍 key:value / prose；缺失则推断。
    一期尚未定型，故本解析器对多种格式都鲁棒。期望字段（任意冒号/等号分隔，大小写无关）：
      time / timestamp / 死亡时间 / when
      team / pool / 死池 / dead_pool / secretary_team
      cause / 死因 / reason
      summary / 三证 / three_proof / detail
    """
    raw = ""
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    kv = {}
    for line in raw.splitlines():
        m = re.match(r'\s*([A-Za-z_]+|死亡时间|死因|死池|三证)\s*[:=]\s*(.+)$', line)
        if m:
            kv[m.group(1).strip().lower()] = m.group(2).strip()

    def getk(*keys):
        for k in keys:
            if k in kv:
                return kv[k]
        return None

    tval = getk("time", "timestamp", "死亡时间", "when", "death_time")
    if tval:
        death_time = tval
    else:
        m = re.search(r'(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?|\d{2}-\d{2}\s+\d{2}:\d{2})', raw)
        death_time = m.group(1) if m else (_dt.datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M") if os.path.isfile(path) else "?")

    tval = getk("team", "pool", "死池", "dead_pool", "secretary_team")
    if tval:
        team = tval.upper()
        team = "CODEX" if "CODEX" in team else ("T2" if "2" in team else ("T1" if "1" in team else team))
    else:
        m = re.search(r'\b(T1|T2|CODEX)\b', raw, re.I)
        team = m.group(1).upper() if m else home_env.get("SECRETARY_TEAM", "T1").upper()

    cval = getk("cause", "死因", "reason")
    blob = (cval or "") + " " + raw
    if QUOTA_RE.search(blob) or re.search(r'限额|配额|超额|rate[\s_.-]?limit|usage[\s_.-]?limit', blob, re.I):
        cause = "QUOTA"
    elif re.search(r'无响应|无反应|no[\s_-]?response|crash|崩溃|卡死|hung|timeout|超时', blob, re.I):
        cause = "CRASH"
    else:
        cause = "CRASH"

    summary = getk("summary", "三证", "three_proof", "detail")
    if not summary:
        summary = re.sub(r'\s+', ' ', raw).strip()[:400]
    return {"time": death_time, "team": team, "cause": cause, "summary": summary, "raw": raw}


def parse_usage_snap(path: str, team: str) -> Optional[dict]:
    """解析 usage_snap.log 中该 team 最新一行的 5h/7d/fable/reset。返回
    {five,seven,fable,reset5h,resetfb,ts,line}。
    D-3 哨兵行（SNAP_ERR/AUTH_EXPIRED/API_DOWN/API_BADSHAPE/HTTP_* 裸词）按
    「无有效快照」处理：log 原因并返回 None，绝不当数字解析。"""
    if not os.path.isfile(path):
        return None
    # C(a)：四池识别（T3/T4 原结构盲区补齐）
    NEEDLE = {"T1": ".claude", "T2": ".claude-team2",
              "T3": ".claude-team3", "T4": ".claude-team4"}
    if team not in NEEDLE:
        return None
    needle = NEEDLE[team]
    pat = re.compile(rf'(?:^|\s){re.escape(needle)}:')
    last = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            if pat.search(line):
                last = line.strip()
    if not last:
        return None
    sent = SNAP_SENTINEL_RE.search(last)
    if sent:
        log(f"[快照] {team} 最新行为哨兵 {sent.group(1)}（无有效快照，按无快照处理）: {last[:140]}")
        return None
    m = re.match(r'(\d{2}-\d{2}\s+\d{2}:\d{2})\s+', last)
    ts = m.group(1) if m else None
    nums = {}
    for key in ("5h", "7d", "fable", "extra"):
        # \b 防 "reset5h=07-31T23:00" 里的 "5h=" 子串污染 "5h=" 真字段
        mm = re.search(rf'\b{key}=([0-9.]+)', last)
        if mm:
            nums[key] = float(mm.group(1))
    resets = {}
    for key in ("reset5h", "resetfb"):
        # C(a) 括号注：补 reset5h/resetfb 两个 key（值形如 08-01T01:39，0% 用量时为空串）
        mm = re.search(rf'\b{key}=(\S*)', last)
        if mm:
            resets[key] = mm.group(1)
    return {"five": nums.get("5h"), "seven": nums.get("7d"), "fable": nums.get("fable"),
            "reset5h": resets.get("reset5h", ""), "resetfb": resets.get("resetfb", ""),
            "ts": ts, "line": last}


def snap_age_min(snap: Optional[dict], now: _dt.datetime) -> Optional[float]:
    if not snap or not snap.get("ts"):
        return None
    try:
        t = _dt.datetime.strptime(f"{now.year}-{snap['ts']}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    if t > now:
        t = t.replace(year=now.year - 1)
    return (now - t).total_seconds() / 60.0


def quota_gate(snap: Optional[dict], gate: str, cfg: Cfg) -> tuple[bool, str]:
    """额度预检。返回 (pass, reason)。None 快照视为不通过（保守）。"""
    g = cfg.quota_gate
    if snap is None:
        return False, "no usage snapshot for team"
    if gate == "fable":
        if snap.get("fable") is not None and snap["fable"] >= g:
            return False, f"fable={snap['fable']}%>={g}%"
        if snap.get("five") is not None and snap["five"] >= g:
            return False, f"5h={snap['five']}%>={g}%"
        return True, f"fable={snap.get('fable')}% 5h={snap.get('five')}%"
    if gate == "opus":
        if snap.get("five") is not None and snap["five"] >= g:
            return False, f"5h={snap['five']}%>={g}%"
        if snap.get("seven") is not None and snap["seven"] >= g:
            return False, f"7d={snap['seven']}%>={g}%"
        return True, f"5h={snap.get('five')}% 7d={snap.get('seven')}%"
    return False, f"unknown gate {gate}"


# ----------------------------- C 项：四池动态选池（v4） -----------------------------

def select_target_pool(cfg: Cfg, death: dict, snap_cache: dict) -> Optional[dict]:
    """v4：四池实时用量选最空闲且未死的 Fable 池；都紧比 reset 谁先到；全灭返回 None（Codex 末梯兜底）。
    snap_cache 按 team 缓存本轮回合的快照（含 None），供调用方复用避免重复解析。"""
    dead_team = death.get("team", "").upper()
    # 陈旧快照预检：沿用旧 GRADIENT 循环「首个快照 >stale_snap_min 则刷新一次」语义，
    # 单点收口在选池入口（usage-snap.sh 一把刷四池，任一可读快照的 ts 即可代表新旧）。
    probe = None
    for _p in FABLE_POOLS:
        probe = parse_usage_snap(cfg.snap_log, _p["team"])
        if probe is not None:
            break
    age = snap_age_min(probe, _dt.datetime.now())
    if age is not None and age > cfg.stale_snap_min:
        log(f"[快照] snapshot {age:.0f}min > {cfg.stale_snap_min:.0f}min stale, refreshing")
        refresh_snap(cfg)

    candidates = []
    for p in FABLE_POOLS:
        if death.get("cause") == "QUOTA" and p["team"] == dead_team:
            log(f"[选池] 跳过死池 {p['team']}（QUOTA death）")
            continue
        snap = parse_usage_snap(cfg.snap_log, p["team"])
        snap_cache[p["team"]] = snap
        ok, why = quota_gate(snap, "fable", cfg)
        if not ok:
            log(f"[选池] {p['team']} 额度门未过: {why}")
            continue
        candidates.append((p, snap))
    if not candidates:
        log("[选池] 全部 Fable 池不可用（死/紧/无快照）→ Codex 末梯兜底")
        return None
    # 排序键：(fable% 升序, 5h% 升序, reset5h 近→远, resetfb 近→远) —— 最空闲优先；都紧比谁先 reset
    def sort_key(t):
        _p, s = t
        # None（如 fable=? 解析不出）按最空（0）处理，与 quota_gate 对未知字段放行的语义一致；
        # 同时防 sort 中 None 与 float 比大小抛 TypeError。
        fable = (s.get("fable") if s else None)
        five = (s.get("five") if s else None)
        fable = 0.0 if fable is None else fable
        five = 0.0 if five is None else five
        r5 = (s.get("reset5h") if s else "") or "9999-99T99:99"  # 空 reset(0%未触发)视为最不急
        rfb = (s.get("resetfb") if s else "") or "9999-99T99:99"
        return (fable, five, r5, rfb)
    candidates.sort(key=sort_key)
    chosen, csnap = candidates[0]
    log(f"[选池] 动态选中 {chosen['team']} "
        f"(fable={csnap.get('fable') if csnap else '?'}% 5h={csnap.get('five') if csnap else '?'}%)")
    return chosen


# ----------------------------- E 项：stage-1 Noa 一段式 -----------------------------

def k3_resident_alive(cfg: Cfg) -> bool:
    rc, _ = _run(["tmux", "has-session", "-t", cfg.noa_tmux], dry=False, timeout=5.0)
    return rc == 0


def dispatch_to_noa(cfg: Cfg, death: dict, target_pool: Optional[dict]) -> bool:
    """stage-1：向 k3-resident 投复活单。优先投 k3_resident_inbox 任务文件（k3_resident.mjs:13 契约），
    兼容 tmux send-keys 直注。Noa 执行 switch/takeover + 飞书报四要素，完成后写 noa_done_flag。"""
    ts = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    task_path = os.path.join(cfg.noa_inbox, f"resurrect_{ts}.task")
    pool_desc = target_pool["team"] if target_pool else "Codex(末梯兜底)"
    body = (
        f"【复活单 from 史官】来源=secretary_resurrect(stage1)，时间={death.get('time')}\n"
        f"死因={death.get('cause')}，三证摘要={death.get('summary','')[:200]}\n"
        f"目标池={pool_desc}\n"
        f"指令：按 ~/code/worker-core/SECRETARY_MIGRATION.md v4 执行复活——\n"
        f"  1) 验尸 2) 清场 3) 改 secretary-home.env 4) 重启 waker 5) 重启飞书桥 6) 飞书报四要素\n"
        f"  完成后 touch {cfg.noa_done_flag}（史官据此判定 stage-1 成功，不进 stage-2）。\n"
        f"  接单先 touch {cfg.noa_progress_flag}。"
    )
    if cfg.dry:
        log(f"[DRY] would write Noa task {task_path}:\n{body}")
        return True
    os.makedirs(cfg.noa_inbox, exist_ok=True)
    with open(task_path, "w", encoding="utf-8") as f:
        f.write(body)
    log(f"[stage1] Noa 复活单已投 {task_path}")
    # 兜底：k3-resident 不扫 inbox 时用 tmux send-keys 提醒
    if k3_resident_alive(cfg):
        _run(["tmux", "send-keys", "-t", cfg.noa_tmux,
              f"有复活单: {task_path}；读它执行。", "Enter"], dry=False, timeout=10.0)
    return True


def noa_completed(cfg: Cfg) -> bool:
    return os.path.isfile(cfg.noa_done_flag)


def noa_in_progress(cfg: Cfg) -> bool:
    return os.path.isfile(cfg.noa_progress_flag)


def codex_probe(cfg: Cfg) -> tuple[bool, str]:
    """最小 codex exec 探测 Codex 梯可用性。限额→不通过。dry 时模拟通过。"""
    if cfg.dry:
        log("[DRY] would probe codex exec (assuming available)")
        return True, "dry-probe pass"
    cmd = [cfg.codex_cli, "exec", "--skip-git-repo-check", "Respond with the single word: ok"]
    rc, out = _run(cmd, dry=False, timeout=cfg.codex_probe_timeout, capture=True)
    if QUOTA_RE.search(out):
        return False, f"codex quota error: {out[:160]}"
    return True, f"codex probe rc={rc}"


def refresh_snap(cfg: Cfg):
    """快照 >阈值陈旧则先刷新。dry 时只打印。"""
    if cfg.dry:
        log(f"[DRY] would refresh snapshot: bash {cfg.snap_sh}")
        return
    _run(["bash", cfg.snap_sh], dry=False, timeout=60.0)


def copy_transcript(sid: str, cwd: str, from_cfg: str, to_cfg: str, *, dry: bool) -> bool:
    """搬尸：拷 jsonl 到目标池 projects 目录。"""
    slug = cwd_slug(cwd)
    src = os.path.join(from_cfg, "projects", slug, f"{sid}.jsonl")
    if not os.path.isfile(src):
        log(f"[搬尸] source jsonl not found: {src}")
        return False
    dstdir = os.path.join(to_cfg, "projects", slug)
    dst = os.path.join(dstdir, f"{sid}.jsonl")
    if dry:
        log(f"[DRY] would copy transcript {src} -> {dst}")
        return True
    os.makedirs(dstdir, exist_ok=True)
    shutil.copy2(src, dst)
    log(f"[搬尸] copied {src} -> {dst} ({os.path.getsize(dst)} bytes)")
    return True


def create_tab(cfg: Cfg, payload: dict) -> dict:
    """POST /api/projects/:id/tabs。返回 tab dict（含 id、claudeSessionId）。"""
    url = f"http://127.0.0.1:{cfg.port}/api/projects/{cfg.project}/tabs"
    http = cfg.http or _http_real
    code, resp = http("POST", url, payload)
    if code != 201 or not isinstance(resp, dict):
        raise RuntimeError(f"create_tab failed HTTP {code}: {str(resp)[:300]}")
    log(f"[建tab] {resp.get('type')} tab id={resp.get('id')} sid={resp.get('claudeSessionId')} model={payload.get('modelOverride')}")
    return resp


def queue_takeover(cfg: Cfg, tab_id: str, text: str):
    """兜底投递：PUT /api/projects/:id/tabs/:tabId/queue 把接管指令写入
    pendingQueue，pty 启动（WS attach）时作为第一条消息 drain。返回 True 成功。"""
    if cfg.dry:
        log(f"[DRY] would queue takeover tab={tab_id} text={text[:60]!r}")
        return True
    url = f"http://127.0.0.1:{cfg.port}/api/projects/{cfg.project}/tabs/{tab_id}/queue"
    code, body = _http_real("PUT", url, {"queue": [text]}, timeout=10.0)
    if code == 200:
        log(f"[兜底投递] pendingQueue set tab={tab_id} (drains on pty start)")
        return True
    log(f"[兜底投递] FAILED tab={tab_id} HTTP {code}: {str(body)[:200]}")
    return False


def inject_takeover(cfg: Cfg, tab_id: str, text: str):
    """经 wake-secretary.sh 注入接管指令。fresh tab 无 live pty 时 inject 404
    （/api/sessions 列表为空），退回 pendingQueue 兜底投递（pty 启动即 drain）。"""
    env = dict(os.environ)
    env["NANO_PORT"] = cfg.port
    env["NANO_MATCH"] = tab_id
    env["SEND_NOW"] = "1"
    rc, out = _run([cfg.wake_sh, text], dry=cfg.dry, timeout=30.0, env=env)
    if rc == 0:
        log(f"[注入接管] OK tab={tab_id} text={text[:80]!r}")
        return True
    log(f"[注入接管] wake-secretary rc={rc} (no live pty on fresh tab); fallback pendingQueue")
    log(f"  wake out: {out.strip()[:240]}")
    return queue_takeover(cfg, tab_id, text)


def write_handoff(cfg: Cfg, death: dict) -> str:
    """兜底：写交接包 HANDOFF_<date>_secretary.md。返回路径。"""
    date = _dt.datetime.now().strftime("%Y%m%d")
    path = os.path.join(CODEX_WORK, f"HANDOFF_{date}_secretary.md")
    body = (
        f"# HANDOFF {date} — 秘书自动复活交接包\n\n"
        f"## 前任死亡（验尸取证，不信传闻）\n"
        f"- 死亡时间：{death.get('time')}\n"
        f"- 死因分类：{death.get('cause')}\n"
        f"- 三证摘要：{death.get('summary')}\n\n"
        f"## 接班第一动作 = SECRETARY_MIGRATION.md v3 验尸清单\n"
        f"1. 验尸：前任 jsonl mtime + waker.log 注入记录，取证死亡时间与死因\n"
        f"2. 清场：杀残余秘书会话/进程（防双消费者），只留自己\n"
        f"3. 改住址：~/code/secretary-home.env（644→改→自锁444）+ 重启史官\n"
        f"4. 改飞书桥：feishu-secretary-bridge.service 的 NANO_MATCH/NANO_PORT → daemon-reload + restart\n"
        f"5. INBOX 留痕 + 飞书报主人接管完成\n\n"
        f"## 必读\n"
        f"- ~/code/worker-core/SECRETARY_MIGRATION.md（v3 节）\n"
        f"- memory CURRENT_WORKFLOW.md（团队路由 Team1/Team2/AIGW）\n"
        f"- ~/codex_work/SECRETARY_INBOX 尾部 + P0_TAGS\n"
    )
    if cfg.dry:
        log(f"[DRY] would write handoff {path}")
        return path
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    log(f"[兜底] wrote handoff {path}")
    return path


def takeover_text(tier: dict, death: dict, *, fallback: bool) -> str:
    base = (
        f"你是新任秘书。前任已死亡（死因={death.get('cause')}，"
        f"死亡时间={death.get('time')}，三证={death.get('summary','')[:120]}）。"
        f"立即按 ~/code/worker-core/SECRETARY_MIGRATION.md v3「验尸清单」执行："
        f"1)验尸 2)清场 3)改住址 4)改飞书桥 5)INBOX留痕+报主人。当前梯队={tier['name']}。接班。"
    )
    if fallback:
        date = _dt.datetime.now().strftime("%Y%m%d")
        base += f" 并读 ~/codex_work/HANDOFF_{date}_secretary.md 交接包。"
    return base


def update_home_env(cfg: Cfg, new: dict):
    """收尾改住址：644→写→自锁444。new 含 team/session/config_dir/port/project/tab/tabtype。"""
    path = cfg.home_env
    lines = [
        f'chmod 444 "{path}"',
        f'export SECRETARY_TEAM="{new["team"]}"',
        f'export SECRETARY_SESSION="{new["session"]}"',
        f'export SECRETARY_CONFIG_DIR="{new["config_dir"]}"',
        f'export WAKE_TABTYPE="{new.get("tabtype", "claude")}"',
        f'export WAKE_PORT="{new["port"]}"',
        f'export WAKE_PROJECT="{new["project"]}"',
        f'export WAKE_TAB="{new["tab"]}"',
        f'export SECRETARY_CWD="{new.get("cwd", cfg.secretary_cwd)}"',
    ]
    content = "\n".join(lines) + "\n"
    if cfg.dry:
        log(f"[DRY] would rewrite home env {path}:\n{content}")
        return
    os.chmod(path, 0o644)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(path, 0o444)
    log(f"[收尾] home env updated + self-locked 444: {path}")


def restart_waker(cfg: Cfg):
    """重启 tmux waker。safe/dry 时只打印。"""
    if cfg.safe:
        log(f"[safe] skip prod waker restart (would: tmux kill-session -t waker; new WAKE_LIVE=1 {cfg.waker_sh})")
        return
    if cfg.dry:
        log(f"[DRY] would: tmux kill-session -t waker; tmux new-session -d -s waker 'WAKE_LIVE=1 bash {cfg.waker_sh}'")
        return
    _run(["tmux", "kill-session", "-t", "waker"], dry=False, timeout=10.0)
    _run(["tmux", "new-session", "-d", "-s", "waker", f"WAKE_LIVE=1 bash {cfg.waker_sh}"], dry=False, timeout=10.0)
    log("[收尾] tmux waker restarted")


def edit_feishu_unit(cfg: Cfg, tab_id: str, port: str):
    """改飞书桥 unit NANO_MATCH/NANO_PORT → daemon-reload + restart。safe/dry 时只打印。"""
    unit = cfg.feishu_unit
    if cfg.safe or cfg.dry:
        log(f"[{'safe' if cfg.safe else 'DRY'}] would edit {unit}: NANO_MATCH={tab_id} NANO_PORT={port}; systemctl --user daemon-reload + restart feishu-secretary-bridge")
        return
    if not os.path.isfile(unit):
        log(f"[收尾] feishu unit not found, skip: {unit}")
        return
    with open(unit, encoding="utf-8") as f:
        txt = f.read()
    txt = re.sub(r'(?m)^Environment=NANO_MATCH=.*$', f'Environment=NANO_MATCH={tab_id}', txt)
    txt = re.sub(r'(?m)^Environment=NANO_PORT=.*$', f'Environment=NANO_PORT={port}', txt)
    with open(unit, "w", encoding="utf-8") as f:
        f.write(txt)
    _run(["systemctl", "--user", "daemon-reload"], dry=False, timeout=15.0)
    _run(["systemctl", "--user", "restart", "feishu-secretary-bridge"], dry=False, timeout=15.0)
    log(f"[收尾] feishu unit updated NANO_MATCH={tab_id} NANO_PORT={port} + restarted")


def notify_master(cfg: Cfg, death: dict, tier_name: str, port: str, tab_id: str):
    """飞书通知主人（四要素）+ ntfy 同步。safe/dry 时只打印。"""
    msg = (
        f"‼️ 秘书自动复活完成\n"
        f"① 旧秘书死因：{death.get('cause')}（三证：{death.get('summary','')[:150]}；死亡时间 {death.get('time')}）\n"
        f"② 切换到梯队：{tier_name}\n"
        f"③ 新端口：{port}\n"
        f"④ 新 tab id：{tab_id}"
    )
    if cfg.dry or cfg.safe:
        log(f"[{'safe' if cfg.safe else 'DRY'}] would notify master:\n{msg}")
        log(f"[{'safe' if cfg.safe else 'DRY'}] would ntfy {cfg.ntfy_url}: {msg[:80]}")
        return
    _run([cfg.lark_cli, "im", "+messages-send", "--chat-id", cfg.chat_id, "--text", msg], dry=False, timeout=20.0)
    _run(["curl", "-d", msg, cfg.ntfy_url], dry=False, timeout=15.0)
    log(f"[收尾] notified master (lark + ntfy)")


def consume_down(cfg: Cfg):
    """复活成功后消费/归档 SECRETARY_DOWN。"""
    if cfg.dry:
        log(f"[DRY] would archive {cfg.down_file} -> {cfg.down_file}.consumed")
        return
    if os.path.isfile(cfg.down_file):
        shutil.move(cfg.down_file, cfg.down_file + ".consumed")
        log(f"[收尾] archived SECRETARY_DOWN -> {cfg.down_file}.consumed")


def resurrect_one(cfg: Cfg, home_env: dict, death: dict) -> Optional[dict]:
    """对单次死亡执行梯度复活（v4：动态选中的 Fable 一梯 + Codex 末梯兜底），
    返回成功 tier 的结果 dict 或 None（全梯耗尽）。stage-2 每次进入都重新选池（用最新快照）。"""
    old_sid = home_env.get("SECRETARY_SESSION", "")
    old_cfg_dir = home_env.get("SECRETARY_CONFIG_DIR", os.path.join(HOME, ".claude"))
    cwd = home_env.get("SECRETARY_CWD") or cfg.secretary_cwd
    dead_team = death.get("team", home_env.get("SECRETARY_TEAM", "T1").upper())
    log(f"[复活] dead_team={dead_team} cause={death['cause']} time={death['time']} old_sid={old_sid[:8]}")

    # C(b)：动态选池替代固定 GRADIENT 迭代。选中 Fable 池 → 一梯；选不中 → 只剩 Codex 末梯。
    snap_cache: dict = {}
    chosen = select_target_pool(cfg, death, snap_cache)
    tiers = []
    if chosen is not None:
        tiers.append({"name": f"{chosen['team']} Fable", "type": "claude", "team": chosen["team"],
                      "config": chosen["config"], "model": chosen["model"], "gate": "fable"})
    tiers.append(CODEX_TIER)

    for tier in tiers:
        name = tier["name"]
        log(f"--- 梯度 [{name}] ---")

        if death["cause"] == "QUOTA" and tier["team"] == dead_team:
            log(f"[跳梯] quota death on dead pool {dead_team} == tier team {tier['team']}, skip")
            continue

        if tier["gate"] == "codex":
            ok, why = codex_probe(cfg)
        else:
            # 快照本轮已在 select_target_pool 解析并过完门（未过门则 chosen=None 根本构不成梯），
            # 这里直接复用 snap_cache 的回合并显式过门留痕，对账一致不重复解析。
            snap = snap_cache.get(tier["team"])
            ok, why = quota_gate(snap, tier["gate"], cfg)
        log(f"[额度预检] {name}: {'PASS' if ok else 'SKIP'} ({why})")
        if not ok:
            continue

        target_cfg_dir = os.path.join(cfg.config_root or HOME, tier["config"]) if tier["config"] else old_cfg_dir
        jsonl_path = secretary_jsonl(home_env, cfg)
        jsonl_size = os.path.getsize(jsonl_path) if jsonl_path and os.path.isfile(jsonl_path) else 0
        can_resume = (tier["type"] == "claude" and old_sid and jsonl_size > 0
                      and jsonl_size <= cfg.resume_max_mb * 1024 * 1024)

        if can_resume:
            log(f"[搬尸] resume: old jsonl {jsonl_size} bytes <= {cfg.resume_max_mb}MB -> copy + resume on {tier['team']}")
            copy_transcript(old_sid, cwd, old_cfg_dir, target_cfg_dir, dry=cfg.dry)
            payload = {"type": "claude", "label": f"secretary-{tier['team'].lower()}",
                       "claudeSessionId": old_sid, "claudeConfigDir": target_cfg_dir,
                       "claudeSessionCwd": cwd, "modelOverride": tier["model"], "effortOverride": "high",
                       "fresh": False}
        else:
            log(f"[兜底] fresh+handoff: type={tier['type']} jsonl={jsonl_size}B (> {cfg.resume_max_mb}MB or codex)")
            write_handoff(cfg, death)
            if tier["type"] == "claude":
                payload = {"type": "claude", "label": f"secretary-{tier['team'].lower()}",
                           "claudeConfigDir": target_cfg_dir, "claudeSessionCwd": cwd,
                           "modelOverride": tier["model"], "effortOverride": "high", "fresh": True}
            else:
                payload = {"type": "codex", "label": "secretary-codex", "modelOverride": tier["model"]}

        tab = create_tab(cfg, payload)
        tab_id = tab.get("id", "?")
        new_sid = tab.get("claudeSessionId") or old_sid or ""
        time.sleep(1.5)
        inject_takeover(cfg, tab_id, takeover_text(tier, death, fallback=not can_resume))

        new_home = {"team": tier["team"], "session": new_sid, "config_dir": target_cfg_dir,
                    "port": cfg.port, "project": cfg.project, "tab": tab_id,
                    "tabtype": tier["type"], "cwd": cwd}
        update_home_env(cfg, new_home)
        restart_waker(cfg)
        edit_feishu_unit(cfg, tab_id, cfg.port)
        notify_master(cfg, death, name, cfg.port, tab_id)
        consume_down(cfg)
        log(f"[复活完成] tier={name} tab={tab_id} port={cfg.port} resume={can_resume}")
        return {"tier": name, "tab": tab_id, "port": cfg.port, "resume": can_resume, "sid": new_sid}

    log("[复活失败] 全梯度耗尽，无可用梯队")
    return None


def resurrect(cfg: Cfg) -> int:
    """主复活入口。fail-closed 双查 + 梯度复活。"""
    log(f"=== secretary_resurrect start (dry={cfg.dry} safe={cfg.safe} port={cfg.port}) ===")
    if not os.path.isfile(cfg.down_file):
        log(f"[fail-closed] {cfg.down_file} 不存在，秘书未判死，退出不动作")
        return 0
    home_env = parse_secretary_home(cfg.home_env)
    death = parse_secretary_down(cfg.down_file, home_env)

    jpath = secretary_jsonl(home_env, cfg)
    age = jsonl_inactivity_age(jpath)
    if age is None:
        log(f"[fail-closed] 找不到秘书 jsonl（{jpath}），无法确认 ≥{cfg.inactivity_min:.0f}min 零活动，退出不动作")
        return 0
    if age < cfg.inactivity_min * 60:
        log(f"[fail-closed] 秘书 jsonl {age:.0f}s 前仍有活动（<{cfg.inactivity_min:.0f}min），活秘书，退出不动作")
        return 0
    log(f"[fail-closed] 双查通过：SECRETARY_DOWN 存在 + jsonl 静默 ≥{cfg.inactivity_min:.0f}min（{age:.0f}s）{jpath}")

    # ── stage-1：先把复活单甩给 Noa（E 项两段式，主人定纲：Noa=复活执行权，史官=判死+兜底）──
    snap_cache: dict = {}
    target = select_target_pool(cfg, death, snap_cache)  # C 项动态选池（含 T3/T4），结果写进复活单
    noa_dispatched = False
    if k3_resident_alive(cfg):
        # 互斥：清上一轮残留信号，防旧 done/running flag 造成误判
        for f in (cfg.noa_done_flag, cfg.noa_progress_flag):
            if os.path.isfile(f):
                os.remove(f)
        dispatch_to_noa(cfg, death, target)
        noa_dispatched = True
        log(f"[stage1] 等 Noa 执行，超时 {cfg.noa_timeout:.0f}s（轮询 10s）")
        t0 = time.time()
        while time.time() - t0 < cfg.noa_timeout:
            if noa_completed(cfg):
                log(f"[stage1] Noa 完成复活（{time.time()-t0:.0f}s），史官不重复动作")
                _run(["rm", "-f", cfg.noa_progress_flag], dry=cfg.dry, timeout=5.0)
                return 0
            time.sleep(10)
        # 超时 → 史官接管兜底（Noa 之后若再完成，由 env 444 自锁 + stage-2 fail-closed 双查天然防双消费者）
        if noa_in_progress(cfg):
            log(f"[stage1] Noa 接单但 {cfg.noa_timeout:.0f}s 未完成 → 史官接管兜底（stage-2）")
        else:
            log(f"[stage1] Noa {cfg.noa_timeout:.0f}s 未接单（无 progress flag）→ 史官兜底（stage-2）")
    else:
        log("[stage1] k3-resident tmux 不存在（Noa 死了）→ 直接 stage-2 史官兜底")

    # ── stage-2：史官自动复活兜底（resurrect_one，内嵌 C 项动态选池，用最新快照重选）──
    # 进兜底前复查 done flag：Noa 可能在超时边界后 10s 轮询间隙内刚完成（QA P2 竞态窗口）。
    # 仅本轮真派过单才复查——k3-resident 死亡分支未清残留 flag，陈旧 done 不得当完成。
    if noa_dispatched and noa_completed(cfg):
        log("[stage1] 超时后复查发现 Noa 已完成，史官不重复动作")
        _run(["rm", "-f", cfg.noa_progress_flag], dry=cfg.dry, timeout=5.0)
        return 0
    result = resurrect_one(cfg, home_env, death)
    if result is None:
        log("[FAIL] 全梯度耗尽")
        failsig = os.path.join(CODEX_WORK, "FLAG_secretary_resurrect")
        if not cfg.dry:
            with open(failsig + ".FAIL", "w", encoding="utf-8") as f:
                f.write(f"all tiers exhausted at {_dt.datetime.now()}\n")
        return 1
    return 0


def compact_patrol(cfg: Cfg) -> int:
    """预防性 compact：秘书活着且 jsonl 超阈值 → 注入 /compact，冷却 4h。"""
    log(f"=== compact-patrol start (dry={cfg.dry} port={cfg.port}) ===")
    if os.path.isfile(cfg.down_file):
        log("[compact] SECRETARY_DOWN 存在，交复活流程处理，跳过")
        return 0
    home_env = parse_secretary_home(cfg.home_env)
    if not home_env.get("WAKE_TAB"):
        log("[compact] 无 WAKE_TAB，跳过")
        return 0
    jpath = secretary_jsonl(home_env, cfg)
    if not jpath or not os.path.isfile(jpath):
        log("[compact] 无 jsonl，跳过")
        return 0
    size = os.path.getsize(jpath)
    if size <= cfg.compact_min_mb * 1024 * 1024:
        log(f"[compact] jsonl {size}B <= {cfg.compact_min_mb}MB，无需 compact")
        return 0

    marker = os.path.join(CODEX_WORK, ".compact_patrol_last")
    if os.path.isfile(marker):
        age_h = (time.time() - os.path.getmtime(marker)) / 3600.0
        if age_h < cfg.compact_cooldown_h:
            log(f"[compact] 冷却中（{age_h:.1f}h < {cfg.compact_cooldown_h}h），跳过")
            return 0
    log(f"[compact] jsonl {size}B > {cfg.compact_min_mb}MB 且过冷却 -> 注入 /compact")
    env = dict(os.environ)
    env["NANO_PORT"] = home_env.get("WAKE_PORT", cfg.port)
    env["NANO_MATCH"] = home_env["WAKE_TAB"]
    env["SEND_NOW"] = "1"
    _run([cfg.wake_sh, "/compact"], dry=cfg.dry, timeout=30.0)
    if not cfg.dry:
        with open(marker, "w") as f:
            f.write(str(time.time()))
    log("[compact] done")
    return 0


# ----------------------------- selftest -----------------------------

class _MockHTTP:
    def __init__(self):
        self.calls = []
        self.responses = {}

    def __call__(self, method, url, payload=None, *, timeout=10.0):
        self.calls.append((method, url, payload))
        key = (method, url)
        if key in self.responses:
            return self.responses[key]
        return (201, {"id": "tab-xyz", "type": payload.get("type", "claude"),
                      "claudeSessionId": payload.get("claudeSessionId") or "new-sid-1234"})


def _make_lab(tmpdir: str, *, down_body: str, team: str = "T1", cause: str = "quota",
              session: str = "842f6a5a-b82b-4fba-b8c0-b267e2f33460",
              jsonl_size_mb: float = 1.0, snap_lines: str = "") -> dict:
    lab = os.path.join(tmpdir, "lab")
    os.makedirs(lab, exist_ok=True)
    home = os.path.join(lab, "secretary-home.env")
    cfg_dir_t1 = os.path.join(lab, ".claude")
    cfg_dir_t2 = os.path.join(lab, ".claude-team2")
    slug = cwd_slug(HOME)
    dead_cfg = cfg_dir_t2 if team == "T2" else cfg_dir_t1
    os.makedirs(os.path.join(dead_cfg, "projects", slug), exist_ok=True)
    os.makedirs(os.path.join(cfg_dir_t1, "projects", slug), exist_ok=True)
    os.makedirs(os.path.join(cfg_dir_t2, "projects", slug), exist_ok=True)
    jpath = os.path.join(dead_cfg, "projects", slug, f"{session}.jsonl")
    with open(jpath, "wb") as f:
        f.write(b"x" * int(jsonl_size_mb * 1024 * 1024))
    old = os.path.getmtime(jpath) - 1200
    os.utime(jpath, (old, old))
    with open(home, "w") as f:
        f.write(f'chmod 444 "{home}"\nexport SECRETARY_TEAM="{team}"\n'
                f'export SECRETARY_SESSION="{session}"\n'
                f'export SECRETARY_CONFIG_DIR="{dead_cfg}"\nexport WAKE_TABTYPE="claude"\n'
                f'export WAKE_PORT="9477"\nexport WAKE_PROJECT="d1ffad35-5204-4280-9f82-ccadf6e40fe0"\n'
                f'export WAKE_TAB="oldtab01"\nexport SECRETARY_CWD="{HOME}"\n')
    down = os.path.join(lab, "SECRETARY_DOWN")
    with open(down, "w") as f:
        f.write(down_body)
    snap = os.path.join(lab, "usage_snap.log")
    with open(snap, "w") as f:
        f.write(snap_lines)
    return {"lab": lab, "home": home, "down": down, "snap": snap,
            "cfg_t1": cfg_dir_t1, "cfg_t2": cfg_dir_t2, "jpath": jpath, "session": session}


def _selftest():
    import tempfile
    failures = []
    tmp = tempfile.mkdtemp(prefix="resurrect_test_")
    # v4：stage-1 的 k3_resident_alive 是真 tmux 调用（dry 也不旁路）。历史分支聚焦 stage-2
    # 梯度行为，离线自测统一按「k3-resident 不存在 → 直走 stage-2」patch，不真探真注 tmux；
    # 两段式（stage-1 投单/超时/直走）专项场景在 ~/codex_work/qa_scratch_resurrect_v4/ 覆盖。
    globals()["k3_resident_alive"] = lambda c: False
    # 哨兵解析会 log() —— 自测日志隔离进 tmp，防污染生产 resurrect.log
    saved_logfile = os.environ.get("RESURRECT_LOG_FILE")
    os.environ["RESURRECT_LOG_FILE"] = os.path.join(tmp, "selftest_resurrect.log")

    def check(name, cond, detail=""):
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {name}" + (f" -- {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    print("== selftest: parse_secretary_down ==")
    d = parse_secretary_down.__wrapped__ if hasattr(parse_secretary_down, "__wrapped__") else parse_secretary_down
    p = os.path.join(tmp, "sd1")
    with open(p, "w") as f:
        f.write("time: 2026-07-30 09:40\nteam: T1\ncause: 限额 usage.limit\nsummary: 3次注入无消费+jsonl零活动+探测90s无响应\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T1"})
    check("down quota team T1", r["team"] == "T1" and r["cause"] == "QUOTA", str(r))
    p = os.path.join(tmp, "sd2")
    with open(p, "w") as f:
        f.write("死亡时间 07-30 09:40\n死池 T2\n死因 无响应\n三证 3次无消费\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T1"})
    check("down crash team T2", r["team"] == "T2" and r["cause"] == "CRASH", str(r))
    p = os.path.join(tmp, "sd3")
    with open(p, "w") as f:
        f.write("secretary heartbeat lost, rate-limit exceeded, 429 too many requests\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T2"})
    check("down prose quota infer", r["cause"] == "QUOTA", str(r))
    p = os.path.join(tmp, "sd4")
    with open(p, "w") as f:
        f.write("no response after 90s probe\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T1"})
    check("down prose crash infer", r["cause"] == "CRASH", str(r))
    # Exact format waker_core.py _declare_death writes (cause uses dots: rate.limit/usage.limit)
    p = os.path.join(tmp, "sd5")
    with open(p, "w") as f:
        f.write("SECRETARY_DOWN\ntimestamp: 2026-07-30 09:40:00\ncause: rate.limit\n"
                "session: 842f6a5a-b82b-4fba-b8c0-b267e2f33460\nteam: T1\nanchor: waker\n"
                "evidence:\n  (a) 3 consecutive injections, no jsonl consumption\n"
                "  (b) jsonl mtime inactive 15 min\n  (c) probe injected, 90s waited, no jsonl activity\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T1"})
    check("down real rate.limit -> QUOTA T1", r["cause"] == "QUOTA" and r["team"] == "T1", str(r))
    p = os.path.join(tmp, "sd6")
    with open(p, "w") as f:
        f.write("SECRETARY_DOWN\ntimestamp: 2026-07-30 09:40:00\ncause: usage.limit\nteam: T2\n")
    r = parse_secretary_down(p, {"SECRETARY_TEAM": "T1"})
    check("down real usage.limit -> QUOTA T2", r["cause"] == "QUOTA" and r["team"] == "T2", str(r))

    print("== selftest: parse_usage_snap + quota_gate ==")
    snap = os.path.join(tmp, "snap.log")
    with open(snap, "w") as f:
        f.write("07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n"
                "07-30 09:30 .claude-team2: 5h=0.0% 7d=75.0% fable=100% extra=50007.0\n")
    s1 = parse_usage_snap(snap, "T1")
    check("snap T1 parse", s1 and s1["fable"] == 17.0 and s1["five"] == 25.0 and s1["seven"] == 12.0, str(s1))
    s2 = parse_usage_snap(snap, "T2")
    check("snap T2 parse", s2 and s2["fable"] == 100.0 and s2["seven"] == 75.0, str(s2))
    cfg = Cfg(snap_log=snap)
    ok, why = quota_gate(s1, "fable", cfg)
    check("gate fable T1 pass", ok and "PASS" not in why, why)
    ok, why = quota_gate(s2, "fable", cfg)
    check("gate fable T2 skip (fable=100)", not ok, why)
    ok, why = quota_gate(s2, "opus", cfg)
    check("gate opus T2 pass (7d=75<90)", ok, why)
    snap_hi = os.path.join(tmp, "snap_hi.log")
    with open(snap_hi, "w") as f:
        f.write("07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n"
                "07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=100% extra=50007.0\n")
    s2hi = parse_usage_snap(snap_hi, "T2")
    ok, why = quota_gate(s2hi, "opus", cfg)
    check("gate opus T2 skip (7d=95>=90)", not ok, why)
    ok, why = quota_gate(s1, "opus", cfg)
    check("gate opus T1 pass", ok, why)
    s_none = parse_usage_snap(snap, "CODEX")
    check("snap CODEX none", s_none is None, str(s_none))
    # v4 C(a)：T3/T4 四池可解析 + reset5h/resetfb 字段（空 reset=0% 未触发的正确行为）
    snap4 = os.path.join(tmp, "snap4.log")
    with open(snap4, "w") as f:
        f.write("07-30 09:30 .claude-team3: 5h=29.0% 7d=7.0% fable=13% reset5h=07-30T23:00 resetfb=08-02T02:00 extra=0.0\n"
                "07-30 09:30 .claude-team4: 5h=0.0% 7d=0.0% fable=0% reset5h= resetfb= extra=None\n")
    s3 = parse_usage_snap(snap4, "T3")
    check("snap T3 parse + reset fields", s3 and s3["fable"] == 13.0 and s3["reset5h"] == "07-30T23:00" and s3["resetfb"] == "08-02T02:00", str(s3))
    s4 = parse_usage_snap(snap4, "T4")
    check("snap T4 parse empty-reset", s4 and s4["fable"] == 0.0 and s4["reset5h"] == "" and s4["resetfb"] == "", str(s4))
    check("snap reset 子串不污染 5h 字段", s3["five"] == 29.0, str(s3))
    # v4 哨兵：D-3 裸词行按无有效快照处理（None），不当数字解析崩掉
    snap_sent = os.path.join(tmp, "snap_sent.log")
    with open(snap_sent, "w") as f:
        f.write("07-30 09:30 .claude-team2: AUTH_EXPIRED\n"
                "07-30 09:30 .claude-team3: HTTP_429\n"
                "07-30 09:30 .claude-team4: API_DOWN\n"
                "07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% reset5h= resetfb= extra=1.0\n")
    check("snap sentinel AUTH_EXPIRED -> None", parse_usage_snap(snap_sent, "T2") is None)
    check("snap sentinel HTTP_429 -> None", parse_usage_snap(snap_sent, "T3") is None)
    check("snap sentinel API_DOWN -> None", parse_usage_snap(snap_sent, "T4") is None)
    s_ok = parse_usage_snap(snap_sent, "T1")
    check("snap 哨兵混排中正常行仍解析", s_ok and s_ok["fable"] == 17.0, str(s_ok))
    check("quota_gate 哨兵(=None快照)不通过且带原因", quota_gate(None, "fable", Cfg())[0] is False)

    print("== selftest: fail-closed double-check ==")
    lab = _make_lab(tmp, down_body="team: T1\ncause: 限额\nsummary: 三证齐\n", snap_lines="07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n")
    cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"],
              port="9477", http=_MockHTTP())
    os.utime(lab["jpath"], (time.time() - 100, time.time() - 100))
    rc = resurrect(cfg)
    check("fail-closed: live secretary (jsonl active<15min) exits 0 no action", rc == 0, f"rc={rc}")

    print("== selftest: branch A — quota-skip (all tiers exhausted) ==")
    lab = _make_lab(tmp, down_body="team: T1\ncause: 限额\nsummary: 三证齐\n",
                   snap_lines="07-30 09:30 .claude: 5h=95.0% 7d=95.0% fable=95% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n")
    mock = _MockHTTP()
    mock.responses[("POST", f"http://127.0.0.1:9477/api/projects/d1ffad35-5204-4280-9f82-ccadf6e40fe0/tabs")] = (201, {"id": "codextab", "type": "codex", "claudeSessionId": None})
    cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"],
              port="9477", http=mock)
    cfg.codex_probe_timeout = 0.001
    orig_probe = codex_probe
    def fake_probe(c):
        return False, "codex quota error: 429 rate-limit"
    globals()["codex_probe"] = fake_probe
    try:
        rc = resurrect(cfg)
    finally:
        globals()["codex_probe"] = orig_probe
    check("branch A: all tiers skip -> rc=1, no tab created", rc == 1 and len(mock.calls) == 0, f"rc={rc} calls={len(mock.calls)}")

    print("== selftest: branch B — 搬尸 resume (jsonl<=2MB, T1 fable pass) ==")
    lab = _make_lab(tmp, down_body="team: T2\ncause: 限额\nsummary: 三证齐\n", team="T2",
                   jsonl_size_mb=1.0,
                   snap_lines="07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n")
    mock = _MockHTTP()
    cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"],
              port="9477", http=mock)
    rc = resurrect(cfg)
    resume_call = mock.calls[0][2] if mock.calls else None
    check("branch B: rc=0 and resume tab created with fresh=False+claudeSessionId", rc == 0 and resume_call and resume_call.get("claudeSessionId") == lab["session"] and resume_call.get("fresh") is False, f"rc={rc} payload={resume_call}")

    print("== selftest: branch C — 兜底 fallback (jsonl>2MB) ==")
    lab = _make_lab(tmp, down_body="team: T1\ncause: 无响应\nsummary: 三证齐\n",
                   jsonl_size_mb=3.0,
                   snap_lines="07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n")
    mock = _MockHTTP()
    cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"],
              port="9477", http=mock)
    rc = resurrect(cfg)
    fresh_call = mock.calls[0][2] if mock.calls else None
    handoff = os.path.join(CODEX_WORK, f"HANDOFF_{_dt.datetime.now().strftime('%Y%m%d')}_secretary.md")
    check("branch C: rc=0 fresh=True no claudeSessionId", rc == 0 and fresh_call and fresh_call.get("fresh") is True and not fresh_call.get("claudeSessionId"), f"rc={rc} payload={fresh_call}")

    print("== selftest: DRY_RUN prints full chain ==")
    import io, contextlib
    lab = _make_lab(tmp, down_body="team: T1\ncause: 无响应\nsummary: 三证齐\n", jsonl_size_mb=1.0,
                   snap_lines="07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n")
    mock = _MockHTTP()
    cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"], port="9477", http=mock)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = resurrect(cfg)
    out = buf.getvalue()
    check("DRY_RUN prints [DRY] for create tab? (no real curl)", "[建tab]" in out and rc == 0, f"rc={rc}")
    check("DRY_RUN prints [DRY] would notify", "[DRY] would notify master" in out, out[-200:])

    print("== selftest: compact-patrol ==")
    lab = _make_lab(tmp, down_body="", team="T1", jsonl_size_mb=8.0,
                   snap_lines="07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n")
    down_absent = os.path.join(lab["lab"], "NO_DOWN")
    cfg = Cfg(dry=True, down_file=down_absent, home_env=lab["home"], snap_log=lab["snap"], port="9477")
    rc = compact_patrol(cfg)
    check("compact: jsonl>6MB -> would inject /compact (dry)", rc == 0, f"rc={rc}")

    if saved_logfile is None:
        os.environ.pop("RESURRECT_LOG_FILE", None)
    else:
        os.environ["RESURRECT_LOG_FILE"] = saved_logfile
    shutil.rmtree(tmp, ignore_errors=True)
    print()
    if failures:
        print(f"SELFTEST FAILED: {len(failures)} -> {failures}")
        return 1
    print("SELFTEST PASSED")
    return 0


def _drill():
    """DRY_RUN 全梯度三分支演练，写日志到 ~/codex_work/DRILL_secretary_resurrect.log。"""
    import io, contextlib, tempfile
    tmp = tempfile.mkdtemp(prefix="resurrect_drill_")
    logpath = os.path.join(CODEX_WORK, "DRILL_secretary_resurrect.log")
    buf = io.StringIO()
    # 演练期间把 log() 的文件写入隔离到 /dev/null，避免污染真实 resurrect.log；
    # 演练全链路输出经 stdout 重定向进 buf 再落盘到 DRILL 日志。
    saved_logfile = os.environ.get("RESURRECT_LOG_FILE")
    os.environ["RESURRECT_LOG_FILE"] = "/dev/null"
    # v4：演练聚焦 stage-2 梯度，禁真探 k3-resident tmux（否则 dry 也会真等 noa_timeout）
    globals()["k3_resident_alive"] = lambda c: False

    def run_branch(title, down_body, team, jsonl_mb, snap_lines, codex_ok):
        print(f"\n########## DRILL BRANCH: {title} ##########\n", file=buf)
        lab = _make_lab(tmp, down_body=down_body, team=team, jsonl_size_mb=jsonl_mb, snap_lines=snap_lines)
        mock = _MockHTTP()
        if not codex_ok:
            mock.responses[("POST", f"http://127.0.0.1:9477/api/projects/d1ffad35-5204-4280-9f82-ccadf6e40fe0/tabs")] = (503, {"error": "codex unavailable"})
        cfg = Cfg(dry=True, down_file=lab["down"], home_env=lab["home"], snap_log=lab["snap"], port="9477", http=mock)
        orig_probe = codex_probe
        globals()["codex_probe"] = (lambda c: (codex_ok, "drill codex pass" if codex_ok else "drill codex 429"))
        with contextlib.redirect_stdout(buf):
            try:
                resurrect(cfg)
            except Exception as e:
                print(f"  [drill exception] {e}", file=buf)
        globals()["codex_probe"] = orig_probe

    snap_ok_t1 = "07-30 09:30 .claude: 5h=25.0% 7d=12.0% fable=17% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n"
    snap_full = "07-30 09:30 .claude: 5h=95.0% 7d=95.0% fable=95% extra=51186.0\n07-30 09:30 .claude-team2: 5h=95.0% 7d=95.0% fable=95% extra=50007.0\n"

    with contextlib.redirect_stdout(buf):
        run_branch("A 限额跳梯+全耗尽", "team: T1\ncause: 限额\nsummary: 三证齐\n", "T1", 1.0, snap_full, False)
        run_branch("B 搬尸resume (T1Fable)", "team: T2\ncause: 限额\nsummary: 三证齐\n", "T2", 1.0, snap_ok_t1, True)
        run_branch("C 兜底fallback (jsonl>2MB)", "team: T1\ncause: 无响应\nsummary: 三证齐\n", "T1", 3.0, snap_ok_t1, True)
    out = buf.getvalue()
    # 恢复 log 文件环境
    if saved_logfile is None:
        os.environ.pop("RESURRECT_LOG_FILE", None)
    else:
        os.environ["RESURRECT_LOG_FILE"] = saved_logfile
    os.makedirs(CODEX_WORK, exist_ok=True)
    with open(logpath, "w", encoding="utf-8") as f:
        f.write(out)
    shutil.rmtree(tmp, ignore_errors=True)
    has_a = "全梯度耗尽" in out
    has_b = "[搬尸]" in out
    has_c = "[兜底]" in out
    print(out)
    print(f"\n[drill] log -> {logpath}")
    print(f"[drill] branches covered: A(限额跳梯)={'YES' if has_a else 'NO'} B(搬尸)={'YES' if has_b else 'NO'} C(兜底)={'YES' if has_c else 'NO'}")
    return 0 if (has_a and has_b and has_c) else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="秘书自动梯度复活模块")
    ap.add_argument("--compact-patrol", action="store_true", help="预防性 compact 入口（crontab 每小时）")
    ap.add_argument("--selftest", action="store_true", help="离线单测")
    ap.add_argument("--drill", action="store_true", help="DRY_RUN 全梯度三分支演练日志")
    ap.add_argument("--dry-run", action="store_true", help="全链路打印动作不执行")
    ap.add_argument("--safe", action="store_true", help="E2E 安全模式：执行 API/拷贝/住址/注入，跳过生产危险步（tmux/systemctl/lark）")
    ap.add_argument("--port", default=os.environ.get("RESURRECT_PORT", "9476"))
    ap.add_argument("--project", default=os.environ.get("RESURRECT_PROJECT", "d1ffad35-5204-4280-9f82-ccadf6e40fe0"))
    ap.add_argument("--home-env", default=os.environ.get("RESURRECT_HOME_ENV", os.path.join(CODE_DIR, "secretary-home.env")))
    ap.add_argument("--down-file", default=os.environ.get("RESURRECT_DOWN_FILE", os.path.join(CODEX_WORK, "SECRETARY_DOWN")))
    ap.add_argument("--snap-log", default=os.environ.get("RESURRECT_SNAP_LOG", os.path.join(CODEX_WORK, "usage_snap.log")))
    ap.add_argument("--config-root", default=os.environ.get("RESURRECT_CONFIG_ROOT", ""),
                    help="E2E 隔离：梯队 config 目录的根（默认 $HOME），生产留空")
    ap.add_argument("--noa-timeout", type=float,
                    default=float(os.environ.get("RESURRECT_NOA_TIMEOUT", "300")),
                    help="E 项两段式：stage-1 等 Noa 执行的超时秒数（默认 300s）")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()
    if args.drill:
        return _drill()

    dry = args.dry_run or os.environ.get("DRY_RUN", "") == "1"
    cfg = Cfg(dry=dry, safe=args.safe, port=args.port, project=args.project,
              home_env=args.home_env, down_file=args.down_file, snap_log=args.snap_log,
              config_root=args.config_root, noa_timeout=args.noa_timeout)
    if args.compact_patrol:
        return compact_patrol(cfg)
    return resurrect(cfg)


if __name__ == "__main__":
    sys.exit(main())
