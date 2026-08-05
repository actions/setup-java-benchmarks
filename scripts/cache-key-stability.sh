#!/usr/bin/env bash

# Tree arrangement for the cache key stability check.
#
# This is not a benchmark. It asserts properties of the cache key, because a key
# that changes when it should not costs a full cache miss, and a miss costs more
# than every timing effect the rest of this repository measures put together. On
# Spring PetClinic a miss is roughly a minute; the timing benchmarks resolve
# effects of tens of milliseconds.
#
# The probes never create ~/.m2. setup-java skips its post-job save when the
# configured path does not exist ("Path Validation Error ... hence no cache is
# being saved"), so the whole check runs without storing a single cache entry.

set -euo pipefail

command=${1:?command is required}

project_dir=${PROJECT_DIR:-petclinic}
pom="$project_dir/pom.xml"
pristine_pom=".cache-key-pristine-pom.xml"

first_java_source() {
  find "$project_dir/src" -name '*.java' | sort | head -n 1
}

case "$command" in
  init)
    # A pristine copy so that the probe which edits the pom can be undone
    # exactly. Restoring with git would also revert the checkout of PetClinic
    # itself, and reverting by editing back risks leaving a trailing newline that
    # changes the hash.
    cp "$pom" "$pristine_pom"
    rm -rf "$HOME/.m2"
    ;;
  restore-tree)
    cp "$pristine_pom" "$pom"
    rm -rf "$HOME/.m2"
    ;;
  touch-unrelated)
    # A source file is not part of any dependency-manifest pattern, so hashing it
    # would be a defect. This is the change that most often breaks caching in the
    # wild: a key that tracks the whole tree misses on every commit.
    source_file=$(first_java_source)
    if [ -z "$source_file" ]; then
      echo "No Java source found under $project_dir/src" >&2
      exit 1
    fi
    printf '\n// cache key stability probe\n' >> "$source_file"
    printf 'cache key stability probe\n' >> "$project_dir/README.md"
    echo "Modified $source_file and README.md"
    ;;
  touch-dependencies)
    # A comment in the XML epilog is well-formed and changes the file's hash
    # without changing what Maven resolves, which is what the key is supposed to
    # track.
    printf '<!-- cache key stability probe -->\n' >> "$pom"
    ;;
  record)
    # Written as CSV rather than read from step outputs in the checker, because
    # a key that comes back empty must be recorded as empty and diagnosed there
    # rather than silently collapsing two probes into one equal pair.
    results=${2:?results file is required}
    probe=${3:?probe name is required}
    key=${4-}
    mkdir -p "$(dirname "$results")"
    printf '"%s","%s","%s","%s"\n' \
      "${RUNNER_LABEL:?RUNNER_LABEL is required}" \
      "${RUNNER_REPLICA:?RUNNER_REPLICA is required}" \
      "$probe" "$key" >> "$results"
    echo "$probe: ${key:-<empty>}"
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
