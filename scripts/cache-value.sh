#!/usr/bin/env bash

# Fixture helpers for the cache value benchmark.
#
# This benchmark answers the question the rest of the suite was missing: what
# does the Maven cache actually save a real project? Both arms run the same
# resolve against the same dependency tree. The only difference is whether
# setup-java restored the local repository first, so the difference between them
# is the whole value of the feature rather than a detail of its implementation.

set -euo pipefail

command=${1:?command is required}

# Spring PetClinic is checked out below the benchmark repository rather than over
# it, because its build runs a nohttp check across the whole basedir and would
# otherwise lint these scripts.
project_dir=${PROJECT_DIR:-petclinic}

write_identity() {
  # The cached arm keys on this file rather than on the real pom, so the key is
  # fixed for the run and every slot restores the entry the seed job stored.
  printf '%s\n' "${1:?benchmark id is required}" > .cache-value-key
}

case "$command" in
  prepare)
    write_identity "${2:?benchmark id is required}"
    ;;
  reset)
    # Every slot must resolve into an empty local repository. Leaving artifacts
    # behind would let the uncached arm resolve from what an earlier cached slot
    # restored, which is the one thing this benchmark must not allow: it would
    # report that the cache saves nothing.
    rm -rf "$HOME/.m2"
    write_identity "${2:?benchmark id is required}"
    ;;
  resolve)
    # Both arms run this identical command. The cached arm finds the artifacts in
    # the restored repository; the uncached arm fetches them from Maven Central.
    # Keeping the command identical is what makes the difference attributable to
    # the cache rather than to the work being done.
    cd "$project_dir"
    ./mvnw --batch-mode --no-transfer-progress dependency:go-offline
    ;;
  verify)
    # Checked from setup-java's own `cache-hit` output rather than by inspecting
    # the restored tree, because inspecting it costs a `du` over a few hundred
    # MiB and this has to run outside the timed span to stay out of the
    # measurement.
    #
    # A silent miss on the cached arm is the failure that matters: both arms
    # would then download from Maven Central and the benchmark would report,
    # with a perfectly tight interval, that the cache is worthless.
    arm=${2:?arm is required}
    cache_hit=${3-}
    case "$arm" in
      cached)
        if [ "$cache_hit" != "true" ]; then
          echo "The cached arm reported cache-hit='$cache_hit'; the seeded" \
            "entry was not restored, so this slot measured a download rather" \
            "than a restore" >&2
          exit 1
        fi
        ;;
      uncached)
        if [ -n "$cache_hit" ]; then
          echo "The uncached arm reported a cache-hit value ('$cache_hit');" \
            "it must run with caching disabled" >&2
          exit 1
        fi
        ;;
      *)
        echo "Unsupported arm: $arm" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
