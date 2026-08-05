# setup-java benchmarks

This repository compares [`actions/setup-java@v1.4.4`](https://github.com/actions/setup-java/releases/tag/v1.4.4), [`actions/setup-java@v2.5.1`](https://github.com/actions/setup-java/releases/tag/v2.5.1), [`actions/setup-java@v3.14.1`](https://github.com/actions/setup-java/releases/tag/v3.14.1), [`actions/setup-java@v4.9.1`](https://github.com/actions/setup-java/releases/tag/v4.9.1), [`actions/setup-java@v5.2.0`](https://github.com/actions/setup-java/releases/tag/v5.2.0), [`actions/setup-java@v5.6.0`](https://github.com/actions/setup-java/releases/tag/v5.6.0), and the unreleased [`actions/setup-java@main`](https://github.com/actions/setup-java/tree/main) using [Spring PetClinic](https://github.com/spring-projects/spring-petclinic).

The benchmark is designed around the two costs that matter to Actions users:

- **Execution time:** setup, build, cache restore, and post-job cache save durations.
- **Cache storage:** compressed JDK, Maven dependency, and Maven Wrapper cache sizes.

## Methodology

Every workflow here measures effects of a few hundred milliseconds to a few seconds on hosted runners, where the variance between runners is larger than the effect. Four properties are what make a result mean something, and all four workflows now share them.

**Millisecond timing.** The Actions API reports step `started_at` and `completed_at` only to the nearest second. Setup steps take two to six seconds, so reading durations from the API quantizes every measurement to ±500 ms — the same magnitude as the effects being measured. Timing is taken inside the job with `scripts/measure.mjs`.

**Same-runner pairing.** Between-runner variance cannot be averaged away by adding more independent jobs to each arm. Every arm is measured inside the _same_ job, in an order mirrored about the middle of the job: ABBA for two arms, and `v1..main` followed by `main..v1` for the version sweep. Differencing within a runner removes the runner's own speed, and the mirrored order cancels drift that is linear across the job. Each measured slot deletes `~/.m2` first so every restore extracts into an empty tree.

Every job also runs one unmeasured warm-up slot first. The first setup in a job pays costs the later ones do not — DNS resolution, TLS handshakes to the cache service and the JDK host, and a cold page cache — and that is a one-off spike rather than drift, so the mirrored order cannot cancel it. Without the warm-up slot the A/A control resolved a spurious 0.4 s difference between an arm's own first and last slot.

**One cache, every arm.** A cache entry's download throughput depends on where the service placed the stored blob, and that placement is fixed for the life of the entry. Seeding one entry per arm therefore confounds the arm with its blob, and because the bias is identical on every runner, pairing cannot remove it and more samples only tighten the interval around the wrong answer. A single entry is seeded and every arm restores it.

**Intervals, not point estimates.** `scripts/stats.mjs` reports a bootstrap 95% confidence interval, a permutation p-value, and a Hodges-Lehmann shift, and turns them into an explicit verdict. A comparison whose interval includes zero is reported as `inconclusive` rather than as a number that looks like a result. A verdict additionally requires the permutation test to agree: the percentile bootstrap is only approximate at ten paired observations, while the sign-flip test is exact under the null, so where they disagree the interval is the one that is wrong.

**Stalled slots fail fast.** Each measured setup is capped at three minutes. A restore that has not finished by then has stalled on the cache service rather than being slow — its neighbours in the same job take a few seconds — and failing costs one runner instead of holding the run open. The version sweep restores fifteen times per job where the two-arm workflows restore five, so it runs in narrower waves.

**Stalled runners are discarded.** A slot can stall on the cache service for several seconds. Which arm the stall lands on is arbitrary, so that runner contributes an arbitrarily large difference and, with ten runners, one such slot moves the mean by more than any effect being measured. Runners whose _own arm disagrees with itself_ by more than a robust threshold are dropped. That decision is made purely on within-arm spread, which has the same distribution whether or not the arms differ, so unlike filtering on the arm difference it cannot bias the result. Every report lists what it discarded and why.

**A design that cannot reach significance says so.** The sign-flip test has only 2^n distinct assignments for n paired runners, so its smallest attainable p-value is 2^-n however large the effect is. At four usable runners that floor is 0.0625, above the 0.05 a verdict requires — the run cannot report a finding even for an effect it measured perfectly. Those runs are reported as `underpowered` rather than `inconclusive`, because the two call for opposite readings: `inconclusive` means the data did not show an effect, `underpowered` means the design could not have shown one. The first live run of **Cache value** measured caching as 4.5x faster, 22.4 s, and reported `inconclusive` on four surviving runners; that is what this exists to stop.

Every report also publishes two guard rails:

- A **noise floor**, the median spread between the two slots of the same arm on one runner. An effect smaller than this is reported as `within-noise` even when its interval excludes zero.
- An **A/A control**, the same estimator applied to one arm against itself. It costs no extra jobs because every arm is already measured twice per runner. A healthy run reports `within-noise` or `inconclusive`; anything else means the harness is biasing results and the headline verdict cannot be trusted.

After changing a harness, run it with both arms set to the same ref. The true effect is then exactly zero, and any other verdict is a defect rather than a finding. That check is what caught the per-arm cache confound described above: on identical code it reported a 0.859 s improvement, with the baseline blob served at ~60 MB/s and the candidate blob at ~105–130 MB/s on the same runner in the same job.

`scripts/paired.mjs` implements the pairing and `scripts/stats.mjs` the statistics; every report builds on both.

## What each workflow asks

Caching is a chain, and a benchmark is only useful if it says which link it is measuring. A restore that is quick because it hit is not comparable to one that is quick because it found nothing; a difference in transfer time is usually a difference in the network rather than in setup-java. The workflows are therefore organised by question, and each is built around the _one_ quantity that answers it.

| Workflow                      | Question                                   | How it is arranged                                  | Effect it can resolve  |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------- | ---------------------- |
| **Cache value**               | What does caching buy at all?              | Real PetClinic build, cached against uncached       | Tens of seconds        |
| **Cache key stability**       | Does the cache hit when it should?         | Deterministic assertions on the computed key        | Pass or fail           |
| **Action overhead**           | What does setup-java's own code cost?      | ~1 MiB entry, so the transfer is not what is timed  | Tens to hundreds of ms |
| **Transfer overlap**          | Does it overlap the transfers it makes?    | Large entries, so concurrency has something to hide | Hundreds of ms         |
| **Cache save**                | What does the first run pay?               | Post-run save of a Maven-shaped tree                | Seconds                |
| **JDK cache**                 | Is caching the JDK worth it?               | `cache-jdk` off against on, same ref                | Seconds                |
| **Benchmark** (version sweep) | How does `main` compare with each release? | All versions on one runner, mirrored order          | Hundreds of ms         |

### Which release to compare against

The pairwise workflows — **Action overhead**, **Transfer overlap** and **Cache save** — take `baseline-ref` as a choice of three releases, defaulting to the newest:

| Baseline | Why it is on the list                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v5.6.0` | The newest release. `main` against this is the change set that has not shipped yet, and it is the only comparison where a difference points at a specific pull request. |
| `v5.2.0` | Before the v5 cache work settled. Widens the window to the whole of v5 without leaving the versions that share a cache key scheme.                                      |
| `v4.9.1` | The last v4. The oldest release that still takes `cache-dependency-path`, so it can restore the _same_ cache entry as `main` rather than one of its own.                |

Nothing older is offered. v3 and earlier predate `cache-dependency-path` and so restore an entry of their own, and a stored blob's throughput is fixed for the life of that entry — the version difference is then confounded with blob placement, which pairing cannot remove. v1's bundled cache client is rejected by the current cache service outright. Those versions are still measured by the version sweep, which reports them without ranking them, and that is the right place for them.

Run a workflow once per baseline to get all three comparisons; each run is self-contained, so they can be dispatched together.

The sizes in the third column are the design, not an accident. setup-java does not move the bytes itself — it hands the transfer to `@actions/cache` — so a benchmark with a large fixture measures the network and a benchmark with a small one measures the action. **Action overhead** and **Transfer overlap** are deliberately the same measurement at two fixture sizes for exactly that reason, and together they decompose a restore into the part setup-java controls and the part it does not.

## Version sweep

Each action version runs with Java 17 on `ubuntu-24.04`:

| Distribution               | Expected setup path          | Purpose                                                   |
| -------------------------- | ---------------------------- | --------------------------------------------------------- |
| Eclipse Temurin            | Hosted runner tool-cache hit | Measures setup overhead when the JDK is already available |
| Microsoft Build of OpenJDK | JDK download and extraction  | Measures setup overhead when the JDK must be installed    |

v1 predates distribution selection and integrated dependency caching. It runs only its native Zulu installer path. v2 supports the Temurin and Microsoft scenarios, but its bundled legacy cache client is rejected by the current Actions cache service. v1 and v2 therefore have no Maven cache storage, and their cold/warm labels are repeated uncached samples.

A seed job compiles Spring PetClinic once to populate a single Maven cache entry. Every measurement runner then sets up all seven versions in one job, in the order `v1..main` followed by `main..v1`, deleting `~/.m2` before each slot. The report compares `main` with every version using a paired interval per runner, but it ranks only the versions that do the same work from the same stored blob.

**`main` is the thing under test, not the thing being ranked.** `main` is the newest code, and every released version is a baseline it is measured against, exactly as the two-arm workflows measure a candidate against a baseline. So the reported difference is `main` minus the version, and the verdict describes `main`: an `improvement` means `main` is faster than that version. Differencing the other way would label a released version a `regression` for being slower than the code that succeeded it, which inverts what was actually measured — the finding there is that `main` got faster.

**Only comparable versions are ranked.** v4, v5.2, v5.6 and `main` all restore the same seeded entry through `cache-dependency-path`, so a difference between them is a difference in the implementation. `main` is ranked against each of them, with Holm's step-down correction across that family: it is tested against every one of them in one run, so without a correction the chance that one comparison clears 0.05 by luck is far above 0.05.

v1, v2 and v3 are measured on the same runners and published, but they carry no verdict, because a verdict would report a difference in the _workload_ as though it were a difference in the implementation:

| Version | Why it is not ranked                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.4.4  | Installs its own JDK and does no dependency caching                                                                                                   |
| v2.5.1  | Its bundled cache client is rejected by the current cache service, so it restores nothing                                                             |
| v3.14.1 | Predates `cache-dependency-path` and keys on `pom.xml`, so it restores its own entry — the blob confound described above, which pairing cannot remove |

v3 is the instructive case. In run 30979614347 it took 3.69 s and 3.89 s on two runners that ran v4 in 0.50 s and 0.52 s moments later in the same job. A sevenfold gap that appears on some runners and not others is blob placement, not code, and ranking it would have published a verdict for it.

Spring PetClinic and third-party actions are pinned to commits. `setup-java@main` intentionally remains a moving ref so each run evaluates the current upcoming v6 code; the report records the `main` commit observed when it is generated.

## Running

Every workflow is dispatched from **Actions > _(workflow)_ > Run workflow**. The ones that compare two refs take a `baseline-ref` and a `candidate-ref`, so any of them can be pointed at a PR branch; the ones that sample across runners take a runner count, where each runner contributes two observations per arm.

Each report job writes a Markdown summary to the run and uploads raw JSON and CSV. Benchmark-created caches are deleted after measurement, because the repository shares one cache budget across all of these workflows and an entry left behind by one run evicts the seeded entries another depends on.

**Run a harness change against itself before believing it.** Set both refs to the same value: the true effect is then exactly zero, and any verdict other than `inconclusive` or `within-noise` is a defect rather than a finding.

## The workflows in detail

### Cache value

The **Cache value** workflow answers the question a user actually has: is turning `cache: maven` on worth it? It builds Spring PetClinic for real, cached against uncached, in ABBA order on one runner.

This is the only scenario whose effect is large enough to see without any statistical machinery, and that is the point of running it — it establishes the scale everything else is a fraction of. A result here in the tens of seconds is what makes an argument about 40 ms of action overhead worth having or not worth having.

### Cache key stability

The **Cache key stability** workflow measures nothing. The cache key is a deterministic function of the tree, so its properties can be asserted outright rather than estimated, and those properties dominate every timing in this repository: a key that changes when it should not costs a full cache miss — about a minute on PetClinic — where the timing workflows are resolving tens of milliseconds.

It checks that the key is unchanged when the same tree is hashed twice, unchanged when an unrelated source file is edited, changed when the dependency manifest is edited, identical across two runners on the same platform, and different across platforms. The cross-runner check is the important one: if two runners on the same tree disagree, caching never works for anyone, because every job computes a key no other job has stored.

Nothing is stored by any of it. setup-java skips its post-job save when the configured path does not exist, and no probe ever creates `~/.m2`.

### Action overhead

The **Action overhead** workflow compares two refs across three operating systems, four cache profiles and two configuration layouts, with a cache entry of about a megabyte spread over many small files. The small entry is the whole design: it leaves resolving a distribution, computing a cache key, writing settings and toolchains, and the bookkeeping around a restore as what is being timed, rather than the network.

The four cache profiles are nested levels of work rather than competing options:

| Profile       | What the action does                                |
| ------------- | --------------------------------------------------- |
| `none`        | Never touches the cache code                        |
| `maven-miss`  | Computes a key and is told no                       |
| `maven-hit`   | Computes a key, is told yes, unpacks a ~1 MiB entry |
| `gradle-miss` | A miss through the other package manager            |

Differencing the levels says where the time goes, and the report publishes that decomposition alongside the comparison. Those level differences are between-configuration, so they are reported as observed medians with no interval and no verdict; they describe what a setup costs rather than establishing that two refs differ.

Each configuration is one runner, so it yields one paired difference and cannot support an interval alone. Configurations are treated as **blocks** — arms compared within a configuration, on the same runner, in ABBA order after a discarded warm-up slot — and the differences pooled across the matrix.

Every slot records setup-java's `cache-hit` output, and the report refuses to be read normally if a `maven-hit` slot missed or a `maven-miss` slot hit, because either turns a level of the decomposition into a different level and the labels stop being true.

#### Why this replaced the Maven configuration warm path

The workflow this grew out of was called a warm path and was not one. It had no seed job, and its synthetic `benchmark/pom.xml` hashed to a key nothing had ever stored, so every one of its "warm" restores was a miss — the job logs read `maven cache is not found` and `Path Validation Error ... hence no cache is being saved`. Its three cache profiles were three variations on a failed lookup, and it could not see the restore path at all. The differences it reported were real, but they were differences in the cost of _missing_, published under a heading that said warm.

### Transfer overlap

The **Transfer overlap** workflow isolates the setup step to compare two refs (by default `v5.6.0` against `main`) with a synthetic 160 MiB dependency cache seeded for both arms and a 9 MiB wrapper cache, and runs no Maven command. Measurement jobs contain no JDK or Maven Central downloads.

When a build configures more than one cache, setup-java restores both, and whether it does so in sequence or at the same time is its own choice — unlike the throughput of either transfer. That makes overlap one of the few properties of caching a change to this action can actually move, and [actions/setup-java#1174](https://github.com/actions/setup-java/pull/1174) moved it by awaiting the two restores together. An effect that exists only while a transfer is in flight is proportional to how long the transfer takes, which is why the fixtures here are large and why the same effect is invisible in **Action overhead**.

This workflow is also the reference implementation for how a comparison is measured in this repository. Point `baseline-ref` and `candidate-ref` at any two refs — including a PR branch — to check whether a change delivers a real improvement, or at the _same_ ref to check the harness itself.

#### Why the harness was rebuilt

The earlier version ran each arm as its own matrix of independent jobs, read durations from the Actions API, and reported a "paired median delta" that paired `sample N` of one arm with `sample N` of the other. Those samples shared no runner and no point in time, so the pairing removed no variance at all.

Two consecutive runs of that harness against an unchanged `v4.8.0` — where the true difference is exactly zero — produced medians of 2 s and 3 s, a spurious 1.2 s separation whose confidence interval excluded zero. Over the same pair of runs the reported candidate delta flipped from +0.6 s to −0.8 s. `scripts/stats.test.mjs` pins that dataset as a regression test so unpaired sampling is not reintroduced.

### Cache save

The **Cache save** workflow measures what the first run pays. A cache miss costs the download the user already paid for _plus_ the save, and nothing else here measured the second half of that.

setup-java saves in its post-job hook, which cannot be bracketed by a timer from inside the job. The save is therefore driven directly through the `@actions/cache` version each ref pins, which is where the difference between refs actually lives, against a Maven-shaped fixture: nested group directories of small `.jar`, `.pom` and `.sha1` files rather than one large blob, because archive cost tracks file count and directory depth as much as it tracks bytes.

Each save runs in a local action at `.github/actions/cache-save-slot` rather than a `run:` step. The runner injects the cache service URL and runtime token into action steps only, so the same client driven from `run:` fails its reservation with `Cache Service Url not found`. `saveCache` swallows that, returns `-1`, and leaves behind a duration that looks like a measurement — the first live run of this scenario reported 10.278s with a standard deviation of 0.008s across ten runners, which was a retry backoff rather than an upload. The slot now fails when `saveCache` does not return a real cache id, so that failure mode cannot be published as a result again.

### JDK cache

The **JDK cache** workflow measures the installed-JDK cache added on `actions/setup-java@main`. It compares `cache-jdk: false` against `cache-jdk: true`, defaulting to Microsoft Build of OpenJDK 17. Both arms use the same action ref, so the result isolates JDK caching instead of conflating it with implementation changes between commits.

A single seed job compiles Spring PetClinic to populate one Maven cache entry and one JDK cache entry. Every measurement runner then runs both arms in one job in ABBA order under `cache-read-only: true`. Both arms restore the same Maven entry — only the JDK entry differs between them, which is the effect under test.

Every seed and measured slot removes matching JDKs from `$RUNNER_TOOL_CACHE` first, deliberately measuring the not-preinstalled path and preventing a hosted-runner tool-cache hit from bypassing JDK cache restore logic. Select Temurin to test that same forced-miss path with a distribution normally preinstalled on hosted runners.

JDK cache keys are derived from the JDK's identity and source, so unlike dependency cache keys they cannot be namespaced per run; the `prepare` job deletes existing JDK caches before seeding.

## Reading results

**Read the verdict, not the point estimate.** Every comparison reports one, and it is the only part of the output that has been checked against the harness's own noise. A result reported as `inconclusive` has established nothing however suggestive its number looks, and one reported as `within-noise` is smaller than this harness can resolve on hosted runners.

**Check the A/A control first.** It applies the same estimator to one arm against itself, where the true difference is exactly zero. A healthy run reports `within-noise` or `inconclusive`. Anything else means the run measured the harness rather than the code, and the headline is void.

**Check which link was measured.** A number from **Action overhead** and a number from **Transfer overlap** are not the same quantity and do not add up to a user-visible saving on their own; the scale that makes either of them matter comes from **Cache value**.

Network throughput, hosted-runner image changes, upstream artifact availability and runner load all introduce variance, which is what the guard rails above exist to absorb.

## Local checks

```bash
npm test          # unit tests, plus a syntax check of the JS embedded in heredocs
bash -n scripts/*.sh
shellcheck scripts/*.sh
```

`npm test` includes `scripts/check-embedded-node.mjs` because several helpers run node inline through a heredoc, and that code is a string to everything else here: prettier does not format it, `node --test` never imports it, and shellcheck sees an opaque block. A syntax error in one of them otherwise stays invisible until a runner reaches it, which costs a whole benchmark run to find out.
