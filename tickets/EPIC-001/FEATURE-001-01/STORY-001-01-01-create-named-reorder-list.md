# STORY-001-01-01: Create a named reorder list, so that a Returning Buyer holds a durable, owned, channel-scoped list to reorder from later

- **Story ID:** STORY-001-01-01
- **Epic:** EPIC-001, at `tickets/EPIC-001-reorder-and-replenishment.md`
- **Feature:** FEATURE-001-01 Named Reorder Lists with Line Quantities, at `tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md`
- **Persona (WHO):** Returning Buyer
- **Batch:** B1 Foundation, whose "depends on" column reads "Nothing" [tickets/EPIC-001-reorder-and-replenishment.md:§9.4 Run Batches]
- **Owner:** the automated run. Every sub-task in section 6 is assigned to `@automated-run`
- **Nomination:** epic section 9a harness-proving run
- **Operation under test:** `createReorderList`, one of the eight Shop API operations this feature publishes [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.6 Named API Surfaces]
- **Diagrams:** none in this file. Where a visual is needed, read **Figure F1-ER** in the parent feature file [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.8 Figure F1-ER]

---

## 2. Source Traceability

> "Make it effortless for returning buyers to reorder the items they purchase regularly"

That sentence is clause C1 of the objective statement, and the epic maps it to five of the twenty-five stories with this one first [tickets/EPIC-001-reorder-and-replenishment.md:§10.2 Objective-Clause Map]. The label on this story is therefore a quoted clause of the objective statement rather than a derived one.

How this story serves the clause: a buyer cannot reorder a regularly purchased set with less effort than rebuilding it until that set exists as a durable, named, owned object, and this story is the one that brings that object into being. Everything the rest of the epic does to a list — adding a line, materialising it into a cart, previewing a delta, sharing it across seats — reads a row that this story writes.

**Why this story is the epic's harness-proving run.** Four pieces of evidence, each independent of the others, transcribed from the nomination rather than re-argued [tickets/EPIC-001-reorder-and-replenishment.md:§9.5 Nomination]:

- **It is the first story in dependency order that requires a new plugin-owned table**, and therefore the first additive migration in the set. Nothing upstream of it needs to exist.
- **It exercises the entire toolchain in a single pass** — new plugin-owned entities, an additive migration through the existing lifecycle [packages/core/src/migrate.ts:L118], an `extend type Mutation` schema extension of the shape the shipped wishlist plugin already demonstrates [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L16], a permission-gated resolver, and an end-to-end specification driven by the existing harness [packages/testing/src/index.ts:L10-L12]. A misconfiguration in any link of that chain fails this story.
- **It has no prerequisite story**, so a red result isolates to the environment rather than to the reorder design. That property is what makes it a proving run.
- **It runs on the four per-engine jobs that already exist** [.github/workflows/build_and_test.yml:L174] with no new infrastructure, so the first additive migration is evidenced on MariaDB, MySQL, PostgreSQL and sql.js on its first merge.

This story is **not** the epic's demonstration slice. That nomination belongs to `STORY-001-02-01` [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination], and section 3 states the disqualifying reason outright rather than leaving it implicit.

---

## 3. Precedent In This Repository

**PRECEDENT:** near-identical

**A complete saved-list plugin already ships in this repository.** `packages/dev-server/example-plugins/wishlist-plugin/` is not a sketch or a fragment: its own README states that it is the complete plugin described in the platform's "Writing your first plugin" tutorial [packages/dev-server/example-plugins/wishlist-plugin/README.md:L3].

Its entire published surface is three operations, and they are the evidence for the verdict above:

- `activeCustomerWishlist` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L13], declared through `extend type Query` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L12].
- `addToWishlist(productVariantId: ID!)` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L17], declared through `extend type Mutation` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L16].
- `removeFromWishlist(itemId: ID!)` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L18].

**The precedent is heavier than "an example exists".** Searching the documentation tree for the plugin's name returns six files and all six teach it, which the parent feature enumerates with a citation for each [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.3 What Already Exists]. This is the platform's canonical teaching example, not an incidental sample, and the permission helper this story depends on carries a wishlist definition as its own worked example [packages/core/src/common/permission-definition.ts:L119].

**What this story adds beyond it, stated exactly.** Three things, none of which the shipped precedent has:

- **A name.** The precedent exposes one unnamed collection per customer.
- **More than one list per customer.** The precedent offers no way to hold a weekly restock list apart from a quarterly consumables list.
- **A per-line quantity.** The precedent's item entity carries a `ProductVariant` relation [packages/dev-server/example-plugins/wishlist-plugin/entities/wishlist-item.entity.ts:L10-L11] and a `productVariantId` column [packages/dev-server/example-plugins/wishlist-plugin/entities/wishlist-item.entity.ts:L13-L14] and nothing else, so it cannot express "six of this and one of that".

This story delivers the first of the three and creates the table that will hold the third; the per-line quantity becomes writable in `STORY-001-01-02` through `addItemToReorderList`. All three are named here so a reviewer prices this story as the scaffold it is rather than as the whole capability.

**One deliberate departure from the precedent.** The shipped plugin stores ownership as a `relation` custom field pushed onto `Customer` and hidden with `internal: true` [packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts:L18-L24]. This story does not follow it: ownership is a `customerId` column on the plugin-owned `ReorderList` table, because the custom-field route widens published operation signatures as a side effect and that is a reportable violation rather than an accepted cost [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions]. The dev-server custom-fields object is empty today [packages/dev-server/dev-config.ts:L116] and is still empty after this story ships.

**The searched set that produced the verdict.** The whole of `packages/dev-server/example-plugins/`, the whole of `packages/dev-server/test-plugins/`, and `packages/dashboard/test-plans/`. The closest match in that set is the wishlist plugin, and it is close enough that the verdict is near-identical rather than partial.

**The consequence, stated plainly.** Because the precedent is near-identical, this story is disqualified from the epic's demonstration-slice nomination: a bare saved list is the single most heavily precedented thing this epic could build, so demonstrating it would demonstrate a capability the platform already ships. The nomination belongs to `STORY-001-02-01`, which has no near-identical precedent [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination]. This story keeps the harness-proving nomination, where near-identical precedent is an advantage rather than an embarrassment, because a well-trodden shape is the right thing to prove a toolchain with.

---

## 4. User Story

```text
As a Returning Buyer,
I want to create a reorder list under a name I choose,
So that the set of items I buy regularly is retrievable by that name in a later session instead of being rebuilt from the catalogue.
```

### 4.1 INVEST Criteria

- **Independent:** this story depends on no other story in this ticket set. Its prerequisites are the plugin module itself and one authenticated customer, both of which exist outside the epic, which is why the epic nominates it as the run that proves the toolchain [tickets/EPIC-001-reorder-and-replenishment.md:§9.5 Nomination].
- **Negotiable:** the shape of the input payload, the name-length bound and whether the permission set is one definition or four are all open to a maintainer's decision; the two architectural decisions that bear on this story are recorded in the epic rather than settled here [tickets/EPIC-001-reorder-and-replenishment.md:§8.2 Architectural Decisions].
- **Valuable:** a named list is the object every later reorder path reads. Without it the buyer has nowhere to keep a repeat purchase set, and FEATURE-001-02 has no list to materialise into a cart.
- **Estimable:** the shape is a re-application of shipped work — two plugin-owned entities, one additive migration, one service method, one permission-gated resolver — so its size is anchored to a plugin that exists in this repository rather than to intuition [tickets/EPIC-001-reorder-and-replenishment.md:§9.1 The Estimation Rubric].
- **Sized Appropriately:** three points on the epic's Fibonacci scale, which prices a new plugin-owned table plus its additive migration plus one operation at exactly that value, and the scale deliberately omits thirteen so an oversized story is split instead of estimated [tickets/EPIC-001-reorder-and-replenishment.md:§9.1 The Estimation Rubric].
- **Testable:** every criterion in section 5 names one GraphQL operation and asserts a state a test can read — an exact list name, a line count of zero, an exact error result type, an exact stored column value, or an exact count of root Shop API queries.

### 4.2 Demonstration Requirement

One path, runnable end to end, with the working directory stated first.

1. `cd packages/dev-server` [CONTRIBUTING.md:L148] and seed the database with `bun run populate` [packages/dev-server/package.json:L8], the command the contribution guide shows with that working directory [CONTRIBUTING.md:L149].
2. Start the server from the same directory with `bun run dev` [packages/dev-server/package.json:L13], the form the contribution guide documents [CONTRIBUTING.md:L179] and [CONTRIBUTING.md:L180].
3. Authenticate against the Shop API as a customer from the populated data, sending the channel token in the `vendure-token` request header [packages/core/src/entity/channel/channel.entity.ts:L58-L59].
4. Execute the mutation below and read the returned list identifier and name.

```graphql
mutation {
    createReorderList(input: { name: "Weekly grocery restock" }) {
        ... on ReorderList {
            id
            name
            lines {
                id
            }
        }
        ... on ReorderListNameConflictError {
            errorCode
            message
        }
        ... on ReorderListLimitError {
            errorCode
            message
        }
    }
}
```

**Expected:** a `ReorderList` payload whose `name` equals `Weekly grocery restock` character for character, whose `id` is a new identifier, and whose `lines` collection holds exactly zero entries.

That block is a request shape, not an implementation. No Admin API surface is exercised by this story, so no administrative credential is used in the demonstration, and no dashboard extension is opened.

---

## 5. Acceptance Criteria

Eight criteria. Each names exactly one GraphQL operation, so a failing criterion points at a single published contract. The five required coverage classes map onto them as follows: valid input is AC-1, invalid or incomplete input is AC-2, an error naming the exact type returned is AC-3 and AC-4, an edge case is AC-7, and the assertion that an existing operation is unchanged is AC-8. AC-5 and AC-6 carry the two authorisation assertions that the parent feature makes mandatory in every story of this feature [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.7 The Existing Mechanism This Feature Consumes Rather Than Rebuilds].

Two properties of the operation are stated once here rather than repeated in every criterion. `createReorderList` is a single synchronous write: it enqueues no job and schedules no task, so there is no asynchronous trigger and no observable completion signal to name. And it reads no price and no stock level, so no criterion below is a point-in-time availability read that can go stale between check and commit; that class of read belongs to FEATURE-001-03 and FEATURE-001-04.

AC-1: A named list is created for the authenticated customer in the active channel
* Given a Returning Buyer is authenticated against the Shop API in the channel identified by the token sent in the `vendure-token` request header [packages/core/src/entity/channel/channel.entity.ts:L62], the request resolves its language from that channel's `defaultLanguageCode` [packages/core/src/entity/channel/channel.entity.ts:L74], and that customer owns no `ReorderList` row named `Weekly grocery restock` in that channel
* When that customer executes the `createReorderList` mutation with the name `Weekly grocery restock`
* Then the mutation returns a `ReorderList` whose `name` equals `Weekly grocery restock` character for character and whose line count is exactly zero, the stored row carries the authenticated customer as its `customerId` and the token's channel as its `channelId`, and the same `name` string is returned under every `languageCode` because a list name is stored as the buyer entered it and is not a translated string [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.9 Channel Scoping, Language Scoping And Monetary Values]

AC-2: A blank name is rejected and no row is written
* Given a Returning Buyer is authenticated in the active channel, and the number of `ReorderList` rows that customer owns in that channel is recorded before the call
* When that customer executes the `createReorderList` mutation with a name consisting only of space characters
* Then no `ReorderList` row is written, the recorded number is unchanged at its exact prior value, and the response carries a request-level error entry and no `createReorderList` payload

**A note on AC-2, because the gap is real.** The rejection is not a member of the result union: none of the six error results this ticket set declares covers a blank name, and this story declines to invent a seventh [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.10 The Error Vocabulary This Feature Introduces]. The nearest shipped analogue is the precedent service raising the platform's input-error class when a variant id does not resolve [packages/dev-server/example-plugins/wishlist-plugin/service/wishlist.service.ts:L37-L39]. A *missing* `name` argument is a different case again and is not written as a criterion at all, because a non-nullable input argument fails GraphQL schema validation before any resolver executes.

AC-3: A name the same customer already holds returns ReorderListNameConflictError
* Given a Returning Buyer is authenticated in the active channel and already owns a `ReorderList` named `Weekly grocery restock` in that channel, where the name is unique per owning customer and channel [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.4 Named Entities Touched]
* When that customer executes the `createReorderList` mutation a second time with the name `Weekly grocery restock`
* Then the mutation returns `ReorderListNameConflictError`, no second row is written, and the number of `ReorderList` rows that customer owns in that channel is exactly one

AC-4: A customer holding the configured maximum returns ReorderListLimitError
* Given the plugin option that caps the number of reorder lists per customer is configured to a value, a Returning Buyer is authenticated in the active channel, and the number of `ReorderList` rows that customer owns in that channel is exactly equal to that configured value
* When that customer executes the `createReorderList` mutation with a name they do not already hold
* Then the mutation returns `ReorderListLimitError`, no row is written, and the number of `ReorderList` rows that customer owns in that channel is still exactly the configured value

**A note on AC-4, because the number is deliberately absent.** The maximum itself is an open product decision that the epic records as blocking eight stories including this one [tickets/EPIC-001-reorder-and-replenishment.md:§8.1 Product Decisions], and the parent feature states that until a maintainer takes it the error type is declarable while its numeric trigger is not writable [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.10 The Error Vocabulary This Feature Introduces]. AC-4 therefore asserts the boundary behaviour against whatever value is configured and invents no figure. The shape is idiomatic rather than novel: the platform already ships an order-level limit error [packages/core/src/api/schema/common/common-error-results.graphql:L37] that carries its own maximum in its payload [packages/core/src/api/schema/common/common-error-results.graphql:L40], so what is missing here is the value and not the pattern. Both `ReorderListNameConflictError` and `ReorderListLimitError` are declared new by this ticket set, and declaring them grows the published `ErrorCode` enum on every boot, because its members are derived from every type implementing the `ErrorResult` interface [packages/core/src/api/config/generate-error-code-enum.ts:L9] matched against the interface-name constant in the same file [packages/core/src/api/config/generate-error-code-enum.ts:L3] by a filter over each type's declared interfaces [packages/core/src/api/config/generate-error-code-enum.ts:L17]. The epic records that growth as collision C2 and requires any consuming example that switches on `ErrorCode` to carry a default branch [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions].

AC-5: An unauthenticated request writes nothing
* Given the request carries a valid channel token in the `vendure-token` header [packages/core/src/entity/channel/channel.entity.ts:L62] and no authenticated session
* When the `createReorderList` mutation is executed with a name
* Then no `ReorderList` row is written and the response carries no `createReorderList` payload, the request being refused by the session guard the shipped precedent already demonstrates for a request holding no active user [packages/dev-server/example-plugins/wishlist-plugin/service/wishlist.service.ts:L74-L76]

AC-6: Ownership is derived from the session and cannot be nominated by the caller
* Given two customers exist in the active channel, a Returning Buyer is authenticated as the second of them, and that session holds the `Create` permission this feature's CRUD permission definition exposes [packages/core/src/common/permission-definition.ts:L172]
* When that customer executes the `createReorderList` mutation
* Then the created row's `customerId` is the authenticated customer's id, the operation exposes no argument able to nominate a different owner, and no row owned by the first customer can be produced by this call

**A note on AC-6, because the gate alone is not the control.** The gate is a `CrudPermissionDefinition` [packages/core/src/common/permission-definition.ts:L146] built from the single name `ReorderList`, which yields four permissions from that one name [packages/core/src/common/permission-definition.ts:L114-L115] by mapping the four operations over it [packages/core/src/common/permission-definition.ts:L156], is registered through `authOptions.customPermissions` [packages/core/src/common/permission-definition.ts:L123-L128] and is applied to the resolver with the `@Allow` decorator [packages/core/src/common/permission-definition.ts:L134]. The control is the in-resolver logic asserted above, and it is mandatory rather than defensive: this platform states in its own source that ownership cannot be statically encoded, so a resolver relying on it **must** include logic enforcing that only the owner of the resource has access, and without that logic the effect is the same as public access [packages/core/src/api/config/generate-permissions.ts:L32-L34]. How many permission definitions the epic registers is an open architectural decision, so the single definition named here is a proposal rather than a settled fact [tickets/EPIC-001-reorder-and-replenishment.md:§8.2 Architectural Decisions], and registering it grows the published `Permission` enum, which the epic records as collision C3 [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions].

AC-7: The same name under a different channel token creates a second list
* Given a Returning Buyer owns a `ReorderList` named `Weekly grocery restock` created under one channel token, and a second channel exists carrying a different unique token [packages/core/src/entity/channel/channel.entity.ts:L62]
* When that same customer executes the `createReorderList` mutation with the name `Weekly grocery restock` while sending the second channel's token in the `vendure-token` header
* Then the mutation returns a new `ReorderList` rather than `ReorderListNameConflictError`, the new row's `channelId` is the second channel, and that customer owns exactly one list of that name in each of the two channels, because uniqueness is per owning customer and channel rather than per customer alone

**A note on AC-7.** The complementary read assertion — that a list created under one channel token is not returned under a foreign one — is asserted on the read operations in `STORY-001-01-04`, because this story publishes no query [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.9 Channel Scoping, Language Scoping And Monetary Values].

AC-8: The existing customer read path is unchanged
* Given `ReorderPlugin` is registered in the dev-server plugin array [packages/dev-server/dev-config.ts:L121] and the Shop API schema has been regenerated with this story's `extend type Mutation` block loaded
* When the `activeCustomer` query [packages/core/src/api/schema/shop-api/shop.api.graphql:L5] is executed by an authenticated customer
* Then it returns that authenticated customer as it did before the plugin was registered, its declared signature is byte-identical, and the Shop API root `Query` type still declares exactly nineteen root queries [packages/core/src/api/schema/shop-api/shop.api.graphql:L1-L52]

**A note on AC-8, which is the additive-only constraint made countable.** The byte-identical assertion covers every existing operation declared in that file, including `addItemToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L72], `addItemsToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L74] and `adjustOrderLine` [packages/core/src/api/schema/shop-api/shop.api.graphql:L80]: none of the three gains an argument, loses an argument or changes its return type, and definition-of-done item 7 records the same assertion as a merge gate. Where a platform mechanism would widen one of those signatures as a side effect of an otherwise additive change, it is reported to the epic's collision section rather than accepted silently [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions].

---

## 6. Sub-tasks

Sub-tasks:
* Define or extend the two plugin-owned entities this feature owns — `ReorderList` with its `customerId` and `channelId` columns, its buyer-supplied `name` column and its uniqueness rule over owning customer and channel, and `ReorderListLine` with its parent-list, variant and integer-quantity columns — together with the plugin option that caps the number of lists per customer — @automated-run
* Implement the `ReorderListService` creation method and its Shop API resolver, deriving the owning customer from the authenticated session — @automated-run
* Write additive TypeORM migration — @automated-run
* Extend Shop API schema and permission-gate the operation — @automated-run
* Build the storefront-consumable `createReorderList` mutation payload, this feature shipping no dashboard surface — @automated-run
* Write unit tests for the name-uniqueness check, the blank-name rejection and the session-derived ownership resolution — @automated-run
* Write e2e test via @vendure/testing covering all acceptance criteria — @automated-run
* Verify no regression on `activeCustomer` and `addItemToOrder` — @automated-run
* Document operation and payload schema — @automated-run

Four notes on that block, so no sub-task is read as carrying more latitude than it has.

- **Both tables are created here, and only one of them is written to here.** The parent feature's story index assigns "the new tables" to this story, in the plural [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§3. User Stories Index], so this story's single additive migration creates `ReorderList` and `ReorderListLine` together. This story writes rows to the first table only: the first write to `ReorderListLine` arrives with `addItemToReorderList` in `STORY-001-01-02`, which is why no criterion in section 5 asserts a line row and why AC-1 asserts a line count of exactly zero. Shipping both tables in one migration is what keeps the count of additive migrations in this feature at one rather than two.
- **The schema sub-task alters no existing field.** It adds `createReorderList` inside an `extend type Mutation` block, following the precedent the shipped plugin sets [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L16].
- **The migration sub-task uses the lifecycle that already exists** — generated with `generateMigration` [packages/core/src/migrate.ts:L118], applied with `runMigrations` [packages/core/src/migrate.ts:L40] and rolled back with `revertLastMigration` [packages/core/src/migrate.ts:L89] — and it adds new tables only, with no destructive statement and no column type change on any existing table.
- **The documentation sub-task means JSDoc on the new public API** rather than a hand-written page, because this platform generates its reference documentation from the sources [tickets/EPIC-001-reorder-and-replenishment.md:§11.5 Public API Documentation Is Generated].

---

## 7. Edge Cases

Four scenarios. The three unconditionally required categories are covered by the first three, and the fourth covers the one conditional category that applies to a create-a-list operation. Two of the required three resolve to *proceed* rather than to a block or a warning, and that is stated honestly rather than force-fitted into a failure the operation cannot have.

* Scenario: Zero, null or empty collection — the customer owns no reorder list at all
   * Given a Returning Buyer is authenticated in the active channel and owns zero `ReorderList` rows in that channel
   * When that customer executes `createReorderList` with the name `Weekly grocery restock`
   * Then proceed: the mutation returns a `ReorderList` whose line count is exactly zero and whose name equals the input name, and the number of lists that customer owns in that channel becomes exactly one — an empty starting state is the normal first call rather than an error path

* Scenario: An item unavailable, deleted or disabled since the last purchase — a variant the buyer previously bought is now disabled
   * Given a Returning Buyer previously purchased a variant whose `enabled` flag is now false [packages/core/src/entity/product-variant/product-variant.entity.ts:L53]
   * When that customer executes `createReorderList` with a name they do not already hold
   * Then proceed, with no warning and no audit record: this operation reads no variant at all, because a list is created empty and lines arrive in `STORY-001-01-02`. A disabled variant cannot affect list creation, and its effect on a reorder is evaluated later — at preview time by FEATURE-001-03 and at resolution time by FEATURE-001-04

* Scenario: A price changed since the last purchase — the catalogue price of a previously purchased variant has moved
   * Given the price of a variant the buyer previously purchased has changed since that purchase
   * When that customer executes `createReorderList` with a name they do not already hold
   * Then proceed, with no warning: the `ReorderList` table stores no monetary column, so this story holds no price that could go stale, and a price delta is computed at preview time by FEATURE-001-03 [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.9 Channel Scoping, Language Scoping And Monetary Values]. Copying a price onto a list row would be a defect rather than an optimisation

* Scenario: Concurrent modification or race — two requests create the same list name for the same customer at the same moment
   * Given a Returning Buyer owns no list named `Weekly grocery restock` in the active channel, and two requests carrying that name are in flight together for that customer and that channel
   * When both executions of `createReorderList` reach the write
   * Then block one of the two: exactly one execution returns a `ReorderList` and the other returns `ReorderListNameConflictError`, and the number of lists that customer owns in that channel ends at exactly one more than its starting value, because uniqueness over owning customer and channel is a database constraint rather than a service-only check a second code path could bypass [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.4 Named Entities Touched]

The two remaining conditional categories do not apply here and are not force-fitted. A point-in-time read gone stale between check and commit does not apply because this operation reads no availability and makes no reservation. A channel, currency or language mismatch between an original order and a reorder context does not apply because this operation reads no order and carries no monetary value; the channel dimension it does have is asserted as AC-7 instead.

---

## 8. Dependencies

Each entry states the required thing, then why it is required and where it belongs, and each is classified as a **data dependency** or a **shared code path**.

- **Configuration — the dev-server plugin registration array:** required because none of this feature's operations is reachable until `ReorderPlugin` is registered in that array [packages/dev-server/dev-config.ts:L121], and it belongs to this story as the harness-proving run's first wiring step. **Shared code path**, used by all four stories of FEATURE-001-01. Naming that file here is a documentation act and does not license a documentation run to edit it; the edit belongs to the future implementation run [tickets/EPIC-001-reorder-and-replenishment.md:§11.7 The Two Permitted Configuration Exceptions].
- **Data — one authenticated customer account:** required because the operation derives the owning customer from the session, so nothing can own a list without it, and it is obtainable from the populated dev data [packages/dev-server/package.json:L8]. **Data dependency.**
- **Configuration — `authOptions.customPermissions`:** required as the registration point for the `ReorderList` permission definition that gates this mutation [packages/core/src/common/permission-definition.ts:L123-L128], and it belongs to FEATURE-001-01 as the mechanism all four of its stories consume [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.7 The Existing Mechanism This Feature Consumes Rather Than Rebuilds]. **Shared code path.**
- **Entity `Customer`:** required as the ownership identity stored on `ReorderList`, read through the authenticated session and never altered, and it belongs to the platform rather than to this epic [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.4 Named Entities Touched]. **Shared code path**, read only.
- **Entity `Channel`:** required as the scoping identity stored on `ReorderList`, resolved from the token sent in the `vendure-token` header [packages/core/src/entity/channel/channel.entity.ts:L62], with that channel's `defaultLanguageCode` governing translated output [packages/core/src/entity/channel/channel.entity.ts:L74]; it belongs to the platform. **Shared code path**, read only.
- **Service `TransactionalConnection`:** required as the persistence path for the new tables, which is the idiom the shipped precedent already uses to obtain a repository bound to the request's transaction [packages/dev-server/example-plugins/wishlist-plugin/service/wishlist.service.ts:L46-L50]; it belongs to the platform. **Shared code path.**
- **Test harness `@vendure/testing`:** required by this story's end-to-end sub-task, with no alternative harness introduced, and its surface is exported from one index [packages/testing/src/index.ts:L10-L12]. **Shared code path.**
- **Story — none.** This story has **no prerequisite story** in this ticket set. That is not an accident of ordering: it is one of the four pieces of evidence for the harness-proving nomination in section 2, and the parent feature records the same fact from its own side, with 01-02 depending on 01-01 and never the reverse [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§4.3 Intra-Feature Story Order].

### 8.1 Decisions This Story Waits On

Dependencies on a decision rather than on code. None is taken here, and each belongs to a maintainer.

- **The maximum number of lists per customer.** It is the numeric half of AC-4, and the epic records it as an objective ambiguity blocking eight stories including this one [tickets/EPIC-001-reorder-and-replenishment.md:§8.1 Product Decisions].
- **Zero custom fields, or accept the widening.** Section 3 assumes the zero-custom-fields resolution the epic recommends; the other resolution moves the ownership column and reshapes this story [tickets/EPIC-001-reorder-and-replenishment.md:§8.2 Architectural Decisions].
- **The branch target.** It blocks nothing in this story's design and gates its merge, and it is a conflict in this repository's own documentation rather than an oversight [tickets/EPIC-001-reorder-and-replenishment.md:§11.1 The Branch Target Is A Three-Way Conflict].

### 8.2 A Declared Gap, Recorded Rather Than Absorbed

The parent feature publishes eight Shop API operations, and two of them — `updateReorderList`, which renames a list, and `deleteReorderList`, which removes a list together with its lines [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.6 Named API Surfaces] — are delivered by **no story in this ticket set**. The four stories of FEATURE-001-01 cover creation, line addition, line adjustment and removal, and the read path; renaming and deleting a list fall to none of them.

This story does not absorb them. It adds no acceptance criterion for either operation and claims neither, and its estimate row covers neither. They are recorded here as feature-level surface awaiting a separately assignable story, which is the honest disposition of a gap found after the decomposition was fixed rather than a gap quietly folded into the nearest story.

---

## 9. Story Estimation Guidance

The four numeric values below are transcribed from this story's row in the epic's delivery-split table, which is the single source of truth for every estimate in this ticket set, and they are not recomputed here [tickets/EPIC-001-reorder-and-replenishment.md:§9.2 Story Table].

Estimation Factors:
* Effort: Medium — two plugin-owned entities, one additive migration, one service method, one permission-gated resolver and one end-to-end specification, plus the plugin scaffold and the harness bootstrap that the epic names as the reason this row sits above the three-point baseline anchor [tickets/EPIC-001-reorder-and-replenishment.md:§9.1 The Estimation Rubric]
* Complexity: Low — every mechanism it uses already ships in this repository, from the entity and schema-extension shape [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L16] to the permission helper [packages/core/src/common/permission-definition.ts:L146] and the migration lifecycle [packages/core/src/migrate.ts:L118], so the work is re-application rather than invention
* Uncertainty: Medium — two open decisions bear on it, the list maximum that AC-4 asserts against [tickets/EPIC-001-reorder-and-replenishment.md:§8.1 Product Decisions] and the number of permission definitions registered [tickets/EPIC-001-reorder-and-replenishment.md:§8.2 Architectural Decisions], and as the first additive migration in the set it is also the run that discovers any per-engine migration defect
* Suggested Story Points: 3
* Estimated Lines of Code to Generate: 420, split as 240 production / 180 test
* Estimated Autonomous Generation Time: 3.0 hours
* Estimated Human Review Time: 1.2 hours

---

## 10. Definition of Done (Story-Level)

- [ ] Every acceptance criterion in section 5 is covered by an automated test that names the same GraphQL operation the criterion names, with none waived or partially accepted.
- [ ] Unit tests are co-located with the files they test and carry the `.spec.ts` suffix [CONTRIBUTING.md:L428], and they reach minimum 80% line coverage over the new service methods.
- [ ] An end-to-end specification lives in the package's own `e2e/` directory [CONTRIBUTING.md:L434], is written with the `@vendure/testing` package [CONTRIBUTING.md:L436] whose harness surface is exported from one index [packages/testing/src/index.ts:L10-L12], and exercises every acceptance criterion in section 5.
- [ ] The additive TypeORM migration is generated [packages/core/src/migrate.ts:L118], applied [packages/core/src/migrate.ts:L40] and reverted once [packages/core/src/migrate.ts:L89]; it adds only new tables, alters no existing column type, and performs no destructive statement.
- [ ] The migration is exercised on the four database engine jobs that already exist — `e2e-sqljs` [.github/workflows/build_and_test.yml:L174], `e2e-mariadb` [.github/workflows/build_and_test.yml:L202], `e2e-mysql` [.github/workflows/build_and_test.yml:L240] and `e2e-postgres` [.github/workflows/build_and_test.yml:L276] — with **native SQLite recorded as an unverified engine** and not claimed, because the test package exports MySQL, PostgreSQL and sql.js initializers only [packages/testing/src/index.ts:L10-L12] while the contribution guide lists SQLite as officially supported [CONTRIBUTING.md:L143]; the MariaDB job stays pinned to `mariadb:11.5` [.github/workflows/build_and_test.yml:L213] because of the default change its own comment records [.github/workflows/build_and_test.yml:L211].
- [ ] `git diff --stat -- packages/core packages/admin-ui` prints nothing, and the dev-server custom-fields object is still empty [packages/dev-server/dev-config.ts:L116].
- [ ] No existing Shop API operation signature changed: the regenerated schema still declares nineteen root queries [packages/core/src/api/schema/shop-api/shop.api.graphql:L1-L52] and leaves `addItemToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L72] and `addItemsToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L74] byte-identical, and any side-effect widening of an existing operation or of a published enum is reported to the epic's Feasibility Collisions section rather than accepted [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions].
- [ ] The mutation is permission-gated by the CRUD permission definition [packages/core/src/common/permission-definition.ts:L146] **and** the resolver contains its own ownership enforcement, because a permission on its own is the equivalent of public access [packages/core/src/api/config/generate-permissions.ts:L32-L34]; a request authenticated as a different customer is refused, and a negative test proves it.
- [ ] The operation and its payload schema are documented as JSDoc on the new public API, every doc block carrying a `@since` tag naming the next minor version — for this checkout that derives to `@since 3.8.0`, from the declared version 3.7.0 [packages/core/package.json:L3] and the next-minor rule [CONTRIBUTING.md:L340], and it is presented as a derivation rather than as a quotation because the guide's own example names a different version.
- [ ] The demonstration path in section 4 was executed end to end after deleting the cached seed data under the package's own `e2e/__data__/` directory, which the agent handbook requires after a schema change [AGENTS.md:L19].
