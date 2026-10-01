{
  stdenvNoCC,
  nodejs_24,
  patch,
  openclawSource,
}:
stdenvNoCC.mkDerivation {
  name = "openclaw-source-patches";
  dontUnpack = true;
  dontBuild = true;
  nativeBuildInputs = [
    nodejs_24
    patch
  ];
  OPENCLAW_SOURCE = openclawSource;
  OWNERSHIP_PATCH = ../patches/allow-nix-store-plugin-ownership.patch;
  TRUST_PATCH = ../patches/trust-nix-runtime-plugins.patch;
  RECORDS_PATCH = ../patches/ignore-managed-plugin-records.patch;
  TIMESTAMP_PATCH = ../patches/deterministic-missing-tool-result-timestamp.patch;
  AGGREGATE_BUDGET_PATCH = ../patches/fix-tool-result-aggregate-budget.patch;
  SCNET_RETRY_PATCH = ../patches/scnet-headerless-429-retry.patch;
  SESSIONS_SEND_PATCH = ../patches/sessions-send-empty-selector.patch;
  CONTEXT_ENGINE_PATCH = ../patches/context-engine-owned-tool-results.patch;
  RETRY_DEFAULTS_PATCH = ../patches/retry-defaults.patch;
  IDLE_RETRY_PATCH = ../patches/replay-safe-idle-retry.patch;
  RHCG_PAYLOAD_PATCH = ../patches/rhcg-openai-compatible-payload.patch;
  OPENCODE_GO_DEEPSEEK_FLASH_PATCH = ../patches/opencode-go-deepseek-flash-thinking.patch;
  MINIMAX_M31_FLASH_EFFORT_PATCH = ../patches/minimax-m31-flash-effort.patch;
  PENDING_TOOL_TIMESTAMP_PATCH = ../patches/pending-tool-result-timestamp.patch;
  FEISHU_STREAMING_PATCH = ../patches/feishu-session-owned-streaming.patch;
  doCheck = true;
  checkPhase = "node ${../tests/source-patches/check.mjs}";
  installPhase = "${../scripts/empty-install.sh}";
}
