{
  stdenvNoCC,
  nodejs_24,
  openclawGateway,
}:
stdenvNoCC.mkDerivation {
  name = "openclaw-opencode-go-deepseek-flash";
  dontUnpack = true;
  dontBuild = true;
  nativeBuildInputs = [ nodejs_24 ];
  OPENCLAW_GATEWAY_PACKAGE = openclawGateway;
  OPENCLAW_PATCH_SCRIPT = ../scripts/patch-opencode-go-deepseek-flash-npm-dist.mjs;
  doCheck = true;
  checkPhase = "node --test ${../scripts/patch-opencode-go-deepseek-flash-npm-dist.test.mjs}";
  installPhase = "${../scripts/empty-install.sh}";
}
