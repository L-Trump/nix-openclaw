{
  lib,
  pkgs,
  stdenv,
  nodejs_22,
  openclawGateway,
  includeRuntimePluginSmoke ? false,
  runtimePluginSmokeId ? "diagnostics-prometheus",
  expectRuntimePluginTrust ? true,
}:

let
  runtimePluginSmokeRoot =
    if includeRuntimePluginSmoke then pkgs.openclawRuntimePlugins.${runtimePluginSmokeId} else null;
  gatewayUnderTest =
    if includeRuntimePluginSmoke then
      pkgs.symlinkJoin {
        name = "${lib.getName openclawGateway}-${runtimePluginSmokeId}-trust-smoke";
        paths = [ openclawGateway ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram "$out/bin/openclaw" \
            --set OPENCLAW_NIX_MODE 1 \
            --set OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY 1 \
            --set OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS ${
              lib.escapeShellArg (if expectRuntimePluginTrust then toString runtimePluginSmokeRoot else "")
            }
        '';
      }
    else
      openclawGateway;
in
stdenv.mkDerivation {
  pname =
    if includeRuntimePluginSmoke then
      "openclaw-runtime-plugin-${runtimePluginSmokeId}-${
        if expectRuntimePluginTrust then "trusted" else "untrusted"
      }-gateway-smoke"
    else
      "openclaw-gateway-smoke";
  version = lib.getVersion openclawGateway;

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;

  nativeBuildInputs = [ nodejs_22 ];

  env = {
    OPENCLAW_GATEWAY = gatewayUnderTest;
  }
  // lib.optionalAttrs includeRuntimePluginSmoke {
    OPENCLAW_RUNTIME_PLUGIN_SMOKE_ID = runtimePluginSmokeId;
    OPENCLAW_RUNTIME_PLUGIN_SMOKE_ROOT = runtimePluginSmokeRoot;
    OPENCLAW_RUNTIME_PLUGIN_EXPECT_TRUST = if expectRuntimePluginTrust then "1" else "0";
  };

  __darwinAllowLocalNetworking = true;

  doCheck = true;
  checkPhase = "${nodejs_22}/bin/node ${../scripts/gateway-smoke.mjs}";
  installPhase = "${../scripts/empty-install.sh}";
}
