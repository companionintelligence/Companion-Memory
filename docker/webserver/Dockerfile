FROM nginx:stable

RUN apt-get update && apt-get install -y tini && apt-get clean

COPY frontend/apps/web/dist /usr/share/nginx/html/ci/web

EXPOSE 8642

ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["nginx", "-g", "daemon off;"]
