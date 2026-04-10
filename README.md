# pySAR Frontend

<p align="center">
  <img src="https://raw.githubusercontent.com/amckenna41/pySAR/master/images/pySAR.png" alt="pySAR logo" width="500" />
</p>

Interactive React + FastAPI interface for the [pySAR](https://github.com/amckenna41/pySAR) protein Sequence-Activity Relationship toolkit.


## Features

- **Dataset upload** — drag-and-drop `.txt` / `.csv` / `.tsv` datasets with live preview, column auto-detection, and sequence-length statistics
- **Parameter configuration** — full GUI for Model, Descriptor, and DSP settings mapped directly to `pySAR` config options
- **Encoding wizard** — choose from AAI, Descriptor, or combined AAI+Descriptor strategies with all tuning knobs exposed
- **Live job monitoring** — real-time log stream and status tracking while encoding runs in the background
- **Results dashboard** — sortable/filterable results table, CSV export, and Recharts visualisations (R² bar chart, histogram, category breakdown, metric comparison)
- **Config history** — save and reload configurations from browser localStorage
- **Dark mode** — toggle in the sidebar

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Python | ≥ 3.8 |
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| pySAR installed in your Python env | see parent `requirements.txt` |

## Installation

### 1. Backend

```bash
cd pySAR_frontend/backend
pip install -r requirements.txt
```

### 2. Frontend

```bash
cd pySAR_frontend/frontend
npm install
```

## Running

### Option A — single command (recommended)

```bash
cd pySAR_frontend
chmod +x start.sh
./start.sh
```

This starts both the API server (port 8000) and the Vite dev server (port 5173). Open [http://localhost:5173](http://localhost:5173).

### Option B — manually

**Terminal 1 — backend**
```bash
cd pySAR_frontend
uvicorn backend.main:app --reload --port 8000
```

**Terminal 2 — frontend**
```bash
cd pySAR_frontend/frontend
npm run dev
```

## Architecture

```
pySAR_frontend/
├── backend/
│   ├── main.py                      FastAPI app — upload, encoding jobs, results
│   └── requirements.txt
└── frontend/                        Vite + React 18
    └── src/
        ├── store/
        │   └── appStore.js           Zustand global state
        ├── utils/
        │   ├── api.js                Axios API client
        │   └── errorHandling.js      Error formatting helpers
        ├── components/               Shared / reusable components
        │   ├── AaiExplorer.jsx       AAIndex1 catalogue browser with category filter
        │   ├── ConfigPreview.jsx     Live JSON config preview panel
        │   ├── DatasetPreview.jsx    Dataset table with stats and validation warnings
        │   ├── DescriptorConfig.jsx  Descriptor selection and metaparameter form
        │   ├── DescriptorExplorer.jsx Descriptor catalogue browser with heatmap
        │   ├── DSPConfig.jsx         DSP (signal processing) parameters form
        │   ├── ErrorBoundary.jsx     React error boundary with retry
        │   ├── HowToModal.jsx        Four-step tutorial modal
        │   ├── JobsPanel.jsx         Job history with search, filter, sort, and CSV export
        │   ├── LandingPage.jsx       Animated homepage
        │   ├── Layout.jsx            App shell — sidebar, dark mode, nav
        │   ├── ModelConfig.jsx       ML model selection and hyperparameter form
        │   ├── ModelExplorer.jsx     Model reference browser
        │   ├── ResultsCharts.jsx     R² charts, histogram, and metric comparison
        │   └── Skeleton.jsx          Shimmer loading placeholders
        └── steps/                    Wizard step pages
            ├── Step1Upload.jsx
            ├── Step2Configure.jsx
            ├── Step3Encode.jsx
            └── Step4Results.jsx
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/aai-indices` | Return all AAI1 record codes for typeahead |
| `GET` | `/api/aai-indices-full` | Return all AAI1 records with metadata (title, category, references) |
| `GET` | `/api/descriptors` | Return the full descriptor catalogue with metadata |
| `POST` | `/api/upload` | Upload a dataset file, returns preview + column guesses |
| `POST` | `/api/upload-descriptors` | Upload a pre-calculated descriptors CSV |
| `GET` | `/api/dataset/{file_id}/rows` | Return all rows for an uploaded dataset |
| `GET` | `/api/example-datasets` | List built-in example datasets with previews |
| `POST` | `/api/example-dataset/{name}` | Load a built-in example dataset (copies to upload dir) |
| `POST` | `/api/dataset/{file_id}/deduplicate` | Remove duplicate sequences, returns new file_id |
| `POST` | `/api/dataset/{file_id}/fix-missing-sequences` | Drop rows with null or empty sequences |
| `POST` | `/api/dataset/{file_id}/fix-missing-activity` | Remediate missing activity values (mean/median/remove) |
| `POST` | `/api/dataset/{file_id}/fix-outliers` | Remediate outlier activity values (winsorize/mean/remove) |
| `POST` | `/api/encode` | Submit an encoding job, returns `job_id` |
| `POST` | `/api/jobs/{job_id}/cancel` | Request cancellation of a running job |
| `GET` | `/api/jobs/{job_id}` | Return current status, log, and results for a job |
| `GET` | `/api/jobs` | List all jobs (metadata only, no results payload) |
| `DELETE` | `/api/jobs/{job_id}` | Remove a job from the registry |

## Data Format

Datasets must contain at least two columns: one holding protein sequences and one holding the numeric activity/property values. All standard formats are accepted:

| Format | Extension | Delimiter |
|--------|-----------|-----------|
| Comma-separated | `.csv` | `,` |
| Tab-separated | `.tsv` | `\t` |
| Space/whitespace-separated | `.txt` | whitespace |

**Sequence column** — must contain single-letter amino acid codes using the standard 20-residue alphabet (`ACDEFGHIKLMNPQRSTVWY`). Mixed-case is accepted; non-standard characters will trigger a validation warning.

**Activity column** — must be numeric. The column name can be anything; the app will auto-detect it and highlight its statistical distribution.

Example (CSV):

```
sequence,T50
MTIKEMPQPKTFGELKNLPLL...,55.0
MTIKEMPQPKTFGELKNLPLL...,61.3
```

The app auto-detects the most likely sequence and activity columns on upload and flags any missing values, duplicates, or outliers before encoding begins.

---

## Example Datasets

Four built-in datasets are available directly in the app (no upload needed) via the **Load Example** button on the upload screen:

| Dataset | Property | Sequences | Source |
|---------|----------|-----------|--------|
| **Thermostability** | Enzyme T50 (°C) — temperature at which 50% activity is lost | 260 | Protein engineering |
| **Absorption** | UV peak absorption wavelength (nm) of fluorescent protein variants | 80 | Spectroscopy |
| **Enantioselectivity** | Enantioselectivity (E-value) of lipase variants | 151 | Directed evolution |
| **Localization** | Subcellular localisation score | 253 | Proteomics |

These datasets are stored in the `example_datasets/` directory and are also used in the parent [pySAR](https://github.com/amckenna41/pySAR) library's test suite.

---

## Encoding Strategies

Choose a strategy on **Step 3 — Encode**. Each strategy produces a different feature matrix that is then used to train the selected regression model.

### AAI (AAIndex1)
Encodes each sequence using one or more physicochemical property scales from the [AAIndex1](https://www.genome.jp/aaindex/) database (566 indices). Each residue is replaced by its numerical property value, and the resulting signal is optionally processed with DSP filters (e.g. Savitzky-Golay smoothing, FFT) before a summary statistic reduces it to a fixed-length vector. Best when the property of interest is related to a known physicochemical signal.

### Descriptor
Encodes sequences using sequence-derived feature descriptors computed by the [protpy](https://github.com/amckenna41/protpy) library. Descriptors range from simple composition vectors (amino acid/dipeptide/tripeptide frequencies) to autocorrelation measures, CTD features, pseudo-composition, and more. No DSP step. Best when a broad, composition-based feature set is preferred.

### AAI + Descriptor (combined)
Concatenates the AAI-encoded feature vector with a descriptor feature vector for each sequence, producing a richer combined representation. Useful for exploring whether combining physicochemical signals with compositional features improves model performance.

---

## Deployment

The backend depends on `numpy`, `scipy`, `pandas`, `scikit-learn`, and `pySAR`. These scientific Python packages exceed Vercel's 250 MB serverless function limit and cannot run as a single serverless function. The recommended approach is a **split deployment**: static frontend on Vercel, containerised backend on a separate platform.

### Frontend — Vercel

`vercel.json` is pre-configured to build and serve only the static frontend:

1. Fork or push this repository to GitHub.
2. Import the project in the [Vercel dashboard](https://vercel.com/new).
3. Vercel will auto-detect `vercel.json`:
   - **Build command**: `cd frontend && npm install && npm run build`
   - **Output directory**: `frontend/dist`
4. Deploy. The frontend will be live at your Vercel URL.
5. Set the `VITE_API_URL` environment variable in Vercel to point to your deployed backend (e.g. `https://your-api.railway.app`).

### Backend — Docker (Railway / Render / Fly.io)

A `Dockerfile` is included at the repo root. Any platform that supports Docker containers will work. Railway is the simplest option:

**Railway:**
1. Create a new project in [Railway](https://railway.app) and connect your GitHub repo.
2. Railway auto-detects the `Dockerfile` and builds it.
3. Set the `PORT` environment variable to `8000` if not inferred automatically.
4. Copy the public backend URL and set it as `VITE_API_URL` in your Vercel project settings.

**Render:**
1. Create a new **Web Service** in [Render](https://render.com), connect your repo.
2. Set **Environment** → `Docker`, **Port** → `8000`.

**Fly.io:**
```bash
fly launch --dockerfile Dockerfile --port 8000
fly deploy
```

### Pointing the frontend at the backend

In the Vercel project dashboard → **Settings → Environment Variables**, add:

```
VITE_API_URL=https://your-backend-url.railway.app
```

Then update [frontend/src/utils/api.js](frontend/src/utils/api.js) to use this variable as the base URL (it currently defaults to `http://localhost:8000` which works fine locally).

> **Running everything locally?** Use `./start.sh` as described in [Running](#running) — no Docker or split deployment needed.

---

## Configuration Mapping

The GUI exposes all parameters documented in [CONFIG.md](CONFIG.md). A live JSON preview of the generated config is available on the **Configure → Config Preview** tab.

[Back to top](#TOP)