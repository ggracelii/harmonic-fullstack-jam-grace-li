# Harmonic Fullstack Jam

## Overview
This document describes the frontend and backend updates made to enable improved list management, batch moving of companies between lists, and UX enhancements such as progress indicators and fun facts displaying during lengthy operations.

Video demo showing feature functionality: https://youtu.be/UFVPYkRJOZA

---

## Frontend Enhancements
These edits all took place in `frontend/src/components/CompanyTable.tsx`.

### 1. Cross-Page Selection
Users can now select individual companies or use the new **Select all** feature to select every item across all pages of the company table.

### 2. Clear Selection
A **Clear** button was added to reset all selections instantly.

### 3. Move Modal
Clicking **“Move selected to another list”** opens a modal window that lists only eligible destination lists.  
The default value is blank, ensuring users must intentionally pick a valid list.

### 4. Filtered Move Rules
The modal filters which lists can be moved to based on the current list:
- Users can move companies from **My List** to either of the other two lists.  
- Users can move companies from **Liked Companies List** and **Companies To Ignore List** to each other only.
- Users cannot move companies from either **Liked Companies List** and **Companies To Ignore List** back to **My List**, which already contains all companies.

### 5. Progress Bar
A  **progress bar** shows the status of each background move job in real time.
- Light orange: active progress  
- Dark orange: completed  
- Gray: failed  
When a job completes successfully, a message displays the total number of items moved and the number of duplicates skipped.

If the job fails, a failure message is shown instead.

Both messages automatically disappear after 8 seconds.

### 6. Fun Facts Panel
A  **Fun Facts** box appears above the progress text/bar.  

It cycles through short rotating fun facts every 3 seconds during the move operation to keep the user entertained.

### 7. Color Scheme
Kept the orange color scheme consistent across all elements to maintain a cohesive aesthetic.

---

## Backend Enhancements
These edits all took place in `backend/main.py` and `backend/backend/routes/moves.py`.

### 1. Duplicate Handling
The backend now counts duplicates, allowing the app to report exactly how many records were **skipped** because they already existed in the target list.

### 2. Job Tracking
Each background move task stores its progress in a global in-memory job dictionary.

### 3. Job Fields
Each job tracks:
- `moved`
- `total`
- `duplicates`
- `status`
- `startedAt` / `finishedAt`
- `message` (error info if any)

### 4. Failure Reporting
If a job fails, the backend saves the exception string in `message`, which is then shown in the frontend progress toast.

---

## Reflection

In designing and implementing this feature, my goal was to create an intuitive, responsive, and non-blocking user experience for managing company collections. I wanted users to be able to select companies and move them between lists seamlessly without disrupting their workflow. To achieve this, I built a cross-page selection model that supports "Select All" functionality and a background job system that runs asynchronously, with real-time progress updates displayed through a dynamic progress bar and a rotating "Fun Facts" panel. The color scheme was intentionally designed to match the Harmonic brand aesthetic, ensuring a cohesive and visually polished experience that feels integrated with the rest of the platform.

From a technical perspective, the implementation balances simplicity, scalability, and user experience. The backend uses asynchronous job execution with periodic polling for status updates, and PostgreSQL’s ON CONFLICT DO NOTHING upserts to ensure idempotency and prevent duplicate entries. While I could have optimized for raw performance by using larger batch sizes (e.g., moving several hundred items per update), I chose smaller batches to enable a more dynamic and visually engaging progress bar. The continuous movement of the progress indicator reinforces user trust that the system is actively working, which I believe is more valuable from a UX standpoint. On the frontend, I focused on maintaining responsiveness and clear feedback, allowing users to continue browsing and interacting even while background operations run.

If I were to continue developing this feature, I would focus on two main enhancements:
1. Adding a cancel job capability so users can interrupt long-running operations
2. Introducing a queueing and throttling mechanism for job scheduling to handle concurrent moves gracefully. 

Overall, this project reinforced my belief that strong UX design (clear visual feedback, responsive controls, and details like the Fun Facts panel) can make even complex backend processes feel smooth, engaging, and human-centered.

**Note:** In `backend/Dockerfile`, I added the `--no-root` flag to the `RUN` command to resolve errors that occurred when running the application. Other than this and the addition of  `backend/backend/routes/moves.py`, the deployment process and file structure remain unchanged.