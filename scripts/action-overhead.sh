#!/usr/bin/env bash

set -euo pipefail

command=${1:?command is required}

benchmark_home="$PWD/benchmark-maven-home"
results_dir="$PWD/.benchmark-results"
sizes_file="$results_dir/action-overhead-sizes.csv"

# Roughly a megabyte spread over many small files. The point of this scenario is
# to measure what setup-java's own code costs, so the entry has to be small
# enough that the transfer is not what is being timed, while still being made of
# many files rather than one, because archiving cost tracks file count as much as
# it tracks bytes.
fixture_files=200
fixture_file_kib=5

write_manifest() {
  identity=$1

  mkdir -p benchmark
  # The cache key is a hash of this file, so the identity written into it is what
  # decides whether a slot hits the seeded entry or misses. Every byte outside
  # the identity has to be stable, or two slots that should share an entry would
  # compute different keys.
  cat > benchmark/pom.xml <<XML
<project>
  <benchmarkIdentity>$identity</benchmarkIdentity>
</project>
XML
  cat > benchmark/build.gradle <<GRADLE
plugins { id("java") }
// benchmark identity: $identity
GRADLE
}

write_toolchains() {
  toolchains_profile=$1

  if [ "$toolchains_profile" = "existing" ]; then
    cat > "$benchmark_home/toolchains.xml" <<'XML'
<toolchains xmlns="http://maven.apache.org/TOOLCHAINS/1.0.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/TOOLCHAINS/1.0.0 http://maven.apache.org/xsd/toolchains-1.0.0.xsd">
  <toolchain>
    <type>foo</type>
    <provides>
      <custom>preserved</custom>
    </provides>
    <configuration>
      <fooHome>/opt/foo</fooHome>
    </configuration>
  </toolchain>
</toolchains>
XML
  elif [ "$toolchains_profile" != "empty" ]; then
    echo "Unsupported toolchains profile: $toolchains_profile" >&2
    exit 1
  fi
}

case "$command" in
  # Build the tiny local repository that the seed job stores, so that the
  # measured `maven-hit` slots have something real to restore.
  seed-fixture)
    identity=${2:?identity is required}

    rm -rf "$benchmark_home"
    mkdir -p "$benchmark_home"
    write_manifest "$identity"

    repository="$HOME/.m2/repository/com/example/benchmark"
    rm -rf "$HOME/.m2"
    mkdir -p "$repository"
    for index in $(seq 1 "$fixture_files"); do
      # Random rather than zeroes so the archive cannot be compressed away to
      # nothing, which would make the seeded entry unrepresentative of a real
      # local repository full of already-compressed jars.
      dd if=/dev/urandom "of=$repository/artifact-$index.jar" \
        bs=1024 count="$fixture_file_kib" status=none
    done
    ;;
  prepare)
    cache_profile=${2:?cache profile is required}
    toolchains_profile=${3:?toolchains profile is required}
    identity=${4:?identity is required}


    rm -rf "$benchmark_home"
    mkdir -p "$benchmark_home"
    write_manifest "$identity"
    write_toolchains "$toolchains_profile"

    # Every slot starts from an absent cache directory. Restoring on top of an
    # existing tree would let the second slot in an arm do less work than the
    # first, and it also keeps setup-java from saving anything on the profiles
    # that are supposed to miss: the action skips its post-job save when the
    # configured path does not exist.
    case "$cache_profile" in
      none | maven-miss | maven-hit)
        rm -rf "$HOME/.m2"
        ;;
      gradle-miss)
        rm -rf "$HOME/.gradle"
        ;;
      *)
        echo "Unsupported cache profile: $cache_profile" >&2
        exit 1
        ;;
    esac
    ;;
  start)
    mkdir -p "$results_dir"
    node scripts/measure.mjs start
    ;;
  record)
    results_file=${2:?results file is required}
    os=${3:?os is required}
    cache_profile=${4:?cache profile is required}
    layout=${5:?layout profile is required}
    arm=${6:?arm is required}
    slot=${7:?slot is required}
    cache_hit=${8:-}

    mkdir -p "$results_dir"
    # An empty cache-hit output is not the same as a miss: the `none` profile
    # never asks about the cache, and refs older than the output's introduction
    # report nothing. Recording that distinction lets the report tell a genuine
    # miss apart from a slot it cannot verify.
    node scripts/measure.mjs record "$results_file" \
      "$os" "$cache_profile" "$layout" "$arm" "$slot" "${cache_hit:-unset}"
    ;;
  record-size)
    arm=${2:?arm is required}
    action_path=${3:?action path is required}

    mkdir -p "$results_dir"
    index_bytes=$(node -e "const fs=require('fs'); process.stdout.write(String(fs.statSync(process.argv[1]).size))" "$action_path/dist/setup/index.js")
    js_bytes=$(node -e "const fs=require('fs'); const path=require('path'); let total=0; for (const entry of fs.readdirSync(process.argv[1])) { if (entry.endsWith('.js')) total += fs.statSync(path.join(process.argv[1], entry)).size; } process.stdout.write(String(total));" "$action_path/dist/setup")
    chunk_count=$(find "$action_path/dist/setup" -maxdepth 1 -name '*.js' | wc -l | tr -d ' ')
    printf '%s,%s,%s,%s\n' \
      "$arm" "$index_bytes" "$js_bytes" "$chunk_count" \
      >> "$sizes_file"
    ;;
  # Every run stores three fresh entries whose keys are hashes, so nothing about
  # the name says which run owns them. The seed jobs record the keys the action
  # reported; this deletes exactly those.
  delete-seeded)
    repository=${2:?repository is required}

    found=0
    while IFS= read -r key_file; do
      key=$(tr -d '\r\n' < "$key_file")
      if [ -z "$key" ]; then
        # Older refs do not publish `cache-primary-key`, so seeding with one
        # leaves an entry that has to age out on its own.
        echo "No key recorded in $key_file; nothing to delete for it." >&2
        continue
      fi
      found=$((found + 1))
      if gh cache delete "$key" --repo "$repository"; then
        echo "Deleted $key"
      else
        echo "Could not delete $key; it will expire on its own." >&2
      fi
    done < <(find "$results_dir" -name 'seeded-key-*.txt' -type f)

    if [ "$found" -eq 0 ]; then
      echo "No seeded cache keys were recorded." >&2
    fi
    ;;
  *)
    echo "Unsupported command: $command" >&2
    exit 1
    ;;
esac
