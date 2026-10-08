# Eclipse Remote Build

VS Code extension for an existing Eclipse CDT cross-compile environment hosted in Docker on an SSH target. It does **not** replace Eclipse project configuration.

## Implemented

- VS Code command **Eclipse Remote Build: Configure** opens a GUI for SSH destination, host sync root, Docker container, transfer selection, Eclipse profile, and archive definitions.
- Saves settings to workspace-relative `.vscode/eclipse-remote-build.json`.
- **Sync Only** and **Sync and Build** use `rsync -az --checksum` over SSH: unchanged file contents are not resent, and sources remain relative to the local workspace. Files explicitly declared in `sync.profileFiles` are also sent.
- The build executes Eclipse CDT Managed Build headlessly with `-importAll` and `-build project/configuration` **inside an existing container** using `docker exec`.
- The **Provision image** operation uploads the Dockerfile and archive paths and starts `docker build`.

## Prerequisites

Install Node.js, `npm`, OpenSSH, and `rsync` locally. The SSH host needs Docker, a reachable running Eclipse container with the workspace bind-mounted at `/workspace`, and Eclipse CDT plus its cross-toolchain already installed and runnable. SSH key-based login and verified host keys are required.

```sh
npm install
npm run compile
# F5 from VS Code to launch the Extension Development Host
```

Select **Eclipse Remote Build: Configure** from the Command Palette. Specify the SSH host and existing container. Set the Eclipse executable (e.g. `/opt/eclipse/eclipse`), Eclipse CDT project name and configuration (e.g. `Release`), and import folders relative to the workspace root.

A starting workspace config:

```json
{
  "ssh": { "host": "builder.internal", "port": 22, "user": "dev", "identityFile": "" },
  "remote": { "root": "/srv/eclipse-remote-build", "container": "eclipse-builder", "dockerCommand": "docker" },
  "sync": { "include": ["src", ".project", ".cproject"], "exclude": [".git/", "*.o"], "profileFiles": ["build/profiles/release.xml"] },
  "provision": { "baseImage": "ubuntu:24.04", "image": "eclipse-builder:local", "dockerfile": "docker/Dockerfile", "archives": [] },
  "profiles": [{ "name": "Release", "project": "MyProject", "configuration": "Release", "eclipseWorkspace": "/tmp/eclipse-workspace", "eclipseExecutable": "/opt/eclipse/eclipse", "imports": ["."], "extraArgs": [], "environment": {} }]
}
```

## Deployment contract

Remote host receives `<remote.root>/<workspace-relative-path>`. Mount this host root as **`/workspace`** in the container. Example:

```sh
docker run -d --name eclipse-builder \
  -v /srv/eclipse-remote-build:/workspace \
  eclipse-builder:local
```

The image build command only builds an image; it does **not** start/replace existing containers. The current Dockerfile is a baseline and does **not** yet automatically unpack GUI archive definitions. Custom Eclipse/toolchain archive installation is the next integration step.

## Known limitations (initial implementation)

Single-root local workspace. No download of generated artifacts (intentionally deferred). No remote clean or deletion of removed local files. Archive metadata is currently editable and validated but not yet applied to image creation. No native local-transport-gateway-assets integration or end-to-end Sandbox test yet.

## Security

Uses argument-array local processes and strict SSH host-key verification. Configure SSH permissions and Docker access on the target. Treat the configuration file as source-controlled nonsecret metadata; never store secrets in environment profiles. Executed build arguments are supplied to Eclipse inside Docker.
