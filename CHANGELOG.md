# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **Progress connector in sidebar nav** — a thin vertical line now connects adjacent step badges in the sidebar, coloured green when the step is completed and gray otherwise, giving a clear visual trail through the workflow.
- **Always-visible mobile bottom tab bar** — on small screens a fixed bottom navigation bar shows the step icon and number at all times, replacing the "nothing visible until hamburger tapped" behaviour. The full sidebar still slides in from the hamburger button.
- **Upload skeleton** — while a file is uploading or processing, an animated pulse skeleton (column picker, stats grid, preview table rows) occupies the post-upload area so the layout does not jump when the real content arrives.
- **AAI chip collapse** — when more than 5 indices are selected the chip row collapses to the first 5 with a `+N more` badge; clicking expands all chips and a `▲ collapse` button contracts them again.

### Changed
- **Toasts moved to `bottom-center`** — `react-hot-toast` notifications now appear at the bottom-centre of the viewport instead of the top-right, reducing interference with the sidebar and header.

### Fixed
- **"Dataset upload failed" error when running with frontend only** — `handleRun` in `Step3Encode.jsx` previously only blocked when `backendAvailable === false`, so clicking Run before the 4-second health-check resolved (while `backendOnline` was still `null`) bypassed the guard and attempted a lazy upload against an offline backend. The guard is now `!== true`, which catches both `null` (in-flight) and `false` (confirmed offline), with distinct toast messages for each state.
- **`@vitest/coverage-v8` version bump** — updated `vitest` and `@vitest/coverage-v8` in `frontend/package.json` from `^2.2.5` to `^3.0.0`. Version `2.2.5` was never published (the `2.x` line only reached `2.1.9`), causing Vercel builds to fail with `npm error notarget No matching version found`.

### Changed
- **Automated Cloud Run → Vercel URL sync** — `cloudbuild.yaml` now has a post-deploy step that automatically propagates the Cloud Run service URL to Vercel as the `VITE_API_URL` environment variable and triggers a Vercel production redeploy via a deploy hook. This eliminates the manual step of copying the Cloud Run URL and pasting it into the Vercel dashboard after each backend deployment. Two secrets (`vercel-token`, `vercel-deploy-hook`) must be stored in GCP Secret Manager and the `_VERCEL_PROJECT_ID` substitution variable set in the Cloud Build trigger.

### Added
- **`use_cv` / `cv_folds` wired end-to-end** — cross-validation settings configured in the Model tab are now included in the encode request payload and forwarded to pySAR's model config section via `_build_config`. `EncodeRequest` has two new optional fields: `use_cv: bool = False` and `cv_folds: int = 5`.
- **`TRUST_PROXY` environment variable** — `_get_client_ip` now only trusts the `X-Forwarded-For` header when `TRUST_PROXY=true` is set in the environment. Previously the header was unconditionally trusted, allowing any client to forge an IP and bypass per-IP rate limiting. Cloud Run / Fly.io deployments should set `TRUST_PROXY=true`; direct-exposure instances leave it unset.
- **`_validate_file_id` helper** — a new module-level helper in `backend/main.py` validates that `file_id` path parameters match the UUID4 format before being used in glob patterns. Applied to all five dataset endpoints (`/rows`, `/deduplicate`, `/fix-missing-sequences`, `/fix-missing-activity`, `/fix-outliers`). Prevents glob metacharacter injection (`*`, `?`, `[`) from enumerating files in the upload directory.
- **Axios retry interceptor** — the API client in `api.js` now retries up to 3 times with exponential backoff (1 s → 2 s → 4 s) on network errors or 502/503 responses for GET requests. This improves resilience against transient backend failures and cold-start timeouts.
- **Upload `timeout: 0`** — `uploadDataset` and `uploadDescriptorsCSV` in `api.js` now pass `timeout: 0` (unlimited) to override the global 30 s axios timeout. Large files near the 10 MB limit over slow connections previously caused a `ECONNABORTED` error before the server could respond.
- **Upload "Processing…" phase** — after the upload progress bar reaches 100 % (all bytes sent), the overlay in `Step1Upload.jsx` now switches to a pulsing indigo bar and "Processing…" label while waiting for the server to parse and analyse the file, making it clear that work is still in progress.
- **`Retry-After` countdown in 429 error messages** — `formatApiError` in `errorHandling.js` now reads the `Retry-After` response header when a 429 is received and appends "(retry in Xs)" to the message so users know when they can try again.

### Fixed
- **`VALID_ALGORITHMS` mismatch between frontend and backend** — `configValidation.js` was missing `bagging`, `adaboost`, `gpr`, and `linear`, causing false validation warnings when importing or running configs that used these algorithms (all four are accepted by the backend and offered in `ModelConfig.jsx`). The list is now in sync with `_VALID_ALGORITHMS` in `backend/main.py`.
- **Stats table used population std dev instead of sample std dev** — the summary stats table in `Step4Results.jsx` divided by `vals.length` (population) instead of `vals.length - 1` (sample). Fixed to use the sample standard deviation with a guard for single-element arrays.
- **Activity column guess could return a non-numeric column** — `_build_dataset_response` in `backend/main.py` now prefers numeric columns when auto-detecting the activity column. The candidate list excludes the guessed sequence column and known ID-like names; numeric columns are tried first with a fallback to the first non-excluded column.
- **Model count estimate used wrong default descriptor count** — `estimateModels` in `encoding.js` hardcoded `12` as the fallback descriptor count when none are selected, while the backend uses `33`. The function now accepts an optional `allDescCount` parameter (default `33`); `Step3Encode.jsx` passes `allDescriptorKeys.length` (the live catalogue count fetched from `/api/descriptors`) so the pre-submit estimate matches the backend.

### Added
- **pySAR output CSV files no longer written to project root** — pySAR's encoding methods automatically write result CSVs to an `outputs/` directory relative to the process working directory. The encoding subprocess now `os.chdir`s to a throwaway `tempfile.mkdtemp()` directory before running any encoding, so those files are written to the system temp directory instead of the repo root. The temp directory is deleted in the subprocess `finally` block. The parent server process working directory is unaffected. Results are delivered exclusively via the in-memory subprocess queue and are only accessible through the frontend download buttons on the Results page.
- **"Clear all" button for AAI index selection** — an × button now appears to the right of the AAI search/chip bar whenever at least one index is selected. Clicking it calls `setEncoding({ aai_indices: [] })`, clearing all selections in one click without having to remove each chip individually.
- **Dataset removal resets all parameters** — removing the uploaded dataset (the red × on the dropzone in Step 1) now also resets the Configure and Encode & Train parameters to their defaults. `clearDataset` in `appStore.js` now atomically sets `dataset → null`, `step → 1`, `config → DEFAULT_CONFIG`, and `encoding → DEFAULT_ENCODING`.

### Fixed
- **422 on "Start Encoding" with example datasets after page reload** — Zustand `persist` serialises the Zustand store to `localStorage` via `JSON.stringify`, which converts a `File` object to `{}`. After a reload, `dataset._pendingFile` was `{}` (truthy) rather than `undefined`, so `uploadDataset({})` fired and the backend returned 422. Fixed by: (a) adding `_pendingFileText` (raw CSV string) and `_pendingFileName` to `parseDataset.js` return value — both are plain strings that survive serialisation; (b) stripping `_pendingFile` from the persisted dataset in `appStore.js` `partialize`; (c) reconstructing the `File` from `_pendingFileText`/`_pendingFileName` via an `instanceof File` guard in `handleRun` (Step 3) and `ensureUploaded` (Step 1).
- **AAI search placeholder text clipped** — the "Type to search indices…" placeholder was cut off at the trailing 's' because `min-w-[140px]` was too narrow for the monospace font. Increased to `min-w-[190px]`.
- **Max Models placeholder text removed** — the "unlimited" placeholder in the Max Models input was removed to reduce visual clutter.
- **`extratrees` algorithm support** — `ExtraTreesRegressor` (`extratrees`) is now accepted by the backend `_VALID_ALGORITHMS` validator and by the frontend `VALID_ALGORITHMS` list in `configValidation.js`. It was already wired up in the UI (`ModelConfig.jsx`, `ModelExplorer.jsx`) but previously rejected with a 422 at submission.
- **macOS SIGSEGV fix (`OBJC_DISABLE_INITIALIZE_FORK_SAFETY`)** — `backend/main.py` now sets `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` via `os.environ.setdefault` on `sys.platform == "darwin"` before defining `_MP_CTX`. This ensures forked encoding subprocesses do not crash with signal 11 (SIGSEGV) due to Apple's Objective-C runtime fork-safety check, regardless of whether the server is started via `start.sh` or `uvicorn` directly.
- **`start.sh` macOS env guard** — `start.sh` exports `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` on macOS as a belt-and-suspenders complement to the in-process `os.environ.setdefault`.
- **Accurate subprocess exit-code error messages** — a new module-level helper `_subprocess_exit_hint(exitcode)` in `backend/main.py` maps OS signal exit codes to specific, actionable messages: exit code `-11` (SIGSEGV) now explains the macOS fork/Objective-C conflict and points to `start.sh`; exit code `-9` (SIGKILL) identifies likely out-of-memory and suggests reducing dataset size; other codes get a generic restart hint. Previously all non-zero exits were incorrectly described as OOM.
- **`snakeToTitle` descriptor display helper** — moved from an inline function in `Step3Encode.jsx` to `frontend/src/utils/encoding.js` (exported). Converts `snake_case` descriptor keys to human-readable Title Case (e.g. `moran_autocorrelation` → `Moran Autocorrelation`). Recognises known acronyms: `CTD`, `AAI`, `PAAC`, `DSP`. Applied to the descriptor checkbox grid, sequence-length warning banner, and lag toast message.
- **12 config templates** — the Live config preview "Templates" panel now includes 12 named starter configurations (up from 4), covering: Quick Benchmark (PLS), Random Forest, DSP + HGBR, k-Fold CV, SVR (RBF kernel), Gradient Boosting, Elastic Net, k-NN Regressor, LASSO (sparse), DSP + Random Forest, HGBR + CV (10-fold), and Strict Holdout (30% test split).
- **"Deselect all" button in Descriptor Encoding** — when one or more descriptor checkboxes are ticked, a "Deselect all" link button appears in the Descriptors section header. Clicking it calls `setEncoding({ selected_descriptors: [] })`, restoring the "use all" default.

### Changed
- **PDF export Descriptor column width** — the results table in the exported PDF now detects the identifier (non-metric) column and allocates it 42% of the content width (capped at 72 mm), preventing long descriptor names from being truncated. Metric columns share the remaining width equally. Truncation is now driven by `jsPDF.splitTextToSize` against the actual column width rather than a fixed 18-character hard cut.
- **Rich encoding job console logging** — `_run_job` in `backend/main.py` now emits a structured start banner (job ID, strategy, algorithm, sequence/activity columns, n_jobs, max_models, sort_by, test split, CV config), dataset dimensions and load time, a preview of selected AAI indices or descriptors, the encoding subprocess PID, and a completion banner with models evaluated, encoding time, total job time, best model name, and all metric values. Failures emit a dedicated error banner with strategy, algorithm, elapsed time, and a full stack trace.
- **Explained Variance in model detail modal rounded to 4 decimal places** — the per-model detail panel previously rendered all numeric values to 6 decimal places. Metric columns (`R2`, `RMSE`, `MSE`, `MAE`, `RPD`, `Explained_Var`) now render to 4 dp, matching the main results table.

### Security
- **Removed dead `resume` / `resume_file` fields from `EncodeRequest`** — both fields were declared in the Pydantic model but never read by `_run_job` or `_build_config`. `resume_file` was a raw string path with no path-traversal guard. Removed from the backend model; the corresponding `useResume` state, payload key, and "Resume previous" UI checkbox have also been removed from `Step3Encode.jsx`.
- **UUID validation on job-ID path parameters** — `get_job`, `cancel_job`, and `delete_job` now call `_validate_file_id(job_id)` before any dict access, consistent with how all dataset endpoints already validate `file_id`. Rejects malformed or metacharacter-containing IDs at the boundary.
- **`.gitignore` broadened to cover all `.env.*` variants** — the pattern `.env` (exact match) was widened to `.env.*` so `frontend/.env.production` and any future environment-specific files are excluded from version control.
- **AAI index chip spacing** — the selected-index chip container in Step 3 uses `gap-1.5` (6 px) instead of `gap-1` (4 px), preventing chips from visually overlapping when multiple indices are selected.
- **`CTD` acronym display** — `snakeToTitle` now maps `Ctd` → `CTD` after title-casing, so `ctd_composition` renders as `CTD Composition` rather than `Ctd Composition`.

### Tests
- **`test_extratrees_in_valid_algorithms`** — new test in `TestBackendConfiguration` asserting `"extratrees"` is present in `_VALID_ALGORITHMS`.
- **`test_objc_fork_safety_env_var_set_on_macos`** — new test in `TestBackendConfiguration` asserting `OBJC_DISABLE_INITIALIZE_FORK_SAFETY == "YES"` in `os.environ` when running on macOS.
- **`TestSubprocessExitHint`** (8 new tests in `test_api_encode.py`) — pure unit tests for `_subprocess_exit_hint()`: SIGSEGV (-11) mentions segfault and macOS Objective-C; SIGKILL (-9) mentions memory but not segfault; other codes include the exit code value; all codes return a string.
- **`test_valid_algorithms_accepted`** updated — `extratrees` added to the spot-check list.
- **`snakeToTitle` tests** (12 new tests in `encoding.test.js`) — verifies snake_case → Title Case conversion, underscore removal, and correct uppercasing of `CTD`, `AAI`, `PAAC`, and `DSP` acronyms.
- **`encoding.test.js` import updated** — `snakeToTitle` imported from `../../utils/encoding` alongside `logLineClass` and `estimateModels`.

### Added
- **Upload file size limit (10 MB)** — both `/api/upload` and `/api/upload-descriptors` now reject files exceeding `_MAX_UPLOAD_BYTES` (default 10 MB, overridable via `MAX_UPLOAD_MB` env var) with HTTP 413 before writing anything to disk. A matching client-side guard in `Step1Upload.jsx` `onDrop` rejects oversized files immediately with a toast and an `setError` message, preventing unnecessary uploads. The dropzone now shows "Max file size: 10 MB" as a hint line.
- **`hgbr` algorithm support** — `HistGradientBoostingRegressor` (`hgbr`) is now accepted by the backend's `_VALID_ALGORITHMS` Pydantic validator and by the frontend's `VALID_ALGORITHMS` list in `configValidation.js`. It was already offered in the UI (`ModelConfig.jsx`, `ModelExplorer.jsx`) but previously rejected with a 422 at submission.
- **Completed-job TTL eviction** — the hourly `_cleanup_upload_dir` sweep now evicts completed/failed/cancelled jobs whose `completed_at` timestamp is older than `_JOB_COMPLETED_TTL_SECS` (default 1800 s / 30 min, overridable via `JOB_COMPLETED_TTL_SECS` env var), regardless of whether the associated upload file still exists. This bounds `JOBS` memory growth for long-running deployments.

### Changed
- **`_run_job` subprocess error messages improved** — when the encoding subprocess exits without returning a result (e.g. OOM or OS signal), the error message now includes the process exit code and actionable guidance (reduce dataset size, lower `max_models`, check available RAM). Worker-side errors forwarded from the subprocess are now prefixed `"Encoding failed: …"` to distinguish them from infrastructure failures.
- **`isPdfCapturing` always reset on PDF export failure** — `handleExportPDF` in `Step4Results.jsx` now uses a `_captureActive` flag and a `finally` block to guarantee `setIsPdfCapturing(false)` and tab restoration even if an error is thrown mid-chart-capture. Previously, an exception after `setIsPdfCapturing(true)` would leave Recharts animations permanently disabled for the session.
- **Lazy-import `xlsx`** — `import * as XLSX from 'xlsx'` has been removed from the top of `Step4Results.jsx`. `handleExportExcel` is now `async` and does `await import('xlsx')` on demand, keeping it out of the initial bundle (~500 KB).
- **`html2canvas` removed from dependencies** — `html2canvas` is no longer used (PDF chart capture switched to native SVG serialisation in a prior release). Removed from `frontend/package.json` `dependencies` (~200 KB gzipped bundle savings).
- **Pydantic 422 array errors handled in frontend** — FastAPI/Pydantic v2 returns `detail` as an array of `{type, loc, msg, input, ctx}` objects for validation errors. `formatApiError` in `errorHandling.js` now joins the `msg` fields of array details into a readable string instead of passing the raw array to `toast.error`, which previously caused React to crash with "Objects are not valid as React children". The same fix is applied to the generic `detail` branch. `Step3Encode.jsx` now imports and uses `toastApiError` for all catch blocks; `Step1Upload.jsx` uses `formatApiError` for its upload catch.

### Tests
- **`TestUploadFileSizeLimit`** (4 new tests in `test_api_upload.py`) — verifies `/api/upload` and `/api/upload-descriptors` return 413 for oversized payloads, that the 413 detail message mentions the limit, and that `_MAX_UPLOAD_BYTES == _MAX_UPLOAD_MB * 1024 * 1024` with the expected default of 10 MB.
- **`TestBackendConfiguration`** (4 new tests in `test_api_encode.py`) — verifies `hgbr` is present in `_VALID_ALGORITHMS`, the full allowlist matches the expected set, `_JOB_COMPLETED_TTL_SECS` is positive, and its default is 1800 s when the env var is unset.
- **`test_valid_algorithms_accepted`** updated — `hgbr` added to the spot-check list alongside `ridge`, `lasso`, `svr`, `randomforest`.

### Added
- **Customisable PDF export options modal** — clicking "PDF Report" now opens a modal before generating the PDF. Options include: *Export all encoding results* (default: top N only) with a 10 / 25 / 50 quick-select, *Include result charts* (off by default), *Include full config parameters* (appendix, on by default), and *Include config snapshot* (brief summary section, on by default). The modal state is stored in `pdfOptions` React state so selections persist for the session.
- **PDF Appendix section** — the PDF report now has a dedicated Appendix page containing: **A.1 Charts** (optional, full canvas capture of `#results-charts-section` with multi-page slicing), and **A.2 Full Configuration** (all three config sections — Model, DSP, and per-descriptor parameters — rendered as labelled key-value rows with automatic page overflow via `checkPage`). Arrays are joined as comma-separated strings; nested objects are serialised with `JSON.stringify`; null values render as `—`.
- **Encoding subprocess for immediate stop** — the pySAR encoding call (previously a blocking Python call on the background thread) now runs inside a forked child process spawned via `multiprocessing.get_context("fork")`. A `_CANCEL_PROCESSES` dict (keyed by `job_id`) stores each live process handle. When `POST /api/jobs/{job_id}/cancel` is received, the endpoint immediately calls `proc.terminate()` (+ `proc.kill()` if still alive after 3 s), genuinely stopping encoding mid-run rather than only signalling a flag that is checked between phases.
- **`_pySAR_encode_worker` subprocess function** — top-level function that runs inside the forked process, calls the appropriate `aai_encoding` / `descriptor_encoding` / `aai_descriptor_encoding` method, and sends the result (DataFrame + `y_test` + `y_pred`) back to the parent via a `multiprocessing.Queue`. Errors are sent as `("error", message)` tuples so the parent can surface them as failed jobs.
- **`inline_encoding` autouse test fixture** — `tests/backend/conftest.py` now includes an autouse `inline_encoding` fixture that replaces `_MP_CTX` with a synchronous in-process stub via `monkeypatch`. The stub's `Process.start()` immediately puts a minimal stub `DataFrame` result into a stdlib `Queue`, eliminating fork latency from the test suite and preventing spurious 429 responses caused by jobs staying `"running"` across tests.

### Changed
- **PDF structure reorganised** — the Charts section has been moved from the main body into the Appendix (now **A.1 Charts**), followed by the Full Configuration as **A.2**. The main body retains: Title, Job Summary, Best Model, Results Table, and Config Snapshot.
- **`cancel_job` endpoint now terminates subprocess** — in addition to setting the cancel event and updating job status, the handler now pops and terminates the subprocess from `_CANCEL_PROCESSES` immediately, so cancellation is instantaneous regardless of which encoding phase is active.
- **`_cleanup_upload_dir` also purges `_CANCEL_PROCESSES`** — the hourly ghost-job sweep now removes stale entries from `_CANCEL_PROCESSES` alongside `JOBS` and `_CANCEL_EVENTS`.
- **`conftest.py` `clean_jobs` fixture** — extended to clear `_CANCEL_PROCESSES` (imported from `backend.main`) before and after each test, preventing process handles from leaking across tests.
- **Zustand `localStorage` persistence** — the Zustand store is now persisted to `localStorage` via the `zustand/middleware` `persist` adapter. The following slices survive a page refresh: `darkMode`, `showLanding`, `step`, `dataset`, `config`, `encoding`, and `aaiIndicesCache`. Transient UI state (active job, results, panel visibility, encoding queue) is intentionally excluded. An `onRehydrateStorage` hook re-applies the dark-mode CSS class on rehydration, restoring the user's colour-scheme preference without a flash.
- **Config import validation and deep-merge** — `importConfig()` in the Zustand store now validates any imported object against the required shape (`model`, `descriptors`, `pyDSP` top-level keys, each a non-null object) before accepting it, guarding against state corruption from malformed JSON files. Valid configs are deep-merged with `DEFAULT_CONFIG` so any missing nested keys are filled with sensible defaults rather than silently becoming `undefined`.
- **JOBS and rate-limit store periodic cleanup** — the existing hourly `_cleanup_upload_dir` background thread has been extended with two additional sweeps per cycle: (1) pruning completed/failed/cancelled `JOBS` entries whose associated upload file no longer exists on disk, and (2) evicting expired per-endpoint buckets from `_RATE_LIMIT_STORE` so inactive IP entries don't accumulate indefinitely in memory.
- **Structured JSON logging** — the plaintext `logging.basicConfig` formatter has been replaced with a custom `_JsonFormatter` that emits single-line JSON records with `severity`, `message`, `logger`, and `time` fields. GCP Cloud Logging automatically parses `severity` for log-level filtering in Cloud Run, replacing the previously opaque plain-text lines.
- **Per-IP concurrent job limit** — `POST /api/encode` now counts pending/running `JOBS` entries attributed to the requesting IP before creating a new job. If the count reaches `_MAX_CONCURRENT_JOBS_PER_IP` (3), the endpoint returns HTTP 429 with a descriptive message, preventing a single client from saturating the container's thread pool with long-running AAI+Descriptor jobs.
- **`EncodeRequest` field validation** — `strategy` and `sort_by` are now `Literal` types so Pydantic rejects invalid values with a 422 before any background thread is spawned. `algorithm` is checked against a whitelist (`_VALID_ALGORITHMS`) via `@field_validator` and normalised to lowercase. `n_jobs` is clamped to `min(n_jobs, os.cpu_count() or 4)` via `@field_validator`, preventing thread-pool exhaustion from oversized `n_jobs` values.
- **Path traversal guard on `EncodeRequest.file_path`** — a `@field_validator` resolves the submitted `file_path` and asserts it starts with `UPLOAD_DIR.resolve()`, returning a 422 if the path escapes the server's upload directory. This closes the path traversal vulnerability that previously allowed arbitrary file access via `../../etc/passwd`-style inputs.
- **`TestEncodeRequestValidation` test class** — 10 new integration tests covering invalid `strategy`, `sort_by`, and `algorithm` (all expect 422), path traversal attempts (`../../etc/passwd`, `/etc/passwd`), valid algorithm spot-check, algorithm case normalisation, `n_jobs` over-submission (accepted + clamped), and a direct Pydantic validator unit test for the `n_jobs` clamp.
- **`TestConcurrentJobLimit` test class** — 5 new integration tests verifying: submission accepted below the limit, rejected at the limit (429), independent counters per IP, completed jobs not counted, and response body shape.

### Changed
- **Per-endpoint rate limit buckets** (bug fix) — the sliding-window rate limiter previously used a single shared bucket keyed on IP address, meaning exhausting the `/api/upload` allowance (20 req/60 s) also consumed capacity from the `/api/encode` allowance (5 req/60 s). The store key is now `f"{ip}:{path_prefix}"` so each endpoint maintains a fully independent counter.
- **`@app.on_event` → lifespan** — the deprecated `@app.on_event("startup")` handler has been replaced with a FastAPI `lifespan` async context manager (`from contextlib import asynccontextmanager`). This eliminates the deprecation warning emitted by FastAPI/Starlette on every application start and aligns with the recommended approach in FastAPI ≥ 0.93.
- **Exponential backoff on job polling** — the fixed-interval `setInterval` (2 s) in Step 3 that polls `/api/jobs/{id}` has been replaced with a recursive `setTimeout`-based loop. The interval starts at 2 s and doubles on each consecutive network error up to a 30 s cap, then resets to 2 s on the next successful response. A `cancelled` flag prevents state updates after the component unmounts. This reduces unnecessary server traffic during long-running AAI+Descriptor runs without degrading responsiveness for short jobs.
- **AAI index search debounce** — the 566-record filter in the Step 3 AAI index combobox previously re-ran on every keystroke. A `useEffect` now debounces `aaiSearch` → `aaiSearchDebounced` with a 150 ms delay; the filter runs against the debounced value, reducing unnecessary renders during fast typing.
- **Results table `filterText` debounce** — the full-table filter in Step 4 previously re-ran its `useMemo` on every keystroke over potentially thousands of rows. A `useEffect` now debounces `filterText` → `filterTextDebounced` with the same 150 ms delay; the `rows` memo depends on the debounced value, eliminating jank on large AAI+Descriptor result sets.
- **PDF export `config` reference fixed** — `handleExportPDF` in Step 4 referenced `config` (for the Config Snapshot section) but `config` was not in the component's `useAppStore()` destructuring, causing a `ReferenceError` at runtime. `config` is now included in the destructured store values.
- **`conftest.py` `make_encode_payload`** — the hardcoded `/tmp/pysar_frontend/{id}.csv` path has been replaced with `str(UPLOAD_DIR / f"{uploaded_id}.csv")` using the imported `UPLOAD_DIR` constant. This ensures the path traversal validator passes in all test environments, including macOS where `tempfile.gettempdir()` may not return `/tmp`.
- **Rate-limit test updated** — `test_rate_limiting.py::TestUploadRateLimit::test_upload_limit_independent_from_encode_limit` (previously renamed to `test_rate_limit_bucket_is_shared_per_ip` to match the old shared-bucket behaviour) has been restored to its original intent and now asserts `200` — confirming that exhausting the upload bucket no longer blocks encode requests.

### Added (prior)
- **Comprehensive test suite** — full test coverage across backend, frontend, and E2E layers:
  - **Backend unit tests** (`tests/backend/test_helpers.py`) — ~100 tests covering all 11 pure Python helper functions: dataset reading, sequence validation, column-guess confidence, length/activity histograms, duplicate detection, missing-value detection, outlier detection, config building, and model count estimation.
  - **Backend integration tests** (`tests/backend/test_api_upload.py`, `test_api_encode.py`, `test_api_misc.py`) — full HTTP-level coverage of every API endpoint using `starlette.TestClient` with pySAR/aaindex pre-mocked via `sys.modules`; covers happy paths, anomaly detection, 422/404 error cases, dataset remediation parametrised across all strategies, and job lifecycle (submit → poll → cancel → delete).
  - **Rate-limit tests** (`tests/backend/test_rate_limiting.py`) — verifies the sliding-window middleware enforces 5 requests/60 s on `/api/encode` and 20 requests/60 s on `/api/upload`, returns HTTP 429 with `Retry-After` header, and that GET endpoints are never rate-limited.
  - **Frontend unit tests** (Vitest + jsdom, `frontend/src/__tests__/unit/`) — six test files covering `parseDatasetClientSide` (column guessing, length/activity stats, TSV parsing), Zustand store actions and localStorage persistence (`appStore`), `formatApiError` / `toastApiError` error formatting, `validateConfig` and `countDiffs` config validation, `logLineClass` and `estimateModels` encoding utilities, and the full `api.js` module (axios-mocked, all nine exported functions).
  - **Playwright E2E tests** (`tests/e2e/`) — five spec files exercising the full four-step wizard in a real Chromium browser: landing page render + CTA navigation, file upload + validation warnings + example dataset loading, Step 2 tab navigation + algorithm selector + config diff badge, Step 3 strategy selection + job submission (backend mocked via `page.route()`), and Step 4 results table + filter + sorting + export buttons.
  - `frontend/vitest.config.js` — Vitest configuration: jsdom environment, `@testing-library/jest-dom` setup file, v8 coverage with 70 % line/function and 60 % branch thresholds.
  - `playwright.config.js` — Playwright configuration: Chromium only, Vite `webServer` auto-start, trace/video on first retry, screenshot on failure, 1 worker locally / 50 % workers in CI.
  - `pytest.ini` — pytest configuration: `testpaths = tests/backend`, short tracebacks, strict markers, `unit` / `integration` / `slow` marker declarations.
  - `frontend/src/utils/configValidation.js` — `validateConfig(cfg)` and `countDiffs(current, defaults)` extracted from `Step2Configure` for testability.
  - `frontend/src/utils/encoding.js` — `logLineClass(line)` and `estimateModels(strategy, ...)` extracted from `Step3Encode` for testability.
- **CI/CD test integration** (`.github/workflows/build_test.yml`) — the existing Build & Test workflow now runs all test layers automatically on every push and pull request to `main`:
  - **Frontend job**: `npm test` (Vitest unit tests) added after the `npm run build` step.
  - **Backend job**: `pytest -m "not slow"` added after the flake8 lint and import smoke-test steps; `pytest`, `pytest-cov`, and `httpx` added to `backend/requirements.txt`.
  - **E2E job** (new, runs after both frontend and backend succeed): installs the backend runtime dependencies excluding pySAR (encode routes are mocked), starts `uvicorn` in the background, polls `/api/health`, installs Playwright + Chromium, then runs `npx playwright test`. Playwright trace and screenshot artefacts are uploaded to GitHub on failure (7-day retention).

- **Predicted vs actual scatter plot** — after a job completes, the backend re-fits the best model and captures test-set `y_test` / `y_pred`. The new `PredictedActualChart` component (Step 4 → Charts tab) renders a scatter plot with a `y=x` reference line and displays inline R² and RMSE pills.
- **PNG chart export** — every chart card now has an SVG / PNG export dropdown. PNG export uses an SVG-to-canvas pipeline at 2× retina scale via `canvas.toBlob`.
- **Cross-job R² comparison chart** — the Jobs panel compare view shows a recharts grouped bar chart of the top-10 R² values for both selected jobs (Job A in indigo, Job B in emerald), with a parameter diff table below.
- **Train/test split preview** — the dry-run estimate panel in Step 3 now shows `N sequences → X train / Y test` derived from the dataset row count and the configured `test_split` ratio. The config snapshot also shows the split counts.
- **Config diff badge** — the "Config Preview" tab in Step 2 displays an amber badge with the count of settings that differ from `DEFAULT_CONFIG`. The badge disappears when the config is at defaults.
- `result_summary` (top-30 R² values) stored in job history on completion and used for the cross-job comparison chart.
- **Encoding progress ETA** — a daemon ticker thread in the backend interpolates `job["progress"]` from 45 → 95% at one-second intervals during encoding (proportional to `total_models / n_jobs`). The Step 3 progress block now shows `~X / Y models evaluated`, an inline `~Z remaining` countdown, and a `% complete` label beneath the bar. The status-row model count switches between `~X / Y models` (running) and `X models` (done).
- **Config import validation** — `Step2Configure` validates imported JSON configs against known-good value sets (`VALID_ALGORITHMS`, `VALID_SPECTRA`, `VALID_WINDOWS`, `VALID_FILTERS`) and checks numeric ranges for `test_split` (0–1) and `cv_folds` (2–20). Validation errors are displayed in an amber dismissible panel listing every specific field error; the config is still applied so partial imports remain usable.
- **PDF report export** — `handleExportPDF()` in Step 4 lazy-imports `jspdf` and `html2canvas` (avoiding bundle bloat) and generates a styled A4 PDF containing: title + generation date, job metadata, best-model metrics table, top-10 results table with alternating row shading, config snapshot, and a canvas screenshot of the Charts tab (`#results-charts-section`). A "PDF Report" button is added to the export toolbar alongside CSV / Excel / JSON.

### Changed
- `ChartCard` export button replaced with a hover dropdown offering SVG and PNG download options.
- `ComparePanel` in the Jobs panel extended with a recharts `BarChart` above the parameter diff table.
- Step 2 tab rendering updated to support optional badges on tab labels.
- Example dataset listing and loading no longer require a backend API call — the four built-in datasets are served as static files from `frontend/public/example_datasets/` (Vercel CDN). Loading a sample fetches the static file and parses it entirely client-side using a new `parseDataset.js` utility, returning the same response shape as the backend (columns, preview, stats, sequence validation, duplicate/missing/outlier detection).
- Removed the `getExampleDatasets` API call and its `useEffect` from Step1Upload; the list is now initialised synchronously from a hardcoded constant in `api.js`.
- Step 3 (Encode) performs a lazy upload of the example dataset file to the backend before submitting an encode job when `file_path` is null — this keeps Step 1 fully client-side while still allowing encoding when a backend is available. Clear error messaging shown if the backend is unreachable.

### Fixed
- **AAI index dropdown** — removed the 60-item display cap and the 250 ms debounce; the list now renders all matching indices immediately in a `max-h-64` scrollable container. Filter logic changed to prefix-match on the index code (`startsWith`) and substring-match on the title (2+ character queries), matching user expectations when typing a letter prefix.
- **Results filter icon overlap** — the search magnifier icon in the Step 4 results table filter input was hidden behind text. Fixed by applying `!pl-8` (Tailwind `!important` modifier) to override the global `.input { px-3 }` rule.
- **"566 models" warning** — the performance warning about running all 566 AAIndex1 models is now only shown when no specific indices are selected, preventing it from appearing when the user has already narrowed their selection.

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
- Export results as CSV, Excel, JSON, or a formatted PDF report
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
