#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
# Prefer the normal Pi agent dir; fall back to a repo-local dir if home is not writable.
if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
  AGENT_DIR="$PI_CODING_AGENT_DIR"
  mkdir -p "$AGENT_DIR"
elif mkdir -p "$HOME/.pi/agent" 2>/dev/null && touch "$HOME/.pi/agent/.pi-write-test" 2>/dev/null; then
  rm -f "$HOME/.pi/agent/.pi-write-test"
  AGENT_DIR="$HOME/.pi/agent"
else
  AGENT_DIR="$SCRIPT_DIR/.pi-agent"
  mkdir -p "$AGENT_DIR"
fi
export PI_CODING_AGENT_DIR="$AGENT_DIR"

# Check for --no-env flag
NO_ENV=false
ARGS=()
HAS_PROVIDER=false
HAS_MODEL=false
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
    case "$arg" in
      --provider|--provider=*) HAS_PROVIDER=true ;;
      --model|--model=*) HAS_MODEL=true ;;
    esac
  fi
done

# Load repo .env into the process environment (does not override existing vars).
load_dotenv() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%"${line##*[![:space:]]}"}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
    fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -n "${!key+x}" ]]; then
      continue
    fi
    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:-1}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:-1}"
    fi
    export "$key=$value"
  done < "$file"
}

# Pi does not read OPENAI_BASE_URL / LLM_*. Register the .env model in models.json
# and persist it as the startup default in settings.json.
sync_models_json_from_env() {
  local provider="${LLM_PROVIDER:-}"
  local model="${LLM_MODEL:-}"
  local base_url="${OPENAI_BASE_URL:-}"
  local api_key_ref='$OPENAI_API_KEY'

  [[ -n "$provider" && -n "$model" ]] || return 0

  mkdir -p "$AGENT_DIR"

  if [[ "$provider" == "openai" && -n "$base_url" ]]; then
    local models_path="$AGENT_DIR/models.json"
    PROVIDER="$provider" MODEL_ID="$model" BASE_URL="$base_url" API_KEY_REF="$api_key_ref" \
      MODELS_PATH="$models_path" python3 - <<'PY'
import json, os
from pathlib import Path

path = Path(os.environ["MODELS_PATH"])
provider = os.environ["PROVIDER"]
model_id = os.environ["MODEL_ID"]
base_url = os.environ["BASE_URL"]
api_key_ref = os.environ["API_KEY_REF"]

data = {"providers": {}}
if path.exists():
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            data = loaded
            data.setdefault("providers", {})
    except Exception:
        pass

entry = data["providers"].get(provider)
if not isinstance(entry, dict):
    entry = {}

entry["baseUrl"] = base_url
entry["api"] = entry.get("api") or "openai-completions"
entry["apiKey"] = entry.get("apiKey") or api_key_ref
entry.setdefault("compat", {
    "supportsDeveloperRole": False,
    "supportsReasoningEffort": True,
})

models = entry.get("models")
if not isinstance(models, list):
    models = []

if not any(isinstance(m, dict) and m.get("id") == model_id for m in models):
    models.append({
        "id": model_id,
        "name": model_id,
        "reasoning": True,
        "input": ["text"],
        "contextWindow": 1000000,
        "maxTokens": 65536,
    })
entry["models"] = models
data["providers"][provider] = entry
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  fi

  local settings_path="$AGENT_DIR/settings.json"
  PROVIDER="$provider" MODEL_ID="$model" SETTINGS_PATH="$settings_path" python3 - <<'PY'
import json, os
from pathlib import Path

path = Path(os.environ["SETTINGS_PATH"])
data = {}
if path.exists():
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        pass
data["defaultProvider"] = os.environ["PROVIDER"]
data["defaultModel"] = os.environ["MODEL_ID"]
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
}

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  unset LLM_PROVIDER
  unset LLM_MODEL
  unset OPENAI_BASE_URL
  echo "Running without API keys..."
else
  load_dotenv "$ENV_FILE"
  sync_models_json_from_env

  # Prefer .env model selection unless the caller already passed CLI flags.
  if [[ "$HAS_PROVIDER" == "false" && -n "${LLM_PROVIDER:-}" ]]; then
    ARGS+=(--provider "$LLM_PROVIDER")
  fi
  if [[ "$HAS_MODEL" == "false" && -n "${LLM_MODEL:-}" ]]; then
    ARGS+=(--model "$LLM_MODEL")
  fi
fi

"$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
