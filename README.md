# setup-java benchmarks

This repository compares [`actions/setup-java@v1.4.4`](https://github.com/actions/setup-java/releases/tag/v1.4.4), [`actions/setup-java@v2.5.1`](https://github.com/actions/setup-java/releases/tag/v2.5.1), [`actions/setup-java@v3.14.1`](https://github.com/actions/setup-java/releases/tag/v3.14.1), [`actions/setup-java@v4.8.0`](https://github.com/actions/setup-java/releases/tag/v4.8.0), [`actions/setup-java@v5.2.0`](https://github.com/actions/setup-java/releases/tag/v5.2.0), [`actions/setup-java@v5.6.0`](https://github.com/actions/setup-java/releases/tag/v5.6.0), and the unreleased [`actions/setup-java@main`](https://github.com/actions/setup-java/tree/main) using [Spring PetClinic](https://github.com/spring-projects/spring-petclinic).

The benchmark is designed around the two costs that matter to Actions users:

- **Execution time:** setup, build, cache restore, and post-job cache save durations.
- **Cache storage:** compressed JDK, Maven dependency, and Maven Wrapper cache sizes.

## Methodology

Every workflow here measures effects of a few hundred milliseconds to a few seconds on hosted runners, where the variance between runners is larger than the effect. Four properties are what make a result mean something, and all four workflows now share them.

**Millisecond timing.** The Actions API reports step `started_at` and `completed_at` only to the nearest second. Setup steps take two to six seconds, so reading durations from the API quantizes every measurement to ±500 ms — the same magnitude as the effects being measured. Timing is taken inside the job with `scripts/measure.mjs`.

**Same-runner pairing.** Between-runner variance cannot be averaged away by adding more independent jobs to each arm. Every arm is measured inside the *same* job, in an order mirrored about the middle of the job: ABBA for two arms, and `v1..main` followed by `main..v1` for the version sweep. Differencing within a runner removes the runner's own speed, and the mirrored order cancels drift that is linear across the job. Each measured slot deletes `~/.m2` first so every restore extracts into an empty tree.

Every job also runs one unmeasured warm-up slot first. The first setup in a job pays costs the later ones do not — DNS resolution, TLS handshakes to the cache service and the JDK host, and a cold page cache — and that is a one-off spike rather than drift, so the mirrored order cannot cancel it. Without the warm-up slot the A/A control resolved a spurious 0.4 s difference between an arm's own first and last slot.

**One cache, every arm.** A cache entry's download throughput depends on where the service placed the stored blob, and that placement is fixed for the life of the entry. Seeding one entry per arm therefore confounds the arm with its blob, and because the bias is identical on every runner, pairing cannot remove it and more samples only tighten the interval around the wrong answer. A single entry is seeded and every arm restores it.

**Intervals, not point estimates.** `scripts/stats.mjs` reports a bootstrap 95% confidence interval, a permutation p-value, and a Hodges-Lehmann shift, and turns them into an explicit verdict. A comparison whose interval includes zero is reported as `inconclusive` rather than as a number that looks like a result. A verdict additionally requires the permutation test to agree: the percentile bootstrap is only approximate at ten paired observations, while the sign-flip test is exact under the null, so where they disagree the interval is the one that is wrong.

**Stalled slots fail fast.** Each measured setup is capped at three minutes. A restore that has not finished by then has stalled on the cache service rather than being slow — its neighbours in the same job take a few seconds — and failing costs one runner instead of holding the run open. The version sweep restores fifteen times per job where the two-arm workflows restore five, so it runs in narrower waves.

**Stalled runners are discarded.** A slot can stall on the cache service for several seconds. Which arm the stall lands on is arbitrary, so that runner contributes an arbitrarily large difference and, with ten runners, one such slot moves the mean by more than any effect being measured. Runners whose *own arm disagrees with itself* by more than a robust threshold are dropped. That decision is made purely on within-arm spread, which has the same distribution whether or not the arms differ, so unlike filtering on the arm difference it cannot bias the result. Every report lists what it discarded and why.

Every report also publishes two guard rails:

- A **noise floor**, the median spread between the two slots of the same arm on one runner. An effect smaller than this is reported as `within-noise` even when its interval excludes zero.
- An **A/A control**, the same estimator applied to one arm against itself. It costs no extra jobs because every arm is already measured twice per runner. A healthy run reports `within-noise` or `inconclusive`; anything else means the harness is biasing results and the headline verdict cannot be trusted.

After changing a harness, run it with both arms set to the same ref. The true effect is then exactly zero, and any other verdict is a defect rather than a finding. That check is what caught the per-arm cache confound described above: on identical code it reported a 0.859 s improvement, with the baseline blob served at ~60 MB/s and the candidate blob at ~105–130 MB/s on the same runner in the same job.

`scripts/paired.mjs` implements the pairing and `scripts/stats.mjs` the statistics; every report builds on both.

## Scenarios

Each action version runs with Java 17 on `ubuntu-24.04`:

| Distribution | Expected setup path | Purpose |
| --- | --- | --- |
| Eclipse Temurin | Hosted runner tool-cache hit | Measures setup overhead when the JDK is already available |
| Microsoft Build of OpenJDK | JDK download and extraction | Measures setup overhead when the JDK must be installed |

v1 predates distribution selection and integrated dependency caching. It runs only its native Zulu installer path. v2 supports the Temurin and Microsoft scenarios, but its bundled legacy cache client is rejected by the current Actions cache service. v1 and v2 therefore have no Maven cache storage, and their cold/warm labels are repeated uncached samples.

A seed job compiles Spring PetClinic once to populate a single Maven cache entry. Every measurement runner then sets up all seven versions in one job, in the order `v1..main` followed by `main..v1`, deleting `~/.m2` before each slot. The report compares every version against `main` with a paired interval per runner.

v3, v4, and v5.2 cache only Maven dependencies. v5.6 and `main` also cache the Maven Wrapper distribution separately, making the storage and execution-time tradeoff visible. v4 and later share one cache entry through `cache-dependency-path`, so the stored blob is held constant across them. v3 predates that input and keys on `pom.xml`, so it necessarily uses its own entry; treat its difference with more caution than the rest. v1 and v2 do no caching at all and serve as the uncached reference.

Spring PetClinic and third-party actions are pinned to commits. `setup-java@main` intentionally remains a moving ref so each run evaluates the current upcoming v6 code; the report records the `main` commit observed when it is generated.

## Running

Open **Actions > Benchmark setup-java > Run workflow**. Choose how many runners to measure on; each contributes two observations per version. Ten is the default.

The report job writes a Markdown summary and uploads raw JSON and CSV files. Benchmark-created caches are deleted after measurement by default, preventing repeated runs from consuming repository cache storage. Disable cleanup when you need to inspect the entries manually.

### Focused cache restore

The **Focused cache restore** workflow isolates the setup step to compare two `actions/setup-java` refs (by default `v4.8.0` against `main`). It uses a pinned Temurin JDK from the hosted runner tool cache, seeds a synthetic 160 MiB dependency cache for both arms and a 9 MiB wrapper cache for the candidate, and runs no Maven command. Measurement jobs therefore contain no JDK or Maven Central downloads; they measure JDK discovery and Actions cache restoration only.

This workflow is the reference for how a comparison should be measured here. Three properties make its verdicts trustworthy:

**Millisecond timing.** The Actions API reports step `started_at` and `completed_at` only to the nearest second. Setup steps take two to six seconds, so reading durations from the API quantizes every measurement to ±500 ms — the same magnitude as the effects being measured. Timing is therefore taken inside the job with `scripts/measure.mjs`.

**Same-runner pairing.** Between-runner variance on hosted runners is larger than the effects under test, and it cannot be averaged away by adding more independent jobs to each arm. Both arms run in the *same* job in ABBA order — baseline, candidate, candidate, baseline — so each runner yields one paired difference with the runner's own speed cancelled out. The mirrored order also cancels drift across the four slots. Each measured slot deletes `~/.m2` first so every restore extracts into an empty tree.

**One cache, both arms.** A cache entry's download throughput depends on where the service placed the stored blob, and that placement is fixed for the life of the entry. Giving each arm its own seeded cache therefore confounds the arm with its blob, and because the bias is identical on every runner, pairing cannot remove it and more samples only tighten the interval around the wrong answer. A single entry is seeded and both arms restore it.

**Intervals, not point estimates.** `scripts/stats.mjs` reports a bootstrap 95% confidence interval, a permutation p-value, and a Hodges-Lehmann shift for every comparison, and turns them into an explicit verdict. A comparison whose interval includes zero is reported as `inconclusive` rather than as a number that looks like a result.

The report also publishes two guard rails:

- A **noise floor**, the median spread between the two slots of the same arm on one runner. An effect smaller than this is reported as `within-noise` even when its interval excludes zero.
- An **A/A control**, the same estimator applied to the baseline against itself. It costs no extra jobs because each arm is already measured twice per runner. A healthy run reports `within-noise` or `inconclusive`; anything else means slot ordering is biasing the results and the headline verdict cannot be trusted.

Run the workflow with `baseline-ref` and `candidate-ref` set to the same value after changing it. The true effect is then exactly zero, and any verdict other than `inconclusive` or `within-noise` is a defect in the harness rather than a finding. That check is what surfaced the per-arm cache confound described above: on identical code it reported a 0.859 s improvement, with the baseline blob served at ~60 MB/s and the candidate blob at ~105–130 MB/s on the same runner in the same job.

Point `baseline-ref` and `candidate-ref` at any two refs — including a PR branch — to check whether a change delivers a real improvement.

#### Why this replaced the previous design

The earlier version of this workflow ran each arm as its own matrix of independent jobs, read durations from the Actions API, and reported a "paired median delta" that paired `sample N` of one arm with `sample N` of the other. Those samples shared no runner and no point in time, so the pairing removed no variance at all.

Two consecutive runs of that harness against an unchanged `v4.8.0` — where the true difference is exactly zero — produced medians of 2 s and 3 s, a spurious 1.2 s separation whose confidence interval excluded zero. Over the same pair of runs the reported candidate delta flipped from +0.6 s to −0.8 s. `scripts/stats.test.mjs` pins that dataset as a regression test so unpaired sampling is not reintroduced.

### JDK cache

The **JDK cache** workflow measures the installed-JDK cache added on `actions/setup-java@main`. It compares `cache-jdk: false` against `cache-jdk: true`, defaulting to Microsoft Build of OpenJDK 17. Both arms use the same action ref, so the result isolates JDK caching instead of conflating it with implementation changes between commits.

A single seed job compiles Spring PetClinic to populate one Maven cache entry and one JDK cache entry. Every measurement runner then runs both arms in one job in ABBA order under `cache-read-only: true`. Both arms restore the same Maven entry — only the JDK entry differs between them, which is the effect under test.

Every seed and measured slot removes matching JDKs from `$RUNNER_TOOL_CACHE` first, deliberately measuring the not-preinstalled path and preventing a hosted-runner tool-cache hit from bypassing JDK cache restore logic. Select Temurin to test that same forced-miss path with a distribution normally preinstalled on hosted runners.

JDK cache keys are derived from the JDK's identity and source, so unlike dependency cache keys they cannot be namespaced per run; the `prepare` job deletes existing JDK caches before seeding.

Open **Actions > JDK cache > Run workflow** to select the distribution, Java version, action ref, runner count, and cache cleanup behavior.

### Maven configuration warm path

The **Maven configuration warm path** workflow compares two refs of setup-java across 36 configurations: three operating systems, three cache profiles, single and multiple Java versions, and an empty or pre-existing `toolchains.xml`.

Unlike the other workflows it does not repeat one scenario across many runners; it runs each configuration once. A single configuration therefore yields one paired difference and cannot support an interval on its own. Each configuration is instead treated as a **block**: the arms are compared within it, on the same runner, in ABBA order after a discarded warm-up slot, and the differences are pooled across the matrix. That answers the question the workflow actually asks — whether the candidate differs from the baseline across configurations — at no extra job cost.

Per-configuration numbers are still published, but as single observations with no verdict, because that is all they are. Breakdowns by operating system and by cache profile are reported with their own intervals; groups with few blocks will read `inconclusive` even where the pooled result does not, which is the intended behaviour rather than a defect.

Open **Actions > Maven configuration warm path > Run workflow** to select the repository and the two refs.

## Reading results

The summary reports medians for:

- setup time, including JDK discovery/download and dependency-cache restore;
- Spring PetClinic `compile` time;
- the `setup-java` post step that saves caches;
- compressed cache storage per isolated case;
- estimated billed minutes, calculated by rounding each Linux job to a whole minute.

Public repositories do not pay for standard GitHub-hosted runners. The estimated minutes are included to make the results applicable to private repositories; actual charges depend on the account plan and runner type.

Network throughput, hosted-runner image changes, upstream artifact availability, and runner load all introduce variance. Read the verdict rather than the point estimate: a comparison reported as `inconclusive` has not established anything, however suggestive its number looks, and one reported as `within-noise` is smaller than the harness can resolve. Check the A/A control before trusting any headline — if it resolves a difference, the run is measuring the harness rather than the code.

## Local checks

```bash
npm test
bash -n scripts/*.sh
shellcheck scripts/*.sh
```
