#!/usr/bin/env bash

# Cache-identity and reset helpers for the JDK cache benchmark.

set -euo pipefail

command=${1:?command is required}

# Spring PetClinic is checked out below the benchmark repository rather than over
# it, because its build runs a nohttp check across the whole basedir and would
# otherwise lint these scripts.
project_dir=${PROJECT_DIR:-petclinic}
wrapper_properties="$project_dir/.mvn/wrapper/maven-wrapper.properties"

purge_toolcache() {
  # The benchmark deliberately measures the path where the requested JDK is not
  # already installed on the runner image, because that is the only case in
  # which the JDK cache does any work.
  rm -rf "${RUNNER_TOOL_CACHE:?}"/Java_*
}

write_identity() {
  local benchmark_id=$1
  printf '%s\n' "$benchmark_id" > .jdk-cache-key
  # Appended, not overwritten: the real wrapper properties must survive because
  # the seed job builds. Appending only once keeps the hashed contents identical
  # between the seed job and every measured slot.
  local marker="# jdk-cache-benchmark=$benchmark_id"
  if [ ! -f "$wrapper_properties" ] || ! grep -qF -- "$marker" "$wrapper_properties"; then
    printf '%s\n' "$marker" >> "$wrapper_properties"
  fi
}

case "$command" in
  prepare)
    write_identity "${2:?benchmark id is required}"
    ;;
  purge-toolcache)
    purge_toolcache
    ;;
  reset)
    # Every measured slot must start from the same empty state. Without this the
    # second and later slots in a job would extract over files an earlier slot
    # left behind and report an artificially low duration.
    purge_toolcache
    rm -rf "$HOME/.m2"
    write_identity "${2:?benchmark id is required}"
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
