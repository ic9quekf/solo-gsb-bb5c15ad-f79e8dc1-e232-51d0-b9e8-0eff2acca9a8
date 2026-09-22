"""维护窗口排程核心逻辑。

- 拓扑排序计算可执行顺序与最早开始时间
- 同名资源互斥占用,检测资源重叠
- DFS 检测循环依赖并返回可定位的冲突链
- 支持 pinned_start(用户拖动固定)与不可维护时段(Blackout)
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta


def parse_dt(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="minutes")


def find_cycle(tasks: dict) -> list | None:
    """返回一条循环依赖链(任务 id 列表,首尾相同);无环返回 None。"""
    color = {tid: 0 for tid in tasks}  # 0=未访问 1=在栈中 2=已完成
    stack: list = []

    def dfs(u: str):
        color[u] = 1
        stack.append(u)
        for v in tasks[u].get("depends_on", []):
            if v not in tasks:
                continue
            if color[v] == 1:
                idx = stack.index(v)
                return stack[idx:] + [v]
            if color[v] == 0:
                found = dfs(v)
                if found:
                    return found
        stack.pop()
        color[u] = 2
        return None

    for tid in sorted(tasks):
        if color[tid] == 0:
            found = dfs(tid)
            if found:
                return found
    return None


def topo_order(tasks: dict) -> list:
    """Kahn 拓扑排序,结果确定性(按 id 字典序取就绪节点)。"""
    indegree = {tid: 0 for tid in tasks}
    dependents = defaultdict(list)
    for tid, task in tasks.items():
        for dep in task.get("depends_on", []):
            if dep in tasks:
                indegree[tid] += 1
                dependents[dep].append(tid)
    ready = sorted(tid for tid, d in indegree.items() if d == 0)
    order = []
    while ready:
        u = ready.pop(0)
        order.append(u)
        for w in sorted(dependents[u]):
            indegree[w] -= 1
            if indegree[w] == 0:
                ready.append(w)
        ready.sort()
    return order


def compute_schedule(scenario: dict) -> dict:
    """根据场景计算排程,返回任务时间、冲突列表与统计信息。"""
    horizon = scenario.get("horizon") or {}
    try:
        horizon_start = parse_dt(horizon["start"])
        horizon_end = parse_dt(horizon["end"])
    except (KeyError, ValueError) as exc:
        raise ValueError(f"排程日期范围无效: {exc}")
    if horizon_end <= horizon_start:
        raise ValueError("排程结束时间必须晚于开始时间")

    tasks: dict = {}
    for raw in scenario.get("tasks", []):
        t = dict(raw)
        if not t.get("id"):
            continue
        t["depends_on"] = [d for d in t.get("depends_on", []) if d and d != t["id"]]
        t["resources"] = [str(r).strip() for r in t.get("resources", []) if str(r).strip()]
        try:
            t["duration_minutes"] = max(1, int(t.get("duration_minutes") or 0))
        except (TypeError, ValueError):
            t["duration_minutes"] = 1
        tasks[t["id"]] = t

    blackouts = []
    for b in scenario.get("blackouts", []):
        try:
            bs, be = parse_dt(b["start"]), parse_dt(b["end"])
        except (KeyError, ValueError):
            continue
        if be > bs:
            blackouts.append((bs, be))
    blackouts.sort()

    names = {tid: (t.get("name") or tid) for tid, t in tasks.items()}
    conflicts: list = []

    # ---- 循环依赖 ----
    cycle = find_cycle(tasks)
    if cycle:
        conflicts.append({
            "type": "cycle",
            "chain": cycle,
            "message": "循环依赖: " + " → ".join(names.get(c, c) for c in cycle),
        })
        return {
            "horizon": {"start": iso(horizon_start), "end": iso(horizon_end)},
            "blackouts": [{"start": iso(s), "end": iso(e)} for s, e in blackouts],
            "tasks": [],
            "conflicts": conflicts,
            "cycle": cycle,
        }

    # ---- 缺失依赖 ----
    seen_missing = set()
    for tid, t in tasks.items():
        for dep in t.get("depends_on", []):
            if dep not in tasks and (tid, dep) not in seen_missing:
                seen_missing.add((tid, dep))
                conflicts.append({
                    "type": "missing_dependency",
                    "chain": [tid],
                    "message": f"任务「{names[tid]}」依赖了不存在的任务 id「{dep}」",
                })

    order = topo_order(tasks)
    usage: dict = defaultdict(list)  # resource -> [(start, end, tid)]
    scheduled: dict = {}             # tid -> (start, end)

    def overlaps(a0, a1, b0, b1) -> bool:
        return a0 < b1 and b0 < a1

    def earliest_slot(earliest: datetime, dur: timedelta, resources: list) -> datetime:
        """从 earliest 起找到第一个避开不可维护时段与资源占用的开始时间。"""
        start = earliest
        for _ in range(10000):  # 防御性上限
            end = start + dur
            pushed = None
            for bs, be in blackouts:
                if overlaps(start, end, bs, be):
                    pushed = be
                    break
            if pushed is None:
                for r in resources:
                    for s, e, _t in usage[r]:
                        if overlaps(start, end, s, e):
                            pushed = e
                            break
                    if pushed is not None:
                        break
            if pushed is None:
                return start
            start = max(start, pushed)
        return start

    def place(tid: str, start: datetime):
        t = tasks[tid]
        end = start + timedelta(minutes=t["duration_minutes"])
        scheduled[tid] = (start, end)
        for r in t["resources"]:
            usage[r].append((start, end, tid))

    # 第一遍:放置用户拖动固定的任务(pinned),其余任务绕开它们
    for tid in order:
        pinned = tasks[tid].get("pinned_start")
        if not pinned:
            continue
        try:
            place(tid, parse_dt(pinned))
        except ValueError:
            pass  # 非法固定时间按未固定处理

    # 第二遍:按拓扑序放置自动排程任务
    for tid in order:
        if tid in scheduled:
            continue
        t = tasks[tid]
        dur = timedelta(minutes=t["duration_minutes"])
        earliest = horizon_start
        for dep in t.get("depends_on", []):
            if dep in scheduled and scheduled[dep][1] > earliest:
                earliest = scheduled[dep][1]
        place(tid, earliest_slot(earliest, dur, t["resources"]))

    # ---- 冲突检测(拖动固定后可能产生) ----
    for tid, t in tasks.items():
        start, end = scheduled[tid]
        for dep in t.get("depends_on", []):
            if dep in scheduled and start < scheduled[dep][1]:
                conflicts.append({
                    "type": "dependency",
                    "chain": [dep, tid],
                    "message": (
                        f"依赖冲突: 「{names[dep]}」{iso(scheduled[dep][1])} 才结束,"
                        f"但「{names[tid]}」{iso(start)} 已开始"
                    ),
                })
        for bs, be in blackouts:
            if overlaps(start, end, bs, be):
                conflicts.append({
                    "type": "blackout",
                    "chain": [tid],
                    "message": f"「{names[tid]}」与不可维护时段 {iso(bs)} ~ {iso(be)} 重叠",
                })
        if start < horizon_start or end > horizon_end:
            conflicts.append({
                "type": "horizon",
                "chain": [tid],
                "message": f"「{names[tid]}」({iso(start)} ~ {iso(end)}) 超出排程日期范围",
            })

    for resource, ivs in usage.items():
        ivs.sort()
        for i in range(len(ivs)):
            for j in range(i + 1, len(ivs)):
                a, b = ivs[i], ivs[j]
                if b[0] >= a[1]:
                    break
                conflicts.append({
                    "type": "resource",
                    "resource": resource,
                    "chain": [a[2], b[2]],
                    "message": (
                        f"资源「{resource}」重叠: 「{names[a[2]]}」"
                        f"({iso(a[0])}~{iso(a[1])}) 与 「{names[b[2]]}」"
                        f"({iso(b[0])}~{iso(b[1])})"
                    ),
                })

    result_tasks = []
    for tid in order:
        t = tasks[tid]
        start, end = scheduled[tid]
        result_tasks.append({
            "id": tid,
            "name": names[tid],
            "start": iso(start),
            "end": iso(end),
            "duration_minutes": t["duration_minutes"],
            "resources": t["resources"],
            "depends_on": [d for d in t["depends_on"] if d in tasks],
            "pinned": bool(t.get("pinned_start")),
        })
    result_tasks.sort(key=lambda x: (x["start"], x["id"]))

    makespan_end = max((e for _, e in scheduled.values()), default=horizon_start)
    return {
        "horizon": {"start": iso(horizon_start), "end": iso(horizon_end)},
        "blackouts": [{"start": iso(s), "end": iso(e)} for s, e in blackouts],
        "tasks": result_tasks,
        "conflicts": conflicts,
        "cycle": None,
        "stats": {
            "task_count": len(result_tasks),
            "makespan_end": iso(makespan_end),
            "conflict_count": len(conflicts),
        },
    }
