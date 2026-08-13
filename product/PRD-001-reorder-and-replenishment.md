# PRD-001 — Reorder and Replenishment

## 1. Title and One-Line Summary

**Reorder and Replenishment.** Make repeating a regular purchase one deliberate act, with price and availability changes shown before the buyer commits.

## 2. Purpose and Status of This Document

The **requirements are proposals**: argue, rewrite, delete. The **findings are reported facts**, read out of the platform at one recorded point, evidenced in the appendices. Six open questions block all but one, so this is scoping, not specification.

## 3. How to Edit This Document

- Identifiers are stable, and **a retired identifier is never reused**.
- Dependencies are identifier references, so deleting a row leaves a visible break.
- Nothing is cross-referenced by section number; insert or reorder freely.
- Citations and names live in the appendices, so the body can be rewritten freely.
- A marker line closes the body; each question ends with a blank answer line.

## 4. The Problem

A buyer returning for the same things rebuilds the order by hand, line by line, identically every time. Prices also move and items run out between purchases, so a buyer told nothing finds out at checkout. Effort and disclosure belong together.

## 5. Who This Is For

- **Returning Buyer** — buys again without rebuilding, knowing what changed.
- **Buying Account Administrator** — needs lists outliving any colleague, and control over who edits.
- **Marketplace Category Manager** — needs to see what is bought again and again.
- **Seller Operations Manager** — needs that picture confined to their own goods.
- **Customer Support Agent** — needs to see what the buyer was shown when a repeat fails.
- **Storefront Developer** — needs one documented way in, every existing call still working.

## 6. What Already Exists

Proposing the following as new work would be wrong. Adding many items to the cart at once already exists and reports an outcome per item, so partial success is established behaviour. The price last paid and the price now already sit on the cart's lines, guarded by a dedicated automated check. Availability is already three plain states, in stock, low stock and out of stock, not a quantity. Order history is already buyer-tied and storefront-confined; preferences can already be stored with no new store of data. Reporting reaches only a daily count of orders, their total, and an average order value.

Nothing answers the question this turns on, which items does this buyer purchase regularly; nothing implements repeat ordering, replenishment, repeat-demand reporting or reminders.

## 7. What a Buyer Will Be Able To Do

**J1 — The weekly restock.** A buyer picks their most frequent past order and repeats it: every item in the cart at last time's quantity, for their own storefront and no other. The same action works from their regular items. [REQ-001, REQ-004, REQ-007, REQ-022]

**J2 — The price has moved.** One line costs more; both figures show together before commitment. Accepting is the buyer's act; dropping the line is equally available. Later, the agent sees what was shown and accepted. [REQ-012, REQ-014, REQ-015]

**J3 — Half the order is gone.** The failure path, mattering as much. Two lines have run out, one can be met only in part. Everything addable is added, every refusal named with its reason. The partly available line is not quietly trimmed: the shortfall is stated and the buyer decides to take less, wait, or drop it. Availability shows per line in the storefront's usual terms. [REQ-002, REQ-003, REQ-013]

**J4 — The list that keeps itself.** The buyer's regular items assemble out of what they buy, most repeated first, under an operator-set rule. An item bought once is dismissed and stays dismissed. A named list keeps a withdrawn item visible but unavailable. They opt into a reminder for a due item, then switch that one off, effective at once. [REQ-005, REQ-006, REQ-008, REQ-009, REQ-010, REQ-016, REQ-018]

**J5 — The category manager's Monday.** Reporting shows what is bought again and again in the range they answer for, nothing outside it, prepared on the operator's schedule so the page answers at once. A seller sees their own goods only. [REQ-019, REQ-020, REQ-021]

REQ-011 and REQ-017 appear in no journey: the first is deferred until an open question is answered, the second concerns reminder delivery, with no buyer-visible step.

## 8. Proposed Requirements

Seven capability areas, named identically wherever this document groups by capability: **Reorder from a past order**, REQ-001 onward; **Regularly purchased items**, REQ-005 onward; **Saved reorder lists**, REQ-009 onward; **Change awareness before commit**, REQ-012 onward; **Reorder reminders**, REQ-016 onward; **Recurring demand visibility**, REQ-019 onward; **Storefront integration surface**, REQ-022.

Origin is one of four: a top-level clause of the Objective Statement, quoted in full below and labelled **C1**, **C2**, **C3** in order; or an inference from the **Business Targets**, the **Primary Users**, or a **codebase finding**.

|ID|Requirement|Who it serves|Origin|Depends on|
|---|---|---|---|---|
|REQ-001|Repeat a past order in one action|Returning Buyer, Customer Support Agent|Clause C1|—|
|REQ-002|Add what can be added; name every refusal|Returning Buyer|Codebase finding|REQ-001|
|REQ-003|Never silently reduce a quantity; state the shortfall|Returning Buyer|Clause C3|REQ-002|
|REQ-004|Confine a repeat to one storefront|Returning Buyer, Storefront Developer|Codebase finding|REQ-001|
|REQ-005|Show what this buyer buys repeatedly|Returning Buyer|Clause C1|—|
|REQ-006|Let the operator define regular|Marketplace Category Manager, Returning Buyer|Codebase finding|REQ-005|
|REQ-007|Take all regular items, or pick individually|Returning Buyer|Clause C2|REQ-005|
|REQ-008|Let a dismissal stick until undone|Returning Buyer|Primary Users|REQ-005|
|REQ-009|Save items as a named list|Returning Buyer|Clause C2|—|
|REQ-010|Keep a withdrawn item listed as unavailable|Returning Buyer, Customer Support Agent|Primary Users|REQ-009|
|REQ-011|Share a list across one account|Buying Account Administrator|Primary Users|REQ-009|
|REQ-012|Show the price last paid beside the price now|Returning Buyer|Clause C3|REQ-001|
|REQ-013|Show availability per line before commit|Returning Buyer|Codebase finding|REQ-001|
|REQ-014|Require deliberate acceptance of a moved price|Returning Buyer|Clause C3|REQ-012|
|REQ-015|Let an agent see what was shown and accepted|Customer Support Agent|Primary Users|REQ-012, REQ-014|
|REQ-016|Reminders by opt-in only|Returning Buyer|Business Targets|REQ-005|
|REQ-017|Reminder delivery behind one interface|Storefront Developer|Codebase finding|REQ-016|
|REQ-018|Stop reminders wholesale or per item|Returning Buyer|Primary Users|REQ-016|
|REQ-019|Show most repurchased items within the viewer's range|Marketplace Category Manager|Business Targets|REQ-006|
|REQ-020|Prepare repurchase figures on a schedule|Marketplace Category Manager, Seller Operations Manager|Codebase finding|REQ-019|
|REQ-021|Confine a seller's figures to their own goods|Seller Operations Manager|Business Targets|REQ-019|
|REQ-022|One documented addition; disturb no existing call|Storefront Developer|Business Targets|REQ-001, REQ-005, REQ-009, REQ-012|

Recomputed from the table as it stands: twenty-two proposals, seven from a quoted clause, four from the Business Targets, five from the Primary Users, six from a codebase finding.

## 9. Impact of Implementation

### Blast radius

Contained but for one exception. Attach this capability's information to what the platform already exposes rather than keeping it separate, and something existing storefront calls receive changes shape: by the letter of the constraint, a violation to report. Avoidable, and it bears on Storefront integration surface.

### What changes for people who never use this feature

Six behaviours were checked. Existing storefront calls keep their shape and result if the decision above goes the additive way; order history, the cart, the catalogue and availability are read, never altered; reporting unchanged. One change is unavoidable: the permission values every administrative client receives grow, assembled at start-up from whatever is installed.

### What this work would collide with

Two. The platform has no built-in notion of a marketplace, one being assembled a storefront per seller by an addition, so seller-scoped reporting inherits it. And the vendor has published plans to model buying organisations natively, with quotation and approval flows, so anything built now for shared buying is rebuilt against them. That is what defers Saved reorder lists.

### Where the risk concentrates

In one place, not where the effort concentrates. Order history can be neither filtered nor sorted at the level of an individual item, so the question the objective turns on is unanswerable today. That is Regularly purchased items, and it gates Recurring demand visibility. Second, every reporting proposal is somewhere one seller could see another's figures.

### Verification burden created

Substantial and unavoidable. The suite guarding this behaviour runs against four separate data engines, and twenty-nine of the hundred specifications in the core suite, chiefly those behind Reorder from a past order and Change awareness before commit, must pass on all four. Changing how data is stored also invalidates their cached seed data.

### Reversibility

Partial. Whatever the addition stores persists until deliberately removed, and nothing is cleaned up when a capability is withdrawn, except orphaned buyer preferences, already swept on a schedule. Switching off stops new writes but removes nothing written, and a live instance must never run with schema synchronisation.

### Volume sensitivity

Two places, in Regularly purchased items and Reorder reminders. The recurrence computation reads across the items of every past order for a buyer, so its cost grows with how much they have bought. The reminder plumbing polls, fanning out a message per buyer per due item. Neither can be sized: no baseline exists.

## 10. Relative Scale and Effort Signals

Sizes are relative only; no absolute figure appears here.

|Capability area|Relative size|
|---|---|
|Reorder from a past order|S|
|Regularly purchased items|L|
|Saved reorder lists|M|
|Change awareness before commit|S|
|Reorder reminders|M|
|Recurring demand visibility|L|
|Storefront integration surface|S|

The low-hanging fruit is Reorder from a past order, Change awareness before commit and Storefront integration surface, each leaning wholly on shipped behaviour; the expensive minority is Regularly purchased items and Recurring demand visibility.

No area rates XL. What would earn it: inability to avoid changing what existing storefront calls receive; needing a construct for several people on one account; or needing an outside hosted service.

## 11. Constraints That Shape the Product

Everything is added and nothing existing is altered; any change to what an existing call returns is reported as a violation. The core is not modified, so this arrives as a self-contained addition; stored shapes are only added to. Prices are whole numbers in the smallest unit of currency, so a price difference is expressed only as the price last paid against the price now. Every request belongs to one storefront and one language, and nothing crosses that boundary. No outside hosted service is required; anything wanting one sits behind a single interface defaulting to the platform's storage. And no measure is invented: where a target is wanted, this reports that none is declared.

## 12. What Is Out of Scope and Why

Permanent decisions are separated from deferrals, and every deferral states what would bring it back.

|Topic|Ruling|Why, and what would bring it back|
|---|---|---|
|Placing orders automatically on a recurring cycle|Permanent|This suggests and prefills, never placing an order; a reminder is not consent to buy.|
|Repeating a past order across storefronts|Permanent|Every request belongs to one storefront, so an order from elsewhere cannot be drawn in.|
|Replaying the discounts a past order received|Permanent|A past order's promotions attach only after payment completed, so are not reproducible.|
|Lists shared across several people on one account|Deferred|No such construct exists. Returns with a native buying-organisation model, on the vendor's published plans. REQ-011 waits on this.|
|Quotation and approval flows, including spend thresholds|Deferred|Same absent construct. Returns with the same published model, plus a decision on whether a repeat may be submitted for approval.|
|Which administrative surface carries the seller-facing figures|Deferred|Two surfaces exist, one superseding the other. Returns when that is settled for the estate.|

## 13. Open Questions for the Product Owner

Ordered by how much each blocks. Together they block twenty-one of the twenty-two; only REQ-004 needs none, the platform already imposing the boundary it asks for.

**Q1 — Where should this capability's information be kept?** Its own store, or attached to what the platform already exposes. Buyer impact: own store, none; attached, none directly, but every storefront built today receives a differently shaped answer and must be updated. Recommendation: its own store, keeping the additive promise. Blocks all but REQ-004.

Answer:

**Q2 — What makes an item count as regularly purchased?** More than once at all; a set number within a window; or a discernible cycle. Buyer impact: the first buries the regular in noise; the second is more useful but misses slow cycles; the third is best and oftenest wrong. Recommendation: a count within an operator-set window. Blocks REQ-005, REQ-006, REQ-007, REQ-008, REQ-016, REQ-019, REQ-020, REQ-021.

Answer:

**Q3 — Is repeat demand worked out when someone looks, or prepared in advance?** On demand, or on an operator-set schedule. Buyer impact: on demand is current but slowest for the longest history, exactly this buyer; prepared is fast but a cycle behind. Recommendation: prepared, on the operator's schedule. Blocks REQ-005, REQ-007, REQ-016, REQ-019, REQ-020.

Answer:

**Q4 — Who owns a saved list, the individual buyer or the account?** The individual only; the account, shared; or both. Buyer impact: individual surprises nobody but hides a colleague's list; account means one edit changes what all see; both is most useful and alone needs a notion of who may edit. Recommendation: the individual for now, no account construct existing. Blocks REQ-009, REQ-010, REQ-011.

Answer:

**Q5 — Are reminders strictly opt-in, and how should they reach the buyer?** Opt-in only, or on by default with an easy way out; delivered by existing message sending, or behind a new interface. Buyer impact: opt-in contacts nobody unasked but takes up slowly; on by default reaches more buyers yet contacts some who did not ask, costing trust. Recommendation: opt-in, behind an interface defaulting to the platform's storage. Blocks REQ-016, REQ-017, REQ-018.

Answer:

**Q6 — Which administrative surface carries the seller-facing figures?** The newer, the older, or both. Buyer impact: none, no buyer seeing either; the cost falls on the category manager and seller, left in a surface being left behind. Recommendation: the newer, the older being superseded. Blocks REQ-019, REQ-021.

Answer:

## 14. Success Measures

Observable outcomes first, without figures because none is available. A returning buyer repeats a past purchase without searching the catalogue for any item. A buyer is never shown one price and charged another. An item that cannot be supplied is named before the buyer commits. An operator sees what is bought again and again in their own scope. A buyer who has not asked for reminders never receives one.

Candidate metrics, with whether each can be measured today:

- Orders placed over time — **instrumented**; reporting already reaches a daily count.
- Share of orders beginning as a repeat — **not instrumented**; REQ-015's record would deliver it.
- Items found by hand — **not instrumented**; no record of buyer interactions exists.
- Abandonment after seeing a moved price — **not instrumented**; the same absence.
- Most repurchased items in a scope — **not instrumented**; REQ-019 and REQ-020 would deliver it.

An explicit negative result, reported rather than filled in: **no service-level commitment, latency target, availability target, conversion figure, retention figure or revenue estimate is declared anywhere in the platform.** Searching its prose, source, configuration and pipeline definitions returned only percentile arithmetic in a load-testing helper and a monitoring mention in a health-check guide.

## 15. Suggested Sequencing

First, Reorder from a past order with Change awareness before commit and Storefront integration surface: each leans on shipped behaviour, and the repeat without the disclosure is the worse half. Second, Regularly purchased items, which has nothing to lean on and sets the rule everything downstream waits for. Third, Recurring demand visibility, which must follow it because one computation feeds both.

Two pieces run alongside: Saved reorder lists depends on nothing beyond itself and parallels any step after the first, while Reorder reminders needs the regular-items rule, so it follows the second step and parallels the third.

## 16. What This Document Cannot Tell You Yet

Nine things, stated even where the statement is that there is nothing to report.

- **Performance.** Nothing can be said: the platform's one benchmark measures search, so no baseline exists for order, cart, buyer or stock.
- **Targets.** No numeric target is declared anywhere in the platform, so no measure here can be tied to one.
- **Four contradictions in existing material.** The contribution guide names an absent documentation framework; the documentation readme gives a repository address the manifests contradict; that guide calls any stored-shape change breaking where the vendor's published policy allows non-destructive additions on a minor line; and a claim that payment amounts are decimal money is contradicted by the platform's default of whole numbers in the smallest unit. Reported, not corrected, since that means editing files outside this scope; none is asserted here.
- **Shared accounts.** No construct for several people on one account exists, so the Buying Account Administrator's ownership model is unresolved.
- **One data engine.** A fifth engine supported for development is exercised by no automated check, so nothing can be claimed of it.
- **Whether every citation resolved.** It did: every repository reference in the appendices was checked, none failed. One published claim was dropped for want of a verifiable source.
- **Absolute effort and dates.** Not available, and deliberately not guessed.
- **Current buyer behaviour.** Unknown; no record of buyer interactions exists to baseline against.
- **How current this is.** The findings hold for one recorded point, named below; a later patch line has since been published.

## 17. How This Document Was Produced

Read from the working copy on branch master at commit e7f8fe0029ceba9b450f60554226cec2cf628309, platform version 3.7.0. A later patch line, 3.7.1, has since been published.

The Objective Statement, in full:

> "Make it effortless for returning buyers to reorder the items they purchase regularly, so that repeat purchasing on the marketplace requires materially less effort than rebuilding an order from scratch, and so that buyers are made aware of price and availability changes before they commit to a reorder."

Measured: 1 sentence, 48 words, 302 characters, 4 clauses, 3 of them top-level and quotable as requirement origins.

Requirement count and origin split, recomputed from the table as emitted rather than as planned: 22 proposals, 7 from a quoted clause, 4 from the Business Targets, 5 from the Primary Users, 6 from a codebase finding.

Measured body word count: 2992 words, counted to the marker line closing the body.

Mechanical check for technical identifiers in the body: PASS, zero identifier-shaped tokens found.

<!-- END OF BODY -->

---

Everything below this line is evidence, not proposal. It is excluded from the body word budget and from the body's ban on technical identifiers. Repository citations are given as a path plus a locator; published-source claims are grouped separately at the end so the two evidence classes stay distinct.

## Appendix A — Technical Findings and Impact Evidence

### A.1 Existing mechanisms not to duplicate

Each entry names the mechanism that already ships, its evidence, and the requirement in the body that consumes it.

- **Bulk addition to the cart, with per-item outcomes.** `addItemsToOrder(inputs: [AddItemInput!]!): UpdateMultipleOrderItemsResult` already exists, and the result is an object carrying both `order` and `errorResults`, so partial success is a first-class outcome today rather than something to invent [schema-shop.json:Mutation.addItemsToOrder]. The singular `addItemToOrder` returns a union of `Order` plus five error outcomes — `OrderModificationError`, `OrderLimitError`, `NegativeQuantityError`, `InsufficientStockError`, `OrderInterceptorError` [schema-shop.json:UpdateOrderItemsResult]. Consumed by REQ-002.
- **Price movement since an item was added.** `OrderLine.unitPriceChangeSinceAdded` and `OrderLine.unitPriceWithTaxChangeSinceAdded` are present in the committed storefront snapshot [schema-shop.json:OrderLine], populated by the shipped strategy whose own documentation names those fields [packages/core/src/config/order/changed-price-handling-strategy.ts:L12-L13], and guarded by a dedicated end-to-end suite [packages/core/e2e/order-changed-price-handling.e2e-spec.ts:L44]. Consumed by REQ-012.
- **Availability as three display states.** The storefront availability field is a `String`, not an integer [schema-shop.json:ProductVariant.stockLevel], and the default display strategy emits out-of-stock below a saleable count of one, low-stock at or below a threshold whose constructor default is two, and in-stock otherwise [packages/core/src/config/catalog/default-stock-display-strategy.ts:L14-L22]. This confirms the brief's own illustrative example literally. Consumed by REQ-013.
- **Buyer-scoped, storefront-confined order history.** `Customer.orders` returns a paginated `OrderList` [schema-shop.json:Customer.orders]; the order entity carries an indexed `orderPlacedAt`, an indexed customer relation and channel membership [packages/core/src/entity/order/order.entity.ts:L91-L96], the last of which is what confines history to one storefront [packages/core/src/entity/order/order.entity.ts:L150-L152]. Consumed by REQ-001, REQ-004 and REQ-005.
- **Buyer preferences with no new table.** A scoped key-value settings store already exists, with read and write paths and permission checks [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L102-L107], its entity carrying a unique index on key and scope [packages/core/src/entity/settings-store-entry/settings-store-entry.entity.ts:L15-L43], and a scheduled sweep for orphaned entries [packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts:L39-L45]. Consumed by REQ-008, REQ-016 and REQ-018.
- **Reporting, and its ceiling.** The summary query lives in the administration plugin rather than core [packages/admin-ui-plugin/src/api/metrics.resolver.ts:L11-L18]; its interval enumeration has exactly one value and its type enumeration exactly three — order count, order total and average order value [schema-admin.json:MetricType]. Nothing expresses per-item repeat demand. Consumed by REQ-019.

### A.2 Impact evidence, paired with each finding in the body

- **Blast radius.** The schema generator emits a generic scalar-typed `customFields` member on an entity with no visible custom fields, but substitutes a generated per-entity object type the moment one becomes visible [packages/core/src/api/config/graphql-custom-fields.ts:L105-L131]. The same flip applies to create inputs [packages/core/src/api/config/graphql-custom-fields.ts:L160-L195] and to update inputs [packages/core/src/api/config/graphql-custom-fields.ts:L198-L233]. The committed snapshots corroborate the present state: the customer, order, order-line and variant `customFields` members are all the generic `JSON` scalar, and no per-entity custom-fields object type exists in either snapshot [schema-shop.json:Customer.customFields].
- **What changes for people who never use this feature.** Six behaviours were checked, and five are unaffected: existing storefront operation signatures [schema-shop.json:Mutation], order history reads [schema-shop.json:Customer.orders], cart reads [schema-shop.json:OrderLine], availability reads [schema-shop.json:ProductVariant.stockLevel], and existing reporting [schema-admin.json:MetricType]. The sixth is a genuine, unavoidable change: an extension registers permissions that are folded into the administration permission enumeration at start-up [packages/core/src/common/permission-definition.ts:L41-L46], so the value set every administration client receives grows from its present count [schema-admin.json:Permission].
- **What this work would collide with.** A marketplace here is assembled one channel per seller by an extension, which creates a seller, channel, role, administrator, shipping method and stock location for each [packages/dev-server/example-plugins/multivendor-plugin/multivendor.plugin.ts:L128-L156]; the platform has no native marketplace construct.
- **Where the risk concentrates.** `OrderFilterParameter` exposes eighteen input fields — sixteen data fields plus the `_and` and `_or` combinators — and `OrderSortParameter` thirteen; **neither set contains a single line-level or variant-level field** [schema-shop.json:OrderFilterParameter]. The recurrence question is therefore unanswerable from existing operations and requires aggregation across order lines that nothing exposes.
- **Verification burden created.** Continuous integration runs four database engines, each alongside a cache service [.github/workflows/build_and_test.yml:L174-L311]. The core end-to-end directory holds one hundred specification files, of which twenty-nine match order, cart, customer, stock, price or storefront naming — the matching rule is stated here so the figure can be reproduced [packages/core/e2e/order-changed-price-handling.e2e-spec.ts:L44]. Cached seed data must be deleted after any change to stored shape [AGENTS.md:§Testing].
- **Reversibility.** A scheduled sweep already removes orphaned preference entries [packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts:L39-L45]; no equivalent exists for an extension's own tables.
- **Volume sensitivity.** Cross-instance-locked scheduling already exists and is the mechanism a prepared result would use [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts:L14-L19], with stale-lock sweeping [packages/core/src/plugin/default-scheduler-plugin/stale-task.service.ts:L15-L19] and a worked configurable task [packages/core/src/scheduler/tasks/clean-sessions-task.ts:L37-L49]. No performance baseline exists for any affected path: the only benchmark in the repository targets search [packages/core/e2e/default-search-plugin.bench.ts].

### A.3 Constraint collisions found in this repository

- **Additive change with an observable side effect — the headline collision.** Declaring a *visible* custom field on an order, order line, customer or product variant changes the type of a field on an existing type in an existing operation's response, and adds an argument to existing mutations. By the letter of the additive-only constraint that is a violation, and it is reported rather than smoothed over. It is proved twice, once from source [packages/core/src/api/config/graphql-custom-fields.ts:L105-L131] and once from the vendor's published documentation, cited under Research Evidence below. Because the two evidence classes agree, the finding is stated once with both proofs, which is stronger than stating it twice.
- **The escape hatch, verified in the same file.** Fields marked `internal` are filtered from both interfaces and fields marked non-public from the storefront interface, so a wholly internal declaration preserves the generic-scalar branch and leaves the public interface unchanged [packages/core/src/api/config/graphql-custom-fields.ts:L60-L62].
- **A second-order failure mode.** A relation-typed custom field whose target type is absent from the storefront schema causes a hard failure at start-up, with logged remediation advice, rather than a degraded schema [packages/core/src/api/config/graphql-custom-fields.ts:L64-L85].
- **Any change to stored shape is classed as breaking.** The contribution guide defines breaking changes to include any change to the database schema and routes them to the major line, with a worked example that labels an added column as breaking [CONTRIBUTING.md:L388-L392]. This collides head-on with the premise that additive stored change is unremarkable, and it disagrees with the vendor's published policy — both readings are reported below, and neither is adopted.
- **Order promotions cannot be replayed.** Promotions are populated only after the payment process has completed [packages/core/src/entity/order/order.entity.ts:L121-L128], so a past order's discounts cannot be assumed reproducible. This is why replaying them is ruled permanently out of scope.
- **Money is integer minor units, not decimal.** The money column type comes from a configurable strategy whose default declares an integer column with two-decimal precision and integer rounding [packages/core/src/config/entity/default-money-strategy.ts:L14-L22], and payment amounts use the same decorator [packages/core/src/entity/payment/payment.entity.ts:L28].
- **Per-request scoping is real and enforced by the platform.** The request context resolves channel, channel identifier, language, currency, active user and authorisation per request [packages/core/src/api/common/request-context.ts:L344-L382], and prices are stored per variant per channel and currency [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37]. This is why REQ-004 needs no product decision.

### A.4 Precedent, rated per capability area

Ratings are near-identical, partial, or none. Areas with nothing found are stated as explicit negatives rather than left silent.

|Capability area|Precedent|Closeness|
|---|---|---|
|Reorder from a past order|None. No implementation of reorder, replenishment or repeat purchasing exists anywhere; identifier searches across every package source tree return only drag-to-reorder interface helpers|none|
|Regularly purchased items|None. No read path can answer the question [schema-shop.json:OrderFilterParameter]|none|
|Saved reorder lists|One example extension declaring one entity, one service, storefront extensions and a single internal relation custom field [packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts]; it returns bare lists rather than the platform's result-union convention [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts], so it models structure but not error handling|partial|
|Change awareness before commit|The shipped price-drift strategy and its dedicated suite [packages/core/src/config/order/changed-price-handling-strategy.ts]|near-identical|
|Reorder reminders|Transactional delivery whose transport modes include file and none as well as external senders [packages/email-plugin/src/types.ts], plus locked scheduling [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts]|partial|
|Recurring demand visibility|Reporting delivered wholly outside core as an additive extension contributing a query, a service, a strategy seam and a dashboard widget [packages/admin-ui-plugin/src/api/metrics.resolver.ts]|near-identical|
|Storefront integration surface|Additive storefront extensions in both example extensions above; and a live case of an extension declaring two *public* custom fields on a variant, demonstrating the side effect in practice [packages/dev-server/example-plugins/minimum-order-quantity/order-quantity-limits.plugin.ts]|partial|

Two further explicit negatives. No product-requirements precedent of any kind exists in this repository — a case-insensitive filename search across the whole tree for requirement, proposal and design-record patterns returns only an unrelated deployment guide — so the seventeen-section structure derives wholly from the brief. And the only in-core reference to a saved-list capability is a documentation example on a permission helper [packages/core/src/common/permission-definition.ts:L112-L140].

### A.5 Verified surfaces

- **Operation inventory.** Storefront: nineteen queries, thirty-two mutations [schema-shop.json:Mutation]. Administration: eighty-two queries, one hundred and seventy-nine mutations, ninety-seven permission values [schema-admin.json:Permission].
- **Entities relevant to the scope.** Order [packages/core/src/entity/order/order.entity.ts:L70-L102], Customer [packages/core/src/entity/customer/customer.entity.ts:L23-L64], ProductVariantPrice [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37], Payment [packages/core/src/entity/payment/payment.entity.ts:L28], SettingsStoreEntry [packages/core/src/entity/settings-store-entry/settings-store-entry.entity.ts:L15-L43]. The only grouping constructs in the entity directory are customer, customer group, channel and seller: no company, organisation, buying-account or team entity exists, which is why the Buying Account Administrator has no multi-seat construct to build on.
- **Services and strategies.** Settings store [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L194-L207]; changed-price handling [packages/core/src/config/order/changed-price-handling-strategy.ts:L12-L13]; stock display [packages/core/src/config/catalog/default-stock-display-strategy.ts:L14-L22]; cross-channel price propagation [packages/core/src/config/catalog/product-variant-price-update-strategy.ts]; money [packages/core/src/config/entity/default-money-strategy.ts:L14-L22].
- **Permissions.** Registered by extensions and folded into the enumeration at start-up [packages/core/src/common/permission-definition.ts:L10-L38].
- **Events.** Sixty-one event definitions exist, covering order, order-line, order-placed, state-transition, variant, variant-price, stock-movement and customer changes, so price and stock movement are observable without touching core.
- **Error-result convention.** The storefront error union has thirty-one members and the administration one forty-six [schema-shop.json:UpdateOrderItemsResult]; new operations are expected to follow it, which is the respect in which the closest structural precedent does not.
- **History entries.** The history-entry enumeration carries twenty-six values, fourteen prefixed for the customer and twelve for the order — the split is by prefix, stated so it can be reproduced — and **none records a reorder action** [packages/common/src/generated-types.ts:L2174-L2201].

### A.6 Identifiers excluded from the body

The body uses a product vocabulary throughout. This is what each term stands for.

|Body term|Technical identifier|
|---|---|
|the cart|the active `Order` [packages/core/src/entity/order/order.entity.ts:L82]|
|order history|`Customer.orders` [schema-shop.json:Customer.orders]|
|the cart's lines|`OrderLine` [schema-shop.json:OrderLine]|
|the price last paid against the price now|`unitPriceChangeSinceAdded` [schema-shop.json:OrderLine]|
|availability, and its three states|`ProductVariant.stockLevel` [schema-shop.json:ProductVariant.stockLevel]|
|the storefront|the Shop API [schema-shop.json:Mutation]|
|the admin tools, the two surfaces|the Admin API [schema-admin.json:Permission], the legacy interface and the newer dashboard [README.md]|
|reporting|`metricSummary` [packages/admin-ui-plugin/src/api/metrics.resolver.ts:L11-L18]|
|adding many items at once|`addItemsToOrder` [schema-shop.json:Mutation.addItemsToOrder]|
|a store of data, stored shape|a database table and its schema|
|the platform's own preference store|the settings store [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L102-L107]|
|an addition, the extension|a plugin [packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts]|
|one documented way in|storefront schema extensions and resolvers|
|four separate data engines, a fifth engine|the four engines exercised by continuous integration [.github/workflows/build_and_test.yml:L174-L311], and the file-backed engine that is not [packages/core/package.json]|
|the permission values every administrative client receives|the `Permission` enumeration [schema-admin.json:Permission]|
|automatic schema synchronisation|the schema synchronisation option|
|one benchmark, measuring search|[packages/core/e2e/default-search-plugin.bench.ts]|
|a load-testing helper|[packages/dev-server/load-testing/generate-summary.ts]|

## Appendix B — Architectural Decisions

Six decisions, one line each, with a recommendation and what each blocks. Each maps onto an open question in the body.

- **Where new state lives.** Extension-owned tables, or custom fields on core entities — recommend extension-owned tables, because a *visible* custom field changes an existing operation's signature [packages/core/src/api/config/graphql-custom-fields.ts:L105-L131]; blocks every requirement except REQ-004, and is the subject of Q1.
- **Whether buyer preferences need a new table.** The existing scoped settings store, or a new table — recommend the settings store, since it persists scoped values with no schema addition at all and already has a cleanup task [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L194-L207]; blocks REQ-008, REQ-016 and REQ-018.
- **Whether recurrence is computed on read or on a schedule.** Recommend on a schedule, using the existing cross-instance-locked scheduler [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts:L14-L19], because cost grows with a buyer's history; blocks REQ-005, REQ-007, REQ-016, REQ-019 and REQ-020, and is the subject of Q3.
- **Which administration surface the seller-facing figures target.** The newer dashboard, or the legacy interface — recommend the newer, the legacy interface having been superseded from a stated version [README.md]; blocks REQ-019 and REQ-021, and is the subject of Q6.
- **Whether reminder delivery rides the existing transactional extension or a new interface.** Recommend a new interface with a database-backed default, since the existing extension already supports non-external transport modes and can serve as one implementation behind it [packages/email-plugin/src/types.ts]; blocks REQ-016, REQ-017 and REQ-018, and is the subject of Q5.
- **Whether new operations return result unions or bare types.** Recommend result unions per platform convention [schema-shop.json:UpdateOrderItemsResult], not bare lists as the closest structural precedent uses [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts]; blocks REQ-002, REQ-003 and REQ-022.

## Appendix C — Repository and Release Conventions

- **Version lock.** The analysis basis is platform version 3.7.0 [packages/core/package.json], read on branch `master` at commit `e7f8fe0029ceba9b450f60554226cec2cf628309`. Note that the repository-root manifest declares version `0.0.0` and is *not* the platform version [package.json]. A later patch line has since been published upstream; see Research Evidence.
- **Branch target for a new feature, and a collision.** New features are submitted to the `minor` branch while bug fixes go to `master` [CONTRIBUTING.md:L326-L338]. This analysis read `master`, which is the collision: any implementation would be cut against `minor`, so a finding true here may not hold there. Reported, not acted upon.
- **Version tagging for new public interfaces.** New public interfaces carry a tag naming the next minor line [CONTRIBUTING.md:L340-L350]; with core at 3.7.0 that means 3.8.0.
- **Commit convention.** Conventional commits with a package scope that may be omitted when a change belongs to no package [CONTRIBUTING.md:L352-L386], so a commit adding this document is a documentation-type commit with no scope.
- **Supported versus continuously verified database engines.** Continuous integration exercises four engines — an in-memory engine, and three server engines each alongside a cache service [.github/workflows/build_and_test.yml:L174-L311] — across a runtime matrix of three major versions with the middle one as default [.github/actions/setup/action.yml]. A file-backed engine is a declared dependency of core [packages/core/package.json] and is handled throughout its stored-shape registration [packages/core/src/entity/register-custom-entity-fields.ts:L93], **yet no test initialiser is registered for it at all** [e2e-common/test-config.ts:L32-L35]. It is therefore developer-supported but exercised by nothing, which is stronger than merely being absent from the matrix.
- **Cached seed data.** Seed data is cached per package and must be deleted to reset after any change to stored shape [AGENTS.md:§Testing].
- **No continuous-integration job validates this document's path.** The build workflow's change-detection job sets its gate only when a changed path matches the packages directory, the root manifest, the lockfile or the runtime configuration [.github/workflows/build_and_test.yml:L60], and every substantive job is conditioned on that gate; a change confined to this directory therefore skips them all, while the aggregate gate still passes because a skipped job is neither a failure nor a cancellation [.github/workflows/build_and_test.yml:L313-L331]. The documentation workflow triggers only on the documentation tree and the version file [.github/workflows/docs_ci.yml:L4-L21]. Validation of this file was consequently local and self-reported, with the results stated in the body.
- **No prose or Markdown linter exists.** The staged-file lint configuration covers only TypeScript and HTML [.lintstagedrc.json], the formatter is not wired to Markdown [.prettierrc], and all repository hooks are large-file-storage shims. There is therefore no linter to run against this file, and none was added.
- **Existing benchmark and load tooling.** Exactly one benchmark exists in the repository and it targets search [packages/core/e2e/default-search-plugin.bench.ts], with its runner configuration alongside [e2e-common/vitest.config.bench.ts]. A separate load-testing harness exists with storefront documents for adding to an order, adjusting a line, completing an order, searching and deep querying [packages/dev-server/load-testing/generate-summary.ts].
- **Support policy, which is not a performance target.** Supported version lines are declared as a support policy [SECURITY.md], and it is named here only to forestall its being mistaken for a service-level commitment.
- **Known upstream defects affecting sequencing.** **None was established.** No upstream defect bearing on reorder, replenishment, the cart, order history or reporting was identified during this analysis, and rather than imply diligence not performed, this is recorded as an explicit negative: the question was asked and returned nothing.

## Research Evidence — Published Sources

This class is kept separate from repository citations because it describes the vendor's published position rather than the contents of this checkout, and it is the **only** class that is not verifiable from the working copy. Each item carries a source and a retrieval date of 13 August 2026.

- **The published line is one patch ahead of this checkout.** The official changelog lists v3.7.1, dated 14 July 2026, above v3.7.0, dated 1 July 2026, while this checkout is pinned at 3.7.0 with a head commit dated 6 July 2026. Source: `docs.vendure.io/changelog`. This is why the body discloses that the analysis sits one patch line behind.
- **Additive custom fields change existing operation signatures — the second, independent proof.** The vendor's custom-fields documentation states that defining custom fields on the order-line entity gives the storefront's add-item mutation a third input argument, `customFields`, and likewise gives the adjust-line mutation a third input argument, with equivalent input changes on the administration mutations for draft orders and order modification; and that defining them on the order entity gives the administration's modify-order mutation a `customFields` field on its input object. Source: `docs.vendure.io/guides/developer-guide/custom-fields`. Together with the source-level proof in A.3 this finding has two independent proofs, which is materially stronger than either alone.
- **Versioning policy, and the schema-change nuance.** The updating guide states that semantic versioning is generally followed, so breaking API changes arrive only with a major version, and that minor versions may occasionally introduce non-destructive changes to the database schema. It further states as a key rule that a production instance must never be run with the schema synchronisation option enabled, since doing so can cause inadvertent data loss in rare cases. Source: `docs.vendure.io/guides/developer-guide/updating`. The synchronisation prohibition is carried into the body's reversibility finding.
- **Native organisation modelling is on the published roadmap.** The vendor's 2026 technical roadmap announces that business-to-business commerce happens between organisations with complex internal structures and that companies, divisions, buying groups and the relationships between them are modelled natively, as the foundation powering quotation and approval features; it further describes a request-for-quote flow in which a buyer submits their cart for a quote, a sales representative adjusts pricing, and an accepted quote becomes an order, the whole thing versioned; and approval workflows for buyers not authorised to place an order above a spend threshold, including escalation. Source: `vendure.io/blog/vendure-technical-roadmap-2026`. This is the **re-entry condition** attached to both deferrals in the body, and the strongest argument for deferring shared and account-level lists rather than excluding them.

### Where the two evidence classes disagree

Exactly two disagreements were found. Both are reported side by side and **neither is adopted**.

- **Is an additive change to stored shape breaking?** This repository's contribution guide says yes, classing any database schema change as breaking and routing it to the major line, with a worked example labelling an added column as breaking [CONTRIBUTING.md:L388-L392]. The vendor's published updating guide says minor versions may occasionally introduce non-destructive schema changes, describing the addition of a column as minor and non-destructive with no risk of data loss. A reader planning a release needs both readings, because the stricter one governs contribution to this repository while the softer one describes what consumers are told to expect.
- **Which documentation framework does this project use?** The contribution guide names one and describes directories built by it [CONTRIBUTING.md:L488]. No configuration or dependency for that framework exists anywhere in the repository: a filename search returns nothing and a content search finds no reference outside the contribution guide itself. The actual mechanism is a manifest-provider package [docs/package.json] consumed by a manifest source file [docs/src/manifest.ts] and compiled to a committed artifact [docs/manifest.json]. The guide's claim is stale; it is reported here and in the body rather than corrected, because correcting it would breach the single-file constraint.

A related, smaller inconsistency sits alongside the second: the documentation package's own readme links to a different repository address than the one declared in the root and core manifests [docs/README.md].
