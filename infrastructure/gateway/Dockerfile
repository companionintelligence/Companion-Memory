FROM nginx:1.28.0-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

COPY LICENSE /LICENSE
COPY frontend/apps/web/dist /usr/share/nginx/html/ci/web
COPY infrastructure/gateway/nginx.conf /etc/nginx/nginx.conf

EXPOSE 8642

ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["nginx", "-g", "daemon off;"]
