#!/usr/bin/env bash
# Build the embedded browser UI and package a standalone DawnMesh Server.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
target_os=""
target_arch=""
version="$(git describe --tags --always --dirty 2>/dev/null || echo local)"
run_tests=true
all_linux=false

usage() {
  cat <<'HELP'
Usage: ./scripts/build.sh [options]
  --os OS         Target operating system (default: host GOOS)
  --arch ARCH     Target architecture (default: host GOARCH)
  --linux         Package both linux/amd64 and linux/arm64
  --version NAME  Archive version label (default: git describe)
  --skip-tests    Skip Go and protocol tests; TypeScript checking still runs
  -h, --help      Show this help

Requires Go (see go.mod), Node.js >=24, npm, tar. Outputs dist/*.tar.gz,
dist/*/dawnmesh-server[.exe], and dist/SHA256SUMS. Frontend assets and the
LiveKit encryption worker are embedded: Node.js is not needed at runtime.
HELP
}
while (($#)); do
  case "$1" in
    --os|--arch|--version)
      if (($# < 2)); then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in --os) target_os="$2";; --arch) target_arch="$2";; --version) version="$2";; esac
      shift 2 ;;
    --linux) all_linux=true; shift ;;
    --skip-tests) run_tests=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
for tool in node npm go tar; do
  command -v "$tool" >/dev/null || { echo "Required tool not found: $tool" >&2; exit 1; }
done
target_os="${target_os:-$(go env GOOS)}"
target_arch="${target_arch:-$(go env GOARCH)}"
# Labels become filesystem components; reject traversal and shell metacharacters.
for component in "$version" "$target_os" "$target_arch"; do
  if [[ ! "$component" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    echo "Invalid target/version: $component" >&2; exit 2
  fi
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js >=24 is required"); process.exit(1); }'
printf 'Building TypeScript frontend…\n'
npm --prefix frontend ci --no-fund --no-audit
npm --prefix frontend run build
if "$run_tests"; then
  npm --prefix frontend test
  node webtests/client_crypto_test.mjs
  go test ./...
  go vet ./...
fi
mkdir -p dist
build_stage="$(mktemp -d "$project_dir/dist/.build-XXXXXX")"
trap 'rm -rf "$build_stage"' EXIT
archives=()
package_target() {
  local os="$1" arch="$2" name binary
  name="DawnMeshServer-${version}-${os}-${arch}"
  binary=dawnmesh-server
  if [[ "$os" == windows ]]; then binary=dawnmesh-server.exe; fi
  mkdir -p "$build_stage/$name"
  printf 'Building %s/%s…\n' "$os" "$arch"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$build_stage/$name/$binary" ./cmd/dawnmesh-server
  cp LICENSE THIRD_PARTY_NOTICES.md README.md README.en.md config.example.env livekit.example.yaml compose.yaml "$build_stage/$name/"
  cp -R deploy docs "$build_stage/$name/"
  mkdir -p "$build_stage/$name/licenses"
  cp frontend/LICENSE.livekit-client "$build_stage/$name/licenses/"
  mkdir -p "$build_stage/$name/scripts"
  cp scripts/init-config.sh "$build_stage/$name/scripts/"
  COPYFILE_DISABLE=1 tar -C "$build_stage" -czf "dist/$name.tar.gz" "$name"
  mkdir -p "dist/$name"
  cp "$build_stage/$name/$binary" "dist/$name/$binary"
  archives+=("$name.tar.gz")
}
if "$all_linux"; then
  package_target linux amd64
  package_target linux arm64
else
  package_target "$target_os" "$target_arch"
fi
(
  cd dist
  if command -v sha256sum >/dev/null; then
    sha256sum "${archives[@]}" > SHA256SUMS
  else
    shasum -a 256 "${archives[@]}" > SHA256SUMS
  fi
)
printf '\nComplete: %s/dist\n' "$project_dir"
printf '  %s\n' "${archives[@]}" SHA256SUMS
