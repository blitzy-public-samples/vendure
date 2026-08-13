# STORY-001-02-01: Reorder a complete past order into the active cart through one permission-gated mutation, so that a returning buyer receives every line of a repeat purchase in a single call with a named outcome per line

- Parent feature: `tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md`, whose short name is **Reorder from Order History and Saved Lists** [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§1. Feature Title].
- Parent epic: `tickets/EPIC-001-reorder-and-replenishment.md`.
- Batch: **B2, Reorder execution** [tickets/EPIC-001-reorder-and-replenishment.md:§9.4 Run Batches].
- Owner: the automated run [tickets/EPIC-001-reorder-and-replenishment.md:§9.2 Story Table].
- Nomination: this story is the epic's **demonstration slice**, and its four conditions are evidenced in sections 2, 3, 4 and 8 of this file [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination].
- Visual: where this story needs one it names **Figure F2-SEQ** in the parent feature file [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.7 Figure F2-SEQ], which runs from the storefront through the new resolver and the new plugin service into `OrderService.addItemsToOrder` [packages/core/src/service/services/order.service.ts:L654] and back out as a per-line outcome. **This file embeds no figure of its own**, and it names no other artifact as a link, following its parent's convention of keeping a file's link count equal to the number of children it indexes. This story indexes none.
- Rules: **no user-specified rules were provided for this project**, so nothing in this file is attributed to one [tickets/EPIC-001-reorder-and-replenishment.md:§11.9 User-Specified Rules]. Every constraint below derives from the epic's stated architectural constraints and from cited repository conventions, and is carried into the acceptance criteria in section 5 and the definition of done in section 10 rather than asserted once in a preamble.

---

## 1. Story Title

**Reorder a complete past order into the active cart through one permission-gated mutation, so that a returning buyer receives every line of a repeat purchase in a single call with a named outcome per line.**

Short form, transcribed from the epic's story table without rewording so that the two files agree: **Reorder a complete past order** [tickets/EPIC-001-reorder-and-replenishment.md:§9.2 Story Table].

The unit of work the title names is one finished slice. The new mutation exists, it accepts a reference to one placed order, it enforces ownership from the authenticated session, it calls the platform's existing bulk add exactly once, and it returns one outcome for every line it requested. Three things that could be mistaken for part of it are not: narrowing the source to a chosen subset of lines is STORY-001-02-02, the saved-list source path is STORY-001-02-03, and closing the outcome contract over all three source paths is STORY-001-02-04.

---

## 2. Source Traceability

The label is a **quoted objective clause**. The clause is C2 [tickets/EPIC-001-reorder-and-replenishment.md:§10.2 Objective-Clause Map], reproduced verbatim:

> "so that repeat purchasing on the marketplace requires materially less effort than rebuilding an order from scratch"

**This is demonstration-slice condition (i), and it holds.** The label is a quoted clause and not `Inferred`. The distinction is the whole of the condition rather than a formality: twelve of the twenty-five stories in this set carry an `Inferred` label naming the requirements block they derive from [tickets/EPIC-001-reorder-and-replenishment.md:§10.1 The Headline Number], and an inferred story was ruled out of this nomination on the stated ground that the one slice shown to a non-coder should discharge a promise the objective sentence itself makes [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination].

Clause C2 also decides what this story is measured against. The clause speaks of effort relative to rebuilding an order from scratch, so the observable claim is a **countable** one — one call in place of one add-to-cart call per line — and not a timing or conversion claim. This repository declares no numeric business target, and the epic reports that absence as a finding rather than filling it in [tickets/EPIC-001-reorder-and-replenishment.md:§2.2 Business Value, Stated Without Invented Numbers]. No figure is supplied here either.

---

## 3. PRECEDENT In This Repository

**Precedent value: `none`.**

The searched set is named so the claim is checkable rather than asserted: the whole of `packages/dev-server/example-plugins/`, the whole of `packages/dev-server/test-plugins/`, and `packages/dashboard/test-plans/`. That is the same set the epic searched, and this story cites its parent rather than re-running the search [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.12 Precedent In This Repository].

The closest shipped analogue is the wishlist example plugin, and the evidence of non-overlap is its own schema extension. Its entire Shop API surface is three operations — `activeCustomerWishlist`, `addToWishlist(productVariantId: ID!)` and `removeFromWishlist(itemId: ID!)` [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L12-L19]. There is **no order-history-to-cart path of any kind in it**, no bulk projection of source lines, no partial-success payload and no per-line outcome. What this story borrows from it is one mechanism and nothing else: the `extend type Mutation` idiom for adding an operation without touching an existing one [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L16].

**The unflattering half of this disclosure is required output, so it is stated plainly.** The wishlist pattern is this platform's canonical teaching example, and a bare saved list is the single most heavily precedented thing this epic could build. That is exactly why the four stories of FEATURE-001-01 disclose `near-identical` precedent against their own shipped analogue, and why the demonstration slice is deliberately **not** a saved-list story [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination]. This story escapes that verdict on one narrow ground and no other: reading a **placed** order and materialising its lines into the **active** order has no shipped analogue in the searched set. Nothing else about the plugin's anatomy is novel — the entity idiom, the schema extension idiom and the service idiom are all borrowed.

**This is demonstration-slice condition (ii), and it holds** on the evidence above rather than on the absence of a search.

---

## 4. User Story

As a Returning Buyer,
I want to turn one of my past orders into lines on my current cart with a single call,
So that a repeat purchase costs me one call instead of one add-to-cart call per line, and every line that did not land is named back to me with its own outcome.

### 4.1 INVEST Criteria

- **Independent** — no other story in this set is a prerequisite. Section 8.1 gives the whole minimum prerequisite set as exactly two entries, one shared code path and one data dependency, and neither of them is a story. This is **demonstration-slice condition (iv)**, and section 8.1 is its evidence.
- **Negotiable** — the input shape is open. Whether the source order is addressed by its `code` [packages/core/src/entity/order/order.entity.ts:L70] or by its id is a design choice this story may settle either way, and the maximum number of source lines a single call accepts is an open product decision this story may not invent [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§4.5 Open Decisions This Feature Waits On]. What is not negotiable is the single call into the existing bulk add and the per-line outcome it maps back.
- **Valuable** — it is the first point at which a returning buyer gets a repeat purchase into the cart without re-selecting each variant, which is the clause C2 promise in section 2 and the one step of the buyer journey this story owns.
- **Estimable** — the nearest shipped analogue is a seven-file example plugin, and the core call this story consumes already exists with a declared return shape [packages/core/src/service/services/order.service.ts:L663], so the surface to be written is bounded and countable. Section 9 carries the numbers.
- **Sized Appropriately** — one mutation, one resolver, one service method, one projection step and one error-correlation step, over zero new tables [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.3 Named Entities Touched]. It sits at five points on the epic's rubric and is not a candidate for splitting.
- **Testable** — every criterion in section 5 names one published GraphQL operation and asserts an exact line count, an exact integer quantity, or an exact error type name. No criterion asserts a state that has to be judged.

### 4.2 Demonstration Path

One path, concrete, and observable to a non-coder as one named operation with its inputs and its expected response. **This is demonstration-slice condition (iii).**

- **Start the environment from the dev-server package rather than from the repository root**, because neither script exists at the root. Run `cd packages/dev-server` and then `bun run populate` [packages/dev-server/package.json:L8], and then `cd packages/dev-server` and `bun run dev` [packages/dev-server/package.json:L13]. The contribution guide shows both commands with that working directory [CONTRIBUTING.md:L147-L150] and [CONTRIBUTING.md:L178-L181].
- **Sign in over the Shop API as one of the ten seeded customers.** The seed creates ten of them [packages/dev-server/populate-dev-server.ts:L46] and gives every one the password `test` [packages/testing/src/data-population/populate-customers.ts:L19].
- **The email address cannot be written down here, and that limitation is stated rather than papered over.** Seeded addresses are generated from a faker name pair at seed time [packages/testing/src/data-population/mock-data.service.ts:L30], so they differ on every run. Take an `emailAddress` [packages/core/src/api/schema/common/customer.type.graphql:L9] from the customer list in the Admin UI, where the documented default credentials are `superadmin` and `superadmin` [CONTRIBUTING.md:L189-L192]. That lookup is a convenience only. **No acceptance criterion in this story uses an Admin API surface**; the operation itself is a Shop API call, as all four stories in this feature are [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§4.4 Existing Entities, Services And Configuration Required].
- **Place one order for that customer through the existing Shop API**, then read its identifier back through `Customer.orders(options: OrderListOptions): OrderList!` [packages/core/src/api/schema/common/customer.type.graphql:L11].
- **Run one mutation.** The shape below is what this story proposes; it does not exist in the checkout yet and is written here as a target, not as a citation.

```graphql
mutation {
  applyReorderToActiveOrder(input: { sourceOrderId: "<the placed order id>" }) {
    order {
      id
      totalQuantity
      lines {
        id
        quantity
      }
    }
    lineOutcomes {
      sourceOrderLineId
      productVariantId
      requestedQuantity
      addedQuantity
      outcome
    }
  }
}
```

- **The expected response, stated as an exact observable.** For a source order carrying three lines at quantities 2, 1 and 4, the response carries an `order` with three lines whose quantities are 2, 1 and 4 in the order the source lines were requested, a `totalQuantity` of 7 [packages/core/src/entity/order/order.entity.ts:L286], `lineOutcomes` of length 3 each reporting an `addedQuantity` equal to its `requestedQuantity`, and an empty failure list. A non-coder can read that response and see three lines where the cart previously had none.

**Runner-up, recorded for transparency.** STORY-001-03-01 was considered and rejected. It demonstrates the price-and-availability awareness clause, which is arguably the more persuasive demonstration, but a pre-commit preview has nothing to preview until a reorder exists to commit, so it depends on this feature being complete and cannot be the first demonstrable slice [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination].

---

## 5. Acceptance Criteria

Eight criteria. **Each names exactly one published GraphQL operation under test**, so a failure points at a single contract. Criteria name operations, their arguments, and entity and column names as database preconditions; none names a resolver class, a file path or an internal method name. The narrative in section 4 is not restated here — the story carries the value and the criteria carry the testable outcomes.

Three preconditions hold for every criterion without being repeated in each, because they are properties of the request rather than arguments a caller may omit [tickets/EPIC-001-reorder-and-replenishment.md:§7.5 Request Prerequisites]: an authenticated session, a channel resolved from the `vendure-token` request header [packages/core/src/entity/channel/channel.entity.ts:L56-L59], and a language resolved from the channel's `defaultLanguageCode` [packages/core/src/entity/channel/channel.entity.ts:L74]. Where an outcome varies with them, the criterion names the token and the language code.

The error vocabulary these criteria may name is closed. It is the five members of the platform's existing add-or-remove error union [packages/core/src/api/schema/common/common-error-results.graphql:L112-L117], listed as bullets here rather than in the schema's own union form:

- `OrderModificationError` [packages/core/src/api/schema/common/common-error-results.graphql:L80]
- `OrderLimitError`, carrying `maxItems` [packages/core/src/api/schema/common/common-error-results.graphql:L37]
- `NegativeQuantityError` [packages/core/src/api/schema/common/common-error-results.graphql:L44]
- `InsufficientStockError`, carrying `quantityAvailable` and `order` [packages/core/src/api/schema/common/common-error-results.graphql:L50]
- `OrderInterceptorError`, carrying `interceptorError` [packages/core/src/api/schema/common/common-error-results.graphql:L103]

plus the single new `NoReorderableLinesError` this feature declares [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.11 The Error Vocabulary This Feature Introduces]. Declaring one new error result grows the published `ErrorCode` enum automatically, because that enum's members are derived from every type implementing the `ErrorResult` interface [packages/core/src/api/config/generate-error-code-enum.ts:L9]. That side-effect widening is owned by the epic's collision section and by STORY-001-01-04, is referenced here in this one line, and is **not** accepted silently [tickets/EPIC-001-reorder-and-replenishment.md:§6.1 Repository-Discovered Collisions].

AC-1: A whole past order reaches the active cart at the quantities that were placed
* Given an authenticated Returning Buyer whose request carries the channel token `e2e-default-channel` [packages/testing/src/config/test-config.ts:L15] in the `vendure-token` header and resolves to the `languageCode` value `en`; and one source `Order` [packages/core/src/entity/order/order.entity.ts:L44] whose `orderPlacedAt` is set [packages/core/src/entity/order/order.entity.ts:L92], whose `active` column is false [packages/core/src/entity/order/order.entity.ts:L82] and whose `customerId` [packages/core/src/entity/order/order.entity.ts:L99] is that buyer's; and that order carries exactly three `OrderLine` rows whose `orderPlacedQuantity` values are 2, 1 and 4 [packages/core/src/entity/order-line/order-line.entity.ts:L104], each referencing a variant whose saleable quantity is at or above the value on its line
* When `applyReorderToActiveOrder` is executed with a reference to that source order and no line selection
* Then the returned `order` carries exactly three lines, in the order the source lines were requested, whose `quantity` values [packages/core/src/entity/order-line/order-line.entity.ts:L97] are 2, 1 and 4; its `totalQuantity` [packages/core/src/entity/order/order.entity.ts:L286] is 7; the per-line outcome collection holds exactly three entries whose added quantity equals their requested quantity; the failure collection holds zero entries; and the returned `order.currencyCode` [packages/core/src/entity/order/order.entity.ts:L142] equals the channel's `defaultCurrencyCode` [packages/core/src/entity/channel/channel.entity.ts:L88] with every monetary value in the response expressed as an integer in the smallest unit of that currency alongside that code

AC-2: A source order reference that is not a placed order of the authenticated buyer yields the new error result and adds no cart line
* Given an authenticated Returning Buyer, and a source order reference that either matches no row at all or matches an order whose `customerId` [packages/core/src/entity/order/order.entity.ts:L99] belongs to a different customer
* When `applyReorderToActiveOrder` is executed with that reference
* Then the mutation returns `NoReorderableLinesError`, the active order carries the same line count it carried before the call, and the response does **not** distinguish a reference that matches no row from one that matches another customer's order — a deliberate non-disclosure, because no Order not-found error result exists among the error types already implementing the `ErrorResult` interface in this checkout, and the Shop API's own read path records that only orders belonging to the authenticated user may be queried [packages/core/src/api/schema/shop-api/shop.api.graphql:L31-L34]

AC-3: A source line requesting more than the saleable quantity lands at the reduced quantity and names the error type
* Given an authenticated Returning Buyer and a source order carrying exactly two lines whose `orderPlacedQuantity` values are 5 and 1 [packages/core/src/entity/order-line/order-line.entity.ts:L104]; the channel has `trackInventory` true [packages/core/src/entity/channel/channel.entity.ts:L100] and `outOfStockThreshold` 0 [packages/core/src/entity/channel/channel.entity.ts:L108]; the first line's variant has `stockOnHand` 2 [packages/core/src/entity/stock-level/stock-level.entity.ts:L40] and `stockAllocated` 0 [packages/core/src/entity/stock-level/stock-level.entity.ts:L43], so the saleable quantity clamps to 2 [packages/core/src/service/helpers/order-modifier/order-modifier.ts:L117-L133]; the second line's variant has a saleable quantity of at least 1
* When `applyReorderToActiveOrder` is executed with a reference to that source order
* Then the first line is written to the active order at `quantity` 2 rather than 5 and exactly one `InsufficientStockError` [packages/core/src/api/schema/common/common-error-results.graphql:L50] is returned for it carrying `quantityAvailable` 2 [packages/core/src/api/schema/common/common-error-results.graphql:L53] and an `order` [packages/core/src/api/schema/common/common-error-results.graphql:L54]; the second line is written at `quantity` 1 with no error; the per-line outcome collection holds exactly two entries, the first reporting an added quantity of 2 against a requested quantity of 5. A partial add is a success carrying a report and not a failure: the platform writes the line at the reduced quantity and then accumulates the error [packages/core/src/service/services/order.service.ts:L736-L746], so **every reduced quantity is a value the platform returns and never a figure this story supplies**. The availability behind it is read point-in-time, can go stale between the read and the commit, and is not a reservation [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.10 A Point-In-Time Read Is Not A Reservation]

AC-4: A source order whose every line clamps to zero addable quantity writes no line and leaves the cart's line count untouched
* Given an authenticated Returning Buyer and a source order carrying exactly two lines whose variants both remain enabled and not deleted, so the bulk add resolves both [packages/core/src/service/services/order.service.ts:L684-L689], and whose saleable quantity clamps to 0 for each [packages/core/src/service/helpers/order-modifier/order-modifier.ts:L117-L133]
* When `applyReorderToActiveOrder` is executed with a reference to that source order
* Then no line is written for either, the active order carries the same line count it carried before the call, and exactly two `InsufficientStockError` entries are returned, each carrying `quantityAvailable` 0 [packages/core/src/service/services/order.service.ts:L710-L714]. `NoReorderableLinesError` is **not** returned here: the source resolved to two requested lines rather than to zero, and that error covers a source resolving to zero requested lines [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.11 The Error Vocabulary This Feature Introduces]

AC-5: The existing single-item add operation is unchanged after the plugin is registered
* Given the new plugin is registered in the dev-server plugin array [packages/dev-server/dev-config.ts:L121-L155] and the dev-server custom-fields object is still empty [packages/dev-server/dev-config.ts:L116]
* When `addItemToOrder(productVariantId: ID!, quantity: Int!)` [packages/core/src/api/schema/shop-api/shop.api.graphql:L72] is executed against the generated schema
* Then its argument list is byte-identical to its declaration before registration — two arguments, with no third `customFields` argument, which the schema's own docstring states would become available only if custom fields were defined on the `OrderLine` entity [packages/core/src/api/schema/shop-api/shop.api.graphql:L71] — its return type is unchanged, and the existing `shop-order` end-to-end specification passes unmodified [CONTRIBUTING.md:§End-to-end Tests]

AC-6: The existing line-adjustment operation is unchanged after the plugin is registered
* Given the new plugin is registered in the dev-server plugin array [packages/dev-server/dev-config.ts:L121-L155] and no custom field is declared on any core entity by this story
* When `adjustOrderLine(orderLineId: ID!, quantity: Int!)` [packages/core/src/api/schema/shop-api/shop.api.graphql:L80] is executed against the generated schema
* Then its argument list is byte-identical to its declaration before registration — two arguments, with no third argument of type `OrderLineCustomFieldsInput`, which the schema's own docstring states would become available only if custom fields were defined on the `OrderLine` entity [packages/core/src/api/schema/shop-api/shop.api.graphql:L79] — and its return type and nullability are unchanged

AC-7: The existing active-cart read returns the cart the reorder wrote, with an unchanged signature
* Given a Returning Buyer whose session had no cart before the call and for whom `applyReorderToActiveOrder` has since written three lines
* When `activeOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L11] is queried
* Then it returns that cart with exactly three lines, its declared type and nullability are byte-identical to their state before registration, and it gained no argument. Its docstring records that the value is null until an Order is created via `addItemToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L7-L11]; a second operation being able to create the cart is a behavioural note for the new operation's own documentation and **not** a change to this query's signature, and this story edits no docstring in `packages/core`

AC-8: The existing single-order read still refuses another customer's order and gained no reorder argument
* Given an authenticated Returning Buyer, the new plugin registered in the dev-server plugin array [packages/dev-server/dev-config.ts:L121-L155], and the id of an order whose `customerId` [packages/core/src/entity/order/order.entity.ts:L99] belongs to a different customer
* When `order(id: ID!)` [packages/core/src/api/schema/shop-api/shop.api.graphql:L34] is queried with that id
* Then it returns what it returned before registration, because in the Shop API only orders belonging to the currently-authenticated user may be queried [packages/core/src/api/schema/shop-api/shop.api.graphql:L31-L32], it gained no argument and no reorder-specific field, and the root `Query` type still declares nineteen root queries [packages/core/src/api/schema/shop-api/shop.api.graphql:L1-L52]

---

## 6. Sub-tasks

Sub-tasks:
* Define or extend the plugin option set on `ReorderPlugin` — this story defines no entity, no table and no custom field, because the feature introduces none [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.3 Named Entities Touched] and declares zero custom fields on any core entity [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.13 Constraints This Feature Is Built Under] — @automated-run
* Implement the plugin service method that resolves the source order, enforces ownership from the authenticated session, projects each source line to a variant reference and an integer quantity taken from `orderPlacedQuantity` [packages/core/src/entity/order-line/order-line.entity.ts:L104], calls `OrderService.addItemsToOrder` [packages/core/src/service/services/order.service.ts:L654] exactly once, and correlates each returned error back to its requested source line; no event-bus subscriber and no scheduled task, which belong to FEATURE-001-07 and FEATURE-001-05 — @automated-run
* Write additive TypeORM migration — **none is required by this story**, which adds no table and no column and writes only through the platform's existing order write path; the migration lifecycle a table-adding story would generate through is `runMigrations` and its siblings [packages/core/src/migrate.ts:L40], and every reorder table in this set is owned by FEATURE-001-01 and FEATURE-001-07 — @automated-run
* Extend Shop API schema and permission-gate the operation — add the one mutation field through `extend type Mutation` on the root `Mutation` type [packages/core/src/api/schema/shop-api/shop.api.graphql:L70], register its permission through `authOptions.customPermissions`, and pair the gate with in-resolver ownership logic, because a permission alone is the equivalent of public access [packages/core/src/api/config/generate-permissions.ts:L32-L34] — @automated-run
* Build the storefront-consumable surface — the mutation payload mirroring the two-field shape of the platform's published bulk result, an order plus an error collection [packages/core/src/api/schema/shop-api/shop.api.graphql:L298-L300], adding only the correlation back to each requested source line; no dashboard extension, since this story ships no administrative surface — @automated-run
* Write unit tests for the source-line projection, the ownership check and the error-correlation step, co-located with a `.spec.ts` suffix [CONTRIBUTING.md:§Server Unit Tests] — @automated-run
* Write e2e test via @vendure/testing covering all acceptance criteria [packages/testing/src/index.ts:L1-L14], placed under the plugin package's `e2e/` directory [CONTRIBUTING.md:§End-to-end Tests] — @automated-run
* Verify no regression on `addItemToOrder(productVariantId: ID!, quantity: Int!)` [packages/core/src/api/schema/shop-api/shop.api.graphql:L72] by re-running the existing `shop-order` end-to-end specification unmodified — @automated-run
* Document operation and payload schema as JSDoc on the new public API, carrying the derived `@since 3.8.0` tag, since reference pages are generated from JSDoc rather than hand-written [tickets/EPIC-001-reorder-and-replenishment.md:§11.5 Public API Documentation Is Generated, Not Hand-Written] — @automated-run

---

## 7. Edge Cases

Five scenarios: the three categories required of every story in this set, plus the two conditional categories that apply because this story reads availability and copies lines across a request scope. Each is labelled with its category inline, so the category matrix never appears as a table in a story file.

* Scenario: Category — zero, null or empty collection. A placed source order that carries no line at all.
   * Given a placed source order owned by the authenticated Returning Buyer whose `lines` collection [packages/core/src/entity/order/order.entity.ts:L101-L102] is empty, so the projection resolves to zero requested lines
   * When `applyReorderToActiveOrder` is executed with a reference to that order
   * Then the mutation returns `NoReorderableLinesError` and the active order carries the same line count it carried before the call. `NoActiveOrderError` [packages/core/src/api/schema/common/common-error-results.graphql:L95] is **not** returned, because this mutation creates the active order through the platform's existing mechanism and that error is deliberately excluded from its result union [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.8 The No-Active-Order Ruling]

* Scenario: Category — an item unavailable, deleted or disabled since the last purchase. One source line's variant no longer resolves.
   * Given a placed source order carrying four lines, and one of those lines references a variant that no longer satisfies the `enabled: true` and null `deletedAt` predicate the bulk add loads each variant with [packages/core/src/service/services/order.service.ts:L684-L689], or whose parent product has since been disabled, which raises a thrown error [packages/core/src/service/services/order.service.ts:L692-L693]
   * When `applyReorderToActiveOrder` is executed with a reference to that source order
   * Then the call fails at request level and **not one of the four lines is added**, because a thrown error is not an accumulated error entry and there is no `try` and no `catch` anywhere in that bulk-add method — a single line of this class therefore aborts the whole batch. This story asserts that request-level failure rather than a graceful per-line entry, which is the parent feature's explicit ruling: plugin code adds no pre-filter of its own, and this class of unavailability is not expressible as a per-line outcome [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.6 The Existing Mechanisms This Feature Consumes Rather Than Rebuilds]. **The consequence is recorded rather than smoothed over: it is the sharpest limitation of this story**, and the remedy is out of scope here — deciding what to do with an unavailable line, whether to skip it, reduce it, substitute it or abort, is FEATURE-001-04 and its story 04-01. This story reports outcomes and offers no resolution choice

* Scenario: Category — a price changed since the last purchase. The variant now prices at a different integer than the source line recorded.
   * Given a source line whose `listPrice` at placement was 129900 [packages/core/src/entity/order-line/order-line.entity.ts:L120-L121] and whose variant now prices at 134900, both integers in the smallest unit of the currency named by the source order's `currencyCode` [packages/core/src/entity/order/order.entity.ts:L142], and whose `listPriceIncludesTax` flag [packages/core/src/entity/order-line/order-line.entity.ts:L128] records which of gross or net that figure was
   * When `applyReorderToActiveOrder` is executed with a reference to that source order
   * Then the new cart line is priced from the current catalogue by the bulk add's own single adjustment pass [packages/core/src/service/services/order.service.ts:L751] and **no historical price is copied onto it**; this story computes no delta and performs no arithmetic on money. Reporting a delta before the commit is FEATURE-001-03, and reporting one after the add is already done by the platform's existing calculated getters `unitPriceChangeSinceAdded` [packages/core/src/entity/order-line/order-line.entity.ts:L168] and `unitPriceWithTaxChangeSinceAdded` [packages/core/src/entity/order-line/order-line.entity.ts:L181], which this story must not duplicate [tickets/EPIC-001-reorder-and-replenishment.md:§5. Existing Mechanisms That Must Not Be Duplicated]

* Scenario: Category — a point-in-time read gone stale between check and commit. Another order allocated the stock after the storefront read it.
   * Given a storefront read the source order and every line appeared addable, and between that read and the commit another order allocated the stock behind one of those variants
   * When `applyReorderToActiveOrder` is executed with a reference to that source order
   * Then the authoritative decision is the one the bulk add makes at write time through its own validation chain [packages/core/src/service/services/order.service.ts:L675-L679], and the affected line resolves to a per-line `InsufficientStockError` carrying its `quantityAvailable` [packages/core/src/api/schema/common/common-error-results.graphql:L53] rather than to a request-level failure or a retry. A read that showed a line as addable confers no entitlement to add it: **availability is read point-in-time and nothing in this story reserves stock** [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.10 A Point-In-Time Read Is Not A Reservation]

* Scenario: Category — a channel, currency or language mismatch between the original order and the reorder context.
   * Given the source order was placed under one channel `token` [packages/core/src/entity/channel/channel.entity.ts:L62] while the reorder request carries a different token in the `vendure-token` header [packages/core/src/entity/channel/channel.entity.ts:L56-L59]; or the active channel's `defaultCurrencyCode` [packages/core/src/entity/channel/channel.entity.ts:L88] differs from the source order's `currencyCode` [packages/core/src/entity/order/order.entity.ts:L142]; or the request resolves to a language other than the channel's `defaultLanguageCode` [packages/core/src/entity/channel/channel.entity.ts:L74]
   * When `applyReorderToActiveOrder` is executed with a reference to that source order
   * Then a source order belonging to another channel does not resolve at all and is reported as an unresolvable source rather than read across the boundary, which is a hard boundary and not a filter a caller may widen; a currency difference is surfaced in the outcome report with **no conversion attempted**, because this story performs no arithmetic on money at all [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.9 Channel Scoping, Language Scoping And Monetary Values]; and a language difference changes only the translated variant-derived fields the existing catalogue read path resolves, because the outcome report's own fields are identifiers, integer quantities and error type names, none of which is language-varying

---

## 8. Dependencies

Stated in the epic's dependency form — the required thing, then why it is required and where it belongs — with each entry classified as a **data dependency** or a **shared code path**, because a prerequisite without a classification cannot be sequenced. The two sub-sections are kept apart deliberately: the first is what has to be brought into existence before this work can run, and the second is what already ships and is consumed as it stands.

### 8.1 The Minimum Prerequisite Set — Exactly Two Entries, Neither Of Them A Story

- **Configuration, the plugin module and its registration in the dev-server plugin array — shared code path:** the module must be constructed and registered in the `plugins` array before the new mutation is reachable at all [packages/dev-server/dev-config.ts:L121-L155]; it belongs to this piece of work, which is the first in its feature to add a Shop API field, and that array is one of only two files a future implementation may touch outside the plugin package [tickets/EPIC-001-reorder-and-replenishment.md:§11.7 The Two Permitted Configuration Exceptions]. Naming it here is a documentation act and licenses no edit by this ticket.
- **Data, one placed order for the authenticated customer — data dependency:** the source path has no source without it, the row is obtainable end to end through operations that already ship, and it is then readable through `Customer.orders(options: OrderListOptions): OrderList!` [packages/core/src/api/schema/common/customer.type.graphql:L11]; it belongs to the request prerequisites the epic states for every piece of work in this set rather than to any single one [tickets/EPIC-001-reorder-and-replenishment.md:§7.5 Request Prerequisites]. A customer with no placed order is a required edge case rather than an untested state.

**That set is non-empty, it has exactly two entries, and it contains no story.** One is a configuration change and one is a row of data a buyer can create for themselves. That is what makes this piece of work demonstrable on its own the moment the plugin module exists, and it is **demonstration-slice condition (iv)** [tickets/EPIC-001-reorder-and-replenishment.md:§9.6 Nomination].

### 8.2 Existing Platform Surfaces Consumed As They Stand

These are not prerequisites to be built. Each already ships in this checkout, each is read or called without modification, and each sits on the hard zero-edit boundary for the two protected packages. They are listed so that a reviewer can check the whole surface this work touches rather than inferring it.

- **Service `OrderService` — shared code path:** supplies the bulk add this work is built around [packages/core/src/service/services/order.service.ts:L654] and the active-cart read for the authenticated user [packages/core/src/service/services/order.service.ts:L429]; it belongs to `packages/core`, consumed and never modified.
- **Service `ActiveOrderService` — shared code path:** resolves or creates the target cart through the deployment's configured strategy, which is the mechanism the no-active-order ruling rests on [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§2.8 The No-Active-Order Ruling]; it belongs to `packages/core`, likewise consumed and never modified.
- **Entities `Order` and `OrderLine` — data dependency:** `Order` supplies the source rows and the write target [packages/core/src/entity/order/order.entity.ts:L44], and `OrderLine` supplies each source line's variant reference together with the `orderPlacedQuantity` the projection reads [packages/core/src/entity/order-line/order-line.entity.ts:L104] rather than the live `quantity` [packages/core/src/entity/order-line/order-line.entity.ts:L97], which an administrative modification can have altered after placement; both belong to `packages/core`, are read and never altered, and neither gains a column here.
- **Entity `Channel` — data dependency:** supplies the token that scopes the request [packages/core/src/entity/channel/channel.entity.ts:L62] together with the default language code [packages/core/src/entity/channel/channel.entity.ts:L74] and default currency code [packages/core/src/entity/channel/channel.entity.ts:L88] the response resolves against; it belongs to `packages/core` and is read only.
- **Configuration `authOptions.customPermissions` — shared code path:** the registration point for the permission gating the new mutation, paired with in-resolver ownership logic because a permission gate on its own is the equivalent of public access [packages/core/src/api/config/generate-permissions.ts:L32-L34]; it belongs to the plugin's own configuration.
- **Test harness `@vendure/testing` — shared code path:** the end-to-end sub-task is written against it and no alternative harness is introduced [packages/testing/src/index.ts:L1-L14]; it belongs to `packages/testing` and is consumed as published.

---

## 9. Story Estimation Guidance

Estimation Factors:
* Effort: Medium — one mutation field, one resolver, one service method, one projection step and one error-correlation step, over zero new tables and zero migrations.
* Complexity: Medium — the logic is thin, but it consumes a core call whose per-item outcomes must be mapped back to the lines the buyer asked for, and one class of unavailability aborts the batch instead of degrading into an entry, which the acceptance criteria have to keep separate.
* Uncertainty: Medium — the input shape and the skipped-line reason vocabulary are open, and the maximum number of source lines a single call accepts is an open product decision this work may not settle on the project's behalf.
* Suggested Story Points: 5
* Estimated Lines of Code to Generate: 340 production / 260 test
* Estimated Autonomous Generation Time: 4.0 hours
* Estimated Human Review Time: 2.0 hours

All four numeric values above are **transcribed unchanged** from this story's row in the epic's delivery-split table, which is the single source of truth for every estimate in this set [tickets/EPIC-001-reorder-and-replenishment.md:§9.2 Story Table]. They are not recomputed here, and a disagreement between this block and that row is a defect in this file rather than in the table. As a cross-check only: the epic's own rubric independently places consumption of a core service with per-item outcome accumulation at five points, and this work adds no table, which agrees with the transcribed row — and had it not agreed, the row would still govern.

The hour figures are artifact-accounting estimates of generation and review effort. They describe the work of producing the code and say nothing about how the shipped software behaves, which is why no service-level, timing or business figure appears anywhere in this file.

---

## 10. Definition of Done (Story-Level)

Ten items. Each is verifiable by a named command, a named specification or a named count, so none is a matter of opinion.

- [ ] **Every one of the eight acceptance criteria in section 5 is exercised by an automated test**, with unit tests co-located with the code under test carrying a `.spec.ts` suffix [CONTRIBUTING.md:§Server Unit Tests] and an end-to-end specification under the plugin package's `e2e/` directory written against `@vendure/testing` [packages/testing/src/index.ts:L1-L14] and [CONTRIBUTING.md:§End-to-end Tests]. None is waived, deferred or partially accepted.
- [ ] **Test coverage over the new plugin code reaches minimum 80% line coverage.** This is the one numeric target this ticket set permits; it is supplied by the requirements rather than invented here, and no service-level, timing or business figure appears anywhere in this file alongside it.
- [ ] **`git diff --stat -- packages/core packages/admin-ui` prints nothing**, the dev-server custom-fields object is still empty [packages/dev-server/dev-config.ts:L116], and the only file changed outside the plugin package is the dev-server plugin registration array [packages/dev-server/dev-config.ts:L121-L155]. The dashboard bundling configuration [packages/dev-server/vite.config.mts:L1] is **not** touched, because this work ships no dashboard surface.
- [ ] **The four existing operations named in section 5 are evidenced as unchanged in signature and in behaviour** — `addItemToOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L72], `adjustOrderLine` [packages/core/src/api/schema/shop-api/shop.api.graphql:L80], `activeOrder` [packages/core/src/api/schema/shop-api/shop.api.graphql:L11] and `order(id: ID!)` [packages/core/src/api/schema/shop-api/shop.api.graphql:L34] — with no `customFields` argument appearing on either add or adjust, `Customer.orders(options: OrderListOptions): OrderList!` [packages/core/src/api/schema/common/customer.type.graphql:L11] gaining no reorder-specific argument, and the root `Query` type still declaring nineteen root queries [packages/core/src/api/schema/shop-api/shop.api.graphql:L1-L52].
- [ ] **Migration status is stated as evidence rather than assumed: this work adds no table and no column, so it generates no migration.** The lifecycle a table-adding piece of work would generate through is named for contrast [packages/core/src/migrate.ts:L40]. The cached end-to-end seed data under the package's `e2e/__data__/` directory is nonetheless deleted before the first run, because a sibling feature's migration precedes this one [tickets/EPIC-001-reorder-and-replenishment.md:§11.3 Operational Reset Steps After A Schema Change].
- [ ] **Behaviour is evidenced on the four per-engine end-to-end jobs that already exist, with no new infrastructure added** — `e2e-sqljs` [.github/workflows/build_and_test.yml:L174], `e2e-mariadb` [.github/workflows/build_and_test.yml:L202] pinned to `mariadb:11.5` [.github/workflows/build_and_test.yml:L213] because a later default change breaks the suite and the pin is the workaround already in place [.github/workflows/build_and_test.yml:L211], `e2e-mysql` [.github/workflows/build_and_test.yml:L240] and `e2e-postgres` [.github/workflows/build_and_test.yml:L276]. **Native SQLite is named as an unverified engine and is not claimed**, because the harness exports initializers for MySQL, PostgreSQL and sql.js only [packages/testing/src/index.ts:L10-L12].
- [ ] **Ownership is enforced in resolver logic in addition to the permission gate**, so a request authenticated as a different customer is refused before any order row is read on its behalf. The gate alone is not the control: the platform states that a resolver relying on ownership without enforcing it is the equivalent of public access [packages/core/src/api/config/generate-permissions.ts:L32-L34].
- [ ] **`OrderService.addItemsToOrder` [packages/core/src/service/services/order.service.ts:L654] is called exactly once per reorder and no per-variant add loop appears anywhere in the plugin**, and the published payload mirrors the platform's existing two-field bulk result, an order plus an error collection [packages/core/src/api/schema/shop-api/shop.api.graphql:L298-L300], adding only the correlation back to each requested source line [tickets/EPIC-001/FEATURE-001-02-reorder-from-order-history.md:§5. Definition of Done (Feature-Level)].
- [ ] **The operation and its payload schema are documented as JSDoc on the new public API carrying the `@since 3.8.0` tag**, which is *derived* from the next-minor rule [CONTRIBUTING.md:§New features] applied to this 3.7.0 checkout [packages/core/package.json:L2-L3] and is flagged as a derivation rather than presented as a quotation [tickets/EPIC-001-reorder-and-replenishment.md:§11.2 Version Tagging]. The JSDoc records which per-line outcomes the operation can return, that the active order is created through the existing mechanism rather than reported missing, and that the published `ErrorCode` enum grew by the one new error result [packages/core/src/api/config/generate-error-code-enum.ts:L9]. **No hand-written reference page is produced** [tickets/EPIC-001-reorder-and-replenishment.md:§11.5 Public API Documentation Is Generated, Not Hand-Written].
- [ ] **A regression check passes against the two neighbouring existing specifications, re-run unmodified** — `packages/core/e2e/shop-order.e2e-spec.ts` and `packages/core/e2e/order-changed-price-handling.e2e-spec.ts` [tickets/EPIC-001-reorder-and-replenishment.md:§11.6 Testing Conventions] — and no monetary value in the new payload is a decimal: every one is an integer in the smallest unit of its currency, stated alongside the `currencyCode` it belongs to [packages/core/src/entity/order/order.entity.ts:L142].
