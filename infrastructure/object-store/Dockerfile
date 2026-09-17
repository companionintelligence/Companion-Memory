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
#
# Pulled from quay.io, not Docker Hub: docker.io/minio/minio no longer exists
# (every tag, :latest included, answers "pull access denied"), which broke the
# publish build. MinIO's quay.io mirror carries the same RELEASE tags; this one's
# amd64 and arm64 layers are identical (rootfs diff_ids) to the base inside the
# already-published companion/object-store:2026.9.10 image.
ARG MINIO_VERSION=RELEASE.2025-04-22T22-12-26Z
FROM quay.io/minio/minio:${MINIO_VERSION}

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
