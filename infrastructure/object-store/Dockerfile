# Object store is RustFS (Apache-2.0, S3 API). MinIO no longer publishes a
# community image, so this no longer builds FROM a vendored MinIO base.
#
# Pin a release tag. rustfs/rustfs:1.0.0 is a multi-arch manifest (amd64 and
# arm64). Override RUSTFS_VERSION to move the pin deliberately.
#
# The upstream image runs as uid 10001 (user rustfs) and its entrypoint is
# /entrypoint.sh. Ours reads OBJECT_STORE_USERNAME / OBJECT_STORE_PASSWORD,
# refuses to start unless the data directory is a mounted volume, hands the
# whole tree to that user, then execs the upstream entrypoint. Hub bind mounts
# are created root-owned, and everything MinIO wrote is root-owned too (it
# ran as root, and still does if an install rolls back to it): RustFS reads
# those objects but cannot overwrite or delete them.
#
# RustFS reads and writes MinIO's on-disk format (xl.meta, xl-single) in
# place, so an existing MinIO volume is served as-is — no data migration.
ARG RUSTFS_VERSION=1.0.0
FROM rustfs/rustfs:${RUSTFS_VERSION}

USER root
RUN apk add --no-cache su-exec

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/ci-object-store-entrypoint.sh

# Single directory. A one-drive deployment cannot later become a multi-drive
# set in place (RustFS follows MinIO's rule). Several drives means starting
# with several paths, via RUSTFS_VOLUMES, and a fresh volume.
#
# /data/objects, not the upstream default /data: it is where every compose
# file and CI-Marketplace's hand-maintained apps/ci-memory/docker-compose.json
# already mount the volume, so this image and the MinIO one it replaces run
# under the same manifest and a rollback is an image change alone. A path
# that differs from the manifest's serves an empty store instead of the data.
ENV RUSTFS_VOLUMES=/data/objects \
    RUSTFS_ADDRESS=:9000 \
    RUSTFS_CONSOLE_ADDRESS=:9001

# The probe lives with the server it probes: /health is RustFS's own, and
# MinIO answers it 403 (RustFS also answers MinIO's /minio/health/live, but
# that is a compatibility shim, not its documented probe). Compose's
# `service_healthy` dependencies and `up --wait` use this, as does any Hub
# install. start-period covers the first boot's ownership walk.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD curl -f http://localhost:9000/health || exit 1

ENTRYPOINT ["/usr/local/bin/ci-object-store-entrypoint.sh"]
CMD ["rustfs"]
