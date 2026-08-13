# PRD-001 — Reorder and Replenishment

## 1. Title and One-Line Summary

**Reorder and Replenishment.** Make repeating a regular purchase one deliberate act, with price and availability changes shown before the buyer commits.

## 2. Purpose and Status of This Document

The **requirements are proposals**: argue, rewrite or delete them. The **findings are reported facts**, read out of the platform at one recorded point and evidenced in the appendices. Six questions block all but one, so this is scoping, not specification.

## 3. How to Edit This Document

- Identifiers are stable, and **a retired one is never reused**.
- Dependencies are identifier references, so a deleted row leaves a visible break.
- Nothing refers to a section number, so insert or reorder freely.
- Citations sit in the appendices; a marker closes the body, and each question ends with a blank answer line.

## 4. The Problem

A buyer returning for the same things rebuilds the order by hand every time. Prices move and items run out between purchases, so a buyer told nothing finds out at checkout. Effort and disclosure belong together.

## 5. Who This Is For

- **Returning Buyer** — buying again without rebuilding, knowing what changed.
- **Buying Account Administrator** — lists outliving a colleague, and who may edit them.
- **Marketplace Category Manager** — sight of what is bought again and again.
- **Seller Operations Manager** — the same picture, confined to their own goods.
- **Customer Support Agent** — what a buyer was shown when a repeat fails.
- **Storefront Developer** — one documented way in, existing calls untouched.

## 6. What Already Exists

Six things already ship; proposing them as new work would be wrong. Adding many items at once reports an outcome per item, so partial success is established behaviour. Availability is three plain states — in stock, low stock, out of stock — never a quantity. Order history is buyer-tied and storefront-confined, its items and quantities readable. Buyer preferences can be kept with no new store of data. The cart compares prices, with one important limit. Reporting reaches a daily order count, its total and an average order value.

Three easy assumptions are false. That limit first: the comparison covers only movement since a line went into the cart — the check guarding it confirms a freshly added line starts at no change — so it says nothing about what the buyer paid before. The comparison this needs must be built. History can be narrowed and ordered only an order at a time, never by an item, so no request answers which items recur; anything asking must read it through and work that out. And the preference store confines a value to a buyer but leaves the ownership check to whatever exposes it. Nothing implements repeat ordering, replenishment, repeat-demand reporting or reminders.

## 7. What a Buyer Will Be Able To Do

**J1 — The weekly restock.** A buyer repeats a past order in one act: every item in the cart at last time's quantity, their own storefront only. Their regular items work the same way. [REQ-001, REQ-004, REQ-007, REQ-022]

**J2 — The price has moved.** One line costs more, and both figures show together before commitment. Accepting is the buyer's act, dropping the line equally available. Later the agent sees what was shown and accepted. [REQ-012, REQ-014, REQ-015]

**J3 — Half the order is gone.** The failure path, mattering as much. Two lines have run out and one can be met only in part. Everything addable is added, every refusal named with its reason, availability shown per line. The part-available line is not quietly trimmed: the shortfall is stated and the buyer decides. [REQ-002, REQ-003, REQ-013]

**J4 — The list that keeps itself.** Regular items assemble out of what the buyer buys, most repeated first, under an operator-set rule. One bought once is dismissed and stays so. A named list keeps a withdrawn item visible but unavailable. A reminder is taken for one due item, then switched off at once. [REQ-005, REQ-006, REQ-008, REQ-009, REQ-010, REQ-016, REQ-018]

**J5 — The category manager's Monday.** Reporting shows what is bought again and again in the range they answer for, nothing outside it, prepared on the operator's schedule so the page answers at once. A seller sees only their own goods. [REQ-019, REQ-020, REQ-021]

REQ-011 and REQ-017 appear in no journey: the first is deferred pending an open question, the second a delivery obligation with no buyer-visible step.

## 8. Proposed Requirements

Seven capability areas, each with a stable identifier used wherever this document groups by capability — here, in the impact, the effort signals and the sequencing: **CA-1** Reorder from a past order (REQ-001 to REQ-004); **CA-2** Regularly purchased items (REQ-005 to REQ-008); **CA-3** Saved reorder lists (REQ-009 to REQ-011); **CA-4** Change awareness before commit (REQ-012 to REQ-015); **CA-5** Reorder reminders (REQ-016 to REQ-018); **CA-6** Recurring demand visibility (REQ-019 to REQ-021); **CA-7** Storefront integration surface (REQ-022).

Origin is one of four labels: **Quoted clause C1**, **C2** or **C3** — the Objective Statement's three top-level clauses, quoted verbatim and labelled where it appears below — or an inference from the **Business Targets**, the **Primary Users**, or a **codebase finding**. Personas are shortened to Buyer, Account admin, Category manager, Seller ops, Support agent, Developer.

|ID|Requirement|Who it serves|Origin|Depends on|
|---|---|---|---|---|
|REQ-001|Repeat a past order in one act|Buyer, Support agent|Quoted clause C1|—|
|REQ-002|Add what can be added, name every refusal|Buyer|Codebase finding|REQ-001|
|REQ-003|Never silently reduce a quantity, state the shortfall|Buyer|Quoted clause C3|REQ-002|
|REQ-004|Confine a repeat to one storefront|Buyer, Developer|Codebase finding|REQ-001|
|REQ-005|Show what this buyer buys repeatedly, most repeated first|Buyer|Quoted clause C1|—|
|REQ-006|Let the operator define regular|Category manager, Buyer|Codebase finding|REQ-005|
|REQ-007|Take all regular items, or pick them|Buyer|Quoted clause C2|REQ-005|
|REQ-008|Let a dismissal stick until undone|Buyer|Primary Users|REQ-005|
|REQ-009|Save items as a named list|Buyer|Quoted clause C2|—|
|REQ-010|Keep a withdrawn item listed, unavailable|Buyer, Support agent|Primary Users|REQ-009|
|REQ-011|Share a list across one account|Account admin|Primary Users|REQ-009|
|REQ-012|Show the price last paid beside the price now|Buyer|Quoted clause C3|REQ-001|
|REQ-013|Show availability per line before commit|Buyer|Codebase finding|REQ-001|
|REQ-014|Require deliberate acceptance of a moved price|Buyer|Quoted clause C3|REQ-012|
|REQ-015|Let an agent see what was shown and accepted|Support agent|Primary Users|REQ-012, REQ-014|
|REQ-016|Reminders by opt-in only|Buyer|Business Targets|REQ-005|
|REQ-017|Reminder delivery behind one interface, defaulting to no outside service and a record in the platform's own store|Developer|Codebase finding|REQ-016|
|REQ-018|Stop reminders wholesale or per item|Buyer|Primary Users|REQ-016|
|REQ-019|Show most repurchased items in the viewer's range|Category manager|Business Targets|REQ-006|
|REQ-020|Prepare repurchase figures on a schedule|Category manager, Seller ops|Codebase finding|REQ-019|
|REQ-021|Confine a seller's figures to their own goods|Seller ops|Business Targets|REQ-019|
|REQ-022|One documented addition, disturbing no existing call|Developer|Business Targets|REQ-001, REQ-005, REQ-009, REQ-012|


## 9. Impact of Implementation

### Blast radius

Contained but for one exception. Attach this capability's information to what the platform already exposes instead of keeping it apart, and something existing storefront calls receive changes shape — a violation to report. Avoidable, and it bears on CA-7.

### What changes for people who never use this feature

Six behaviours were checked and five are untouched: existing storefront calls keep their shape and result on the additive decision above; order history, the cart, the catalogue and availability are read, never altered; reporting is unchanged. The sixth, the permission values every administrative client receives, grows only if this work defines its own — both shipped reporting extensions reuse an existing one — so it is a choice between a longer list for every client and closer control of who sees seller figures.

### What this work would collide with

Two. There is no built-in marketplace — one is assembled a storefront per seller by an addition, so seller-scoped reporting inherits that shape. And the vendor's plans put buying organisations, quotations and approvals in a paid layer above the open platform, so anything built now for shared buying either duplicates that layer or is replaced by it. That defers CA-3, and makes the deferral a purchase decision rather than a wait.

### Where the risk concentrates

In two places, neither where the effort concentrates. First, CA-2: past items are readable, but no request answers which items recur, so anything asking must read a buyer's history through and work it out — a wholly new computation that CA-6 waits on. Second, scope enforcement: every reporting proposal is a place one seller could see another's figures, every stored preference a place one buyer could read another's.

### Verification burden created

Substantial and unavoidable. The suite guarding this behaviour runs against four separate data engines, and twenty-seven of the hundred specifications must pass on all four; the rule behind that count is in the appendices. Changing how data is stored also invalidates cached seed data.

### Reversibility

Partial. Whatever the addition stores persists until deliberately removed, and nothing is cleaned up when a capability is withdrawn, bar orphaned preferences, already swept on a schedule. Switching off stops new writes but removes nothing written, and a live instance must never run with schema synchronisation.

### Volume sensitivity

Two places, CA-2 and CA-5. The recurrence computation reads every item of every past order a buyer has placed, so cost grows with how much they have bought. Reminders carry only a prospective risk — none exists to observe, but a scheduled design would send one message per buyer per due item. Neither can be sized: no baseline exists.

## 10. Relative Scale and Effort Signals

Sizes are relative only.

|Capability area|Relative size|
|---|---|
|CA-1 Reorder|S|
|CA-2 Regular items|L|
|CA-3 Saved lists|M|
|CA-4 Change awareness|M|
|CA-5 Reminders|M|
|CA-6 Demand visibility|L|
|CA-7 Storefront surface|S|

The low-hanging fruit is CA-1 and CA-7, both leaning almost wholly on shipped behaviour; the expensive minority is CA-2 and CA-6. CA-4 sits between: availability needs nothing new, the price disclosure does.

No area rates XL. What would earn it: being unable to avoid changing what existing storefront calls receive; needing a construct for several people on one account; needing an outside service.

## 11. Constraints That Shape the Product

Everything is added and nothing existing altered; any change to what an existing call returns is a violation to report. The core is untouched and stored shapes only added to, so this arrives as a self-contained addition. Prices are whole numbers in the smallest unit of currency, so a difference is only the price last paid against the price now. Every request belongs to one storefront and one language, and nothing crosses it. No outside hosted service is required: anything wanting one sits behind an interface defaulting to the platform's own storage. And no measure is invented, absence being reported instead.

## 12. What Is Out of Scope and Why

|Topic|Ruling|Why, and what would bring it back|
|---|---|---|
|Placing orders automatically on a recurring cycle|Permanent|This suggests and prefills, never places: a reminder is not consent to buy.|
|Repeating a past order across storefronts|Permanent|Every request belongs to one storefront, so an order from elsewhere cannot be drawn in.|
|Replaying the discounts a past order received|Permanent|A past order records its promotions only once payment completed, and eligibility may since have changed, so identical discounts cannot be assumed reproducible. A product decision, not an impossibility.|
|Lists shared across several people on one account|Deferred|No such construct here, and the vendor sells one in a paid layer. Returns when the Product Owner takes that layer or funds the construct here. REQ-011 waits on that.|
|Quotation and approval flows, including spend thresholds|Deferred|Same construct and paid-layer question, plus whether a repeat may be submitted for approval.|
|Which administrative surface carries the seller-facing figures|Deferred|Two exist, one superseding the other; returns when that is settled for the estate.|

## 13. Open Questions for the Product Owner

Ordered by how much each blocks.

**Q1 — Where should this capability's information be kept?** In its own store, or attached to what the platform already exposes. Its own store touches no buyer; attaching touches none directly, but every storefront built today then gets a differently shaped answer and must be updated first. Recommendation: its own store, keeping the additive promise. Blocks REQ-001 to REQ-003 and REQ-005 to REQ-022, as closed ranges so a later addition cannot silently join them.

Answer:

**Q2 — What makes an item count as regularly purchased?** More than once; a set number within a window; or a discernible cycle. The first buries the regular in noise; the second is more useful but misses slow cycles; the third is best and oftenest wrong. Recommendation: a count within an operator-set window. Blocks REQ-005 to REQ-008, REQ-016 and REQ-019 to REQ-021.

Answer:

**Q3 — Is repeat demand worked out when someone looks, or prepared in advance?** On demand, or on an operator-set schedule. On demand is current but slowest for the longest history, exactly this buyer; prepared is fast but a cycle behind. Recommendation: prepared, on the schedule. Blocks REQ-005, REQ-007, REQ-016, REQ-019, REQ-020.

Answer:

**Q4 — Who owns a saved list, the individual buyer or the account?** The individual only; the account, shared; or both. Individual surprises nobody but hides a colleague's list; account means one edit changes what all see; both is most useful and alone needs a notion of who may edit. Recommendation: the individual, no account construct existing. Blocks REQ-009, REQ-010, REQ-011.

Answer:

**Q5 — Are reminders strictly opt-in, and how should they reach the buyer?** Two choices. Whether: opt-in, or on by default with an easy way out — opt-in contacts nobody unasked but takes up slowly, while default-on reaches more buyers and contacts some who did not ask, costing trust. How: existing message sending, or a new interface whose default keeps its own record — existing sending reaches buyers today but keeps no record, so nobody can later confirm what was sent, while the interface keeps that record. Recommendation: opt-in, behind the interface. Blocks REQ-016, REQ-017, REQ-018.

Answer:

**Q6 — Which administrative surface carries the seller-facing figures?** The newer, the older, or both. No buyer sees either, so the impact falls on the category manager and seller: the newer puts them where investment is going; the older reaches anyone still working there but its maintenance ends, so the work is done twice; both serves everyone at the cost of two surfaces to keep aligned. Recommendation: the newer, the older being superseded. Blocks REQ-019, REQ-021.

Answer:

## 14. Success Measures

Observable outcomes, without figures because none is available. A returning buyer repeats a past purchase without searching the catalogue. No price a buyer was shown changes without their saying so. An item that cannot be supplied is named before commitment. An operator sees what is bought again and again in their scope and no more. A buyer who never asked for reminders never receives one.

Candidate metrics:

- Orders placed over time — **instrumented** by existing reporting's daily count.
- Share of orders beginning as a repeat — **not instrumented**, and no requirement here delivers it: nothing records that an order began as one, so it needs a requirement of its own.
- Items found by hand — **not instrumented**; nothing records buyer interactions.
- Abandonment after a moved price — **not instrumented**; the same absence.
- Most repurchased items in a scope — **not instrumented**; REQ-019 with REQ-020 delivers it.

An explicit negative result: **no service-level, latency, availability, conversion, retention or revenue figure is declared anywhere in the platform** — the search behind that is in the appendices. Any target here must be set by the Product Owner, not quoted.

## 15. Suggested Sequencing

First, CA-1 with CA-4 and CA-7: a repeat without the disclosure is the worse half, so they go together, and the repeat and availability lean on shipped behaviour while the price half does not. Second, CA-2, which sets the rule everything downstream waits for. Third, CA-6, which follows because one computation feeds both.

Two run alongside: CA-3 depends on nothing beyond itself and parallels any step after the first; CA-5 needs the regular-items rule, so follows the second and parallels the third.

## 16. What This Document Cannot Tell You Yet

Nine things, stated even where nothing is to report.

- **Performance.** Nothing: the one automated benchmark measures search, the order and cart harnesses run by hand, and no result is kept.
- **Targets.** None is declared anywhere in the platform.
- **Four contradictions in existing material.** In the appendices; reported, not corrected, none asserted here.
- **Shared accounts.** No construct for several people on one account exists, so that ownership model is unresolved.
- **One data engine.** A fifth, supported for development, sits outside the suite guarding this behaviour, though other checks exercise it.
- **Whether every citation resolved.** It did; the check is reported below.
- **Absolute effort and dates.** Not available, and not guessed.
- **Current buyer behaviour.** Unknown; nothing records buyer interactions.
- **How current this is.** The findings hold for one recorded point, named below; two patch releases have since appeared, the later fixing defects on these paths, so upgrade first.

## 17. How This Document Was Produced

Read from the working copy, branch master at commit e7f8fe0029ceba9b450f60554226cec2cf628309, platform version 3.7.0 — two patch releases behind the published line.

The Objective Statement in full, its three top-level clause boundaries marked with the bracketed labels the origin column uses; the words are unaltered:

> "**[C1]** Make it effortless for returning buyers to reorder the items they purchase regularly, **[C2]** so that repeat purchasing on the marketplace requires materially less effort than rebuilding an order from scratch, and **[C3]** so that buyers are made aware of price and availability changes before they commit to a reorder."

Measured: 1 sentence, 48 words, 302 characters, 4 clauses, 3 top-level and quotable as origins; the fourth sits inside C1.

Requirement count and origin split, recomputed from the emitted table: 22 proposals — 7 quoted clause, 4 Business Targets, 5 Primary Users, 6 codebase finding.

Measured body word count: 2988 words, counted to the marker closing the body.

Mechanical check for technical identifiers in the body: PASS, zero tokens found. Every appendix citation was checked for existence and for supporting its claim.

<!-- END OF BODY -->

---

Everything below this line is evidence, not proposal. It is excluded from the body word budget and from the body's ban on technical identifiers. Repository citations are given as a path plus a locator; published-source claims are grouped separately at the end so the two evidence classes stay distinct.

## Appendix A — Technical Findings and Impact Evidence

### A.1 Existing mechanisms not to duplicate

Each entry names the mechanism that already ships, its evidence, and the requirement in the body that consumes it.

- **Bulk addition to the cart, with per-item outcomes.** `addItemsToOrder(inputs: [AddItemInput!]!): UpdateMultipleOrderItemsResult` already exists, and the result is an object carrying both `order` and `errorResults`, so partial success is a first-class outcome today rather than something to invent [schema-shop.json:Mutation.addItemsToOrder]. The singular `addItemToOrder` returns a union of `Order` plus five error outcomes — `OrderModificationError`, `OrderLimitError`, `NegativeQuantityError`, `InsufficientStockError`, `OrderInterceptorError` [schema-shop.json:UpdateOrderItemsResult]. Consumed by REQ-002.
- **Price movement since an item was added to the *current* order — not since a past purchase.** `OrderLine.unitPriceChangeSinceAdded` and `OrderLine.unitPriceWithTaxChangeSinceAdded` are present in the committed storefront snapshot [schema-shop.json:OrderLine]. Both are computed getters that difference the line's live `unitPrice` against `initialListPrice` [packages/core/src/entity/order-line/order-line.entity.ts:L163-L186], and `initialListPrice` is documented as "the price as calculated when the `OrderLine` was first added to the `Order`" [packages/core/src/entity/order-line/order-line.entity.ts:L106-L113]. The shipped strategy that populates it addresses the case where an item is already in an order and the variant price changes before another is added [packages/core/src/config/order/changed-price-handling-strategy.ts:L9-L13], and its dedicated suite asserts that a newly added line reports a change of zero [packages/core/e2e/order-changed-price-handling.e2e-spec.ts:L66-L78]. **This is within-cart drift. It does not carry the price paid on a prior completed order**, so REQ-012 and REQ-014 are not satisfied by it: delivering them means reading the historical line's recorded unit price and setting it against the variant's current price for the request's channel and currency [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37]. Consumed by REQ-012 and REQ-014, as a partial mechanism only.
- **Availability as three display states.** The storefront availability field is a `String`, not an integer [schema-shop.json:ProductVariant.stockLevel], and the default display strategy emits out-of-stock below a saleable count of one, low-stock at or below a threshold whose constructor default is two, and in-stock otherwise [packages/core/src/config/catalog/default-stock-display-strategy.ts:L14-L22]. This confirms the brief's own illustrative example literally. Consumed by REQ-013.
- **Buyer-scoped, storefront-confined order history, readable down to the item.** `Customer.orders` returns a paginated `OrderList` [schema-shop.json:Customer.orders]; `Order.lines` returns `OrderLine` [schema-shop.json:Order.lines] and `OrderLine.productVariant` returns `ProductVariant` [schema-shop.json:OrderLine.productVariant], so **the items of a buyer's past orders are reachable through existing operations**. The resolver forwards the requested relations to the order service [packages/core/src/api/resolvers/entity/customer-entity.resolver.ts:L36-L49], which loads `lines` among its default relations, filters on the request's channel and on the customer, and excludes drafts [packages/core/src/service/services/order.service.ts:L336-L356] — that channel filter, not entity membership, is what confines history to one storefront. The order entity additionally carries an indexed placement timestamp and an indexed customer relation [packages/core/src/entity/order/order.entity.ts:L84-L99]. Consumed by REQ-001, REQ-004 and REQ-005.
- **Buyer preferences with no new table — storage and scoping only.** A scoped key-value settings store already exists, with read and write paths [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L102-L129, L194-L258] and per-field scope functions covering global, per-user, per-channel and per-user-per-channel isolation [packages/core/src/config/settings-store/settings-store-types.ts:L174-L198]; its entity carries a unique index on key and scope [packages/core/src/entity/settings-store-entry/settings-store-entry.entity.ts:L15-L43] and a scheduled sweep removes orphaned entries [packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts:L39-L45]. **Authorization is not part of it.** `get` and `set` perform no permission check; the service states that its `hasReadPermission` and `hasWritePermission` helpers are "not called internally in the get and set methods, so should be used by any methods which are exposing these methods via the GraphQL APIs" [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L483-L488], and those helpers are separate entry points [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L501-L536, L538-L565]. Any storefront operation built on this store must therefore establish that the caller owns the preference and holds the required permission before reading or writing it. A live example of declaring such fields with an explicit per-field read and write permission exists [packages/dashboard/plugin/dashboard.plugin.ts:L96-L148]. Consumed by REQ-008, REQ-016 and REQ-018.
- **Reporting, and its ceiling.** Two reporting contracts exist. The legacy one declares a summary query [packages/admin-ui-plugin/src/api/api-extensions.ts] resolved under an existing order-read permission [packages/admin-ui-plugin/src/api/metrics.resolver.ts:L11-L18], and it is the only one captured in the committed administration snapshot, where its interval enumeration has exactly one value and its type enumeration exactly three — order count, order total and average order value [schema-admin.json:MetricType]. The current one, absent from that snapshot and therefore not visible in it at all, declares its own summary query taking a date range and a refresh flag with **no interval enumeration**, over the same three types [packages/dashboard/plugin/api/api-extensions.ts]. Neither expresses per-item repeat demand. Consumed by REQ-019.

### A.2 Impact evidence, paired with each finding in the body

- **Blast radius.** The three distinct effects a visible custom field has are set out, and cited separately, under *Constraint collisions found in this repository*. The committed snapshots corroborate the present state: `customFields` is the generic `JSON` scalar on the order [schema-shop.json:Order.customFields, schema-admin.json:Order.customFields], the order line [schema-shop.json:OrderLine.customFields], the customer [schema-shop.json:Customer.customFields] and the product variant [schema-shop.json:ProductVariant.customFields], and no generated per-entity custom-fields object type exists in the storefront snapshot at all.
- **What changes for people who never use this feature.** Six behaviours were checked, and five are unaffected: existing storefront operation signatures [schema-shop.json:Mutation], order history reads [schema-shop.json:Customer.orders], cart reads [schema-shop.json:OrderLine], availability reads [schema-shop.json:ProductVariant.stockLevel], and existing reporting [schema-admin.json:MetricType]. **The sixth is conditional, not unavoidable.** Custom permissions declared by an extension are folded into the administration permission enumeration when it is generated [packages/core/src/api/config/generate-permissions.ts:L39-L67], which grows the value set every administration client receives from its present ninety-seven [schema-admin.json:Permission] — but an extension need not declare one. Both shipped reporting resolvers guard their query with the existing order-read permission and register nothing new [packages/admin-ui-plugin/src/api/metrics.resolver.ts:L11-L18; packages/dashboard/plugin/api/metrics.resolver.ts:L11-L18]. Growth therefore follows only from a deliberate decision to define a permission of this capability's own, which buys finer control over who sees seller-scoped figures; a live example of that choice exists [packages/dashboard/plugin/dashboard.plugin.ts:L96-L148].
- **What this work would collide with.** A marketplace here is assembled one channel per seller by an extension, whose configuration replaces the seller strategy and composes a custom order process [packages/dev-server/example-plugins/multivendor-plugin/multivendor.plugin.ts:L126-L160] while its service creates the seller, channel, role and administrator, then a shipping method and a stock location for each [packages/dev-server/example-plugins/multivendor-plugin/service/mv.service.ts:L45-L47, L51, L100, L107]. The platform has no native marketplace construct.
- **Where the risk concentrates, first place.** `OrderFilterParameter` exposes eighteen input fields — sixteen data fields plus the `_and` and `_or` combinators [schema-shop.json:OrderFilterParameter] — and `OrderSortParameter` thirteen [schema-shop.json:OrderSortParameter]; **neither set contains a single line-level or variant-level field.** The recurrence question is therefore not answerable by any *single* existing request. It is not unanswerable: as A.1 records, the items of a buyer's past orders are reachable through `Customer.orders`, `Order.lines` and `OrderLine.productVariant`, so a consumer could page the history and aggregate client-side. What does not exist is a first-class, server-side filter, sort or aggregate at item level, so the aggregation, its rule and its cost are all new work.
- **Where the risk concentrates, second place.** Scope enforcement. Channel scoping on the history read is applied by the service, not by the entity [packages/core/src/service/services/order.service.ts:L336-L356], so any new read path must apply it deliberately; and the preference store performs no ownership or permission check inside read and write [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L483-L488].
- **Verification burden created.** Continuous integration runs four database engines, each alongside a cache service, in four separate jobs [.github/workflows/build_and_test.yml:L174-L311]; the exact engine and runtime versions are named under *Supported versus continuously verified database engines*. The core end-to-end directory [packages/core/e2e/] holds **one hundred** top-level specification files, of which **twenty-seven** match the reproducible rule `ls packages/core/e2e/*spec.ts | grep -icE '(order|cart|customer|stock|price|storefront)'` — the count is of top-level files only; the same tree holds one hundred and one specifications recursively. The twenty-seven are: active-order-strategy, customer-channel-assignment-strategy, customer-channel, customer-group, customer, draft-order, order-cancel-shipping, order-changed-price-handling, order-channel, order-fulfillment, order-interceptor, order-item-price-calculation-strategy, order-line-custom-fields, order-merge, order-modification, order-multi-vendor, order-multiple-shipping, order-process, order-promotion, order-taxes, order, product-prices, shop-customer, shop-order, stock-control-multi-location, stock-control and stock-location. Cached seed data must be deleted after any change to stored shape [AGENTS.md:§Testing].
- **Reversibility.** A scheduled sweep already removes orphaned preference entries [packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts:L39-L45]; no equivalent exists for an extension's own tables.
- **Volume sensitivity.** The recurrence half is a repository finding: a consumer must read a buyer's history through, because the filter and sort sets carry no item-level field, so cost grows with the history read. The reminder half is **not** a repository finding and is labelled prospectively in the body, because no reminder mechanism exists to observe. What does exist is the machinery such a design would use: cross-instance-locked scheduling [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts:L14-L19], stale-lock sweeping [packages/core/src/plugin/default-scheduler-plugin/stale-task.service.ts:L15-L19] and a worked configurable task [packages/core/src/scheduler/tasks/clean-sessions-task.ts:L37-L49]. That source establishes database-coordinated, exactly-once scheduling and nothing about polling frequency or message fan-out, which is why the body states the fan-out as a design consequence rather than a fact. Neither half can be sized; the benchmark position is set out under *Existing benchmark and load tooling*.

### A.3 Constraint collisions found in this repository

- **Additive change with an observable side effect — the headline collision.** Declaring a *visible* custom field breaks the additive-only constraint, and it does so through **three distinct effects with different scopes**. Conflating them overstates the second and third, so each is cited separately.
  - **Effect one, general to every entity: the output and input type flip.** The generator emits a generic scalar-typed `customFields` member on an entity with no visible custom fields, but substitutes a generated per-entity object type the moment one becomes visible [packages/core/src/api/config/graphql-custom-fields.ts:L105-L131]. The same flip applies to create inputs [packages/core/src/api/config/graphql-custom-fields.ts:L160-L195] and to update inputs [packages/core/src/api/config/graphql-custom-fields.ts:L198-L233]. So a field on the order, the customer or the variant changes the *type* of an existing field in an existing response — nothing more.
  - **Effect two, specific to the order line: extra arguments on two storefront mutations.** Only order-line custom fields cause `addItemToOrder` and `adjustOrderLine` to gain a `customFields` argument, appended to each mutation's argument list [packages/core/src/api/config/graphql-custom-fields.ts:L517-L545], with matching additions to `AddItemInput`, `OrderLineInput`, `AddItemToDraftOrderInput` and `AdjustDraftOrderLineInput` [packages/core/src/api/config/graphql-custom-fields.ts:L547-L584]; the whole path is `addOrderLineCustomFieldsInput` [packages/core/src/api/config/graphql-custom-fields.ts:L461-L586]. **This effect does not follow from a field on any other entity.**
  - **Effect three, specific to the order: a modified administration input.** Order custom fields add `customFields: UpdateOrderCustomFieldsInput` to the existing `ModifyOrderInput` [packages/core/src/api/config/graphql-custom-fields.ts:L436-L455].
  - Effects one and two are corroborated independently by the vendor's published documentation, cited under *Research evidence — published sources*. Because the two evidence classes agree, the finding is stated once with both proofs rather than twice.
- **The escape hatch, verified in the same file.** Fields marked `internal` are filtered from both interfaces and fields marked non-public from the storefront interface, so a wholly internal declaration preserves the generic-scalar branch and leaves the public interface unchanged [packages/core/src/api/config/graphql-custom-fields.ts:L60-L62]. The order-line path applies the same two filters before it touches any mutation argument [packages/core/src/api/config/graphql-custom-fields.ts:L467-L469], so effect two is avoidable on the same terms.
- **A second-order failure mode.** A relation-typed custom field whose target type is absent from the storefront schema causes a hard failure at start-up, with logged remediation advice, rather than a degraded schema [packages/core/src/api/config/graphql-custom-fields.ts:L64-L85].
- **Any change to stored shape is classed as breaking.** The contribution guide defines a breaking change to include "any changes to the DB schema" and routes such contributions to the major branch [CONTRIBUTING.md:L390-L392]. This collides head-on with the premise that additive stored change is unremarkable, and it disagrees with the vendor's published policy — both readings are reported below, and neither is adopted.
- **Order promotions cannot be assumed replayable.** Promotions are populated only after the payment process has completed [packages/core/src/entity/order/order.entity.ts:L121-L128], which establishes when the record appears — not that a promotion could never be evaluated again. What follows is the narrower conclusion the body states: because eligibility and promotion state may have changed since, identical discounts cannot be *assumed* reproducible. Ruling replay permanently out of scope is therefore a product decision resting on that uncertainty, not a technical impossibility.
- **Money is integer minor units, not decimal.** The money column type comes from a configurable strategy whose default declares an integer column with two-decimal precision and integer rounding [packages/core/src/config/entity/default-money-strategy.ts:L14-L22], and payment amounts use the same decorator [packages/core/src/entity/payment/payment.entity.ts:L28].
- **Per-request scoping is real and enforced by the platform.** The request context resolves channel, channel identifier, language, currency and active user per request [packages/core/src/api/common/request-context.ts:L352-L378], and answers permission questions against that same context [packages/core/src/api/common/request-context.ts:L268-L286], and prices are stored per variant per channel and currency [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37]. This is why REQ-004 needs no product decision.

### A.4 Precedent, rated per capability area, CA-1 to CA-7

Each entry names the capability area, its closeness rating — near-identical, partial or none — and the closest precedent found. Areas with nothing found are stated as explicit negatives rather than left silent.

- **CA-1 Reorder from a past order — none.** No implementation of reorder, replenishment or repeat purchasing exists anywhere; identifier searches across every package source tree return only drag-to-reorder interface helpers.
- **CA-2 Regularly purchased items — none.** Nothing computes item recurrence anywhere, and no request answers it: order history can be filtered [schema-shop.json:OrderFilterParameter] and sorted [schema-shop.json:OrderSortParameter] only whole orders at a time. The raw material *is* reachable through the existing history read path [schema-shop.json:Order.lines], so this is an absent aggregate rather than absent data.
- **CA-3 Saved reorder lists — partial.** One example extension declaring one entity, one service, storefront extensions and a single internal relation custom field [packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts]; it returns bare lists rather than the platform's result-union convention [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts], so it models structure but not error handling.
- **CA-4 Change awareness before commit — partial.** Split. The availability half is near-identical: the three-state display strategy ships and needs nothing new [packages/core/src/config/catalog/default-stock-display-strategy.ts:L14-L22]. The price half is only partial: the shipped drift strategy and its dedicated suite compare a line against its own price when added to *that* cart [packages/core/src/entity/order-line/order-line.entity.ts:L106-L113], so they model the disclosure pattern but not the prior-purchase comparison REQ-012 asks for.
- **CA-5 Reorder reminders — partial.** Transactional delivery whose transport modes include a file output and a no-op as well as external senders [packages/email-plugin/src/types.ts:L292-L315], plus locked scheduling [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts:L14-L19]. Neither is a reminder: the scheduler proves only that a task can be run exactly once across instances, and no transport mode is a durable, database-backed record of what was sent — which is why REQ-017 requires a default of that kind.
- **CA-6 Recurring demand visibility — near-identical.** Two precedents, both delivered wholly outside core. The **current** one is primary: an additive extension contributing an administration query [packages/dashboard/plugin/api/api-extensions.ts], a resolver reusing an existing permission [packages/dashboard/plugin/api/metrics.resolver.ts:L11-L18], a service [packages/dashboard/plugin/service/metrics.service.ts], a strategy seam [packages/dashboard/plugin/config/metrics-strategies.ts], a declared custom permission and per-buyer stored settings [packages/dashboard/plugin/dashboard.plugin.ts:L96-L148]; its widget lives in the interface package rather than the extension [packages/dashboard/src/lib/framework/dashboard-widget/metrics-widget/]. The **legacy** one has the same shape [packages/admin-ui-plugin/src/api/api-extensions.ts; packages/admin-ui-plugin/src/service/metrics.service.ts; packages/admin-ui-plugin/src/config/metrics-strategies.ts] but is superseded [packages/admin-ui-plugin/src/plugin.ts:L95-L98]. The two contracts differ: the legacy input carries an interval enumeration of one value, the current one takes a date range and a refresh flag and has no interval enumeration at all.
- **CA-7 Storefront integration surface — partial.** Additive storefront extensions in both example extensions above; and a live case of an extension declaring two *public* custom fields on a variant, demonstrating the side effect in practice [packages/dev-server/example-plugins/minimum-order-quantity/order-quantity-limits.plugin.ts].

Two further explicit negatives. No product-requirements precedent of any kind exists in this repository — a case-insensitive filename search across the whole tree for requirement, proposal and design-record patterns returns only an unrelated deployment guide — so the seventeen-section structure derives wholly from the brief. And the only in-core reference to a saved-list capability is a documentation example on a permission helper [packages/core/src/common/permission-definition.ts:L112-L140].

### A.5 Verified surfaces

- **Operation inventory.** Storefront: nineteen queries [schema-shop.json:Query], thirty-two mutations [schema-shop.json:Mutation]. Administration: eighty-two queries [schema-admin.json:Query], one hundred and seventy-nine mutations [schema-admin.json:Mutation], ninety-seven permission values [schema-admin.json:Permission].
- **Entities relevant to the scope.** Order [packages/core/src/entity/order/order.entity.ts:L70-L102], Customer [packages/core/src/entity/customer/customer.entity.ts:L23-L64], ProductVariantPrice [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37], Payment [packages/core/src/entity/payment/payment.entity.ts:L28], SettingsStoreEntry [packages/core/src/entity/settings-store-entry/settings-store-entry.entity.ts:L15-L43]. The only grouping constructs in the entity directory are customer, customer group, channel and seller: no company, organisation, buying-account or team entity exists, which is why the Buying Account Administrator has no multi-seat construct to build on.
- **Services and strategies.** Settings store read and write [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L102-L129, L194-L258] with its permission helpers separate [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L501-L565]; changed-price handling [packages/core/src/config/order/changed-price-handling-strategy.ts:L9-L13]; stock display [packages/core/src/config/catalog/default-stock-display-strategy.ts:L14-L22]; cross-channel price propagation [packages/core/src/config/catalog/product-variant-price-update-strategy.ts]; money [packages/core/src/config/entity/default-money-strategy.ts:L14-L22].
- **Permissions.** An extension declares a permission [packages/core/src/common/permission-definition.ts:L10-L38], and declared permissions are folded into the generated enumeration [packages/core/src/api/config/generate-permissions.ts:L39-L67]. The definition helper alone does not perform that folding, which is why both are cited.
- **Events.** Sixty-one event definition files exist [packages/core/src/event-bus/events/], covering order, order-line, order-placed, state-transition, variant, variant-price, stock-movement and customer changes, so price and stock movement are observable without touching core.
- **Error-result convention.** The convention is an interface every error type implements: thirty-one types implement it in the storefront schema [schema-shop.json:ErrorResult] and forty-six in the administration schema [schema-admin.json:ErrorResult]. Individual operations then return a union drawn from those — the bulk-add path returns an object carrying an order and per-item errors, while the single-add path returns a six-member union [schema-shop.json:UpdateOrderItemsResult]. New operations are expected to follow this, which is the respect in which the closest structural precedent does not.
- **History entries.** The history-entry enumeration carries twenty-six values, fourteen prefixed for the customer and twelve for the order — the split is by prefix, stated so it can be reproduced — and **none records a reorder action** [packages/common/src/generated-types.ts:L2174-L2201].

### A.6 Identifiers excluded from the body

The body uses a product vocabulary throughout. This is what each term stands for.

- **the cart** — the active `Order` [packages/core/src/entity/order/order.entity.ts:L82].
- **order history** — `Customer.orders` [schema-shop.json:Customer.orders].
- **the cart's lines** — `OrderLine` [schema-shop.json:OrderLine], and the stored line behind a past order [packages/core/src/entity/order-line/order-line.entity.ts:L106-L113].
- **how a line's price has moved since it went into the cart** — `OrderLine.unitPriceChangeSinceAdded`, a difference against `initialListPrice` [packages/core/src/entity/order-line/order-line.entity.ts:L163-L186].
- **the price last paid against the price now** — a proposed comparison of the historical `OrderLine.unitPrice` with the current `ProductVariantPrice` for the request's channel and currency [packages/core/src/entity/product-variant/product-variant-price.entity.ts:L21-L37]. **No existing field expresses this**.
- **availability, and its three states** — `ProductVariant.stockLevel` [schema-shop.json:ProductVariant.stockLevel].
- **the storefront** — the Shop API [schema-shop.json:Mutation].
- **the admin tools, the two surfaces** — the Admin API [schema-admin.json:Query]; the legacy interface [packages/admin-ui-plugin/src/plugin.ts:L95-L98] and the newer dashboard [packages/dashboard/plugin/dashboard.plugin.ts:L54-L57].
- **reporting** — `metricSummary` [packages/admin-ui-plugin/src/api/api-extensions.ts] and `dashboardMetricSummary` [packages/dashboard/plugin/api/api-extensions.ts].
- **adding many items at once** — `addItemsToOrder` [schema-shop.json:Mutation.addItemsToOrder].
- **a store of data, stored shape** — a database table and its schema.
- **the platform's own preference store** — the settings store [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L102-L129] and its scope functions [packages/core/src/config/settings-store/settings-store-types.ts:L174-L198].
- **an addition, the extension** — a plugin [packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts].
- **one documented way in** — storefront schema extensions and resolvers.
- **four separate data engines, a fifth engine** — the four registered test initialisers [e2e-common/test-config.ts:L32-L35] run as four jobs [.github/workflows/build_and_test.yml:L174-L311], and the file-backed engine absent from them [packages/core/package.json].
- **the permission values every administrative client receives** — the `Permission` enumeration [schema-admin.json:Permission].
- **automatic schema synchronisation** — the schema synchronisation option.
- **the one automated benchmark, measuring search** — [packages/core/e2e/default-search-plugin.bench.ts].
- **a load-testing helper** — the percentile summariser [packages/dev-server/load-testing/generate-summary.ts:L29-L30]; the storefront documents it drives live separately [packages/dev-server/load-testing/graphql/shop/].

## Appendix B — Architectural Decisions

Six decisions, each with a recommendation and what it blocks. Four correspond to an open question in the body and say which; two — the preference store and the result convention — are engineering choices with no product question attached, and are marked as such. Two body questions, on what counts as regular and on who owns a list, have no matching decision here because both are product decisions with no architectural fork.

- **Where new state lives.** Extension-owned tables, or custom fields on core entities — recommend extension-owned tables, because a *visible* custom field changes an existing operation's signature [packages/core/src/api/config/graphql-custom-fields.ts:L105-L131]; blocks every requirement except REQ-004; **corresponds to Q1**.
- **Whether buyer preferences need a new table.** The existing scoped settings store, or a new table — recommend the settings store, since it persists per-buyer values with no schema addition at all [packages/core/src/config/settings-store/settings-store-types.ts:L174-L198] and already has a cleanup task [packages/core/src/config/settings-store/clean-orphaned-settings-store-task.ts:L39-L45]; **conditional on the exposing operation enforcing ownership and permission itself**, because the store's read and write paths do not [packages/core/src/service/helpers/settings-store/settings-store.service.ts:L483-L488]; blocks REQ-008, REQ-016 and REQ-018; **no corresponding body question — an engineering choice within Q1's answer**.
- **Whether recurrence is computed on read or on a schedule.** Recommend on a schedule, using the existing cross-instance-locked scheduler [packages/core/src/plugin/default-scheduler-plugin/default-scheduler.plugin.ts:L14-L19], because cost grows with a buyer's history; blocks REQ-005, REQ-007, REQ-016, REQ-019 and REQ-020; **corresponds to Q3**.
- **Which administration surface the seller-facing figures target.** The newer dashboard, or the legacy interface — recommend the newer. The legacy interface's own source states it was replaced from version 3.5.0 and will not be maintained after July 2026, with only critical bugs and security issues patched until then [packages/admin-ui-plugin/src/plugin.ts:L95-L98]; the project readme names the newer surface but states no replacement version, so it is not the authority for this. Blocks REQ-019 and REQ-021; **corresponds to Q6**.
- **Whether reminder delivery rides the existing transactional extension or a new interface.** Recommend a new interface with a database-backed default, since the existing extension already supports non-external transport modes — a file output and a no-op [packages/email-plugin/src/types.ts:L292-L315] — and can serve as one adapter behind the interface. Neither mode is itself the default REQ-017 requires: that default must record each due reminder in the platform's own store, which the settings store and an extension-owned table can both do and no transport mode does. Blocks REQ-016, REQ-017 and REQ-018; **corresponds to Q5**.
- **Whether new operations return result unions or bare types.** Recommend result unions per platform convention [schema-shop.json:ErrorResult], not bare lists as the closest structural precedent uses [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts]; blocks REQ-002, REQ-003 and REQ-022; **no corresponding body question — a convention, not a product choice**.

## Appendix C — Repository and Release Conventions

### C.1 Version lock, branch and release conventions

- **Version lock.** The analysis basis is platform version 3.7.0 [packages/core/package.json], read on branch `master` at commit `e7f8fe0029ceba9b450f60554226cec2cf628309`. Note that the repository-root manifest declares version `0.0.0` and is *not* the platform version [package.json]. Two later patch releases have since been published upstream, the more recent carrying security fixes that bear on this work; both are recorded under *Research evidence — published sources*.
- **Branch target for a new feature, and a collision.** New features are submitted to the `minor` branch while bug fixes go to `master` [CONTRIBUTING.md:L327, L330, L338]. This analysis read `master`, which is the collision: any implementation would be cut against `minor`, so a finding true here may not hold there. Reported, not acted upon.
- **Version tagging for new public interfaces.** New public interfaces carry a tag naming the next minor line [CONTRIBUTING.md:L340]; with core at 3.7.0 that means 3.8.0.
- **Commit convention.** Conventional commits with a package scope that may be omitted when a change belongs to no package [CONTRIBUTING.md:L352-L388], so a commit adding this document is a documentation-type commit with no scope.
### C.2 Engines, runtimes and verification

- **Supported versus continuously verified database engines.** The four engines exercised by the core end-to-end matrix, with their exact point-in-time versions and job locators: an in-memory engine with no service container [.github/workflows/build_and_test.yml:L174-L201, `DB: sqljs`]; `mariadb:11.5` [.github/workflows/build_and_test.yml:L213]; `vendure/mysql-8-native-auth:latest`, a native-authentication image of MySQL 8 rather than the upstream `mysql:8` [.github/workflows/build_and_test.yml:L249]; and `postgres:16` [.github/workflows/build_and_test.yml:L285]. Each of the four jobs runs `redis:7.4.1` as a cache service, deliberately duplicated because the workflow language supports no reuse [.github/workflows/build_and_test.yml:L26-L31, L183, L220, L256, L293]. The runtime matrix is `20.x`, `22.x` and `24.x` [.github/workflows/build_and_test.yml:L97], narrowed to `22.x` alone on a pull request [.github/workflows/build_and_test.yml:L188], with `22.x` the default and the package manager pinned to `1.3.10` [.github/actions/setup/action.yml].
- **The file-backed engine, stated narrowly.** A file-backed engine is a declared dependency of core [packages/core/package.json] and is named explicitly in stored-shape registration, which suppresses a precision option for it and for the in-memory engine [packages/core/src/entity/register-custom-entity-fields.ts:L87-L94], **yet no initialiser is registered for it in the core end-to-end configuration**, which registers exactly four — in-memory, Postgres, MySQL and MariaDB [e2e-common/test-config.ts:L32-L35]. The correct claim is therefore narrow: it is absent from *that* matrix. It is not untested in the repository. It backs the development server [packages/dev-server/dev-config.ts:L228], the command-line end-to-end harness and its fixtures [packages/cli/e2e/cli-test-utils.ts:L69], the diagnostic command's tests [packages/cli/e2e/doctor-command.e2e-spec.ts:L93-L96], real migration runs [packages/cli/e2e/migrate-command.e2e-spec.ts:L199-L227] and the scaffolder's unit tests, one of which is named for it [packages/create/src/helpers.spec.ts:L423-L429]. So what cannot be claimed is its behaviour under *this* capability's new persisted writes, because the suite that would show that does not run against it.
- **Cached seed data.** Seed data is cached per package and must be deleted to reset after any change to stored shape [AGENTS.md:§Testing].

### C.3 What validates this document, and what does not

- **No continuous-integration job validates this document's path.** The build workflow's change-detection job sets its gate only when a changed path matches the packages directory, the root manifest, the lockfile or the runtime configuration [.github/workflows/build_and_test.yml:L60], and every substantive job is conditioned on that gate; a change confined to this directory therefore skips them all, while the aggregate gate still passes because a skipped job is neither a failure nor a cancellation [.github/workflows/build_and_test.yml:L313-L331]. The documentation workflow triggers only on the documentation tree, excluding its compiled manifest, plus the monorepo version file [.github/workflows/docs_ci.yml:L9-L12, L18-L21]. Validation of this file was consequently local and self-reported, with the results stated in the body.
- **No prose or Markdown linter exists.** The staged-file lint configuration covers only TypeScript and HTML [.lintstagedrc.json], the formatter is not wired to Markdown [.prettierrc], and all repository hooks are large-file-storage shims. There is therefore no linter to run against this file, and none was added.
- **Existing benchmark and load tooling.** Precisely stated, because the naive claim that "one benchmark exists and it targets search" is wrong. **Automated:** exactly one benchmark *specification* exists and it targets search [packages/core/e2e/default-search-plugin.bench.ts], with its runner configuration alongside [e2e-common/vitest.config.bench.ts]; those are the only two files matching the benchmark naming convention anywhere in the tree. **Not automated, but present:** an order and product benchmark harness aimed at a known list-performance issue, seeding a thousand products and ten thousand orders [packages/dev-server/load-testing/benchmarks.ts:L22-L37]; a continuous add-to-cart load script [packages/dev-server/load-testing/scripts/add-to-cart-perf-benchmark.js:L5-L20]; an order-list throughput script whose own comment calls it a baseline measurement [packages/dev-server/load-testing/scripts/bm-order-list.js:L20-L28]; and six further load scripts [packages/dev-server/load-testing/scripts/]. Their storefront documents cover adding to an order, adjusting a line, completing an order, searching and deep querying [packages/dev-server/load-testing/graphql/shop/], with administration documents alongside [packages/dev-server/load-testing/graphql/admin/]; a summariser computes percentiles over a run [packages/dev-server/load-testing/generate-summary.ts:L29-L30]. **No result is committed:** the results directory holds only a placeholder [packages/dev-server/load-testing/results/.gitkeep]. So benchmark *code* for order and cart paths does exist; what does not exist is any automated benchmark of them and any recorded baseline — which is the claim the body makes.
### C.4 Support policy and known upstream defects

- **Support policy, which is not a performance target.** Supported version lines are declared as a support policy [SECURITY.md], and it is named here only to forestall its being mistaken for a service-level commitment.
- **Known upstream defects affecting sequencing.** **Two were established, and they are not incidental.** The patch release published after this checkout fixes a broken-access-control defect in the administration mutation that adjusts a draft order line — reachable by unauthenticated callers, who could alter quantities and custom fields on orders they did not own — and a cross-channel write defect, with channel-scope guards added to further update and delete paths. Both sit on the two mechanisms this capability depends on most, order-line mutation authorization and channel scoping. The consequences for sequencing are concrete: upgrade past the analysis basis before implementation begins, and review every new order-line and reporting operation against those two failure modes. Advisory references and dates are under *Research evidence — published sources*. This entry replaces an earlier negative statement that no such defect existed, which was wrong.

### C.5 Research evidence — published sources

This class is kept separate from repository citations because it describes the vendor's published position rather than the contents of this checkout, and it is the **only** class that is not verifiable from the working copy. Each item carries a complete source reference, the source's own publication date where the page states one, and a retrieval date of 13 August 2026.

- **The published line is two patch releases ahead of this checkout.** The latest release is **v3.7.2, published 3 August 2026**, above v3.7.1 of 14 July 2026 and v3.7.0 of 1 July 2026; this checkout is pinned at 3.7.0 with a head commit dated 6 July 2026, so the analysis basis sits **two patch lines behind**. Sources: https://github.com/vendurehq/vendure/releases/tag/v3.7.2 (release notes for v3.7.2, 3 August 2026) and https://docs.vendure.io/changelog (changelog index, retrieved 13 August 2026).
- **Two of that release's security fixes bear directly on this work, so the earlier "no upstream defect" negative is withdrawn.** The v3.7.2 notes publish four advisories. Two are relevant here. First, a **high-severity broken-access-control fix**: the administration mutation that adjusts a *draft* order line was reachable by unauthenticated callers, who could change line quantities and custom fields on orders they did not own (advisory GHSA-hc75-2v4j-x372). Second, a **medium-severity cross-channel write fix** in the same release, alongside channel-scope guards added to further entity update and delete paths (advisory GHSA-rgjm-ff27-p2hf; pull requests 5017 and 5043). Both touch exactly the two things this capability leans on — order-line mutation authorization and channel scoping — so **upgrading past 3.7.0 is a precondition of implementation, not an afterthought**, and any new order-line or reporting operation must be reviewed against the same two failure modes. Source: https://github.com/vendurehq/vendure/releases/tag/v3.7.2 (3 August 2026).
- **Additive custom fields change existing operation signatures — the second, independent proof.** The vendor's custom-fields documentation states that defining custom fields on the order-line entity gives the storefront's add-item mutation a third input argument, `customFields`, and likewise gives the adjust-line mutation a third input argument, with equivalent input changes on the administration mutations for draft orders and order modification; and that defining them on the order entity gives the administration's modify-order mutation a `customFields` field on its input object. Source: https://docs.vendure.io/guides/developer-guide/custom-fields (retrieved 13 August 2026). Together with the source-level proof under *Constraint collisions found in this repository*, this finding has two independent proofs, which is materially stronger than either alone.
- **Versioning policy, and the schema-change nuance.** The updating guide states that semantic versioning is generally followed, so breaking API changes arrive only with a major version, and that minor versions may occasionally introduce non-destructive changes to the database schema. It further states as a key rule that a production instance must never be run with the schema synchronisation option enabled, since doing so can cause inadvertent data loss in rare cases. Source: https://docs.vendure.io/guides/developer-guide/updating (retrieved 13 August 2026). The synchronisation prohibition is carried into the body's reversibility finding.
- **Release cadence, which bounds the sequencing.** The vendor's release-strategy post commits to monthly patch releases — up to twelve a year — and quarterly minor releases, four a year, described as giving predictable upgrade windows. Source: https://vendure.io/blog/updating-our-release-strategy (published 27 October 2025, retrieved 13 August 2026). **Effect on sequencing:** the capability phases in the body are ordered by dependency, not by calendar, but this cadence is the real constraint on when a phase can land on a supported line — a new public interface targets the next minor line, so a phase that misses one window waits for the next. These are the vendor's figures for the vendor's own process; they are **not** adopted as a target of this initiative, and no phase in the body is dated.
- **Organisation modelling is on the published roadmap, but as a commercial layer — this qualifies the deferral.** The vendor's 2026 technical roadmap describes business-to-business commerce as happening between organisations with complex internal structures, and companies, divisions, buying groups and their relationships as modelled natively, as the foundation powering quotation and approval features, together with a request-for-quote flow and approval workflows with spend thresholds and escalation. **Critically, the same page states that the open-source core is the foundation and that the enterprise capabilities ship as a set of proprietary modules integrating with it through the same plugin and extension mechanisms.** The vendor's platform pages already list reorder from a past order and saved lists shared across an organisation among those commercial capabilities. Sources: https://vendure.io/blog/vendure-technical-roadmap-2026 (published 26 February 2026) and https://vendure.io/product/platform/plugins (retrieved 13 August 2026). **Effect on the deferral:** waiting for the roadmap is therefore waiting for a *licensing decision*, not for open-source core to grow the construct. The body's deferral is written accordingly — it names a decision the Product Owner can take now, rather than an indefinite wait on a repository that may never carry the construct.
- **Requirements-traceability practice, which is why this register is shaped as it is.** Published engineering-handbook guidance on traceability data calls for a unique identifier for each requirement, so that elements are clearly identifiable and distinguishable, and for no "holes" in the trace; its companion guidance on bidirectional traceability calls for capturing the source of each requirement — the parent identifier or document — and for a chain traceable both forward and backward, with orphan elements discussed rather than left silent. Sources: https://swehb.nasa.gov/display/SWEHBVB/SWE-047+-+Traceability+Data and https://swehb.nasa.gov/spaces/SWEHBVC/pages/50888903/SWE-052+-+Bidirectional+Traceability (both retrieved 13 August 2026). **Effect on editability:** this is the external warrant for three of the body's editing rules — a stable identifier on every requirement, exactly one stated origin per requirement, and dependencies written as identifier references so a deleted row leaves a visible hole rather than a silent one. It is also why the two requirements belonging to no journey are named explicitly instead of being left as orphans.
- **Nothing was dropped for want of a source.** Every published claim this analysis relied on is listed above with a resolvable reference. An earlier draft recorded that one claim had been dropped without naming it; that statement is withdrawn, because no such claim remains.

#### The four contradictions the body reports but does not correct

Each is reported rather than corrected, because correcting it would mean editing a file outside this document's scope; none of the four contradicted statements is asserted anywhere in this document.

1. **A documentation framework named but absent.** The contribution guide names a framework and describes directories built by it [CONTRIBUTING.md:L488], yet no configuration or dependency for it exists anywhere in the repository — a filename search returns nothing and a content search finds no reference outside that guide. The actual mechanism is a manifest-provider package [docs/package.json] consumed by a manifest source file [docs/src/manifest.ts] and compiled to a committed artifact [docs/manifest.json].
2. **A repository address the manifests contradict.** The documentation package's readme links to a different repository address than the one declared in the root and core manifests [docs/README.md].
3. **Any stored-shape change classed as breaking.** The contribution guide defines a breaking change to include "any changes to the DB schema" and routes such contributions to the major branch [CONTRIBUTING.md:L390-L392]; the vendor's published policy permits non-destructive schema additions on a minor line. Both readings are set out below.
4. **Decimal money.** The money column type comes from a configurable strategy whose default declares an integer column with two-decimal precision and integer rounding [packages/core/src/config/entity/default-money-strategy.ts:L14-L22], and payment amounts use the same decorator [packages/core/src/entity/payment/payment.entity.ts:L28]. Any claim that payment amounts are decimal money is therefore wrong for this platform's default.

#### Where the two evidence classes disagree

Exactly two disagreements were found. Both are reported side by side and **neither is adopted**.

- **Is an additive change to stored shape breaking?** This repository's contribution guide says yes, classing any database schema change as breaking and routing it to the major branch [CONTRIBUTING.md:L390-L392]. The vendor's published updating guide says minor versions may occasionally introduce non-destructive schema changes, describing the addition of a column as minor and non-destructive with no risk of data loss. A reader planning a release needs both readings, because the stricter one governs contribution to this repository while the softer one describes what consumers are told to expect.
- **Which documentation framework does this project use?** The repository's own answer and the framework's absence from the tree are set out as the first of the four contradictions above; the disagreement is recorded here because it is a disagreement between what the project says of itself and what it contains, and neither reading is adopted in this document.
