ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash tar gzip xz-utils unzip libgtk-3-0 libnss3 libasound2t64 default-jre-headless && rm -rf /var/lib/apt/lists/*
COPY . /staging
# User-provided archives are extracted by the generated provisioning script,
# not automatically executed. Run docker/install-archives.sh inside build when configured.
WORKDIR /workspace
CMD ["sleep","infinity"]
