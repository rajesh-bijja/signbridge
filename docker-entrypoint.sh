#!/bin/sh
set -e

# The app user is www-data with home /var/www. Force HOME so os.homedir() (used
# by lib/paths.js) resolves to /var/www regardless of the invoking environment.
export HOME=/var/www

# Base dir holding per-user artifacts and auto-generated TLS certs: always
# ~/.signbridge for the app user. Mounted from the host (see docker-compose.yml);
# must be writable by the app user.
BASE_DIR="${HOME}/.signbridge"

mkdir -p "${BASE_DIR}/artifacts/userartifacts" "${BASE_DIR}/keys"
chown -R www-data:www-data "${BASE_DIR}"

# Directories only, and deliberately NOT `chmod -R`.
#
# A blanket `chmod -R 775 "${BASE_DIR}"` used to be here, and it silently undid
# every restrictive mode in the tree on EVERY container start. The TLS private
# key (lib/certUtils.js), the AES-256 key that seals stored provider API keys
# (lib/llm/secretStore.js) and the settings file holding those sealed keys
# (lib/llm/llmSettings.js) are all written mode 0600 by the app — and all three
# came back 0775, world-readable, after the next `docker restart`. The writers
# were right; this line was wrong, which is the hard kind of permissions bug to
# spot because nothing fails.
#
# What the app actually needs is to be able to write, and `chown -R` above
# already supplies that. So files keep whatever mode their writer chose.
find "${BASE_DIR}" -type d -exec chmod 775 {} +

# keys/ holds the TLS private key and the wrapping key for every stored provider
# credential. Owner-only: encrypting the settings file is worth exactly as much
# as this directory's mode, since the two sit side by side. The file pass also
# repairs installs whose keys the old blanket chmod already widened.
chmod 700 "${BASE_DIR}/keys"
find "${BASE_DIR}/keys" -type f -exec chmod 600 {} +

# Same repair for the artifact stores. Every writer under here asks for 0600 —
# profiles (IAM keys, SSH private keys, bearer tokens, cached SSO state), history
# and favorites (whole requests and responses, Authorization headers included),
# settings (the TinyURL token), chat transcripts, sealed provider keys — but a
# mode is honoured only when the file is CREATED. Rewriting an existing file keeps
# its old mode, so an install predating a writer's mode stays wide forever. This
# is the only thing that fixes those.
#
# Scoped to a list rather than the whole tree on purpose: scripts/ holds the AWS
# CLI scripts this process executes (0700), and sandboxruns/ workspaces are
# mounted into the sandbox container, whose process is a different uid and must be
# able to read the code file. Both would break under a blanket 600.
for store in profiles history favorites collections settings public_client_creds chat llm sandbox; do
    find "${BASE_DIR}/artifacts/userartifacts" -type f -path "*/${store}/*" \
        -exec chmod 600 {} + 2>/dev/null || true
done

# The AWS CLI scripts stay owner-executable; only this process runs them. Excludes
# the Sandbox saved scripts, which live one level deeper, are never executed
# directly, and were just set to 600 by the loop above.
find "${BASE_DIR}/artifacts/userartifacts" -type f -path '*/scripts/*' \
    ! -path '*/sandbox/scripts/*' -exec chmod 700 {} + 2>/dev/null || true

# Sandbox mode runs user code in a sibling container, which means talking to the
# host's Docker daemon through a bind-mounted socket. The socket keeps its HOST
# ownership inside the container, so its group id is whatever the host uses (999
# on most Linux distros, 0 under Docker Desktop) and will not match any group
# www-data already belongs to. Add www-data to a group with that exact gid.
#
# Deliberately NOT `chmod 666`: the socket is the whole point of the grant and
# world-writable access to it is root on the host. Group membership keeps the
# grant to this one account. Mounting the socket at all is a privileged choice —
# if you don't want it, omit the mount and Sandbox mode reports itself as
# unavailable instead of failing mid-run.
DOCKER_SOCK=/var/run/docker.sock
if [ -S "${DOCKER_SOCK}" ]; then
    SOCK_GID=$(stat -c '%g' "${DOCKER_SOCK}" 2>/dev/null || echo '')
    if [ -n "${SOCK_GID}" ]; then
        SOCK_GROUP=$(getent group "${SOCK_GID}" | cut -d: -f1)
        if [ -z "${SOCK_GROUP}" ]; then
            SOCK_GROUP=dockerhost
            groupadd -g "${SOCK_GID}" "${SOCK_GROUP}" 2>/dev/null || true
        fi
        usermod -aG "${SOCK_GROUP}" www-data 2>/dev/null || \
            echo "docker-entrypoint: could not add www-data to group ${SOCK_GROUP}; Sandbox mode may be unavailable"
    fi
fi

exec gosu www-data "$@"
