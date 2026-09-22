/* 维护窗口排程前端:编辑器 + 甘特图 + 拖动重算 + 场景保存/恢复/导出 */
"use strict";

const $ = (sel) => document.querySelector(sel);

/* ---------- 默认演示场景 ---------- */
const DEFAULT_SCENARIO = {
  horizon: { start: "2026-09-23T00:00", end: "2026-09-24T00:00" },
  tasks: [
    { id: "t1", name: "数据库备份", duration_minutes: 60, resources: ["DB"], depends_on: [] },
    { id: "t2", name: "数据库升级", duration_minutes: 90, resources: ["DB"], depends_on: ["t1"] },
    { id: "t3", name: "应用服务发布", duration_minutes: 45, resources: ["App"], depends_on: ["t2"] },
    { id: "t4", name: "缓存刷新", duration_minutes: 30, resources: ["Cache"], depends_on: ["t3"] },
    { id: "t5", name: "网络设备固件升级", duration_minutes: 120, resources: ["Network"], depends_on: [] },
    { id: "t6", name: "回归验证", duration_minutes: 60, resources: ["App", "DB"], depends_on: ["t4", "t5"] },
  ],
  blackouts: [
    { start: "2026-09-23T12:00", end: "2026-09-23T13:30" },
    { start: "2026-09-23T18:00", end: "2026-09-23T19:00" },
  ],
};

const state = {
  scenario: JSON.parse(JSON.stringify(DEFAULT_SCENARIO)),
  schedule: null,
  highlight: new Set(), // 冲突链高亮的任务 id
};

/* ---------- 工具 ---------- */
function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const pad = (n) => String(n).padStart(2, "0");

function toLocalISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(isoStr) {
  const d = new Date(isoStr);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtFull(isoStr) {
  const d = new Date(isoStr);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `请求失败 (${res.status})`);
  return data;
}

/* ---------- 排程重算 ---------- */
async function recalc() {
  try {
    state.schedule = await api("/api/schedule", {
      method: "POST",
      body: JSON.stringify(state.scenario),
    });
    state.lastError = null;
  } catch (e) {
    state.schedule = null;
    state.lastError = e.message;
  }
  renderResults();
}

/* ---------- 编辑器渲染 ---------- */
function renderEditors() {
  $("#horizonStart").value = state.scenario.horizon.start;
  $("#horizonEnd").value = state.scenario.horizon.end;
  renderTaskEditors();
  renderBlackoutEditors();
}

function depOptions(current) {
  return state.scenario.tasks
    .filter((t) => t.id !== current.id)
    .map((t) => `<option value="${esc(t.id)}"${current.depends_on.includes(t.id) ? " selected" : ""}>${esc(t.name)}</option>`)
    .join("");
}

function renderTaskEditors() {
  const box = $("#taskList");
  box.innerHTML = "";
  state.scenario.tasks.forEach((t) => {
    const div = el("div", "task-editor" + (state.highlight.has(t.id) ? " highlight" : ""));
    div.dataset.tid = t.id;
    div.innerHTML = `
      <div class="te-row">
        <input class="te-name" value="${esc(t.name)}" placeholder="任务名称">
        <button class="mini danger te-del" title="删除任务">✕</button>
      </div>
      <div class="te-row">
        <label>时长(分钟)<input type="number" class="te-dur" min="1" step="1" value="${t.duration_minutes}"></label>
        <label>资源(逗号分隔)<input class="te-res" value="${esc(t.resources.join(", "))}" placeholder="DB, App"></label>
      </div>
      <div class="te-row">
        <label>依赖(多选)<select class="te-deps" multiple size="3">${depOptions(t)}</select></label>
      </div>
      <div class="te-row">
        <span class="te-pin">${t.pinned_start ? "📌 已固定 " + fmtFull(t.pinned_start) : "自动排程(可拖动甘特条固定)"}</span>
        ${t.pinned_start ? '<button class="mini te-unpin">解除固定</button>' : ""}
      </div>`;

    div.querySelector(".te-name").addEventListener("change", (e) => {
      t.name = e.target.value.trim() || t.id;
      renderTaskEditors(); // 依赖下拉里的名字也要更新
      recalc();
    });
    div.querySelector(".te-dur").addEventListener("change", (e) => {
      t.duration_minutes = Math.max(1, parseInt(e.target.value, 10) || 1);
      recalc();
    });
    div.querySelector(".te-res").addEventListener("change", (e) => {
      t.resources = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      recalc();
    });
    div.querySelector(".te-deps").addEventListener("change", (e) => {
      t.depends_on = [...e.target.selectedOptions].map((o) => o.value);
      recalc();
    });
    div.querySelector(".te-del").addEventListener("click", () => {
      state.scenario.tasks = state.scenario.tasks.filter((x) => x.id !== t.id);
      state.scenario.tasks.forEach((x) => {
        x.depends_on = x.depends_on.filter((d) => d !== t.id);
      });
      renderTaskEditors();
      recalc();
    });
    const unpin = div.querySelector(".te-unpin");
    if (unpin) {
      unpin.addEventListener("click", () => {
        delete t.pinned_start;
        renderTaskEditors();
        recalc();
      });
    }
    box.appendChild(div);
  });
}

function renderBlackoutEditors() {
  const box = $("#blackoutList");
  box.innerHTML = "";
  state.scenario.blackouts.forEach((b, i) => {
    const row = el("div", "blackout-row");
    row.innerHTML = `
      <label>开始<input type="datetime-local" class="bo-start" value="${esc(b.start)}"></label>
      <label>结束<input type="datetime-local" class="bo-end" value="${esc(b.end)}"></label>
      <button class="mini danger bo-del" title="删除时段">✕</button>`;
    row.querySelector(".bo-start").addEventListener("change", (e) => { b.start = e.target.value; recalc(); });
    row.querySelector(".bo-end").addEventListener("change", (e) => { b.end = e.target.value; recalc(); });
    row.querySelector(".bo-del").addEventListener("click", () => {
      state.scenario.blackouts.splice(i, 1);
      renderBlackoutEditors();
      recalc();
    });
    box.appendChild(row);
  });
}

/* ---------- 结果渲染 ---------- */
function renderResults() {
  renderConflicts();
  renderGantt();
}

function renderConflicts() {
  const box = $("#conflicts");
  box.innerHTML = "<h2>冲突检测</h2>";
  if (state.lastError) {
    box.insertAdjacentHTML("beforeend", `<p class="err">⚠ ${esc(state.lastError)}</p>`);
    return;
  }
  const sc = state.schedule;
  if (!sc) return;
  if (!sc.conflicts.length) {
    box.insertAdjacentHTML(
      "beforeend",
      `<p class="ok">✅ 无冲突,排程可执行。共 ${sc.stats.task_count} 项任务,全部完成于 ${fmtFull(sc.stats.makespan_end)}。</p>`
    );
    return;
  }
  const ul = el("ul", "conflict-list");
  sc.conflicts.forEach((c) => {
    const li = el("li", c.type);
    li.textContent = c.message;
    li.title = "点击定位冲突任务";
    li.addEventListener("click", () => highlightChain(c.chain));
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function highlightChain(chain) {
  state.highlight = new Set(chain);
  renderGantt();
  renderTaskEditors();
  const first = document.querySelector(`#gantt [data-tid="${CSS.escape(chain[0])}"]`);
  if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- 甘特图 ---------- */
function tickStep(spanMs) {
  for (const m of [5, 15, 30, 60, 120, 240, 360, 720, 1440]) {
    const s = m * 60000;
    if (spanMs / s <= 14) return s;
  }
  return 24 * 3600 * 1000;
}

function renderGantt() {
  const g = $("#gantt");
  g.innerHTML = "";
  const sc = state.schedule;
  const empty = $("#ganttEmpty");
  if (!sc || !sc.tasks.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const t0 = new Date(sc.horizon.start).getTime();
  const t1 = new Date(sc.horizon.end).getTime();
  const span = t1 - t0;
  const pct = (ms) => ((ms - t0) / span) * 100;

  // 时间轴
  const axis = el("div", "g-axis");
  const step = tickStep(span);
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const tick = el("div", "g-tick");
    tick.style.left = pct(t) + "%";
    tick.textContent = span > 24 * 3600 * 1000 ? fmtFull(new Date(t)) : fmtTime(new Date(t));
    axis.appendChild(tick);
  }
  g.appendChild(axis);

  // 任务行
  sc.tasks.forEach((task) => {
    const row = el("div", "g-row");
    const label = el("div", "g-label");
    label.innerHTML = `${esc(task.name)}<span class="sub">${esc(task.resources.join(" · ") || "无资源")}</span>`;
    label.title = task.name;

    const track = el("div", "g-track");
    sc.blackouts.forEach((b) => {
      const bo = el("div", "g-blackout");
      bo.style.left = pct(new Date(b.start)) + "%";
      bo.style.width = Math.max(0, pct(new Date(b.end)) - pct(new Date(b.start))) + "%";
      track.appendChild(bo);
    });

    const bar = el(
      "div",
      "g-bar" + (task.pinned ? " pinned" : "") + (state.highlight.has(task.id) ? " conflict" : "")
    );
    bar.dataset.tid = task.id;
    const left = pct(new Date(task.start));
    const width = pct(new Date(task.end)) - left;
    bar.style.left = left + "%";
    bar.style.width = Math.max(0.6, width) + "%";
    bar.textContent = `${fmtTime(task.start)}–${fmtTime(task.end)}`;
    bar.title = `${task.name}\n${fmtFull(task.start)} ~ ${fmtFull(task.end)} (${task.duration_minutes} 分钟)\n拖动调整,松开重算`;
    attachDrag(bar, task, track);

    track.appendChild(bar);
    row.append(label, track);
    g.appendChild(row);
  });

  const legend = el("div", "g-legend");
  legend.innerHTML = '<span class="l-auto">自动排程</span><span class="l-pin">已固定(拖动产生)</span><span class="l-bo">不可维护时段</span>';
  g.appendChild(legend);
}

/* ---------- 拖动调整 ---------- */
function attachDrag(bar, task, track) {
  bar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const t0 = new Date(state.schedule.horizon.start).getTime();
    const t1 = new Date(state.schedule.horizon.end).getTime();
    const span = t1 - t0;
    const dur = new Date(task.end).getTime() - new Date(task.start).getTime();
    const origStart = new Date(task.start).getTime();
    const startX = e.clientX;
    let curStart = origStart;

    bar.classList.add("dragging");

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      let ns = origStart + (dx / rect.width) * span;
      ns = Math.round(ns / (5 * 60000)) * (5 * 60000); // 5 分钟吸附
      ns = Math.max(t0, Math.min(t1 - dur, ns));
      curStart = ns;
      bar.style.left = ((ns - t0) / span) * 100 + "%";
      bar.textContent = `${fmtTime(new Date(ns))}–${fmtTime(new Date(ns + dur))}`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      bar.classList.remove("dragging");
      if (curStart !== origStart) {
        const target = state.scenario.tasks.find((x) => x.id === task.id);
        if (target) {
          target.pinned_start = toLocalISO(new Date(curStart));
          state.highlight.clear();
          recalc().then(renderTaskEditors);
        }
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/* ---------- 场景保存 / 恢复 / 导出 / 导入 ---------- */
async function refreshSavedList() {
  const sel = $("#savedList");
  sel.innerHTML = '<option value="">已保存场景…</option>';
  try {
    const list = await api("/api/scenarios");
    list.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name}(${s.updated_at})`;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error(e);
  }
}

function bindGlobalEvents() {
  $("#horizonStart").addEventListener("change", (e) => {
    state.scenario.horizon.start = e.target.value;
    recalc();
  });
  $("#horizonEnd").addEventListener("change", (e) => {
    state.scenario.horizon.end = e.target.value;
    recalc();
  });

  $("#btnAddTask").addEventListener("click", () => {
    state.scenario.tasks.push({
      id: "t" + Date.now(),
      name: "新任务",
      duration_minutes: 30,
      resources: [],
      depends_on: [],
    });
    renderTaskEditors();
    recalc();
  });

  $("#btnAddBlackout").addEventListener("click", () => {
    const s = new Date(state.scenario.horizon.start);
    state.scenario.blackouts.push({
      start: toLocalISO(new Date(s.getTime() + 12 * 3600 * 1000)),
      end: toLocalISO(new Date(s.getTime() + 13 * 3600 * 1000)),
    });
    renderBlackoutEditors();
    recalc();
  });

  $("#btnSave").addEventListener("click", async () => {
    const name = $("#scenarioName").value.trim();
    if (!name) return alert("请先输入场景名称");
    try {
      await api("/api/scenarios", {
        method: "POST",
        body: JSON.stringify({ name, scenario: state.scenario }),
      });
      await refreshSavedList();
      alert(`场景「${name}」已保存`);
    } catch (e) {
      alert(e.message);
    }
  });

  $("#btnLoad").addEventListener("click", async () => {
    const id = $("#savedList").value;
    if (!id) return alert("请先选择要恢复的场景");
    try {
      const data = await api("/api/scenarios/" + id);
      state.scenario = data.scenario;
      state.highlight.clear();
      $("#scenarioName").value = data.name;
      renderEditors();
      await recalc();
    } catch (e) {
      alert(e.message);
    }
  });

  $("#btnDelete").addEventListener("click", async () => {
    const id = $("#savedList").value;
    if (!id) return alert("请先选择要删除的场景");
    if (!confirm("确定删除该场景?")) return;
    try {
      await api("/api/scenarios/" + id, { method: "DELETE" });
      await refreshSavedList();
    } catch (e) {
      alert(e.message);
    }
  });

  $("#btnExport").addEventListener("click", () => {
    const payload = {
      exported_at: toLocalISO(new Date()),
      scenario: state.scenario,
      schedule: state.schedule,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = ($("#scenarioName").value.trim() || "maintenance-scenario") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#fileImport").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const scenario = data.scenario || data;
        if (!scenario.horizon || !Array.isArray(scenario.tasks)) {
          throw new Error("JSON 中缺少 horizon 或 tasks 字段");
        }
        scenario.blackouts = Array.isArray(scenario.blackouts) ? scenario.blackouts : [];
        state.scenario = scenario;
        state.highlight.clear();
        renderEditors();
        recalc();
      } catch (err) {
        alert("导入失败: " + err.message);
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });
}

/* ---------- 启动 ---------- */
(async function init() {
  bindGlobalEvents();
  renderEditors();
  await refreshSavedList();
  await recalc();
})();
