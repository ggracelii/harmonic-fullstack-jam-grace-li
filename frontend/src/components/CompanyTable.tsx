import { DataGrid, GridRowSelectionModel } from "@mui/x-data-grid";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getCollectionsById, ICompany } from "../utils/jam-api";

/** Minimal types + API calls kept local so no other files change */
type CollectionMeta = { id: string; collection_name: string };
type MoveJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  moved: number;
  total: number;
  duplicates: number;
};

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/** Frontend-only helpers for the new endpoints */
async function fetchCollections(): Promise<CollectionMeta[]> {
  const r = await fetch(`${API}/collections`);
  if (!r.ok) throw new Error("Failed to load collections");
  return r.json();
}
async function startMove(body: any): Promise<MoveJob> {
  const r = await fetch(`${API}/moves/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Failed to start move");
  return r.json();
}
async function getJob(jobId: string): Promise<MoveJob> {
  const r = await fetch(`${API}/moves/jobs/${jobId}`);
  if (!r.ok) throw new Error("Failed to load job");
  return r.json();
}

/** Cross-page selection model */
type SelectionMode =
  | { type: "explicit"; ids: Set<number> }
  | { type: "all"; deselectedIds: Set<number> };

const CompanyTable = (props: { selectedCollectionId: string }) => {
  // Original state
  const [response, setResponse] = useState<ICompany[]>([]);
  const [total, setTotal] = useState<number>();
  const [offset, setOffset] = useState<number>(0);
  const [pageSize, setPageSize] = useState(25);

  // New: selection state (select-all across all results)
  const [mode, setMode] = useState<SelectionMode>({
    type: "explicit",
    ids: new Set(),
  });
  const pageIds = useMemo(() => response.map((r) => r.id), [response]);

  // New: move modal + lists
  const [collections, setCollections] = useState<CollectionMeta[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetListId, setTargetListId] = useState<string>("");

  // New: background job progress
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<MoveJob | null>(null);

  // Fetch page (original)
  useEffect(() => {
    getCollectionsById(props.selectedCollectionId, offset, pageSize).then(
      (newResponse) => {
        setResponse(newResponse.companies);
        setTotal(newResponse.total);
      }
    );
  }, [props.selectedCollectionId, offset, pageSize]);

  // Reset page and selection when the list changes (minimal)
  useEffect(() => {
    setOffset(0);
    setMode({ type: "explicit", ids: new Set() });
  }, [props.selectedCollectionId]);

  // Load lists for destination choices (once)
  useEffect(() => {
    fetchCollections().then(setCollections).catch(() => setCollections([]));
  }, []);

  const sourceList = useMemo(
    () => collections.find(c => c.id === props.selectedCollectionId),
    [collections, props.selectedCollectionId]
  );

  // Allowed targets based on source list name
  const allowedTargets = useMemo(() => {
    if (!sourceList) return [];
    const name = sourceList.collection_name;

    // Rules:
    // - "My List" -> can move to the other two
    // - "Liked Companies List" -> only "Companies to Ignore List"
    // - "Companies to Ignore List" -> only "Liked Companies List"
    // - No one can target "My List"
    if (name === "My List") {
      return collections.filter(c => c.collection_name !== "My List");
    }
    if (name === "Liked Companies List") {
      return collections.filter(c => c.collection_name === "Companies to Ignore List");
    }
    if (name === "Companies to Ignore List") {
      return collections.filter(c => c.collection_name === "Liked Companies List");
    }
    // Fallback: exclude My List and self
    return collections.filter(
      c => c.collection_name !== "My List" && c.id !== sourceList.id
    );
  }, [collections, sourceList]);

  // DataGrid selection shown for the current page only, derived from global selection mode
  const rowSelectionModel: GridRowSelectionModel = useMemo(() => {
    if (mode.type === "all") {
      return pageIds.filter((id) => !mode.deselectedIds.has(id));
    }
    return pageIds.filter((id) => mode.ids.has(id));
  }, [mode, pageIds]);

  // Update global selection when user clicks checkboxes on this page
  const onRowSelectionModelChange = useCallback(
    (model: GridRowSelectionModel) => {
      const selectedOnPage = new Set<number>(model.map(Number));
      if (mode.type === "all") {
        const s = new Set(mode.deselectedIds);
        for (const id of pageIds) {
          if (selectedOnPage.has(id)) s.delete(id);
          else s.add(id);
        }
        setMode({ type: "all", deselectedIds: s });
      } else {
        const s = new Set(mode.ids);
        for (const id of pageIds) {
          if (selectedOnPage.has(id)) s.add(id);
          else s.delete(id);
        }
        setMode({ type: "explicit", ids: s });
      }
    },
    [mode, pageIds]
  );

  // Counts and actions
  const selectedCount = useMemo(
    () =>
      mode.type === "all"
        ? (total ?? 0) - mode.deselectedIds.size
        : mode.ids.size,
    [mode, total]
  );
  const selectAllAcrossResults = () =>
    setMode({ type: "all", deselectedIds: new Set() });
  const clearSelection = () => setMode({ type: "explicit", ids: new Set() });

  // Start move job
  const [progressHintTotal, setProgressHintTotal] = useState<number | null>(null);

  async function beginMove() {
    if (!targetListId) return;

    // close modal immediately so it disappears right away
    setMoveOpen(false);

    // capture count for stable text
    const totalSelectedNow =
      mode.type === "all"
        ? (total ?? 0) - (mode.deselectedIds?.size ?? 0)
        : mode.ids.size;
    setProgressHintTotal(totalSelectedNow);

    const payload =
      mode.type === "all"
        ? {
            sourceListId: props.selectedCollectionId,
            targetListId,
            selection: {
              all: true,
              excludeIds: Array.from(mode.deselectedIds),
            },
          }
        : {
            sourceListId: props.selectedCollectionId,
            targetListId,
            selection: { ids: Array.from(mode.ids) },
          };

    const j = await startMove(payload);
    setJobId(j.jobId);
    setJob(j); // render toast immediately with initial values
  }

  // Poll progress until done; auto-dismiss 8s after completion
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await getJob(jobId);
        setJob(j);
        if (j.status === "completed" || j.status === "failed") {
          setTimeout(() => {
            if (!stop) setJobId(null);
          }, 8000);
          return;
        }
      } catch {
        // ignore transient errors
      }
      if (!stop) setTimeout(tick, 10);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [jobId]);

  return (
  <>
    <div style={{ height: 600, width: "100%" }}>
      <DataGrid
        rows={response}
        rowHeight={30}
        columns={[
          { field: "liked", headerName: "Liked", width: 90 },
          { field: "id", headerName: "ID", width: 90 },
          { field: "company_name", headerName: "Company Name", width: 200 },
        ]}
        initialState={{
          pagination: {
            paginationModel: { page: 0, pageSize: 25 },
          },
        }}
        rowCount={total ?? 0}
        pagination
        checkboxSelection
        paginationMode="server"
        onPaginationModelChange={(newMeta) => {
          setPageSize(newMeta.pageSize);
          setOffset(newMeta.page * newMeta.pageSize);
        }}
        rowSelectionModel={rowSelectionModel}
        onRowSelectionModelChange={onRowSelectionModelChange}
      />
    </div>

    {/* Controls BELOW the table */}
    <Box
      sx={{
        mt: 1.5,
        display: "flex",
        justifyContent: "space-between", // keep left/right separation
        alignItems: "center",
        flexWrap: "wrap",
        width: "100%",
      }}
    >
      {/* Left group */}
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="small" variant="outlined" onClick={selectAllAcrossResults}>
          Select all {total ?? 0}
        </Button>
        <Button size="small" onClick={clearSelection}>
          Clear
        </Button>
        <Typography variant="body2">
          {selectedCount} selected{mode.type === "all" ? " (all pages)" : ""}
        </Typography>
      </Box>

      {/* Right-aligned Move button */}
      <Box>
        <Button
          size="small"
          variant="contained"
          disabled={selectedCount === 0}
          onClick={() => {
            setTargetListId(""); // reset default to blank
            setMoveOpen(true);
          }}
        >
          Move selected to another list
        </Button>
      </Box>
    </Box>

    {/* Move modal */}
    <Dialog open={moveOpen} onClose={() => setMoveOpen(false)}>
      <DialogTitle>Move selected to…</DialogTitle>
      <DialogContent sx={{ minWidth: 320, pt: 2 }}>
        <Select
          fullWidth
          value={targetListId}
          displayEmpty
          onChange={(e) => setTargetListId(String(e.target.value))}
        >
          <MenuItem value="" disabled>Choose a list</MenuItem>
            {allowedTargets.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.collection_name}
            </MenuItem>
          ))}
        </Select>
        <Typography variant="caption" sx={{ mt: 1, display: "block", color: "text.secondary" }}>
          Runs in the background. You can keep browsing.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setMoveOpen(false)}>Cancel</Button>
        <Button disabled={!targetListId} variant="contained" onClick={beginMove}>
          Move
        </Button>
      </DialogActions>
    </Dialog>

    {/* Progress toast */}
    {jobId && (
      
      <Box
        sx={{
          position: "fixed",
          left: 16,
          right: 16,
          bottom: 16,
          bgcolor: "#f5f7fb",
          border: "1px solid #e3e6ee",
          borderRadius: 1.5,
          zIndex: 20000,
          color: "#111",
          boxShadow: 3,
          overflow: "hidden",
        }}
      >
        
        <FunFactsPanel />
        {/* Status line */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2,
            p: 1.2,
            fontSize: 14,
          }}
        >
          <span>
            {job?.status === "completed"
              ? `Completed — moved ${((progressHintTotal ?? job?.total) ?? 0) - (job?.duplicates ?? 0)} 
                items (${job?.duplicates ?? 0} were not moved since they were already in the target list)`
              : job?.status === "failed"
              ? "Failed"
              : `In progress... ${job?.moved ?? 0} out of ${(progressHintTotal ?? job?.total) ?? 0} moved`}
          </span>
        </Box>
        <Box
          sx={{
            height: 6,
            width: `${
              job?.total ? Math.min(100, Math.round((job.moved / job.total) * 100)) : 0
            }%`,
            transition: "width .3s ease",
            bgcolor:
              job?.status === "completed" ? "#10b981"
              : job?.status === "failed" ? "#ef4444"
              : "#3b82f6",
          }}
        />
      </Box>
    )}
  </>
);
};

export default CompanyTable;

function FunFactsPanel() {
  const facts = [
    "Grace (who made this feature) took a gap year to go to ballet school",
    "You can keep browsing companies while this runs",
    "No number before 1,000 contains the letter A.",
    "The human circulatory system is more than 60,000 miles long.",
    "Grace (who made this feature) studies CS, Math, and Dance at Columbia",
    "A cloud weighs around a million tonnes",
    "Giraffes are 30 times more likely to get hit by lightning than people",
    "The largest piece of fossilised dinosaur poo discovered is over 30cm long and over two litres in volume",
    "Grace (who made this feature) is originally from San Diego, CA",
    "All the world’s bacteria stacked on top of each other would stretch for 10 billion light-years",
    "Snails have teeth (scary!)",
    "The longest word in the English language is 189,819 letters long",
    "Grace (who made this feature) drinks -- and can't function without -- at least 400 mg of caffeine daily",
    "On average, people blink 28,000 times a day",
    "A sneeze can travel at speeds of up to 100 miles per hour, dispersing around 100,000 germs into the air",
    "Learning a second language can lead to structural changes in the brain, enhancing cognitive abilities",
    "On that note, Grace (who made this feature) speaks English and Mandarin fluently, and can read the Russian alphabet",
    "Around 5% of adults engage in sleep talking",
    "Human noses can distinguish between around 1 trillion different scents",
    "Cats can hydrate from seawater because their kidneys efficiently filter out the salt, while humans and most animals risk dehydration from drinking seawater",
    "Grace (who made this feature) really wants a pet cat but can't have one right now",
    "The name 'Häagen-Dazs' is a made-up word created by the American founders to sound Danish",
    "The world’s largest grand piano was built by a 15-year-old in New Zealand",
    "That piano is over 18 feet long and only has 85 keys instead of 88",
    "By the way, Grace (who made this feature) plays the piano, violin, and flute",
    "I'm running out of fun facts",
    "Please hire me!"
  ];
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % facts.length), 3000); // 3s each
    return () => clearInterval(id);
  }, []);

  return (
    <Box
      sx={{
        px: 1.2,
        pb: 1.2,
      }}
    >
      <Box
        sx={{
          border: "1px solid #e3e6ee",
          borderRadius: 1,
          p: 1.2,
          height: 96,          // fixed height
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          bgcolor: "#fff",
        }}
      >
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Fun facts while you wait!
        </Typography>
        <Typography variant="body2" sx={{ opacity: 0.9 }}>
          {facts[i]}
        </Typography>
      </Box>
    </Box>
  );
}