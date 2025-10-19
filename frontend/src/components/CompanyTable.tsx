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

// Types for API responses
type CollectionMeta = { id: string; collection_name: string };

// Move job status type
type MoveJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  moved: number;
  total: number;
  duplicates: number;
};

// API base URL
const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// API functions

// Fetch collections metadata
async function fetchCollections(): Promise<CollectionMeta[]> {
  const r = await fetch(`${API}/collections`);
  if (!r.ok) throw new Error("Failed to load collections");
  return r.json();
}

// Start a move job
async function startMove(body: any): Promise<MoveJob> {
  const r = await fetch(`${API}/moves/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Failed to start move");
  return r.json();
}

// Get move job status
async function getJob(jobId: string): Promise<MoveJob> {
  const r = await fetch(`${API}/moves/jobs/${jobId}`);
  if (!r.ok) throw new Error("Failed to load job");
  return r.json();
}

// Selection mode type
type SelectionMode =
  | { type: "explicit"; ids: Set<number> }
  | { type: "all"; deselectedIds: Set<number> };

// CompanyTable component
const CompanyTable = (props: { selectedCollectionId: string }) => {
  // State variables
  const [response, setResponse] = useState<ICompany[]>([]);
  const [total, setTotal] = useState<number>();
  const [offset, setOffset] = useState<number>(0);
  const [pageSize, setPageSize] = useState(25);

  const [mode, setMode] = useState<SelectionMode>({
    type: "explicit",
    ids: new Set(),
  });
  const pageIds = useMemo(() => response.map((r) => r.id), [response]);

  const [collections, setCollections] = useState<CollectionMeta[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetListId, setTargetListId] = useState<string>("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<MoveJob | null>(null);

  // Fetch companies when collection ID, offset, or page size changes
  useEffect(() => {
    getCollectionsById(props.selectedCollectionId, offset, pageSize).then(
      (newResponse) => {
        setResponse(newResponse.companies);
        setTotal(newResponse.total);
      }
    );
  }, [props.selectedCollectionId, offset, pageSize]);

  // Reset selection mode when collection ID changes
  useEffect(() => {
    setOffset(0);
    setMode({ type: "explicit", ids: new Set() });
  }, [props.selectedCollectionId]);

  // Fetch collections metadata on mount
  useEffect(() => {
    fetchCollections().then(setCollections).catch(() => setCollections([]));
  }, []);

  // Determine source list based on selected collection ID
  const sourceList = useMemo(
    () => collections.find(c => c.id === props.selectedCollectionId),
    [collections, props.selectedCollectionId]
  );

  // Determine allowed target lists for moving companies
  const allowedTargets = useMemo(() => {
    if (!sourceList) return [];
    const name = sourceList.collection_name;

    if (name === "My List") {
      return collections.filter(c => c.collection_name !== "My List");
    }
    if (name === "Liked Companies List") {
      return collections.filter(c => c.collection_name === "Companies to Ignore List");
    }
    if (name === "Companies to Ignore List") {
      return collections.filter(c => c.collection_name === "Liked Companies List");
    }

    return collections.filter(
      c => c.collection_name !== "My List" && c.id !== sourceList.id
    );
  }, [collections, sourceList]);

  // Compute row selection model based on selection mode
  const rowSelectionModel: GridRowSelectionModel = useMemo(() => {
    if (mode.type === "all") {
      return pageIds.filter((id) => !mode.deselectedIds.has(id));
    }
    return pageIds.filter((id) => mode.ids.has(id));
  }, [mode, pageIds]);

  // Handle changes in row selection model
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

  // Compute selected count based on selection mode
  const selectedCount = useMemo(
    () =>
      mode.type === "all"
        ? (total ?? 0) - mode.deselectedIds.size
        : mode.ids.size,
    [mode, total]
  );

  // Selection mode handlers
  const selectAllAcrossResults = () =>
    setMode({ type: "all", deselectedIds: new Set() });
  const clearSelection = () => setMode({ type: "explicit", ids: new Set() });
  const [progressHintTotal, setProgressHintTotal] = useState<number | null>(null);

  // Begin move operation
  async function beginMove() {
    if (!targetListId) return;

    setMoveOpen(false);

    // Determine total selected for progress hint
    const totalSelectedNow =
      mode.type === "all"
        ? (total ?? 0) - (mode.deselectedIds?.size ?? 0)
        : mode.ids.size;
    setProgressHintTotal(totalSelectedNow);

    // Prepare payload based on selection mode
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

    // Start move job
    const j = await startMove(payload);
    setJobId(j.jobId);
    setJob(j);
  }

  // Poll for job status updates
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
      }
      if (!stop) setTimeout(tick, 10);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [jobId]);

  // Render component
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

      {/* Selection controls */}
      <Box
        sx={{
          mt: 1.5,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          width: "100%",
        }}
      >
        {/* Selection buttons and count */}
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Button
            size="small"
            variant={mode.type === "all" ? "contained" : "outlined"}
            onClick={() => {
              if (mode.type === "all") {
                clearSelection();
              } else {
                selectAllAcrossResults();
              }
            }}
            sx={{
              color: mode.type === "all" ? "#fff" : "#f97415",
              backgroundColor: mode.type === "all" ? "#f97415" : "transparent",
              borderColor: "#f97415",
              minWidth: 120,
              textTransform: "none",
              boxShadow: "none",
              outline: "none",
              "&:hover": {
                backgroundColor:
                  mode.type === "all" ? "#f97415" : "rgba(249,116,21,0.08)",
                borderColor: "#f97415",
              },
              "&:focus": {
                outline: "none",
                boxShadow: "none",
              },
              "&.Mui-focusVisible": {
                outline: "none",
                boxShadow: "none",
              },
              "&:active": {
                backgroundColor: "#fbbb74",
                borderColor: "#fbbb74",
                color: "#fff",
                outline: "none",
                boxShadow: "none",
              },
            }}
          >
            {mode.type === "all" ? "DESELECT ALL" : "SELECT ALL"}
          </Button>

          {/* Clear selection button */}
          <Button
            size="small"
            onClick={clearSelection}
            sx={{
              color: "#f97415",
              "&:hover": { backgroundColor: "rgba(249,116,21,0.08)" },
              "&:focus": { outline: "none", boxShadow: "none" },
            }}>
            CLEAR
          </Button>

          {/* Selected count display */}
          <Typography variant="body2">
            {selectedCount} selected{mode.type === "all" ? " (all pages)" : ""}
          </Typography>
        </Box>

        {/* Move button */}
        <Box>
          <Button
            size="small"
            variant="contained"
            disabled={selectedCount === 0}
            onClick={() => {
              setTargetListId("");
              setMoveOpen(true);
            }}
            sx={{
              backgroundColor: "#f97415",
              "&:hover": { backgroundColor: "#f97415" },
              "&:active": { backgroundColor: "#fbbb74" },
              "&:focus": {
                outline: "none",
                boxShadow: "none",
              },
              "&.Mui-focusVisible": {
                outline: "none",
                boxShadow: "none",
              },
            }}
          >
            Move selected to another list
          </Button>
        </Box>
      </Box>

      {/* Move dialog */}
      <Dialog
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        PaperProps={{
          sx: {
            borderRadius: 2,
            border: "1px solid #888",
          },
        }}
      >
        <DialogTitle
          sx={{
            color: "#fff",
            fontWeight: 600,
            fontSize: "1.1rem",
          }}
        >
          Move selected to...
        </DialogTitle>

        {/* List selection dropdown */}
        <DialogContent sx={{ minWidth: 320, pt: 2 }}>
          <Select
            fullWidth
            value={targetListId}
            displayEmpty
            onChange={(e) => setTargetListId(String(e.target.value))}
            sx={{
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor: "#888",
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: "#f97415",
              },
              "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                borderColor: "#f97415",
              },
              "& .MuiSelect-icon": {
                color: "#f97415",
              },
            }}
            MenuProps={{
              PaperProps: {
                sx: {
                  "& .MuiMenuItem-root.Mui-selected": {
                    backgroundColor: "rgba(249,116,21,0.15)",
                    color: "#f97415",
                  },
                  "& .MuiMenuItem-root:hover": {
                    backgroundColor: "rgba(249,116,21,0.08)",
                  },
                },
              },
            }}
          >
            <MenuItem value="" disabled>
              Choose a list
            </MenuItem>
            {allowedTargets.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.collection_name}
              </MenuItem>
            ))}
          </Select>

          {/* Background operation note */}
          <Typography
            variant="caption"
            sx={{ mt: 1, display: "block", color: "#888" }}
          >
            This operation runs in the background. You can keep browsing companies.
          </Typography>
        </DialogContent>

        {/* Action buttons */}
        <DialogActions sx={{ pr: 2, pb: 1 }}>
          <Button
            onClick={() => setMoveOpen(false)}
            sx={{
              color: "#f97415",
              "&:hover": { backgroundColor: "rgba(249,116,21,0.08)" },
              "&:focus": { outline: "none", boxShadow: "none" },
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!targetListId}
            variant="contained"
            onClick={beginMove}
            sx={{
              backgroundColor: "#f97415",
              color: "#fff",
              "&:hover": { backgroundColor: "#f97415" },
              "&:focus": { outline: "none", boxShadow: "none" },
              "&.Mui-disabled": {
                color: "#888",
              },
            }}
          >
            Move
          </Button>
        </DialogActions>
      </Dialog>

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
              {job?.status === "completed" ? (() => {
                  const totalMoved =
                    ((progressHintTotal ?? job?.total) ?? 0) - (job?.duplicates ?? 0);
                  const dups = job?.duplicates ?? 0;

                  // Singular vs plural message for duplicates
                  const duplicateMsg =
                    dups === 0
                      ? ""
                      : dups === 1
                      ? " (1 item was not moved since it was already in the target list)"
                      : ` (${dups} items were not moved since they were already in the target list)`;

                  return `Completed — moved ${totalMoved} item${totalMoved === 1 ? "" : "s"}${duplicateMsg}`;
                })()
              : job?.status === "failed"
              ? "Failed"
              : `In progress... ${job?.moved ?? 0} out of ${(progressHintTotal ?? job?.total) ?? 0} moved`}
            </span>
          </Box>
          <Box
            sx={{
              height: 6,
              width: `${job?.total ? Math.min(100, Math.round((job.moved / job.total) * 100)) : 0
                }%`,
              transition: "width .3s ease",
              bgcolor:
                job?.status === "completed" ? "#f97415"
                  : job?.status === "failed" ? "#888"
                    : "#fbbb74",
            }}
          />
        </Box>
      )}
    </>
  );
};

export default CompanyTable;

// Fun facts component
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

  // Cycle through facts every 3 seconds
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % facts.length), 3000);
    return () => clearInterval(id);
  }, []);

  // Render fun facts panel
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
          height: 96,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          bgcolor: "#fff",
        }}
      >
        <Typography
          sx={{
            mb: 0.5,
            color: "#f97415",
            fontWeight: 700,
            fontSize: "1.5rem",
          }}
        >
          Fun facts while you wait!
        </Typography>
        <Typography
          sx={{
            color: "#000",
            fontSize: "1.1rem",
            fontWeight: 500,
            opacity: 0.95,
          }}
        >
          {facts[i]}
        </Typography>
      </Box>
    </Box>
  );
}