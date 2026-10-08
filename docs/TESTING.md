# Interactive testing

## Local VS Code UI

1. Run `npm install && npm run compile`.
2. Open this repository in VS Code. Press F5.
3. Run **Eclipse Remote Build: Configure**.
4. Add a test SSH host, workspace-relative file paths and Eclipse profile.
5. Use **Sync** and inspect the Output panel to verify rsync changes.
6. Change one source file, repeat Sync, and confirm unchanged files are not uploaded.
7. Use **Sync & Build**, inspect the actual Eclipse CDT exit code and remote log.

## Automated branch CI through local-transport-gateway-assets

The file `.local_relay/workflow.json` enables the gateway's branch CI. It requests a Sandbox with Node.js/npm and executes installation, TypeScript check, compile and VSIX packaging. CI results will be stored under `.local_relay/results/<run-id>/` by the relay if a connected Sandbox is available.

This verifies the extension build **only**. It does not mean a remote SSH/Eclipse/Docker integration test has passed.

## Do not commit

Real host addresses, private keys, tokens, injected secrets, SSH config, or Sandbox connection credentials. Test target settings should be kept in local user files or ignored workspace paths.
