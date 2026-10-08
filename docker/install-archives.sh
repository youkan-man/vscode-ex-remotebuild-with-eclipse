#!/usr/bin/env bash
set -euo pipefail
manifest="${1:-/staging/.vscode/eclipse-archives.tsv}"
[ -f "$manifest" ] || exit 0
while IFS=$'\t' read -r src dest strip; do
  [[ -n "$src" ]] || continue
  [[ "$src" != /* && "$src" != *..* ]] || exit 2
  [[ "$dest" == /* && "$dest" != *..* ]] || exit 2
  mkdir -p "$dest"
  case "$src" in
    *.tar.gz|*.tgz|*.tar.xz|*.tar) tar -xf "/staging/$src" -C "$dest" --strip-components="${strip:-0}";;
    *.zip) unzip -oq "/staging/$src" -d "$dest";;
    *) echo "Unsupported archive: $src" >&2; exit 3;;
  esac
done < "$manifest"
