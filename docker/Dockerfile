ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash python3 tar gzip bzip2 xz-utils unzip make libgtk-3-0 libnss3 libasound2t64 default-jre-headless && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep","infinity"]
