# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- Example dataset listing and loading no longer require a backend API call — the four built-in datasets are served as static files from `frontend/public/example_datasets/` (Vercel CDN). Loading a sample fetches the static file and parses it entirely client-side using a new `parseDataset.js` utility, returning the same response shape as the backend (columns, preview, stats, sequence validation, duplicate/missing/outlier detection).
- Removed the `getExampleDatasets` API call and its `useEffect` from Step1Upload; the list is now initialised synchronously from a hardcoded constant in `api.js`.
- Step 3 (Encode) performs a lazy upload of the example dataset file to the backend before submitting an encode job when `file_path` is null — this keeps Step 1 fully client-side while still allowing encoding when a backend is available. Clear error messaging shown if the backend is unreachable.

---

## [1.0.0] — 2026-04-10

### Added

#### Application
- Four-step encoding wizard: Upload → Configure → Encode → Results
- Landing page with animated hero, feature highlights, encoding strategy overview, and built-in dataset showcase
- Dark mode toggle (persisted across sessions)
- Sidebar navigation with mobile-responsive overlay and collapsible layout
- "How To" tutorial modal with four-step walkthrough
- Config history — save and reload named configurations via browser `localStorage`

#### Step 1 — Upload
- Drag-and-drop dataset upload supporting `.txt`, `.csv`, and `.tsv` formats
- Load example dataset directly from four built-in datasets (thermostability, absorption, enantioselectivity, localization)
- Live dataset preview table with sequence and activity column auto-detection
- Sequence validation — flags invalid amino acids, empty sequences, and length statistics
- Activity distribution histogram with skewness and kurtosis stats
- One-click remediation for duplicates, missing sequences, missing activity values (mean / median / remove), and outliers (winsorize / mean / remove)
- Pre-calculated descriptors CSV upload as an alternative to on-the-fly encoding

#### Step 2 — Configure
- Model configuration panel — algorithm selection (Ridge, Lasso, ElasticNet, SVR, PLS, Random Forest, Gradient Boosting, KNN) with hyperparameter controls
- Descriptor configuration panel — full protpy descriptor catalogue with metaparameter forms per descriptor
- DSP configuration panel — Savitzky-Golay, median, FIR, and FFT filter options with parameter validation
- Live JSON config preview tab
- AAIndex1 explorer — searchable/filterable catalogue of all 566 AAIndex1 physicochemical indices with category filter
- Descriptor explorer — interactive catalogue with per-descriptor heatmap visualisation

#### Step 3 — Encode
- Strategy selection: AAI (AAIndex1), Descriptor, or combined AAI+Descriptor
- Encoding job submission with background threading
- Real-time log streaming and progress bar via polling
- Cancel running job
- Hard-block UI prevents re-submission while a job is running

#### Step 4 — Results
- Sortable and filterable results table (by R², RMSE, MAE, Pearson r)
- R² bar chart with colour-coded performance bands
- R² distribution histogram
- Category/descriptor-group breakdown chart
- Side-by-side metric comparison chart (R², RMSE, MAE, Pearson r)
- Export results as CSV, Excel, or JSON
- "Use this model" — pre-fills Step 3 with the selected index/descriptor for re-run

#### Job Management
- Jobs panel — full job history with search, filter by status, sort, and bulk-delete
- Per-job status badges (pending / running / complete / failed / cancelled)
- Job result CSV export from history panel

#### Infrastructure
- FastAPI backend with 18 REST endpoints
- Zustand global state management
- Axios API client with exponential-backoff retry and request timeout
- `formatApiError` / `toastApiError` error-handling helpers
- React `ErrorBoundary` with retry for all major panels
- Shimmer skeleton loading placeholders throughout
- Split deployment architecture — frontend served as static site via Vercel, backend containerised via Docker for Railway / Render / Fly.io
- `Dockerfile` multi-stage build (builder + slim runtime) for backend
- `.dockerignore` to exclude frontend assets, virtual environments, and build artefacts from the Docker build context
- `vercel.json` configured for frontend-only static output with explicit `installCommand` to prevent Python runtime detection
- `.vercelignore` to exclude `.venv`, `requirements.txt`, `api/`, `backend/`, `outputs/`, and other non-frontend paths from Vercel deployment
- Vite `manualChunks` configuration to split the JS bundle into `charts` (recharts), `xlsx`, and `utils` chunks — reducing largest single chunk from 1.2 MB to 545 kB
- `start.sh` convenience script to launch backend and frontend concurrently
