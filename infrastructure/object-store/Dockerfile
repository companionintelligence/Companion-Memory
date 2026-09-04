# Pinned like every other base image in this repo (postgres:18.4-bookworm,
# nginx:1.28.0-bookworm, node:22.15.1-slim). Untagged, this resolved to
# whatever :latest happened to be on the build host, so an appliance rebuild
# could silently swap the object store under live data — and MinIO has shipped
# behaviour-changing releases (the admin console was removed mid-2025) that
# would land without anyone choosing them.
#
# MinIO's only version scheme is the RELEASE.<timestamp> tag; there is no
# semver tag to use instead. Override MINIO_VERSION to move the pin
# deliberately, and re-verify the object store still boots after doing so.
ARG MINIO_VERSION=RELEASE.2025-04-22T22-12-26Z
FROM minio/minio:${MINIO_VERSION}

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
#
# Required (no default — will not start without these):
#   PASSWORD                   MinIO root secret key
#   USERNAME                   MinIO root access key
#
# Optional:
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
# ──────────────────────────────────────────────────

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["server", "/data/objects", "--console-address", ":9001"]
