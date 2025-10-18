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

# Job status structure
class _Job(TypedDict, total=False):
    """
    Job status persisted in-memory.

    Fields:
      status     : "queued" | "running" | "completed" | "failed"
      moved      : number of items ATTEMPTED so far (processed count)
      total      : total items the job will attempt
      duplicates : how many attempts were skipped because they already existed
      startedAt  : epoch seconds when job started
      finishedAt : epoch seconds when job finished (if completed/failed)
      message    : error text if failed
    """
    status: str
    moved: int
    total: int
    duplicates: int
    startedAt: float
    finishedAt: Optional[float]
    message: Optional[str]

# In-memory job store - local for dev only
JOBS: Dict[str, _Job] = {}

# Request/response models

class Selection(BaseModel):
    """
    Selection semantics:
      - Provide explicit ids:         ids=[1,2,3]
      - Or select all minus excludes: all=true, excludeIds=[...]
    """
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

# Endpoints/routes

@router.post("/batch", response_model=JobStatus)
def start_move_job(
    body: StartMoveRequest,
    bg: BackgroundTasks,
    db: Session = Depends(database.get_db),
):
    """
    Start a background job to move companies from source list to target list.
    Returns a JobStatus immediately; the UI polls /moves/jobs/{jobId}.

    Rely on the frontend to filter illegal targets (e.g., "My List"),
    but still block same-source/target here.
    """
    if body.sourceListId == body.targetListId:
        raise HTTPException(status_code=400, detail="Source and target lists must differ")

    ids = _resolve_company_ids(db, body)
    job_id = str(uuid.uuid4())

    # Initialize job status
    JOBS[job_id] = {
        "status": "queued",
        "moved": 0,
        "total": len(ids),
        "duplicates": 0,
        "startedAt": time.time(),
        "finishedAt": None,
        "message": None,
    }

    bg.add_task(_run_move_job, job_id, ids, body.targetListId)

    j = JOBS[job_id]
    return JobStatus(jobId=job_id, **j)

@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    """
    Get the status of a background move job by job ID.
    """
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return JobStatus(jobId=job_id, **job)

def _resolve_company_ids(db: Session, body: StartMoveRequest) -> list[int]:
    """
    Resolve the list of company IDs to move based on the selection criteria.
    """
    sel = body.selection
    if sel.ids is not None:
        seen, out = set(), []
        for i in sel.ids:
            if i not in seen:
                seen.add(i)
                out.append(i)
        return out

    if sel.all:
        q = (
            select(database.CompanyCollectionAssociation.company_id)
            .where(database.CompanyCollectionAssociation.collection_id == body.sourceListId)
        )
        all_ids = [row[0] for row in db.execute(q).all()]
        excl = set(sel.excludeIds or [])
        return [cid for cid in all_ids if cid not in excl]

    raise HTTPException(400, "Provide either selection.ids or selection.all=true")

async def _run_move_job(job_id: str, company_ids: list[int], target_list_id: uuid.UUID):
    """
    Run the background job to move companies to the target list.
    """
    job = JOBS[job_id]
    job["status"] = "running"

    # Can tune these variables:
    # Larger BATCH => faster total time but less granular progress updates
    # SLEEP should be close to DB trigger delay (0.1 defined in main.py)
    BATCH = 1
    SLEEP = 0.1

    try:
        with database.SessionLocal() as db:
            for i in range(0, len(company_ids), BATCH):
                chunk = company_ids[i:i + BATCH]

                # Insert rows, counting only NEW ones via RETURNING
                inserted = _upsert_associations(db, chunk, target_list_id)

                # Update job progress: "moved" counts all attempts, "duplicates" counts skips
                job["moved"] += len(chunk)
                job["duplicates"] += len(chunk) - inserted 

                # Simulate async wait for DB trigger to process
                await asyncio.sleep(SLEEP)

        job["status"] = "completed"
        job["finishedAt"] = time.time()

    except Exception as e:
        job["status"] = "failed"
        job["message"] = str(e)
        job["finishedAt"] = time.time()

def _upsert_associations(db: Session, company_ids: list[int], target_list_id: uuid.UUID) -> int:
    """
    Insert (company_id, target_list_id) pairs.
    Duplicate-safe: ON CONFLICT DO NOTHING with RETURNING counts only newly inserted rows.
    Returns: number of rows actually inserted
    """

    if not company_ids:
        return 0

    rows = [{"company_id": cid, "collection_id": target_list_id} for cid in company_ids]

    stmt = (
        pg_insert(database.CompanyCollectionAssociation)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["company_id", "collection_id"])
        .returning(database.CompanyCollectionAssociation.company_id)
    )
    result = db.execute(stmt)
    inserted_rows = result.fetchall()
    db.commit()
    return len(inserted_rows)