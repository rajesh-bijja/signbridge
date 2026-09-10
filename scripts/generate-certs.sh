#!/usr/bin/env bash
#
# generate-certs.sh
#
# Generates a self-signed TLS certificate/key pair for SignBridge's HTTPS
# server. The server also does this automatically on first run, so this script
# is only needed if you want to (re)generate certs manually — e.g. to refresh an
# expired pair or use a custom CN.
#
# Certs are written to the keys/ subdirectory of the runtime base directory,
# which is always ~/.signbridge (the same fixed location the app uses), with the
# filenames the app expects (see the [ssl] section of config.properties).
#
# Usage:
#   ./scripts/generate-certs.sh
#
set -euo pipefail

BASE_DIR="${HOME}/.signbridge"
KEYS_DIR="${BASE_DIR}/keys"

KEY_NAME="${KEY_NAME:-signbridge_key.pem}"
CERT_NAME="${CERT_NAME:-signbridge_cert.pem}"
DAYS="${DAYS:-825}"
COMMON_NAME="${COMMON_NAME:-localhost}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is required but not found in PATH." >&2
  exit 1
fi

mkdir -p "${KEYS_DIR}"

KEY_PATH="${KEYS_DIR}/${KEY_NAME}"
CERT_PATH="${KEYS_DIR}/${CERT_NAME}"

if [ -f "${KEY_PATH}" ] || [ -f "${CERT_PATH}" ]; then
  echo "Certificate or key already exists in ${KEYS_DIR}."
  echo "Remove them first if you want to regenerate:"
  echo "  rm -f \"${KEY_PATH}\" \"${CERT_PATH}\""
  exit 0
fi

echo "Generating self-signed certificate for CN=${COMMON_NAME} (valid ${DAYS} days)..."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "${KEY_PATH}" \
  -out "${CERT_PATH}" \
  -days "${DAYS}" \
  -subj "/CN=${COMMON_NAME}" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "${KEY_PATH}"

echo "Done."
echo "  key:  ${KEY_PATH}"
echo "  cert: ${CERT_PATH}"
echo ""
echo "Your browser will warn about the self-signed certificate — that is expected"
echo "for local use."
