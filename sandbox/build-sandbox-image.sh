#!/usr/bin/env bash
#
# Build the SignBridge Sandbox execution image.
#
# Sandbox mode runs user code inside a throwaway container started from this
# image. Build it once; every run after that starts in about a second.
#
#   ./sandbox/build-sandbox-image.sh              # build signbridge-sandbox:latest
#   ./sandbox/build-sandbox-image.sh --verify     # build, then print what's inside
#   SANDBOX_IMAGE=my/sandbox:1 ./sandbox/build-sandbox-image.sh
#   AWS_SDK_VERSION=2.25.0 ./sandbox/build-sandbox-image.sh   # pin the Java SDK
#
# If you change the image name, set the same value in config.properties
# ([sandbox] image=...) or the SANDBOX_IMAGE environment variable of the server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SANDBOX_IMAGE:-signbridge-sandbox:latest}"
AWS_SDK_VERSION="${AWS_SDK_VERSION:-}"

VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker > /dev/null 2>&1; then
  echo "ERROR: docker was not found on PATH." >&2
  echo "Sandbox mode needs Docker. Install Docker, then run this script again." >&2
  exit 1
fi

if ! docker version > /dev/null 2>&1; then
  echo "ERROR: the Docker daemon is not responding." >&2
  echo "Start Docker (or Docker Desktop) and run this script again." >&2
  exit 1
fi

echo "Building ${IMAGE}"
echo "  context: ${SCRIPT_DIR}"
if [ -n "${AWS_SDK_VERSION}" ]; then
  echo "  AWS SDK for Java v2: ${AWS_SDK_VERSION} (pinned)"
else
  echo "  AWS SDK for Java v2: current release (resolved during build)"
fi
echo
echo "The first build downloads the JDK, Python, Node, and AWS SDK packages for"
echo "four languages, so expect several minutes and a few GB. Later builds reuse"
echo "the layer cache."
echo

docker build \
  --tag "${IMAGE}" \
  --build-arg "AWS_SDK_VERSION=${AWS_SDK_VERSION}" \
  "${SCRIPT_DIR}"

echo
echo "Built ${IMAGE}"
docker image inspect "${IMAGE}" --format '  size: {{.Size}} bytes ({{len .RootFS.Layers}} layers)'

if [ "${VERIFY}" -eq 1 ]; then
  echo
  echo "Verifying the toolchains inside the image:"
  docker run --rm --network none "${IMAGE}"
fi

echo
echo "Next: reload the Sandbox page in SignBridge. It re-checks for the image"
echo "automatically, so no server restart is needed."
