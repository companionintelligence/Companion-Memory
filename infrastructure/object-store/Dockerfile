# Object store is RustFS (Apache-2.0, S3 API). MinIO no longer publishes a
# community image, so this no longer builds FROM a vendored MinIO base.
#
# Pin a release tag. rustfs/rustfs:1.0.0 is a multi-arch manifest (amd64 and
# arm64). Override RUSTFS_VERSION to move the pin deliberately.
#
# The upstream image runs as uid 10001 (user rustfs) and its entrypoint is
# /entrypoint.sh. Ours reads OBJECT_STORE_USERNAME / OBJECT_STORE_PASSWORD,
# makes the data directory writable by that user, then execs the upstream
# entrypoint. Hub bind mounts are created root-owned, and RustFS will not
# store objects in a directory that user cannot write.
ARG RUSTFS_VERSION=1.0.0
FROM rustfs/rustfs:${RUSTFS_VERSION}

USER root
RUN apk add --no-cache su-exec

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/ci-object-store-entrypoint.sh

# Single directory. A one-drive deployment cannot later become a multi-drive
# set in place (RustFS follows MinIO's rule). Several drives means starting
# with several paths, via RUSTFS_VOLUMES, and a fresh volume.
ENV RUSTFS_VOLUMES=/data \
    RUSTFS_ADDRESS=:9000 \
    RUSTFS_CONSOLE_ADDRESS=:9001

ENTRYPOINT ["/usr/local/bin/ci-object-store-entrypoint.sh"]
CMD ["rustfs"]
