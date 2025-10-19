# Harmonic Fullstack Jam

## Overview
This document describes the frontend and backend updates made to enable improved list management, batch moving of companies between lists, and UX enhancements such as progress indicators and fun facts displaying during lengthy operations.

Quick demo showing feature functionality: https://youtu.be/UFVPYkRJOZA

---

## Frontend Enhancements
These edits all took place in `frontend/src/components/CompanyTable.tsx`.

### 1. Cross-Page Selection
Users can now select individual companies or use the new **“Select all”** feature to select every item across all pages of the company table.

### 2. Clear Selection
A **“Clear”** button was added to reset all selections instantly.

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
- Blue: active progress  
- Green: completed  
- Red: failed  
When a job completes successfully, a message displays the total number of items moved and the number of duplicates skipped.

If the job fails, a failure message is shown instead.

Both messages automatically disappear after 8 seconds.

### 6. Fun Facts Panel
A  **“Fun facts”** box appears above the progress text/bar.  

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

**Note:** In `backend/Dockerfile`, I added the `--no-root` flag to the `RUN` command to resolve errors that occurred when running the application. Other than this and the addition of  `backend/backend/routes/moves.py`, the deployment process and file structure remain unchanged.