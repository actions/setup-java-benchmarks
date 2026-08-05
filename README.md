# setup-java benchmarks

This repository compares [`actions/setup-java@v1.4.4`](https://github.com/actions/setup-java/releases/tag/v1.4.4), [`actions/setup-java@v2.5.1`](https://github.com/actions/setup-java/releases/tag/v2.5.1), [`actions/setup-java@v3.14.1`](https://github.com/actions/setup-java/releases/tag/v3.14.1), [`actions/setup-java@v4.8.0`](https://github.com/actions/setup-java/releases/tag/v4.8.0), [`actions/setup-java@v5.2.0`](https://github.com/actions/setup-java/releases/tag/v5.2.0), [`actions/setup-java@v5.6.0`](https://github.com/actions/setup-java/releases/tag/v5.6.0), and the unreleased [`actions/setup-java@main`](https://github.com/actions/setup-java/tree/main) using [Spring PetClinic](https://github.com/spring-projects/spring-petclinic).

The benchmark is designed around the two costs that matter to Actions users:

- **Execution time:** setup, build, cache restore, and post-job cache save durations.
- **Cache storage:** compressed JDK, Maven dependency, and Maven Wrapper cache sizes.

## Scenarios

Each action version runs with Java 17 on `ubuntu-24.04`:

| Distribution | Expected setup path | Purpose |
| --- | --- | --- |
| Eclipse Temurin | Hosted runner tool-cache hit | Measures setup overhead when the JDK is already available |
| Microsoft Build of OpenJDK | JDK download and extraction | Measures setup overhead when the JDK must be installed |

v1 predates distribution selection and integrated dependency caching. It runs only its native Zulu installer path. v2 supports the Temurin and Microsoft scenarios, but its bundled legacy cache client is rejected by the current Actions cache service. v1 and v2 therefore have no Maven cache storage, and their cold/warm labels are repeated uncached samples.

Every combination gets an isolated cache key and runs twice:

1. **Cold:** no dependency or wrapper cache exists; the post action saves every cache supported by that version.
2. **Warm:** restores the caches created by the matching cold job.

v3, v4, and v5.2 cache only Maven dependencies. v5.6 and `main` also cache the Maven Wrapper distribution separately, making the storage and execution-time tradeoff visible. Because v3 predates `cache-dependency-path`, its benchmark identity is an inert XML comment appended to `pom.xml`; later versions use a dedicated marker file.

Spring PetClinic and third-party actions are pinned to commits. `setup-java@main` intentionally remains a moving ref so each run evaluates the current upcoming v6 code; the report records the `main` commit observed when it is generated.

## Running

Open **Actions > Benchmark setup-java > Run workflow**. Choose one, three, or five independent samples. Three is the default.

The report job writes a Markdown summary and uploads raw JSON and CSV files. Benchmark-created caches are deleted after measurement by default, preventing repeated runs from consuming repository cache storage. Disable cleanup when you need to inspect the entries manually.

### Focused cache restore

The **Focused cache restore** workflow isolates the setup step to compare two `actions/setup-java` refs (by default `v4.8.0` against `main`). It uses a pinned Temurin JDK from the hosted runner tool cache, seeds a synthetic 160 MiB dependency cache for both arms and a 9 MiB wrapper cache for the candidate, and runs no Maven command. Measurement jobs therefore contain no JDK or Maven Central downloads; they measure JDK discovery and Actions cache restoration only.

This workflow is the reference for how a comparison should be measured here. Three properties make its verdicts trustworthy:

**Millisecond timing.** The Actions API reports step `started_at` and `completed_at` only to the nearest second. Setup steps take two to six seconds, so reading durations from the API quantizes every measurement to ±500 ms — the same magnitude as the effects being measured. Timing is therefore taken inside the job with `scripts/measure.mjs`.

**Same-runner pairing.** Between-runner variance on hosted runners is larger than the effects under test, and it cannot be averaged away by adding more independent jobs to each arm. Both arms run in the *same* job in ABBA order — baseline, candidate, candidate, baseline — so each runner yields one paired difference with the runner's own speed cancelled out. The mirrored order also cancels drift across the four slots. Each measured slot deletes `~/.m2` first so every restore extracts into an empty tree.

**Intervals, not point estimates.** `scripts/stats.mjs` reports a bootstrap 95% confidence interval, a permutation p-value, and a Hodges-Lehmann shift for every comparison, and turns them into an explicit verdict. A comparison whose interval includes zero is reported as `inconclusive` rather than as a number that looks like a result.

The report also publishes two guard rails:

- A **noise floor**, the median spread between the two slots of the same arm on one runner. An effect smaller than this is reported as `within-noise` even when its interval excludes zero.
- An **A/A control**, the same estimator applied to the baseline against itself. It costs no extra jobs because each arm is already measured twice per runner. A healthy run reports `within-noise` or `inconclusive`; anything else means slot ordering is biasing the results and the headline verdict cannot be trusted.

Point `baseline-ref` and `candidate-ref` at any two refs — including a PR branch — to check whether a change delivers a real improvement.

#### Why this replaced the previous design

The earlier version of this workflow ran each arm as its own matrix of independent jobs, read durations from the Actions API, and reported a "paired median delta" that paired `sample N` of one arm with `sample N` of the other. Those samples shared no runner and no point in time, so the pairing removed no variance at all.

Two consecutive runs of that harness against an unchanged `v4.8.0` — where the true difference is exactly zero — produced medians of 2 s and 3 s, a spurious 1.2 s separation whose confidence interval excluded zero. Over the same pair of runs the reported candidate delta flipped from +0.6 s to −0.8 s. `scripts/stats.test.mjs` pins that dataset as a regression test so unpaired sampling is not reintroduced.

### JDK cache

The **JDK cache** workflow measures the installed-JDK cache added on `actions/setup-java@main`. It compares a baseline arm with `cache-jdk: false` against a treatment arm with `cache-jdk: true`, defaulting to Microsoft Build of OpenJDK 17. Both arms use the same action ref so the result isolates JDK caching instead of conflating it with implementation changes between commits. Each arm first seeds its Maven dependency and wrapper caches by compiling Spring PetClinic. The treatment seed also downloads and saves the JDK. Warm matrix jobs then use `cache-read-only: true`, so they restore caches without creating entries or racing to save the same key.

JDK cache keys are derived from the JDK's identity and source; unlike dependency cache keys, they cannot be namespaced per iteration. The seed/read-only design avoids cross-contamination between samples. Every seed and measurement job also removes matching JDKs from `$RUNNER_TOOL_CACHE` before setup, deliberately measuring the not-preinstalled path and preventing a hosted-runner tool-cache hit from bypassing JDK cache restore and save logic. Select Temurin to test that same forced-miss path with a distribution normally preinstalled on hosted runners.

Open **Actions > JDK cache > Run workflow** to select the distribution, Java version, warm sample count, and cache cleanup behavior. The report compares warm setup, build, post-step, and job medians; records cold seed setup and JDK save time; and reports the JDK, dependency, and wrapper cache sizes.

### Maven configuration warm path

The **Maven configuration warm path** workflow compares two `actions/setup-java` refs in the action's own Maven configuration path. It checks out a configurable setup-java repository, runs baseline and candidate refs on Linux, Windows, and macOS, and covers Maven cache, Gradle cache, no-cache, single-version, multi-version, empty toolchains, and existing toolchains scenarios.

Each matrix entry alternates three warm in-job setup runs for the baseline and candidate implementations, then reports median and p95 setup time. The workflow also records `dist/setup/index.js`, total `dist/setup` JavaScript bytes, and the JavaScript chunk files containing the XML parser.

## Reading results

The summary reports medians for:

- setup time, including JDK discovery/download and dependency-cache restore;
- Spring PetClinic `compile` time;
- the `setup-java` post step that saves caches;
- compressed cache storage per isolated case;
- estimated billed minutes, calculated by rounding each Linux job to a whole minute.

Public repositories do not pay for standard GitHub-hosted runners. The estimated minutes are included to make the results applicable to private repositories; actual charges depend on the account plan and runner type.

Network throughput, hosted-runner image changes, upstream artifact availability, and runner load all introduce variance. The **Benchmark setup-java** and **JDK cache** workflows still read step durations from the Actions API at one-second resolution and compare arms across independent runners, so treat their sub-second differences as indicative only and compare multiple runs before drawing conclusions. Use **Focused cache restore** when a difference needs to be established rather than illustrated; it is the only workflow here that reports a confidence interval, a noise floor, and an A/A control.

## Local checks

```bash
npm test
bash -n scripts/*.sh
shellcheck scripts/*.sh
```
