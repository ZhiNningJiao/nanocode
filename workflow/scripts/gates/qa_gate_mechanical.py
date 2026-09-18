#!/usr/bin/env python3
"""qa_gate_mechanical.py — 验收自动门·机械段 v1（owner 0830 批：调研强推①，零 LLM）

机制出处：REPORT_agent_survey_grounding.md §3 第一道（swarm-orchestrator「声明=谓词」最小子集
+ ouroboros Mechanical 段 + SWE-bench 判分解耦）。

契约（写进派单书）：REPORT 里每条完成/通过/数字断言必须带证据括注，形式：
    ……结论文字 (证据: <ev>[；<ev>...])
证据 <ev> 三种谓词：
    /abs/path/file.log:123          → 文件存在 且 第123行存在且非空
    /abs/path/file.log:"pattern"    → 文件存在 且 grep -F pattern 命中
    /abs/path/file.md               → 文件存在且非空
裸声明检测：含 PASS/COMPLETE/全绿/已推/已验/成功 等强断言词但无 (证据: ...) 的行 → NAKED 违例。

用法： qa_gate_mechanical.py REPORT.md [--naked-warn]（默认 NAKED 也算 FAIL；--naked-warn 降为警告）
退出码：0=全部 VERIFIED；1=存在 UNVERIFIED 或 NAKED（打回）；2=用法/文件错误。
输出：逐条判定 + 尾部汇总（供秘书直接贴打回单）。
"""
import os, re, subprocess, sys

CLAIM_WORDS = re.compile(r"PASS|COMPLETE|全绿|已推|已验|已部署|成功|通过|0\s*(?:error|fail)|rc=0", re.I)
EV_RE = re.compile(r"[（(]证据[:：]\s*(.+?)[)）]")

def check_ev(ev: str):
    ev = ev.strip()
    m = re.match(r'^(.+?):"(.+)"$', ev)
    if m:
        path, pat = m.group(1).strip(), m.group(2)
        if not os.path.isfile(path):
            return False, f"文件不存在: {path}"
        r = subprocess.run(["/usr/bin/grep", "-aFq", pat, path])
        return (r.returncode == 0), (f"grep 命中" if r.returncode == 0 else f"grep 未命中: {pat!r} in {path}")
    m = re.match(r"^(.+?):(\d+)$", ev)
    if m:
        path, ln = m.group(1).strip(), int(m.group(2))
        if not os.path.isfile(path):
            return False, f"文件不存在: {path}"
        try:
            with open(path, "rb") as f:
                for i, line in enumerate(f, 1):
                    if i == ln:
                        return (len(line.strip()) > 0), (f"第{ln}行非空" if line.strip() else f"第{ln}行为空")
            return False, f"文件只有 {i} 行 < {ln}"
        except Exception as e:
            return False, f"读取失败: {e}"
    path = ev
    if not os.path.isfile(path):
        return False, f"文件不存在: {path}"
    ok = os.path.getsize(path) > 0
    return ok, ("文件存在非空" if ok else "文件为空")

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    report = sys.argv[1]
    naked_fatal = "--naked-warn" not in sys.argv[2:]
    if not os.path.isfile(report):
        print(f"[qa_gate] 报告不存在: {report}"); sys.exit(2)
    verified, unverified, naked = [], [], []
    for lineno, line in enumerate(open(report, encoding="utf-8", errors="replace"), 1):
        line_s = line.rstrip("\n")
        evm = EV_RE.search(line_s)
        if evm:
            for ev in re.split(r"[;；]", evm.group(1)):
                if not ev.strip():
                    continue
                ok, why = check_ev(ev)
                (verified if ok else unverified).append((lineno, ev.strip(), why))
        elif CLAIM_WORDS.search(line_s) and not line_s.lstrip().startswith(("#", ">", "|")):
            naked.append((lineno, line_s.strip()[:100]))
    print(f"== qa_gate_mechanical: {report}")
    for ln, ev, why in verified:
        print(f"  VERIFIED  L{ln}  {ev}  ({why})")
    for ln, ev, why in unverified:
        print(f"  UNVERIFIED L{ln}  {ev}  ({why})")
    for ln, txt in naked:
        print(f"  NAKED     L{ln}  {txt}")
    fail = len(unverified) + (len(naked) if naked_fatal else 0)
    print(f"== 汇总: verified={len(verified)} unverified={len(unverified)} naked={len(naked)} "
          f"→ {'PASS' if fail == 0 and verified else ('FAIL' if fail else 'EMPTY(报告无任何带证据断言,也算FAIL)')}")
    sys.exit(0 if (fail == 0 and verified) else 1)

if __name__ == "__main__":
    main()
