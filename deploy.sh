#!/usr/bin/env bash
# Deploys AirWise to Cloud Run in Mumbai (asia-south1). Run it from the repo root, e.g. in Cloud Shell:
#   PROJECT_ID=your-project GEMINI_API_KEY=your-key ./deploy.sh
# Leave GEMINI_API_KEY unset to call Gemini through Vertex AI with the service account instead of a key.
# Keys go into Secret Manager; they never sit in the image, the repo or the service's plain environment.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-airwise}"
SA="airwise-run@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null
echo "Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com airquality.googleapis.com apikeys.googleapis.com aiplatform.googleapis.com

# Source builds run as the default compute service account, which newer projects don't let build by default.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None --role=roles/run.builder \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" >/dev/null

# The service runs as its own account, which can read only its own secrets (and call Vertex AI if used).
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create airwise-run --display-name="AirWise on Cloud Run"

# put_secret NAME VALUE: stores VALUE as the newest version of secret NAME, readable by the service account.
put_secret() {
  gcloud secrets describe "$1" >/dev/null 2>&1 || gcloud secrets create "$1" --replication-policy=automatic >/dev/null
  printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
}

if ! gcloud secrets describe airwise-maps-key >/dev/null 2>&1; then
  echo "Creating an API key that only works with the Air Quality API..."
  gcloud services api-keys create --display-name=airwise-air-quality --api-target=service=airquality.googleapis.com >/dev/null
  KEY_NAME=$(gcloud services api-keys list --filter="displayName=airwise-air-quality" --format='value(name)' --limit=1)
  put_secret airwise-maps-key "$(gcloud services api-keys get-key-string "$KEY_NAME" --format='value(keyString)')"
fi
SECRETS="MAPS_API_KEY=airwise-maps-key:latest"
ENV_ARGS=()

if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  put_secret airwise-gemini-key "$GEMINI_API_KEY"
  SECRETS="$SECRETS,GEMINI_API_KEY=airwise-gemini-key:latest"
else
  echo "No GEMINI_API_KEY given: Gemini runs on Vertex AI through the service account."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None --role=roles/aiplatform.user \
    --member="serviceAccount:$SA" >/dev/null
  ENV_ARGS=(--set-env-vars "GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global")
fi

echo "Building and deploying..."
gcloud run deploy "$SERVICE" --source . --region "$REGION" --service-account "$SA" --allow-unauthenticated \
  --set-secrets "$SECRETS" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  --memory 512Mi --cpu 1 --max-instances 1 --timeout 60 --cpu-boost

echo "Live at: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
