FROM nginx:1.29.1-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

COPY LICENSE.md /LICENSE.md
COPY frontend/apps/web/dist /usr/share/nginx/html/ci/web
COPY infrastructure/gateway/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=755 infrastructure/gateway/entrypoint.sh /usr/local/bin/gateway-entrypoint.sh

# nginx.conf includes this file unconditionally; the entrypoint rewrites it
# from TRUSTED_PROXY_CIDRS at start, and an empty one is what "trust nothing"
# looks like if the entrypoint is ever bypassed.
RUN : > /etc/nginx/trusted-proxies.conf

# ──────────────────────────────────────────────────
# Environment Variables
#
# Optional:
#   TRUSTED_PROXY_CIDRS   Comma-separated addresses/CIDRs of the reverse proxies
#                         in front of this gateway (a Hub sets it). X-Forwarded-For
#                         is walked back past these to find the client. Empty (the
#                         default) trusts nothing — $remote_addr is the peer.
# ──────────────────────────────────────────────────

EXPOSE 8642

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gateway-entrypoint.sh"]

CMD ["nginx", "-g", "daemon off;"]
