FROM alpine:3.24

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# First-boot secret generator. Creates the master secrets
# file with randomised credentials, then projects one
# per-service file (only the keys that service reads)
# under SECRETS_PROJECTION_ROOT/<service>/.env.secrets.
# Idempotent — an existing master keeps its values, gains
# missing keys, and is re-projected on every boot.
#
# Optional:
#   SECRETS_FILE               Master secrets file, mounted into this container only [/run/secrets/.env.secrets]
#   SECRETS_PROJECTION_ROOT    Parent of the per-service projections [/run/secrets/services]
# ──────────────────────────────────────────────────

ENTRYPOINT ["entrypoint.sh"]
