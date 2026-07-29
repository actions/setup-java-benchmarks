# setup-java benchmarks

This repository compares [`actions/setup-java@v1.4.4`](https://github.com/actions/setup-java/releases/tag/v1.4.4), [`actions/setup-java@v2.5.1`](https://github.com/actions/setup-java/releases/tag/v2.5.1), [`actions/setup-java@v3.14.1`](https://github.com/actions/setup-java/releases/tag/v3.14.1), [`actions/setup-java@v4.8.0`](https://github.com/actions/setup-java/releases/tag/v4.8.0), [`actions/setup-java@v5.2.0`](https://github.com/actions/setup-java/releases/tag/v5.2.0), [`actions/setup-java@v5.6.0`](https://github.com/actions/setup-java/releases/tag/v5.6.0), and the unreleased [`actions/setup-java@main`](https://github.com/actions/setup-java/tree/main) using [Spring PetClinic](https://github.com/spring-projects/spring-petclinic).

The benchmark is designed around the two costs that matter to Actions users:

- **Execution time:** setup, build, cache restore, and post-job cache save durations.
- **Cache storage:** compressed Maven dependency and Maven Wrapper cache sizes.

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

The **Focused cache restore** workflow isolates the setup step for comparing v4 with `main`. It uses a pinned Temurin JDK from the hosted runner tool cache, seeds a synthetic 160 MiB dependency cache for both versions and a 9 MiB wrapper cache for `main`, and runs no Maven command. Warm measurement jobs therefore contain no JDK or Maven Central downloads; they measure JDK discovery and Actions cache restoration only.

## Reading results

The summary reports medians for:

- setup time, including JDK discovery/download and dependency-cache restore;
- Spring PetClinic `compile` time;
- the `setup-java` post step that saves caches;
- compressed cache storage per isolated case;
- estimated billed minutes, calculated by rounding each Linux job to a whole minute.

Public repositories do not pay for standard GitHub-hosted runners. The estimated minutes are included to make the results applicable to private repositories; actual charges depend on the account plan and runner type.

Network throughput, hosted-runner image changes, upstream artifact availability, and runner load all introduce variance. Compare multiple iterations and multiple workflow runs before drawing conclusions.

## Local checks

```bash
npm test
```
