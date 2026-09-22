# 维护窗口排程(Maintenance Window Scheduler)

基于 **FastAPI + SQLite + 原生 JavaScript** 的维护窗口排程 Web 应用。录入服务依赖 DAG、每项维护时长、资源占用与不可维护时段后,系统在指定日期范围内计算满足依赖关系的可执行顺序与开始时间,检测资源重叠与循环依赖并给出可定位的冲突链;支持拖动调整窗口即时重算、场景保存/恢复与 JSON 导出。

## 功能

- **依赖 DAG 排程**:拓扑排序计算可执行顺序,任务从所有依赖完成后尽早开始
- **资源互斥**:同名资源(如 `DB`、`App`)在同一时刻只允许一个任务占用,自动错开
- **不可维护时段**:Blackout 时间段内不安排任务,自动顺延
- **循环依赖检测**:DFS 找出完整循环链(如 `A → B → C → A`),点击可定位高亮
- **冲突链定位**:资源重叠、依赖倒置、越出排程范围、落入 Blackout 等冲突逐条列出,点击即在甘特图与编辑器中高亮相关任务
- **拖动即时重算**:在甘特图上拖动任务条(5 分钟吸附)固定其开始时间,其余任务自动绕开;可一键解除固定
- **场景保存/恢复**:命名场景存入 SQLite,可随时恢复或删除
- **JSON 导出/导入**:导出当前场景与排程结果为 JSON 文件,也可从 JSON 导入场景

## 快速开始

### 方式一:Docker 一键启动(推荐)

```bash
docker build -t maintenance-scheduler .
docker run -d -p 8000:8000 -v scheduler-data:/data --name scheduler maintenance-scheduler
```

### 方式二:Docker Compose

```bash
docker compose up -d --build
```

### 方式三:本地开发

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## 访问

启动后打开浏览器访问:**http://localhost:8000**

首次进入自带一个演示场景(6 项任务、3 类资源、2 段不可维护时段),可直接体验拖动与冲突检测。

## 配置

| 环境变量  | 默认值                 | 说明                                   |
| --------- | ---------------------- | -------------------------------------- |
| `PORT`    | `8000`                 | 服务监听端口(容器内)                 |
| `DB_PATH` | `/data/scheduler.db`   | SQLite 数据库文件路径(本地运行为 `./scheduler.db`) |

修改宿主机映射端口示例:`docker run -d -p 9000:8000 ...`,然后访问 `http://localhost:9000`。

## 使用说明

1. **排程日期范围**:设置开始/结束时间,所有任务必须落在该范围内
2. **维护任务**:填写名称、时长(分钟)、占用资源(逗号分隔,同名互斥)、依赖任务(Ctrl/⌘ 多选)
3. **不可维护时段**:添加 Blackout 时间段,排程自动绕开
4. **甘特图**:蓝色为自动排程任务,黄色为拖动后固定的任务,斜纹区域为不可维护时段;拖动任务条后松开即重算
5. **冲突检测**:面板列出全部冲突,点击某条即在甘特图与左侧编辑器中高亮冲突链上的任务
6. **场景管理**:顶部输入名称后保存;从下拉框选择已保存场景可恢复或删除;「导出 JSON」下载场景与排程结果,「导入 JSON」反向恢复

## API 一览

| 方法 | 路径                  | 说明                             |
| ---- | --------------------- | -------------------------------- |
| POST | `/api/schedule`       | 计算排程(请求体为场景 JSON)    |
| GET  | `/api/scenarios`      | 列出已保存场景                   |
| POST | `/api/scenarios`      | 保存/覆盖场景 `{name, scenario}` |
| GET  | `/api/scenarios/{id}` | 恢复指定场景                     |
| DELETE | `/api/scenarios/{id}` | 删除场景                       |
| GET  | `/api/health`         | 健康检查                         |

场景 JSON 结构:

```json
{
  "horizon": { "start": "2026-09-23T00:00", "end": "2026-09-24T00:00" },
  "tasks": [
    {
      "id": "t1",
      "name": "数据库备份",
      "duration_minutes": 60,
      "resources": ["DB"],
      "depends_on": [],
      "pinned_start": "2026-09-23T09:00"
    }
  ],
  "blackouts": [{ "start": "2026-09-23T12:00", "end": "2026-09-23T13:30" }]
}
```

`pinned_start` 为可选字段,表示用户拖动固定后的开始时间;排程结果中的 `conflicts[].chain` 即冲突链(任务 id 列表)。

## 项目结构

```
├── app/
│   ├── main.py          # FastAPI 入口与 API 路由
│   ├── scheduler.py     # 排程核心:拓扑排序、资源避让、循环依赖与冲突检测
│   ├── db.py            # SQLite 场景存取
│   └── static/          # 原生前端(index.html / app.js / style.css)
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── README.md
```
