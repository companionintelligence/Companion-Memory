FROM minio/minio

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
