"""FastAPI 入口:排程计算、场景保存/恢复、静态页面。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .scheduler import compute_schedule

STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


app = FastAPI(title="维护窗口排程", version="1.0.0", lifespan=lifespan)


class ScenarioIn(BaseModel):
    name: str
    scenario: dict


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/schedule")
def schedule(scenario: dict):
    """计算排程:接收场景 JSON,返回任务时间、冲突链与统计。"""
    try:
        return compute_schedule(scenario)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/scenarios")
def list_scenarios():
    return db.list_scenarios()


@app.post("/api/scenarios")
def save_scenario(payload: ScenarioIn):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="场景名称不能为空")
    return db.save_scenario(name, payload.scenario)


@app.get("/api/scenarios/{sid}")
def get_scenario(sid: int):
    row = db.get_scenario(sid)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    return row


@app.delete("/api/scenarios/{sid}")
def delete_scenario(sid: int):
    if not db.delete_scenario(sid):
        raise HTTPException(status_code=404, detail="场景不存在")
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
