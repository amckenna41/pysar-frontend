#!/usr/bin/env bash
# deploy_gcloud.sh — full end-to-end gcloud setup and deployment for pySAR on Cloud Run
#
# Usage:
#   ./deploy_gcloud.sh [--project PROJECT_ID] [--region REGION] [--skip-apis] [--skip-secrets]
#
# What this script does (in order):
#   1. Authenticate and set the active project
#   2. Enable all required GCP APIs
#   3. Create an Artifact Registry Docker repository
#   4. Build and push the Docker image
#   5. Deploy the backend to Cloud Run
#   6. (Optional) Create Secret Manager secrets for Vercel integration
#   7. (Optional) Connect a Cloud Build trigger to your GitHub repo

set -euo pipefail

# ── Defaults (mirrors cloudbuild.yaml substitutions) ─────────────────────────
PROJECT_ID=""
REGION="europe-west1"
SERVICE="pysar-backend"
REPO="pysar"
CORS_ORIGIN="https://pysar-app.vercel.app"
VERCEL_PROJECT_ID=""

SKIP_APIS=false
SKIP_SECRETS=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)      PROJECT_ID="$2";         shift 2 ;;
    --region)       REGION="$2";             shift 2 ;;
    --cors-origin)  CORS_ORIGIN="$2";        shift 2 ;;
    --vercel-id)    VERCEL_PROJECT_ID="$2";  shift 2 ;;
    --skip-apis)    SKIP_APIS=true;          shift ;;
    --skip-secrets) SKIP_SECRETS=true;       shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*"; }
die()   { echo "[ERROR] $*" >&2; exit 1; }
hr()    { echo "────────────────────────────────────────────────────────"; }

# ── Step 0: Auth + project ────────────────────────────────────────────────────
hr
info "STEP 0 — Authentication & project configuration"
hr

# Log in if no active account (opens browser)
if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q "@"; then
  gcloud auth login
fi

# Resolve project: flag → gcloud default → prompt
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
fi
if [[ -z "$PROJECT_ID" ]]; then
  read -rp "Enter your GCP project ID: " PROJECT_ID
fi
[[ -z "$PROJECT_ID" ]] && die "GCP project ID is required."

gcloud config set project "$PROJECT_ID"
info "Active project: $PROJECT_ID"

# Application Default Credentials (used by Cloud Build / Cloud Run under the hood)
gcloud auth application-default login --quiet 2>/dev/null || true

# ── Step 1: Enable APIs ───────────────────────────────────────────────────────
hr
info "STEP 1 — Enabling required GCP APIs"
hr

if [[ "$SKIP_APIS" == "true" ]]; then
  warn "Skipping API enablement (--skip-apis passed)"
else
  APIS=(
    run.googleapis.com
    artifactregistry.googleapis.com
    cloudbuild.googleapis.com
    secretmanager.googleapis.com
    iam.googleapis.com
    cloudresourcemanager.googleapis.com
    logging.googleapis.com
  )
  gcloud services enable "${APIS[@]}" --project="$PROJECT_ID"
  info "All APIs enabled."
fi

# ── Step 2: Artifact Registry repository ─────────────────────────────────────
hr
info "STEP 2 — Artifact Registry repository: $REPO"
hr

if gcloud artifacts repositories describe "$REPO" \
     --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  info "Repository '$REPO' already exists — skipping creation."
else
  gcloud artifacts repositories create "$REPO" \
    --location="$REGION" \
    --repository-format=docker \
    --description="pySAR Docker images" \
    --project="$PROJECT_ID"
  info "Repository '$REPO' created."
fi

# Authenticate Docker to push to Artifact Registry
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Step 3: Build Docker image ────────────────────────────────────────────────
hr
info "STEP 3 — Building Docker image"
hr
info "Image: $IMAGE"

# Build locally using Cloud Build (avoids needing Docker locally installed)
# Remove '--local' to build on Cloud Build instead (costs build minutes but
# works without a local Docker daemon).
gcloud builds submit \
  --tag "$IMAGE" \
  --project="$PROJECT_ID" \
  .

# ── Step 4: Deploy to Cloud Run ───────────────────────────────────────────────
hr
info "STEP 4 — Deploying to Cloud Run: $SERVICE"
hr

gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=3600 \
  --startup-cpu-boost \
  --no-cpu-throttling \
  --set-env-vars="CORS_ORIGIN=${CORS_ORIGIN}" \
  --project="$PROJECT_ID"

SERVICE_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format="value(status.url)")
info "Cloud Run service live at: $SERVICE_URL"

# ── Step 5: IAM — make service publicly accessible ───────────────────────────
hr
info "STEP 5 — IAM: granting public (unauthenticated) access"
hr

gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --project="$PROJECT_ID" || warn "IAM binding may already exist — continuing."

# ── Step 6: Secret Manager (Vercel integration) ───────────────────────────────
hr
info "STEP 6 — Secret Manager secrets for Vercel integration"
hr

if [[ "$SKIP_SECRETS" == "true" ]]; then
  warn "Skipping Secret Manager setup (--skip-secrets passed)"
else
  # vercel-token
  if gcloud secrets describe vercel-token --project="$PROJECT_ID" &>/dev/null; then
    info "Secret 'vercel-token' already exists."
  else
    read -rsp "Enter your Vercel API token (input hidden): " VERCEL_TOKEN
    echo
    printf '%s' "$VERCEL_TOKEN" | gcloud secrets create vercel-token \
      --data-file=- \
      --project="$PROJECT_ID"
    info "Secret 'vercel-token' created."
    unset VERCEL_TOKEN
  fi

  # vercel-deploy-hook
  if gcloud secrets describe vercel-deploy-hook --project="$PROJECT_ID" &>/dev/null; then
    info "Secret 'vercel-deploy-hook' already exists."
  else
    read -rp "Enter your Vercel deploy hook URL: " VERCEL_HOOK
    printf '%s' "$VERCEL_HOOK" | gcloud secrets create vercel-deploy-hook \
      --data-file=- \
      --project="$PROJECT_ID"
    info "Secret 'vercel-deploy-hook' created."
    unset VERCEL_HOOK
  fi

  # Grant Cloud Build SA access to read both secrets
  CB_SA="$(gcloud projects describe "$PROJECT_ID" \
    --format='value(projectNumber)')@cloudbuild.gserviceaccount.com"

  for SECRET in vercel-token vercel-deploy-hook; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
      --member="serviceAccount:${CB_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$PROJECT_ID" || warn "IAM binding for $SECRET may already exist."
  done
  info "Cloud Build SA granted secretAccessor on both secrets."
fi

# ── Step 7: Cloud Build GitHub trigger (optional) ────────────────────────────
hr
info "STEP 7 — Cloud Build trigger (push to main → auto-deploy)"
hr

TRIGGER_NAME="${SERVICE}-deploy-on-push"

if gcloud builds triggers describe "$TRIGGER_NAME" --project="$PROJECT_ID" &>/dev/null; then
  info "Trigger '$TRIGGER_NAME' already exists — skipping."
else
  read -rp "GitHub owner (org or username) for the trigger [leave blank to skip]: " GH_OWNER
  if [[ -n "$GH_OWNER" ]]; then
    read -rp "GitHub repo name: " GH_REPO

    VERCEL_PROJ_FLAG=""
    if [[ -n "$VERCEL_PROJECT_ID" ]]; then
      VERCEL_PROJ_FLAG="--substitutions=_VERCEL_PROJECT_ID=${VERCEL_PROJECT_ID}"
    fi

    gcloud builds triggers create github \
      --name="$TRIGGER_NAME" \
      --repo-owner="$GH_OWNER" \
      --repo-name="$GH_REPO" \
      --branch-pattern="^main$" \
      --build-config="cloudbuild.yaml" \
      --project="$PROJECT_ID" \
      ${VERCEL_PROJ_FLAG:-}

    info "Trigger '$TRIGGER_NAME' created — pushes to main will auto-deploy."
  else
    warn "Skipped trigger creation."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
hr
echo
info "Deployment complete."
info "  Service URL : $SERVICE_URL"
info "  Image       : $IMAGE"
info "  Region      : $REGION"
info "  Project     : $PROJECT_ID"
echo
info "To manually re-deploy at any time:"
echo "  gcloud builds submit --config cloudbuild.yaml ."
echo
info "To check service status:"
echo "  gcloud run services describe $SERVICE --region=$REGION"
echo
