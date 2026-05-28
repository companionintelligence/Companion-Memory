FROM alpine:3.21

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# First-boot secret generator. Creates a shared secrets
# file with randomised credentials for all services.
# Idempotent — skips generation if the file exists.
#
# Optional:
#   SECRETS_FILE               Output path for generated secrets [/run/secrets/.env.secrets]
# ──────────────────────────────────────────────────

ENTRYPOINT ["entrypoint.sh"]
