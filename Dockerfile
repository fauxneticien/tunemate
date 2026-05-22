FROM python:3.10-slim

# System deps: node for build/build_search_index.mjs, curl + tar for
# the download-data task, ca-certs for HTTPS to GitHub/CDNs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    curl \
    ca-certificates \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Task (go-task) so the same `task` commands work inside and outside the container.
RUN curl -sSL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin

WORKDIR /app

EXPOSE 8000

CMD ["task", "serve"]
