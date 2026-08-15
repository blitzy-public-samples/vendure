# 1. Executive Summary

## 1.1 Project Overview

This project adds `tickets/` to the Vendure 3.7.0 monorepo: a three-tier decomposition of a returning-buyer reorder and replenishment objective into individually buildable work items. One epic, eight feature contracts and twenty-five story tickets — 34 Markdown files, 23,017 lines — specify a prospective `packages/reorder-plugin/` spanning named reorder lists, reorder from order history, pre-commit price and availability deltas, unavailable-line resolution, purchase cadence, list sharing, audit instrumentation and recurring-demand visibility. The deliverable is documentation about prospective code, not the code: every platform claim carries a resolvable file-and-line citation, and the artifact ships its own executable validation gate.

## 1.2 Completion Status

```mermaid
pie showData title Completion — 82.7% Complete
    "Completed Work (hours)" : 265
    "Remaining Work (hours)" : 55.5
```

Colours: **Completed = Dark Blue `#5B39F3`** · **Remaining = White `#FFFFFF`**.

| Metric | Value |
|---|---|
| Total Hours | **320.5** |
| Completed Hours (AI + Manual) | **265** (265 AI + 0 Manual) |
| Remaining Hours | **55.5** |
| Percent Complete | **82.7%** |

`265 / (265 + 55.5) × 100 = 82.7%`. Scope is the project plan's deliverables plus path-to-production work; the plugin implementation the tickets describe sits outside it.

## 1.3 Key Accomplishments

- [x] 34 files in 9 directories: 1 epic (12 sections), 8 features (5 each), 25 stories (10 each), all names conforming.
- [x] 13,517 inline citations resolve against real content here; an independent resolver agrees at zero unresolved.
- [x] 195 acceptance criteria in Given/When/Then form, every story inside the mandated 4–8 band.
- [x] 121 edge-case scenarios, each a complete triplet, every story inside the mandated 3–5 band.
- [x] Zero forbidden terms, zero decimal monetary values, zero invented metrics across all 34 files.
- [x] A 25-step validation gate embedded in the epic, running green end to end.
- [x] Traceability complete: 6 of 6 personas, 4 of 4 clauses, 13-quoted / 12-inferred reported truthfully.
- [x] Zero-edit boundary held: 34 files added, nothing modified, nothing touched outside `tickets/`.

## 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| Fifteen pre-build decisions remain open in epic §8; decision 6 (keep period for customer-linked rows) gates the merge of every story that persists one | Implementation cannot start on the affected stories until values are supplied — the tickets are forbidden to invent them | Product + Engineering lead | 14h |
| No gate inspects this artifact: no CI path filter matches a `tickets/**`-only change, and the maintainer-held digest-pinned validator location the suite's own execution condition requires does not exist | A future edit can break a citation, link, count or rollup with nothing to catch it | Platform / DevEx | 8h |
| Inventory authority unsigned (architectural decision 5): the shipped saleable-stock read resolves a single `GlobalSettings` row while the non-deprecated `Channel` pair is read nowhere in `packages/core` | Every availability criterion carries a consistent-seeding obligation until this is signed off | Architecture | 3h |
| Branch target unresolved as a three-way conflict — `minor` for feature work, `major` for schema changes, this work on a branch cut from `master` | The implementation has no agreed merge path | Maintainers | 2h |
| Native SQLite is named an unverified engine: claimed as officially supported, with no CI job and no test-harness initializer | Changes the definition of done for all 25 stories | Maintainers | 2h |
| Two gate blind spots measured and still unasserted — edge-case scenario child-bullet indentation, and the literal sub-task opener | Two template classes rest on manual census rather than the gate | DevEx | 3h |
| Nothing the tickets specify has been exercised at runtime, because the code they describe does not exist | Every contract is verified as a specification, not as running software | Implementation team | Tracked by the epic's own delivery split |
| Five repository-documentation claims remain stale in place, reported in epic §6.3 rather than corrected | A reader following `CONTRIBUTING.md` still meets each one | Docs maintainer | 4h |

## 1.5 Access Issues

**No access issues identified.** The repository was fully readable, the merge base resolved, the gate ran to completion and all 12 diagrams rendered. Two environment facts bound automated checking; neither is an access failure:

| System/Resource | Type of Access | Issue Description | Resolution Status | Owner |
|---|---|---|---|---|
| Workspace dependencies | Local toolchain | No installed dependencies are present, and installing them is prohibited for this deliverable, so the repository's own unit and end-to-end suites are neither applicable nor runnable against it | Not an issue — by design; nothing in the artifact compiles | N/A |
| `npm audit` | Dependency scanning | Cannot run against a Bun workspace carrying no npm lockfile; no dependency was added, removed or updated, so there is no dependency surface to audit | Not an issue — no dependency change exists | N/A |

## 1.6 Recommended Next Steps

1. **[High]** Close the fifteen open pre-build decisions, starting with the keep period — it gates six stories. (14h)
2. **[High]** Stand up the digest-pinned validator location; gate `tickets/**`. (8h)
3. **[High]** Sign off the inventory-authority decision; settle the branch target. (5h)
4. **[Medium]** Accept the §5.2 divergences; confirm the `STORY-001-01-03` scope and 3.7.2+ floor. (6.5h)
5. **[Medium]** Import the set into the tracker; correct the five reported documentation claims. (10h)

# 2. Project Hours Breakdown

## 2.1 Completed Work Detail

| Component | Hours | Description |
|---|---|---|
| Repository reconnaissance and citation groundwork | 30 | Read the entity, config, API-schema, service, event-bus, scheduler, job-queue, permission and testing subtrees of `packages/core/src`, the example and test plugin trees under `packages/dev-server`, the contribution conventions, the CI workflows and the checked-in introspection snapshots, recording each verified identifier with its locator. Yielded the 13,517 resolvable citations the artifact rests on. |
| Published-platform research | 6 | Three threads the repository cannot answer about itself: upstream version status, whether additive extension mechanisms widen existing API signatures, and best practice for the artefact form. Reported in a section physically separate from the repository findings. |
| Epic file | 55 | `tickets/EPIC-001-reorder-and-replenishment.md` — 5,978 lines, all 12 mandated sections in order, 2 diagrams, a 14-row do-not-duplicate inventory, 10 ranked feasibility collisions, 22 settled rulings, 20 ranked pre-build decisions, a 21-key plugin option ledger, the delivery split with rollup and both nominations, traceability, and the path to production. |
| Eight feature contracts | 48 | `tickets/EPIC-001/FEATURE-001-01` … `-08` — 7,394 lines, exactly 5 sections each, 10 diagrams, each naming the entities, services and API surfaces it touches and the existing platform mechanism it must consume rather than rebuild. |
| Twenty-five story tickets | 60 | `tickets/EPIC-001/FEATURE-001-0N/STORY-001-0N-0S-*.md` — 9,645 lines, exactly 10 sections each, 195 acceptance criteria, 121 edge-case scenarios, per-story INVEST assessment, precedent disclosure, sub-task block and estimation block. |
| Embedded 25-step validation gate | 34 | 22 validators plus 3 evidence commands specified in epic §11.10 — roughly 199 KB of step source, every step fail-closed, aggregating rather than short-circuiting, asserting exact counts and set equality in both directions, with path containment and token-scoped exemptions. Each was exercised against a deliberately faulty fixture. |
| Cross-file numeric reconciliation | 10 | The estimation rubric plus the reconciliation that makes the epic table the single source of truth: 25 rows across five numeric columns fixed before any story was written, two independent rollup decompositions, the persona map, the clause map and the batch partition. |
| Contract settlement and consistency verification | 22 | The work that makes 34 files agree with one another: the cumulative published-surface ledger as sole authority, the withdrawn-form ledger, the erasure-map consequence stated identically at every consuming site, the code-to-surface mapping table, the permission arithmetic, and prose well-formedness across the set. |
| **Total** | **265** | |

## 2.2 Remaining Work Detail

| Category | Hours | Priority |
|---|---|---|
| Pre-build decision closure — the fifteen open decisions in epic §8, including the inventory-authority sign-off, the branch-target conflict and the native-SQLite claim | 19 | High |
| Artifact validation gate — stand up the maintainer-held digest-pinned validator location, and decide the gate for `tickets/**` | 8 | High |
| Validator suite hardening — adopt the two measured compensating assertions (edge-case scenario indentation, literal sub-task opener) | 3 | Medium |
| Project-plan count-divergence sign-off — validator count, grown inventories, definition-of-done counts, `STORY-001-01-03` scope and reprice, the 3.7.2+ validated floor | 6.5 | Medium |
| Repository documentation corrections — the five claims reported in epic §6.3, corrected in place | 4 | Medium |
| Security and privacy design confirmations — the `STORY-001-08-03` fail-closed access audit, and the seller-scope deployment convention | 3.5 | Medium |
| Tracker import and navigation surfacing of the 34-file set | 6 | Medium |
| Optional refinements — `FEATURE-001-07` heading renumber with its twelve inbound citations, keyset-versus-offset pagination decision, upstream defect filings | 5.5 | Low |
| **Total** | **55.5** | |

## 2.3 Reconciliation

| Check | Expected | Actual | Status |
|---|---|---|---|
| Section 2.1 sum | 265 | 265 | ✅ |
| Section 2.2 sum | 55.5 | 55.5 | ✅ |
| Section 2.1 + Section 2.2 | 320.5 (Total Hours, §1.2) | 320.5 | ✅ |
| Remaining hours in §1.2, §2.2 and §7 | identical | 55.5 in all three | ✅ |
| Completion percentage | `265 / 320.5 × 100` | 82.7% in §1.2, §7 and §8 | ✅ |
| Human task list sum (§10 F) | 55.5 | 55.5 across 16 tasks | ✅ |

**A boundary worth stating explicitly.** Epic §9 carries its own estimates for the plugin implementation the tickets specify — 113 story points, 7,720 production and 5,850 test lines, 92.5 generation hours and 48.8 human review hours. That is the work *ahead*, described by this deliverable and deliberately outside its scope. None of it is counted in the 320.5 hours above, and the two sets of figures should never be added together.

# 3. Test Results

This deliverable is hand-authored Markdown describing prospective code, so it compiles nothing and no unit or end-to-end suite applies to it. Its executable gate is the 25-step validation suite specified in epic §11.10 — 22 validators and 3 evidence commands. Every figure below was observed by running that suite from the repository root, and by running a second, independently written implementation of the same rules as a cross-check. Each step was audited read-only before execution: zero write-mode file opens, zero network calls, zero repository mutations; 23 of 23 Python steps parse, 2 of 2 shell steps pass `bash -n`. The eight rows below partition all 25 steps exactly once.

| Area / Category | Framework | Tests | Passed | Failed | Coverage | What This Proves |
|---|---|---|---|---|---|---|
| Citation and cross-reference resolution (V6, V14) | Python resolver, three locator forms | 2 gate steps | 2 | 0 | 34 of 34 files; 13,517 citations + 1,290 dependency references resolved | Every factual claim about the platform points at real content in this checkout, and every prerequisite a story names exists in the set |
| Structural hierarchy, navigation and identifier integrity (V5, V7, V8, V17) | Python + shell, exact-set comparison | 4 gate steps | 4 | 0 | 34 of 34 files, 9 of 9 directories; 33 links, 25 identifiers, 22 rulings | The tree is exactly the declared tree, every relative link resolves inside it, the epic's story set equals the set on disk in both directions, and no citation target is ambiguous |
| Story-template conformance (V1, V3, V4, V12, V16) | Python, per-file assertions | 5 gate steps | 5 | 0 | 25 of 25 stories; 195 criteria scanned | Every story carries its ten sections, one Given/When/Then triplet per criterion, a concrete demonstration, classified dependencies and ten definition-of-done items — with no forbidden term, no frontmatter, no diagram and no table inside a criterion |
| Constraint-class enforcement (V2, V9) | Python, span-scoped scanning | 2 gate steps | 2 | 0 | 34 of 34 files; 157 currency pairings recognised | Money is an integer in the smallest currency unit with its code stated, never a decimal; and no service-level, latency, conversion or revenue figure is asserted anywhere |
| Numeric reconciliation and traceability (V10, V11, V13, V19, V21) | Python table parser | 5 gate steps | 5 | 0 | 34 of 34 files; 25 delivery rows, 6 personas, 2 nominations, 18 stated counts | The epic table is the single source of truth: every story's estimates equal its own row, both rollup decompositions sum to it, every persona is the WHO of a story, the two nominations are distinct, and every stated count matches its own list |
| Schema and contract single-authority (V18, V20) | Python GraphQL and prose parser | 2 gate steps | 2 | 0 | 30 files carrying GraphQL blocks; 87 declarations, 15 authority rules | Every proposed type, input, enum, union and interface is declared exactly once across the set, and every settled cross-file contract is stated one way in one declaring place |
| Diagram structure and rendering (V15) | Python, plus a real render with mmdc 11.16.0 | 1 gate step + 12 renders | 13 | 0 | 9 of 9 diagram-bearing files | All 12 diagrams parse and render to SVG, with two in the epic, at least one in each feature file, and none in any story file |
| Repository boundary and tooling evidence (E1, E2, E3, V22) | Shell + Python | 4 gate steps | 4 | 0 | 34 of 34 files; 290 enumerations checked | `packages/core`, `packages/admin-ui` and both permitted-exception configuration files are byte-identical to the baseline; the four engine jobs and the benchmark tooling the definition of done relies on exist; and no prose is severed mid-sentence |

**Suite result: 25 of 25 steps exit zero, 0 failures, no step emitting to standard error.** The cross-check implementation agrees independently on every shared rule, resolving 13,474 citations with zero unresolved, 33 links with zero broken, and identical story-identifier sets at 25.

### Not Covered

- **Everything the tickets specify, as running behaviour.** The 14 Shop API operations, 5 Admin API operations, 7 tables, 6 new error results, 3 permission definitions, 3 events, 1 scheduled task and 1 configurable strategy are targets in ticket text. No test exercises them because the code does not exist. Before release of the *plugin*, each story's own acceptance criteria and end-to-end specification become the tests that cover it.
- **No continuous-integration job inspects this artifact.** `build_and_test.yml` filters on `packages/**`, `docs_ci.yml` on `docs/**`, `generate_docs.yml` on `packages/**/*.ts` and `.tsx`, `deploy_dashboard.yml` on `packages/{dashboard,core,common}/**`, and `publish_and_install.yml` on `packages/**`. None matches a `tickets/**`-only change, so the artifact cannot regress the build and equally nothing gates it automatically. A human should run the 25 steps before merging any edit to `tickets/**` until that gate exists.
- **Two template classes the gate cannot see.** No step asserts edge-case scenario child-bullet indentation, and none asserts the literal sub-task opener. Both were measured directly instead — 121 of 121 scenarios carry Given, When and Then at a consistent indent, and 25 of 25 stories open their sub-task block with the literal template line — but a future edit would not be caught. A human should add both assertions.
- **Semantic correctness of the specifications themselves.** A green gate is a structural verdict. It proves every claim resolves and every count agrees; it cannot prove that a proposed contract is the right contract. Epic §11.10 lists seven questions no step can answer, and reading the four-file curated path in §9 is the compensating control.
- **The repository's own suites.** `bun run test` (196 co-located unit specs) and `bun run e2e` (108 end-to-end specs) were not run: nothing in this change set compiles, no dependency was added, and the deliverable is prohibited from installing a workspace. They remain unaffected, since 34 files were added and none modified.

# 4. Runtime Validation &amp; UI Verification

There is no application in this change set to drive. The deliverable adds 34 Markdown files and no executable code, so "runtime" here means the artifact's own machine-checkable gates and its rendering surface. What was actually executed, and what was observed:

- ✅ **Operational — the 25-step validation gate.** Extracted from epic §11.10 and run from the repository root against the committed tree: all 25 steps exit zero, no failures, no step writing to standard error. Re-extraction on each invocation, so the committed step text is what ran.
- ✅ **Operational — independent rule cross-check.** A separately written implementation of the same rules resolved 13,474 citations with zero unresolved, found 33 links with zero broken, and derived identical story-identifier sets at 25 — agreement from a different instrument, not a repeat of the same one.
- ✅ **Operational — diagram rendering.** All 12 Mermaid blocks extracted and rendered to SVG with the `mmdc` CLI: 12 of 12 succeeded. This is the surface a reader actually meets, since GitHub renders these fenced blocks natively with no build step.
- ✅ **Operational — repository boundary gate (E1).** Resolved its baseline as a verified strict ancestor of `HEAD` and reported `packages/core`, `packages/admin-ui`, `packages/dev-server/dev-config.ts` and `packages/dev-server/vite.config.mts` all unchanged.
- ✅ **Operational — platform evidence gates (E2, E3).** The four engine jobs each resolve their own service image; the benchmark configuration, runner and three load-test scripts the definition of done relies on all exist and each invokes the entry point it claims.
- ⚠ **Partial — engine coverage the artifact depends on.** E2 confirms `e2e-sqljs`, `e2e-mariadb`, `e2e-mysql` and `e2e-postgres`, and confirms native SQLite has no job and no test-harness initializer. It also emits a standing note that `e2e-mysql` resolves a floating `:latest` tag, so the MySQL version exercised is not fixed across runs. Both facts are named in the epic rather than inherited silently.
- ⚠ **Partial — gate execution posture.** The suite is a specification, and executing it requires either a maintainer-audited copy pinned by digest outside the contribution, or a credentialless, egress-disabled, read-only sandbox that aborts on digest mismatch. The run reported here satisfied the second condition — every step audited read-only first, extracted outside the repository, executed against an unmodified tree that was clean afterwards. The first condition's audited location does not exist yet.
- ❌ **Never exercised at runtime — every behaviour the tickets specify.** No server was started, no database created, no migration generated or run, no GraphQL operation sent, no benchmark executed and no browser opened. The 14 Shop and 5 Admin operations, the 7 tables, the scheduled task, the events and the configurable strategy are prospective. Nothing in this change set can be driven, because the code it describes has not been written.
- ❌ **Never exercised at runtime — the four dashboard surfaces.** `STORY-001-04-03`, `STORY-001-08-01`, `STORY-001-08-02` and `STORY-001-08-03` each specify a React dashboard extension, and each is assigned to a developer working in parallel precisely because acceptance needs visual verification in a running dashboard. Each carries a single followable runbook — live Vite on port 5173 as the default, the built bundle on port 3000 as the labelled alternative — but no screen was rendered and no screenshot exists.
- ❌ **Never exercised at runtime — the two privacy designs.** The erasure map that removes every customer-addressed path to an audit row, and the byte-identical empty page that stops a collection identifier acting as an existence oracle, are both specified with the assertions that would prove them. Neither can be observed until the plugin exists; each is a required test in its owning story's definition of done.

# 5. Compliance &amp; Quality Review

## 5.1 Compliance Matrix

Where each deliverable stands now, against the project plan's own benchmarks.

| Deliverable / Benchmark | Required | Delivered | Status |
|---|---|---|---|
| `tickets/` tree, three-tier naming, no extra file | 34 files, 10 directories, story directories slug-less | 34 files, 9 subdirectories, 34 of 34 names conforming, 0 non-Markdown, 0 symlinks | ✅ Pass |
| Epic, all twelve sections in strict order | 12 sections | 12 `## N.` headings in the mandated order, 5,978 lines, 2 diagrams | ✅ Pass |
| Feature contracts | 6–8 features, 5 sections each, ≥1 diagram | 8 features, exactly 5 sections each, 10 diagrams | ✅ Pass |
| Story tickets | 2–5 stories per feature, 10 sections each | 25 stories distributed 4/4/3/3/3/3/2/3, exactly 10 sections each | ✅ Pass |
| Acceptance criteria and edge cases | 4–8 criteria and 3–5 scenarios per story, five coverage classes, three unconditional categories, forbidden terms banned | 195 criteria (22 stories at 8, one at 7, two at 6) and 121 scenarios (21 at 5, four at 4), Given/When/Then balanced 121/121/121, 0 forbidden-term occurrences | ✅ Pass |
| Story format invariants | Flat Markdown, no frontmatter, no diagram, no table inside a criterion | 0 violations across 25 stories; 0 diagrams in any story file | ✅ Pass |
| Citation discipline | Every claim carries a resolvable `[path:locator]` | 13,517 citations resolved, 0 unresolved; corroborated independently at 13,474/0 | ✅ Pass |
| Integer money and no invented metrics | Smallest currency unit with code; no SLA, latency, conversion or revenue figure | 157 currency pairings recognised, 0 decimal monetary values, 0 invented-metric candidates | ✅ Pass |
| Numeric self-consistency | Epic table is sole authority; rollups sum; links and identifiers reconcile | 25 rows cross-checked against their own story, 2 rollup decompositions summing to one overall row, 33/33 links, story-identifier sets equal both directions | ✅ Pass |
| Traceability and persona coverage | Every persona the WHO of ≥1 story; every objective clause used; honest quoted/inferred split | 6 of 6 personas across 25 mapped stories, 4 of 4 clauses, 13 quoted / 12 inferred reported at true value | ✅ Pass |
| Zero-edit boundary and prohibitions | No edit to `packages/core` or `packages/admin-ui`; no file outside `tickets/`; no CI filter, script, formatter run or workspace build | 34 files added, 0 modified, 0 deleted, 0 paths outside `tickets/`; both permitted-exception files byte-identical | ✅ Pass |
| Eighteen pre-output rules mechanised | An executable pre-emission checklist | 22 validators + 3 evidence commands, all 25 green; every rule mapped to an enforcing step, two classes additionally verified by direct census | ⚠ Pass with caveat — see §5.2 DV1 |

## 5.2 AAP &amp; Rule Divergences and Gaps

**No user-specified rules exist for this project.** The rules document contains exactly one line stating that none were provided, and the project plan records the same independently. There is therefore no user rule this work could depart from, and none has been invented. Everything below is a divergence from the plan itself.

| What the AAP/Rule Required | What Was Delivered Instead | Why It Diverged | Impact | Remediation |
|---|---|---|---|---|
| **DV1** — Ten local validators plus three evidence commands as the artifact's enforcement | Twenty-two validators plus the three evidence commands — twenty-five steps | Four successive rounds of scrutiny each found a defect class the then-current suite passed clean over; the plan forbids relaxing a rule, so growth was the only compliant direction | Strictly stronger enforcement; no rule weakened | Review and accept the larger suite (§2.2 sign-off) |
| **DV2** — Two of the plan's literal command forms | The epic's own equivalents supersede them, and the supersession is declared in the artifact | Run verbatim, the plan's invented-metric grep reports 43 non-metric lines and its estimate skeleton raises on this table shape and prints nothing | None on content; a reader running the sketch gets a weaker gate and the artifact says so | None required |
| **DV3** — A 13-row mechanism inventory, 6 collisions, 3 documentation discrepancies, an option surface with no enumerated keys | 14 rows, 10 collisions, 5 discrepancies, a 21-key option ledger | Each addition is a platform fact found during delivery; suppressing one to preserve a count would have hidden real behaviour | Additive only; no existing document edited | Review and accept the larger inventories (§2.2 sign-off) |
| **DV4** — Tickets to cite `Channel.trackInventory` and `Channel.outOfStockThreshold` as the inventory authority | Tickets follow the plan, and the platform's divergent live read path is carried as architectural decision 5, open and maintainer-owned | The shipped saleable-stock read resolves a single `GlobalSettings` row with no channel predicate; the two `Channel` columns are read nowhere in `packages/core` | Every availability criterion additionally requires the global row seeded consistently | Sign off the decision (§1.4, §2.2) |
| **DV5** — Three permission definitions | Three definitions, but all administrative: one in `FEATURE-001-04` publishing two members, two in `FEATURE-001-08` publishing one each | A customer session cannot hold a custom permission, so buyer operations gated on one would be refused for every buyer in every channel | Count matches; buyer operations gate on `Permission.Owner` plus mandatory in-resolver ownership | None required — reasoning recorded in the epic |
| **DV6** — Nine epic and six feature definition-of-done items | 13 at the epic tier, 11–21 across the eight features; exactly ten at every story tier | The plan names counts without enumerating the items and no exemplar exists in the repository | None to correctness — every item is a cited, checkable obligation | Supply the canonical nine and six, or confirm a superset satisfies it (§2.2) |
| **DV7** — `STORY-001-01-03` implied two operations by its filename | Four operations, repriced 2 → 3 points with both rollups recomputed | The plan's own fourteen-operation Shop inventory left two operations with no owning story, and every alternative breached a harder invariant | No change to file, story or operation counts; the story is wider than its slug suggests | Confirm the home and decide whether to widen the slug (§2.2) |
| **DV8** — One configurable strategy; platform version lock 3.7.0 | One strategy, restored by withdrawing a second; and a 3.7.2+ *validated implementation floor* alongside the unchanged 3.7.0 lock | The second strategy had no owning story and exceeded the declared surface; the patch floor was raised on evidence about the platform | `FEATURE-001-05` ships a due-signal read with no notification transport | Confirm the patch floor when scheduling; raise a separate ticket if an email adapter is wanted (§2.2) |

**DV1 — the gate grew because each round of scrutiny found something nothing checked.** The plan specifies ten validators as the artifact's only enforcement; the suite carries twenty-two plus three evidence commands. A citation naming a nonexistent section and a diagram that did not render made V6 heading-aware and added V15 and V16. Four of the plan's own rules — persona coverage, demonstration concreteness, nomination distinctness, dependency referential integrity — were asserted as gated while nothing checked them, becoming V11–V14. Identifier ambiguity, duplicate GraphQL declaration, definition-of-done drift and one contract stated two ways became V17–V20; a stated count outside a definition-of-done block and severed prose became V21 and V22. Two classes still have no step; §2.2 costs adding them.

**DV2 — the plan's own command forms do not run clean here, and the artifact says so where a reader meets them.** The literal invented-metric grep produces 43 lines, every one inspected by token: 52 are "retention" in the row-lifecycle sense — how long an audit row is kept, a configured plugin option — 26 are the requirements-supplied `minimum 80% line coverage` figure, and one each of `uptime`, `revenue`, `conversion rate`, `SLA`, `MRR` and `ARR` sit inside the epic's own replacement regex as terms of the pattern. No business, latency or conversion figure is asserted anywhere. The plan's estimate skeleton separately raises on this table shape and prints nothing, which is worse than a false alarm.

**DV3 — four inventories are larger than projected, and each extra entry is a platform fact.** The do-not-duplicate inventory carries 14 rows rather than 13; collisions number 10 rather than 6, still separated into eight repository-discovered and two research-discovered; documentation discrepancies number 5 rather than 3; and a 21-key option ledger exists where the plan enumerated no keys. The most consequential addition is the never-applied `preventOverlap` default — the scheduler reads `task.options.preventOverlap ? … : undefined`, so an omitted member is falsy and there is no overlap protection despite the documented default. It is the only one of the five discrepancies that silently changes server behaviour, and dropping it to hold a count of three would have been worse.

**DV4 — the inventory authority the plan names is not the one the platform reads.** The plan directs every stock precondition at `Channel.trackInventory` and `Channel.outOfStockThreshold`. Here the saleable-stock computation resolves a single global settings row with no channel predicate (`packages/core/src/service/services/product-variant.service.ts:L323-L324`), the two `Channel` columns are read nowhere in `packages/core` outside their own declarations, and the global pair they replaced is annotated `@deprecated` (`packages/core/src/entity/global-settings/global-settings.entity.ts:L32-L45`). Rather than amend the plan by implication or hide the platform, the tickets follow the plan and carry the conflict as architectural decision 5. A maintainer must accept the consistent-seeding obligation permanently or approve a plugin-level read of the `Channel` pair.

**DV5 — the permission model moved layer, not count.** The plan fixes three definitions without saying where they live. All three are administrative: `FEATURE-001-04` registers one read-write definition publishing two members and `FEATURE-001-08` registers two single-member definitions, giving three definitions and four published members with the enum moving 97 → 99 → 101. `FEATURE-001-01` and `FEATURE-001-06` register none. The cause is a hard platform constraint: the Customer Role ships holding `Permission.Authenticated` alone, every customer user receives that role, and `RoleService.update` refuses to amend it — so an operation gated on a registered permission would be refused for every buyer in every channel. Buyer operations gate on `Permission.Owner` plus in-resolver ownership.

**DV6 — the definition-of-done counts are supersets of unenumerated targets.** The plan names nine items at the epic tier and six at the feature tier but never lists them, and the repository contains no exemplar to copy. The epic carries 13 and the eight feature files carry between 11 and 21; every story carries exactly ten, which the gate asserts. Reducing to nine and six would have meant inventing a taxonomy the plan does not state and deleting obligations that are individually sound and individually cited — silent invention judged the worse failure. A maintainer should supply the canonical nine and six or confirm a superset satisfies the requirement; step V19 will then hold the chosen figure.

**DV7 — one story is wider than the filename the plan gave it.** The plan names `STORY-001-01-03` `change-line-quantity-and-remove-line`, implying two operations, while its own inventory lists fourteen Shop API operations including `updateReorderList` and `deleteReorderList` with no story named as their owner. An operation declared with no owner is a real gap, and every alternative breached a harder invariant: a twenty-sixth story breaks the fixed 25-story, 34-file structure the gate enforces, and `STORY-001-01-01` was already at the eight-criterion ceiling. The two operations were assigned to the existing story, which now owns four — two over a list's lines, two over the list itself — with its delivery row repriced and all rollups recomputed together.

**DV8 — one strategy restored by withdrawal, and a patch floor raised.** The plan enumerates exactly one configurable strategy for the whole set: `FEATURE-001-04`'s substitution-candidate strategy. A replenishment notification strategy that had appeared in `FEATURE-001-05` was withdrawn on three stated grounds — it exceeded the declared surface, it had no owning story, and removing it discharges the no-external-service constraint more completely because nothing in the feature then leaves the process. The feature ships a due-signal read and nothing that sends; a deployment wanting email prompts needs a follow-up ticket. Separately the epic requires 3.7.2+ as the validated implementation floor while the version lock and every citation remain 3.7.0, so every `@since 3.8.0` tag still holds.

# 6. Risk Assessment

Forward-looking only: what could still go wrong from here.

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| No pipeline gate inspects the artifact — no CI path filter matches a `tickets/**`-only change, so a future edit can break a citation, link, count or rollup unseen | Technical | High | High | The 25-step suite exists and runs green; stand it up in the maintainer-held digest-pinned location the epic's own execution condition requires, or add a `tickets/**` filter that runs the audited copy | Open — costed in §2.2 (8h) |
| A green gate is a structural verdict, not a semantic one; two blind spots are measured and still unasserted (edge-case scenario indentation, literal sub-task opener) | Technical | Medium | Medium | The epic states the reading obligation and lists seven questions no step can answer; both classes were verified by direct census (121/121 balanced triplets, 25/25 literal openers) and adding the assertions is costed | Open — costed in §2.2 (3h) |
| Citation durability: 13,517 locators pin file-and-line references into a monorepo that moves, so a refactor in `packages/core` will strand line ranges even where the claim stays true | Technical | Medium | High | Every locator is machine-resolvable, so one V6 run identifies the full repair list; the fix is mechanical rather than investigative | Accepted with a monitoring path |
| The suite is contributor-supplied executable text; an automated gate that runs it on a contributed branch would execute that text with a reviewer's credentials | Security | High | Low | Two execution conditions are specified in full — a maintainer-audited copy pinned by digest outside the contribution, or a credentialless, egress-disabled, read-only sandbox aborting on digest mismatch — and neither permits automatic execution on a contributed branch | Open — the audited location does not exist yet (§2.2) |
| Two settled privacy designs are unproven until built: the erasure map that removes every customer-addressed path to an audit row, and the byte-identical empty page that stops a collection identifier acting as an existence oracle | Security | Medium | Medium | Each is specified with the assertion that proves it and is a required test in its owning story's definition of done | Open — carried into implementation |
| Fifteen open pre-build decisions gate implementation and the artifact may not supply their values; decision 6 gates the merge of every story that persists a customer-linked row | Operational | High | High | Each is stated with the number of stories it blocks, so scheduling is a work list rather than a discovery exercise | Open — costed in §2.2 (19h) |
| Branch target unresolved as a three-way conflict between `minor` for feature work, `major` for schema changes, and this branch cut from `master` | Operational | Medium | Medium | The epic states the conflict rather than resolving it, which is the correct posture for a documentation deliverable, and names the evidence on all three sides | Open — costed in §2.2 |
| Engine coverage is narrower than the contribution guide claims: native SQLite has no CI job and no test-harness initializer, and the MySQL job resolves a floating `:latest` tag so the version exercised is not fixed | Integration | Medium | Medium | Both facts are named in the epic, and the evidence gate emits the floating-tag note on every run rather than inheriting it silently; a migration "verified against each supported engine" is evidenced on MariaDB, MySQL, PostgreSQL and sql.js | Open — decision costed in §2.2 |

# 7. Visual Project Status

### Hours: completed against remaining

```mermaid
pie showData title Project Hours Breakdown — 82.7% Complete
    "Completed Work" : 265
    "Remaining Work" : 55.5
```

Colours: **Completed Work = Dark Blue `#5B39F3`** · **Remaining Work = White `#FFFFFF`** · accents Violet-Black `#B23AF2`, highlight Mint `#A8FDD9`.

### Remaining work by priority

```mermaid
pie showData title Remaining 55.5 Hours by Priority
    "High" : 27
    "Medium" : 23
    "Low" : 5.5
```

### Remaining hours per category

```mermaid
xychart-beta
    title "Remaining Hours by Category (total 55.5)"
    x-axis ["Decisions", "Gate", "Sign-off", "Tracker", "Optional", "Docs fix", "Privacy", "Suite"]
    y-axis "Hours" 0 --> 20
    bar [19, 8, 6.5, 6, 5.5, 4, 3.5, 3]
```

### Artifact delivered

```mermaid
pie showData title Files Delivered by Tier — 34 Total
    "Story tickets" : 25
    "Feature contracts" : 8
    "Epic" : 1
```

**Integrity note.** "Remaining Work" is **55.5** hours here, in the Section 1.2 metrics table, and as the sum of the Section 2.2 Hours column. "Completed Work" is **265** in all three places. `265 + 55.5 = 320.5` Total Hours, and `265 / 320.5 = 82.7%` — the same percentage stated in Sections 1.2 and 8.

# 8. Summary &amp; Recommendations

**What was delivered.** `tickets/` now holds a complete three-tier decomposition of the reorder and replenishment objective: one epic carrying all twelve mandated sections, eight feature contracts each carrying five, and twenty-five story tickets each carrying ten — 34 files, 9 subdirectories, 23,017 lines, added without modifying or deleting a single existing file. The artifact is unusually dense in verifiable substance rather than prose: 13,517 inline citations that all resolve against real content in this checkout, 195 acceptance criteria in Given/When/Then form, 121 complete edge-case scenario triplets, 87 GraphQL declarations each declared exactly once across the set, 12 rendering diagrams, and a 21-key plugin option ledger with an owner for every key. It also ships its own enforcement: a 25-step gate embedded in epic §11.10 that runs green end to end.

**What was verified, and how.** The gate was executed from the repository root against the committed tree and every one of its 25 steps exits zero. Because a suite that grades its own artifact is a weak instrument on its own, three independent checks were run alongside it: a separately written implementation of the same rules, which agrees at 13,474 citations resolved with zero unresolved and identical story-identifier sets at 25; a real render of all 12 diagrams, 12 of 12 succeeding; and direct census of the two template classes no step asserts, confirming 121 of 121 balanced scenario triplets and 25 of 25 literal sub-task openers. The repository boundary was confirmed mechanically — `packages/core`, `packages/admin-ui` and both permitted-exception configuration files are byte-identical to the baseline, and nothing outside `tickets/` changed.

**The gaps that matter.** Two are structural and both are addressable. First, nothing in the pipeline inspects this artifact: no CI path filter matches a `tickets/**`-only change, and the maintainer-held, digest-pinned validator location the suite's own execution condition requires does not exist. The artifact cannot regress the build, but equally nothing catches a broken citation or a drifted count on the next edit. Second, fifteen pre-build decisions remain open in epic §8 — the keep period for customer-linked rows, the recurrence threshold, the aggregate window, the page size, several bounds and maxima, and the locale list. These are open by design, because the tickets are forbidden to invent a value the repository does not declare, but decision 6 gates the merge of every story that persists a customer-linked row, so implementation stalls on the affected stories until they are taken. Behind those sit five signatures: the inventory-authority sign-off, the branch target, the native-SQLite claim, the count divergences in §5.2, and two security design confirmations.

**The honest limit on what any of this proves.** This project delivered a specification, and a green gate is a structural verdict. It establishes that every claim resolves, every count agrees and every contract is stated one way in one place. It cannot establish that a proposed contract is the right contract, and nothing the tickets specify has been exercised at runtime because the code they describe does not exist — no server started, no migration run, no operation sent, no dashboard screen rendered. The compensating control is the reading obligation the epic states in its own words, discharged through the four-file curated path in §9. The artifact is honest about this in a way worth preserving: it reports its traceability split at 13 quoted against 12 inferred rather than flattering it upward, names the shipped wishlist plugin as near-identical precedent where that makes its own work look less original, and declares native SQLite unverified against the contribution guide's own claim of support.

**Production readiness.** The project is **82.7% complete** — 265 of 320.5 hours — measured against the project plan's deliverables plus the path-to-production work needed to make them usable. As a planning input the artifact is ready to read and ready to import; it is not yet ready to be *maintained*, because the edit that follows it has no gate. Recommended order: stand up the validation gate and take the fifteen decisions in parallel (27 hours of High-priority work), then the sign-offs and documentation corrections, then the tracker import. Adding the two missing assertions is cheap and worth doing before the first edit lands. One boundary should stay visible in any schedule: the 113 points, 7,720 production and 5,850 test lines, 92.5 generation hours and 48.8 review hours in epic §9 describe the plugin implementation *ahead*, are deliberately outside this project's scope, and must not be added to the 320.5 hours above.

# 9. Development Guide

This deliverable is Markdown. It compiles nothing, needs no build step and has no preview server. Everything below was executed from the repository root and the outputs shown are the outputs observed.

## 9.1 System Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | `^20.19.0 \|\| >=22.12.0` declared; CI exercises `20.x`, `22.x`, `24.x` | Declared in the root `package.json`; 24.x is the highest line the matrix exercises |
| Bun | 1.3.10, pinned | Pinned by `.github/actions/setup/action.yml`, with an in-file note to bump only when re-validating. Needed only for commands the *tickets* quote, never to validate the artifact |
| Python | 3.x | 23 of the 25 validation steps are Python; no third-party package is required |
| git, grep, awk, find | any | The remaining steps and the evidence commands |
| `@mermaid-js/mermaid-cli` (`mmdc`) | optional | Only if you want diagrams rendered locally. GitHub renders the fenced blocks natively with no tooling |

```bash
# Verify the toolchain. Run from the repository root.
node --version        # expect v20.19+, v22.12+ or v24.x
python3 --version     # expect 3.x
git --version
```

## 9.2 Environment Setup

There is nothing to install and nothing to configure. No environment variable, database, cache or message queue is required to read or validate this artifact.

```bash
cd <repository-root>
git status --porcelain          # expect empty
ls tickets/                     # expect: EPIC-001  EPIC-001-reorder-and-replenishment.md
```

> **Do not run these for this deliverable.** `bun install`, `bun run build`, `bun run test`, `bun run e2e` and `bun run docs:build`. Nothing in `tickets/` compiles; `docs:build` regenerates reference pages under `docs/` from JSDoc, which is a different surface entirely. Do not run Prettier over `tickets/` either — this repository formats no Markdown (`.lintstagedrc.json` carries no `*.md` entry, `.prettierignore` carries no Markdown entry, and there is no `.markdownlint*` or `.remarkrc`), so introducing the practice would create an expectation nothing enforces.

## 9.3 Reading the Artifact

The epic nominates a four-file path, chosen after the decomposition was final, that answers the four questions a reader arrives with. Read them in this order:

```text
tickets/EPIC-001-reorder-and-replenishment.md
    -> what is being built, what already exists, what collides, what must be decided first

tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md
    -> how a reorder actually reaches the cart, and which existing service does the work

tickets/EPIC-001/FEATURE-001-02/STORY-001-02-01-reorder-complete-past-order.md
    -> what one finished, demonstrable unit of this work looks like

tickets/EPIC-001/FEATURE-001-03-price-and-availability-delta-preview.md
    -> how buyers are warned before they commit, and why that is not already solved
```

Two sections repay reading before any implementation is scheduled. Epic **§5** lists the platform mechanisms that must be consumed rather than rebuilt. Epic **§8** lists the twenty ranked pre-build decisions — fifteen still open — each with the number of stories it blocks.

## 9.4 Validating the Artifact

The authority is the 25-step suite in epic **§11.10** — 22 validators and 3 evidence commands. It is written as a **specification**, and the epic is explicit that no step may be run by extracting it from the file on a contributed branch. Execution requires one of two conditions:

- **Condition A — an audited copy pinned by digest.** A maintainer transcribes each step into a validator location that is not part of the branch and not writable by a contribution, records each step's SHA-256 in a manifest held in that same location, and compares the manifest *before* anything executes. This is the intended long-term posture and it does not exist yet.
- **Condition B — a credentialless, read-only sandbox.** No credential of any kind, egress disabled, repository mounted read-only, unprivileged user, and the run aborts on any digest mismatch.

```bash
# Audit before you execute, whichever condition you are under.
# Expect no output from any of the three greps.
grep -nE "open\([^)]*,\s*['\"][wa]|shutil\.|os\.(remove|unlink|rmdir|makedirs|rename)" <step-dir>/*.py
grep -nE "urllib|requests\.|socket|curl |wget " <step-dir>/*.py <step-dir>/*.sh
grep -nE "git (push|commit|checkout|reset|clean|add|rm)" <step-dir>/*.py <step-dir>/*.sh

# Then syntax-check every step.
for f in <step-dir>/*.py; do python3 -c "import ast;ast.parse(open('$f').read())" || echo "PARSE FAIL $f"; done
for f in <step-dir>/*.sh; do bash -n "$f" || echo "SYNTAX FAIL $f"; done
```

```bash
# Run the suite. ALWAYS from the repository root, or every step fails closed on a zero file count.
cd <repository-root>
export BASELINE=$(git merge-base HEAD origin/master)

for s in V1 V2 V3 V4 V5 V6 V7 V8 V9 V10 V11 V12 V13 V14 E1 E2 E3 \
         V15 V16 V17 V18 V19 V20 V21 V22; do
  f=<step-dir>/$s.py; [ -f "$f" ] || f=<step-dir>/$s.sh
  case "$f" in *.py) python3 "$f";; *) bash "$f";; esac
  echo "$s exit=$?"
done
```

The gate is that **all twenty-five exit zero**, and a step is never relaxed to accommodate content.

## 9.5 Verification Steps

Each of these runs on its own in under a second and needs no setup.

```bash
# The tree is exactly the declared tree.
find tickets -name '*.md' -type f | wc -l        # expect 34
find tickets -mindepth 1 -type d | wc -l         # expect 9
find tickets -name '*.md' -type f | grep -cE \
  '/(EPIC-[0-9]{3}-|FEATURE-[0-9]{3}-[0-9]{2}-|STORY-[0-9]{3}-[0-9]{2}-[0-9]{2}-)[a-z0-9-]+\.md$'
                                                  # expect 34
```

```bash
# Every relative navigation link resolves.
python3 - <<'PY'
import os, re, glob
bad = [t for f in glob.glob('tickets/**/*.md', recursive=True)
         for t in re.findall(r'\]\((\./[^)]+\.md)\)', open(f).read())
         if not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(f), t)))]
print('broken links:', len(bad))      # expect 0   (33 links found)
PY
```

```bash
# The zero-edit boundary holds. Expect no output at all.
git diff --stat -- packages/core packages/admin-ui \
                   packages/dev-server/dev-config.ts packages/dev-server/vite.config.mts

# Nothing outside tickets/ changed. Expect 0.
git diff --name-only $(git merge-base HEAD origin/master)..HEAD | grep -vc '^tickets/'
```

```bash
# The platform evidence the definition of done relies on exists.
grep -oE 'e2e-(sqljs|mariadb|mysql|postgres):' .github/workflows/build_and_test.yml
ls e2e-common/vitest.config.bench.ts \
   packages/core/e2e/default-search-plugin.bench.ts \
   packages/dev-server/load-testing/benchmarks.ts
```

**A model verification output.** Step V8 prints nine `ok` lines and then its verdict — this is the shape every step's success looks like:

```text
V8: hierarchy, count and naming assertions
  ok   markdown files under tickets/ = 34
  ok   directories below tickets/ = 9
  ok   non-markdown files under tickets/ = 0
  ok   symlinks under tickets/ = 0
  ok   epic tickets/EPIC-001-reorder-and-replenishment.md
  ok   every file on disk is an expected member of the EPIC-001 hierarchy
  ok   expected hierarchy members resolved by identifier = 34
  ok   the directory set is exactly the expected 9 directories
V8: PASS
```

## 9.6 Optional: Rendering the Diagrams Locally

Optional. GitHub renders every fenced Mermaid block natively, so nothing here is required to read the artifact. `OUT` is any scratch directory outside the repository — never a path inside `tickets/`, since the tree must stay at exactly 34 files.

```bash
export OUT="${OUT:?set OUT to a scratch directory outside the repository}"
mkdir -p "$OUT" && printf '{"args":["--no-sandbox","--disable-dev-shm-usage"]}\n' > "$OUT/pp.json"

python3 - <<'PY'
import glob, os
out = os.environ['OUT']
n = 0
for f in sorted(glob.glob('tickets/**/*.md', recursive=True)):
    inb, buf = False, []
    for l in open(f).read().split('\n'):
        if l.strip().startswith('```mermaid'): inb, buf = True, []; continue
        if inb and l.strip() == '```':
            inb = False; n += 1
            open(os.path.join(out, f'd{n:02d}.mmd'), 'w').write('\n'.join(buf) + '\n'); continue
        if inb: buf.append(l)
print('extracted:', n)      # expect 12
PY

for f in "$OUT"/*.mmd; do mmdc -p "$OUT/pp.json" -i "$f" -o "${f%.mmd}.svg" -q || echo "FAIL $f"; done
# expect 12 SVGs and no FAIL line
```

## 9.7 Troubleshooting

Every case below was reproduced, not imagined.

| Symptom | Cause | Resolution |
|---|---|---|
| A step prints `FAIL files inspected number 0, expected exactly 34` and exits 1 | The step was run from somewhere other than the repository root | `cd` to the repository root first. This is the "exact counts, never at least" invariant doing its job — a step that read nothing fails rather than reporting success |
| `E1: FAIL no baseline resolved. Export BASELINE=<commit>, or UPSTREAM=<ref>…` | Neither `BASELINE` nor a resolvable upstream is set — common in a shallow checkout with no `origin/master` | `export BASELINE=$(git merge-base HEAD origin/master)`, or `export UPSTREAM=<ref>` so that `git merge-base` resolves |
| `E1: FAIL BASELINE resolves to HEAD (…). Every commit on this branch would then be invisible to this gate.` | `BASELINE` was set to `HEAD` | Use the commit the branch diverged from. This refusal is deliberate: it is the one condition the baseline exists to prevent |
| `Error: Failed to launch the browser process: Code: 1` when rendering a diagram | `mmdc` cannot start Chrome without a sandbox-disabling config in a container | Pass `-p` with a config carrying `--no-sandbox --disable-dev-shm-usage`. Rendering is optional — GitHub renders the fenced blocks natively |
| An invented-metric scan reports dozens of lines that are plainly not metrics | The shorter command set sketched in the requirements was run instead of the suite's own step | Run the §11.10 steps. The epic declares the supersession in the paragraph before them; the shorter forms over-report row-lifecycle language and one of them prints nothing at all on this table shape |
| A citation resolves to the wrong content after a refactor in `packages/core` | Line-range locators pin to positions that move | Run V6 for the full repair list — every locator is machine-resolvable, so the fix is mechanical rather than investigative |
| The file count reads 35 or more | A scratch file, index or README was added under `tickets/` | Remove it. The epic states a total of 34 and V8 compares that against the tree as an exact set, so any extra file fails the gate |

## 9.8 Example Usage — Following a Story Through to a Demonstration

The two stories the epic nominates are the fastest way to see the artifact work as intended.

- **`STORY-001-01-01` — the harness-proving run.** The first story in dependency order that needs a new plugin-owned table, so it is the first additive migration. It exercises the whole toolchain in one pass — new entity, additive migration, schema extension, permission-gated resolver, and an end-to-end specification — and it has no prerequisite story, so a failure isolates to the environment rather than to the domain.
- **`STORY-001-02-01` — the demonstration slice.** Observable to a non-coder as one named operation with its inputs and expected response, traceable to a quoted clause of the objective, with no near-identical precedent in the repository. Its only prerequisites are the plugin module itself and one placed order for the authenticated customer.

Both name real scripts. `packages/dev-server/package.json` declares `dev` (`node ../cli/dist/cli.js dev all --server-entry ./index.ts --worker-entry ./index-worker.ts`) and `populate` (`node -r ts-node/register -r dotenv/config populate-dev-server.ts`), and the stories quote them as the way a reader starts and seeds a server once the plugin exists. Nothing in `tickets/` runs them today, and nothing needs to.

# 10. Appendices

## A. Command Reference

| Purpose | Command | Expected result |
|---|---|---|
| Count the artifact | `find tickets -name '*.md' -type f \| wc -l` | `34` |
| Count directories | `find tickets -mindepth 1 -type d \| wc -l` | `9` |
| Check naming conformance | `find tickets -name '*.md' -type f \| grep -cE '/(EPIC-[0-9]{3}-\|FEATURE-[0-9]{3}-[0-9]{2}-\|STORY-[0-9]{3}-[0-9]{2}-[0-9]{2}-)[a-z0-9-]+\.md$'` | `34` |
| Zero-edit boundary | `git diff --stat -- packages/core packages/admin-ui packages/dev-server/dev-config.ts packages/dev-server/vite.config.mts` | no output |
| Scope containment | `git diff --name-only $(git merge-base HEAD origin/master)..HEAD \| grep -vc '^tickets/'` | `0` |
| Resolve the validation baseline | `export BASELINE=$(git merge-base HEAD origin/master)` | a strict ancestor of `HEAD` |
| Engine-job evidence | `grep -oE 'e2e-(sqljs\|mariadb\|mysql\|postgres):' .github/workflows/build_and_test.yml` | four job names |
| Benchmark-tooling evidence | `ls e2e-common/vitest.config.bench.ts packages/core/e2e/default-search-plugin.bench.ts packages/dev-server/load-testing/benchmarks.ts` | three paths |
| Count acceptance criteria | `find tickets -name 'STORY-*.md' -exec grep -hE '^AC-[0-9]+:' {} + \| wc -l` | `195` |
| Count edge-case scenarios | `find tickets -name 'STORY-*.md' -exec grep -hcE '^\s*\* Scenario:' {} + \| awk '{s+=$1} END {print s}'` | `121` |
| Confirm no diagram in any story | `grep -rln 'mermaid' tickets --include='STORY-*.md' \| wc -l` | `0` |

## B. Port Reference

No port is used to read or validate this artifact. The ports below appear inside ticket text as the addresses a reader will use once the plugin exists.

| Port | Surface | Note |
|---|---|---|
| 3000 | API server, including its own `/dashboard/` route | The labelled alternative in every dashboard runbook: it serves a built bundle |
| 5173 | Vite development server | The single default in every dashboard runbook, because `dev all` already starts Vite as one of its processes and so needs no further command |

## C. Key File Locations

| Path | Role |
|---|---|
| `tickets/EPIC-001-reorder-and-replenishment.md` | The epic. Twelve sections; §5 the do-not-duplicate inventory, §6 the collisions and documentation discrepancies, §7.10 the option ledger, §8 the pre-build decisions, §9 the delivery split, §11.10 the validation suite |
| `tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md` … `-08-recurring-demand-visibility.md` | The eight feature contracts, five sections each |
| `tickets/EPIC-001/FEATURE-001-0N/STORY-001-0N-0S-*.md` | The twenty-five story tickets, ten sections each |
| `packages/core/package.json`, `lerna.json` | The platform version lock, 3.7.0, shared by every package under Lerna fixed versioning |
| `.github/workflows/build_and_test.yml` | The four engine jobs and the Node matrix the migration evidence maps onto |
| `.github/actions/setup/action.yml` | The pinned Bun version |
| `packages/testing/src/index.ts` | The end-to-end harness surface, exporting MySQL, PostgreSQL and sql.js initializers — the evidence that native SQLite is unverified |
| `packages/dev-server/dev-config.ts`, `packages/dev-server/vite.config.mts` | The two permitted configuration exceptions: named in ticket text as the only files a future implementation may touch outside its own package, and untouched here |
| `packages/dev-server/example-plugins/wishlist-plugin/` | The shipped saved-list plugin the tickets disclose as near-identical precedent for the list-creation stories |
| `packages/dev-server/test-plugins/reviews/` | The precedent for a plugin shipping a React dashboard extension with internationalisation catalogues |

## D. Technology Versions

| Component | Version | Source |
|---|---|---|
| `@vendure/core` | 3.7.0 | `packages/core/package.json`; corroborated by `lerna.json` |
| Validated implementation floor required by the epic | 3.7.2+ | Epic §7.1 — see §5.2 DV8 |
| Node.js (declared) | `^20.19.0 \|\| >=22.12.0` | Root `package.json` `engines.node` |
| Node.js (exercised) | `20.x`, `22.x`, `24.x` | `.github/workflows/build_and_test.yml` matrix |
| Bun | 1.3.10, pinned | `.github/actions/setup/action.yml` |
| MariaDB | `mariadb:11.5`, pinned deliberately | `build_and_test.yml`, `e2e-mariadb` |
| MySQL | `vendure/mysql-8-native-auth:latest` — a floating tag | `build_and_test.yml`, `e2e-mysql` |
| PostgreSQL | `postgres:16` | `build_and_test.yml`, `e2e-postgres` |
| sql.js | WebAssembly driver, in-process | `build_and_test.yml`, `e2e-sqljs` |
| Native SQLite | **unverified** — no job, no harness initializer | `packages/testing/src/index.ts` |
| Python (validation steps) | 3.x, no third-party package | 23 of the 25 steps |
| `@mermaid-js/mermaid-cli` | optional, 11.x | Only for local diagram rendering |

## E. Environment Variable Reference

| Variable | Scope | Purpose |
|---|---|---|
| `BASELINE` | Validation only | The commit the boundary gate diffs against. Must be a strict ancestor of `HEAD`; the gate refuses a missing, `HEAD`-equal or unresolvable value |
| `UPSTREAM` | Validation only | Alternative to `BASELINE` — a ref such that `git merge-base HEAD $UPSTREAM` resolves. Defaults to `origin/master` |

No other environment variable is needed. Reading or validating this artifact requires no secret, no credential, no API key and no service endpoint.

## F. Human Task List

16 tasks, 55.5 hours, reconciling exactly with Sections 1.2, 2.2 and 7.

| ID | Task | Priority | Hours |
|---|---|---|---|
| H1 | Close the fifteen open pre-build decisions in epic §8 — keep period for customer-linked rows (gates six stories), recurrence threshold, aggregate window, default page size, lists-per-buyer and lines-per-list bounds, source-line maximum, seats-per-list, substitution-candidate maximum, list-name input contract, locale list | High | 14.0 |
| H2 | Sign off architectural decision 5, the inventory-authority question: accept the consistent-seeding obligation as permanent, or approve a plugin-level read of the `Channel` pair | High | 3.0 |
| H3 | Resolve the three-way branch-target conflict and record the chosen strategy | High | 2.0 |
| H4 | Stand up the maintainer-held, digest-pinned validator location — transcribe all 25 steps outside the contribution and record each step's SHA-256 in a manifest held with the runner | High | 5.0 |
| H5 | Decide and implement a gate for `tickets/**`: a CI path filter running the audited suite, or a documented pre-merge manual gate | High | 3.0 |
| M1 | Adopt the two compensating assertions into the suite — edge-case scenario child-bullet indentation, and the literal sub-task opener | Medium | 3.0 |
| M2 | Review and accept the count divergences: 22 validators against ten, the grown inventories, the 21-key ledger, and the epic and feature definition-of-done counts | Medium | 3.5 |
| M3 | Confirm `STORY-001-01-03` as the home of `updateReorderList` and `deleteReorderList` and its 2 → 3 point reprice; decide whether to widen its slug | Medium | 1.5 |
| M4 | Confirm the 3.7.2+ validated implementation floor when the work is scheduled | Medium | 1.5 |
| M5 | Correct the five reported repository-documentation claims in place | Medium | 4.0 |
| M6 | Review the fail-closed choice on `STORY-001-08-03`'s administrator access audit — an audit-write failure refuses the lookup | Medium | 1.5 |
| M7 | Decide whether the seller-role deployment convention becomes a documented operational requirement, and whether a guard with a SuperAdmin carve-out is wanted | Medium | 2.0 |
| M8 | Import the 34-file set into the tracker preserving the hierarchy; decide whether to surface it from `README.md` | Medium | 6.0 |
| L1 | Decide the native-SQLite support claim for the plugin — 'unverified' today, and the answer changes the definition of done for all 25 stories | Low | 2.0 |
| L2 | Renumber `FEATURE-001-07`'s mixed heading scheme, updating all twelve inbound section citations in the same change | Low | 2.0 |
| L3 | Decide whether a keyset read is worth adding for the support lookup, documented offset-stable only | Low | 1.5 |
| | **Total** | | **55.5** |

## G. Glossary

| Term | Meaning in this artifact |
|---|---|
| **Epic / Feature / Story** | The three tiers of the decomposition: one epic states scope and constraints, eight features state how the pieces fit, twenty-five stories state what must be true for each unit to be accepted |
| **Citation** | An inline `[path:locator]` reference. The locator is a line range, a section heading or a key path, and all 13,517 resolve against real content in this checkout |
| **Locator-less citation** | A cited path with no locator. The gate reports these as failures; there are none |
| **Demonstration slice / harness-proving run** | The two distinct nominations in epic §9 — the story that best shows the work to a non-coder, and the story that best exercises the whole toolchain in one pass |
| **Precedent disclosure** | A required per-story field valued `near-identical`, `partial` or `none`, stating how close the story sits to work already shipped in this repository |
| **`Sized Appropriately`** | The mandated wording for the INVEST size criterion. It deliberately collides with a forbidden term, which is why the forbidden-term check matches on word boundaries with this exact phrase allow-listed |
| **Withdrawn form** | An identifier or contract wording the set has replaced. The gate asserts each is never defined or required again, while still permitting it to be *named* as withdrawn — which is how the artifact records its own corrections |
| **Single authority** | The rule that each settled contract is declared in exactly one place; the gate enforces it in prose as well as in schema blocks |
| **Pre-build decision** | A value or choice the tickets are forbidden to invent because the repository declares no figure for it. Twenty are ranked in epic §8; fifteen remain open |
| **Point-in-time read** | An availability or price read that can go stale between reading and committing. Every such read says so rather than implying a reservation |
| **Evidence command (E1–E3)** | One of three gate steps that check the repository rather than the artifact: the protected-path boundary, the per-engine job set, and the benchmark tooling |
