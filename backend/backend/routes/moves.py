# backend/routes/moves.py
import uuid
import asyncio
import time
from typing import Dict, List, Optional, TypedDict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from backend.db import database

router = APIRouter(prefix="/moves", tags=["moves"])

# In-memory job store (OK for single-process dev). Swap to Redis for prod.
class _Job(TypedDict, total=False):
    status: str        # queued | running | completed | failed
    moved: int
    total: int
    duplicates: int
    startedAt: float
    finishedAt: Optional[float]
    message: Optional[str]

JOBS: Dict[str, _Job] = {}

# --------- Request/Response models ----------

class Selection(BaseModel):
    # Either provide explicit ids OR set all=True with optional excludeIds
    ids: Optional[list[int]] = None
    all: Optional[bool] = None
    excludeIds: list[int] = []

class StartMoveRequest(BaseModel):
    sourceListId: uuid.UUID
    targetListId: uuid.UUID
    selection: Selection

class JobStatus(BaseModel):
    jobId: str
    status: str
    moved: int
    total: int
    duplicates: int = 0
    startedAt: float
    finishedAt: Optional[float] = None
    message: Optional[str] = None

# --------- Endpoints ----------

@router.post("/batch", response_model=JobStatus)
def start_move_job(
    body: StartMoveRequest,
    bg: BackgroundTasks,
    db: Session = Depends(database.get_db),
):
    if body.sourceListId == body.targetListId:
        raise HTTPException(status_code=400, detail="Source and target lists must differ")

    # Resolve the full set of company IDs now so the job is deterministic.
    ids = _resolve_company_ids(db, body)
    job_id = str(uuid.uuid4())

    JOBS[job_id] = {
        "status": "queued",
        "moved": 0,
        "total": len(ids),
        "duplicates": 0,
        "startedAt": time.time(),
        "finishedAt": None,
        "message": None,
    }

    # Fire off background worker
    bg.add_task(_run_move_job, job_id, ids, body.targetListId)

    j = JOBS[job_id]
    return JobStatus(jobId=job_id, **j)

@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return JobStatus(jobId=job_id, **job)

# --------- Helpers ----------

def _resolve_company_ids(db: Session, body: StartMoveRequest) -> list[int]:
    sel = body.selection
    if sel.ids is not None:
        # de-dup while preserving order
        seen, out = set(), []
        for i in sel.ids:
            if i not in seen:
                seen.add(i)
                out.append(i)
        return out

    if sel.all:
        # All companies currently in the source list minus exclusions
        q = (
            select(database.CompanyCollectionAssociation.company_id)
            .where(database.CompanyCollectionAssociation.collection_id == body.sourceListId)
        )
        all_ids = [row[0] for row in db.execute(q).all()]
        excl = set(sel.excludeIds or [])
        return [cid for cid in all_ids if cid not in excl]

    raise HTTPException(400, "Provide either selection.ids or selection.all=true")

async def _run_move_job(job_id: str, company_ids: list[int], target_list_id: uuid.UUID):
    job = JOBS[job_id]
    job["status"] = "running"

    BATCH = 1      # tune chunk size
    SLEEP = 0.1      # backoff to respect DB trigger throttle

    try:
        with database.SessionLocal() as db:
            for i in range(0, len(company_ids), BATCH):
                chunk = company_ids[i:i + BATCH]
                inserted = _upsert_associations(db, chunk, target_list_id)
                job["moved"] += len(chunk)
                job["duplicates"] += len(chunk) - inserted 
                await asyncio.sleep(SLEEP)

        job["status"] = "completed"
        job["finishedAt"] = time.time()
    except Exception as e:
        job["status"] = "failed"
        job["message"] = str(e)
        job["finishedAt"] = time.time()

def _upsert_associations(db: Session, company_ids: list[int], target_list_id: uuid.UUID) -> int:
    if not company_ids:
        return 0

    rows = [{"company_id": cid, "collection_id": target_list_id} for cid in company_ids]

    stmt = (
        pg_insert(database.CompanyCollectionAssociation)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["company_id", "collection_id"])
        .returning(database.CompanyCollectionAssociation.company_id)  # count actual inserts
    )
    result = db.execute(stmt)
    inserted_rows = result.fetchall()  # only actually inserted rows are returned
    db.commit()
    return len(inserted_rows)