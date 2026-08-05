#!/usr/bin/env bash

# Fixture and cache-identity helpers for the focused cache restore benchmark.

set -euo pipefail

command=${1:?command is required}

dependency_fixture="$HOME/.m2/repository/focused-benchmark/dependencies.bin"
wrapper_fixture="$HOME/.m2/wrapper/dists/focused-benchmark/wrapper.bin"

write_identity() {
  local benchmark_id=$1
  printf '%s\n' "$benchmark_id" > .focused-cache-key
  mkdir -p .mvn/wrapper
  printf 'wrapperVersion=focused\n# benchmark-id=%s\n' "$benchmark_id" \
    > .mvn/wrapper/maven-wrapper.properties
}

case "$command" in
  prepare)
    write_identity "${2:?benchmark id is required}"
    ;;
  seed-fixtures)
    mkdir -p "$(dirname "$dependency_fixture")" "$(dirname "$wrapper_fixture")"
    head -c "$((DEPENDENCY_FIXTURE_MIB * 1024 * 1024))" /dev/urandom > "$dependency_fixture"
    head -c "$((WRAPPER_FIXTURE_MIB * 1024 * 1024))" /dev/urandom > "$wrapper_fixture"
    ;;
  reset)
    # Each measured slot must restore into an empty tree, otherwise the second
    # and later restores in a job would extract over files that already exist
    # and report an artificially low duration.
    rm -rf "$HOME/.m2"
    write_identity "${2:?benchmark id is required}"
    ;;
  verify)
    arm=${2:?arm is required}
    actual=$(wc -c < "$dependency_fixture")
    expected=$((DEPENDENCY_FIXTURE_MIB * 1024 * 1024))
    if [ "$actual" -ne "$expected" ]; then
      echo "Dependency fixture for $arm is $actual bytes, expected $expected" >&2
      exit 1
    fi
    # Only the candidate arm is expected to maintain a separate wrapper cache;
    # a baseline that also produces one is fine, so this check is arm-specific
    # and non-fatal when the fixture is simply absent for the baseline.
    if [ "$arm" = "candidate" ]; then
      actual=$(wc -c < "$wrapper_fixture")
      expected=$((WRAPPER_FIXTURE_MIB * 1024 * 1024))
      if [ "$actual" -ne "$expected" ]; then
        echo "Wrapper fixture for $arm is $actual bytes, expected $expected" >&2
        exit 1
      fi
    fi
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
