#!/usr/bin/env bash

# Cache-identity helpers for the setup-java version sweep.
#
# Markers are appended idempotently so that repeating a slot does not change the
# hashed files. The warm sweep depends on that: every slot must derive the same
# cache key, otherwise it would miss and measure a download instead of a restore.

set -euo pipefail

command=${1:?command is required}
benchmark_id=${2:?benchmark id is required}

wrapper_properties=.mvn/wrapper/maven-wrapper.properties

append_once() {
  local file=$1 line=$2
  if [ ! -f "$file" ] || ! grep -qF "$line" "$file"; then
    printf '%s\n' "$line" >> "$file"
  fi
}

write_identity() {
  # Versions from v4 onwards select their cache key with cache-dependency-path,
  # so a single file drives all of them.
  printf '%s\n' "$benchmark_id" > .benchmark-cache-key
  # v5.6 and main additionally maintain a wrapper cache keyed on the wrapper
  # properties. The real contents must survive because the seed job builds.
  append_once "$wrapper_properties" "# benchmark-id=$benchmark_id"
  # v3 predates cache-dependency-path and hashes pom.xml. A comment in the
  # epilog is well-formed XML and leaves the build unaffected.
  append_once pom.xml "<!-- benchmark-id=$benchmark_id -->"
}

case "$command" in
  prepare)
    write_identity
    ;;
  reset)
    # Every measured slot must restore into an empty tree, otherwise later slots
    # would extract over files an earlier slot left behind and report an
    # artificially low duration.
    rm -rf "$HOME/.m2"
    write_identity
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
