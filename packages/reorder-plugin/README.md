# Vendure Reorder Plugin

Adds named reorder lists carrying a per-line quantity to the Vendure Shop API, so a returning buyer can curate a reusable purchase list instead of rebuilding one from search results.

## Installation

```bash
npm install @vendure/reorder-plugin
```

## Usage

Add the plugin to the `plugins` array of your `VendureConfig`:

```ts
import { VendureConfig } from '@vendure/core';
import { ReorderPlugin } from '@vendure/reorder-plugin';

export const config: VendureConfig = {
    // ...
    plugins: [
        // ...
        ReorderPlugin.init({
            maxListsPerCustomer: 25,
            maxLinesPerList: 200,
            maxQuantityPerLine: 999,
            defaultReorderListsPageSize: 25,
            defaultReorderListLinesPageSize: 50,
        }),
    ],
};
```

Import `ReorderPlugin` from the package root, as above, rather than from a path inside the
package.

Every option is optional and any key you omit takes its documented default, so
`ReorderPlugin.init({})` is a valid call that yields exactly the defaults in the table below.
Whatever you do supply is still checked: all five values are validated once, at plugin
initialisation rather than at request time, and a malformed value **fails plugin initialisation
with a named configuration error identifying the offending key**. A bound that silently degraded
to "admit everything" would be worse than no bound at all, because nothing would fail while the
guarantee was gone.

## Database migration

The plugin registers two new database entities of its own — `ReorderList` (table `reorder_list`)
and `ReorderListLine` (table `reorder_list_line`). It adds no column, relation or custom field to
any core entity, so the schema change is purely additive — but the two new tables still have to be
created, so after adding the plugin to your configuration you must generate and run a migration
before the new operations will work.

The plugin ships the migration for its own tables under `src/migrations/`. No SQL is reproduced
here on purpose: generated migration SQL is specific to the database engine it was generated
against, so a single migration file is not portable across engines and yours should be generated
against the engine you actually deploy on. See the
[Vendure migrations guide](https://docs.vendure.io/guides/developer-guide/migrations/) for the
generate-and-run workflow.

## Options

| Option                            | Type                                                                                  | Default | Enforced at                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `maxListsPerCustomer`             | `number` — integer, finite, at least 1                                                | `25`    | `createReorderList`, under a pessimistic row lock on the owning customer                                     |
| `maxLinesPerList`                 | `number` — integer, finite, at least 1                                                | `200`   | `addItemToReorderList` only — **not** `adjustReorderListLine`, which cannot breach a line-count bound        |
| `maxQuantityPerLine`              | `number` — integer units, finite, at least 1, no greater than a signed 32-bit integer | `999`   | `addItemToReorderList` and `adjustReorderListLine`, applied to the **resulting** quantity, not the increment |
| `defaultReorderListsPageSize`     | `number` — integer, finite, at least 1                                                | `25`    | The `take` applied to `activeCustomerReorderLists` when a caller supplies none                               |
| `defaultReorderListLinesPageSize` | `number` — integer, finite, at least 1                                                | `50`    | The `take` applied to `ReorderList.lines` when a caller supplies none                                        |

Both page-size defaults sit below the platform's own `apiOptions.shopListQueryLimit`, which
defaults to `100`. The plugin never bypasses that limit, so a caller asking for more rows than the
Shop API permits is refused by the platform exactly as it would be on any other paginated query.

There is deliberately no `maxListNameLength` option. The 191-character bound on a list name is a
fixed constant, because it is a key-size constraint on a `varchar(191)` column that participates in
a composite unique index on the MySQL and MariaDB engines — not a product choice about how long a
list name ought to be. Making it configurable would offer exactly one legal value and give a
deployment a way to break itself.

## Shop API operations

Two queries and six mutations are added to the Shop API. Every existing operation keeps its exact
signature; nothing is changed or removed.

Queries:

- `activeCustomerReorderLists` — a paginated page of the authenticated customer's lists in the active channel.
- `activeCustomerReorderList` — one list addressed by id, or `null` if there is no such list the caller may read.

Mutations:

- `createReorderList` — creates an empty list under a name.
- `updateReorderList` — renames an existing list.
- `deleteReorderList` — deletes a list together with its lines.
- `addItemToReorderList` — adds a product variant with a quantity, accumulating onto the existing line when the list already holds that variant.
- `adjustReorderListLine` — sets an existing line's quantity to an absolute value.
- `removeReorderListLine` — removes a single line from a list.

Field-by-field types are not reproduced here; the schema published by the plugin is the
authoritative description, and you can read it through introspection or GraphiQL against a running
server.

The two fields that return a page — `activeCustomerReorderLists` and the nested `ReorderList.lines`
— each accept the standard `options` argument the platform generates for every paginated list, so
`skip`, `take`, `sort` and `filter` behave as they do elsewhere in the API. Default sorting is a
total order — lists newest-first, lines oldest-first, each tie-broken by identifier — so paging
forward over rows sharing a timestamp will not show you the same row twice or skip one. When you
supply your own `sort`, the identifier tie-break is appended to it rather than replacing it.

There is no idempotency key on `addItemToReorderList`, and its absence is deliberate rather than an
oversight: delivery is at-least-once, so two deliveries of one add will accumulate.
`adjustReorderListLine` is the deterministic remedy, because it sets an absolute quantity instead
of adding to one.

## Access control

Access is ownership-based. Every one of the eight operations is scoped to the customer resolved
from the authenticated session and to the channel resolved from the `vendure-token` header, and
that check is applied before any row is read or written. A list belonging to another customer, or
created under a different channel token, is never returned. The single-list read answers every one
of those cases the same way — an unknown id, another customer's list and another channel's list all
resolve to `null` rather than to a distinguishable error — so it discloses nothing about whether a
given list exists.

Ordinary customer sessions can use all eight operations. The plugin registers no custom permission
and adds no custom field to any core entity, so nothing needs to be granted to a role and the
published `Permission` enum is unchanged.

## Errors

Error results carry the data a client needs to act on rather than a message to be string-matched:
`ReorderListNameConflictError` reports the canonical `conflictingNameKey` that collided, and
`ReorderListLimitError` reports the breached maximum as `maxItems`. `ReorderListNotFoundError` and
`ReorderListLineNotFoundError` cover a list or line that is not there for this caller.

Malformed input is not a domain outcome and is not returned as a union member. An empty or
over-long list name, and a quantity that is non-positive or would exceed `maxQuantityPerLine`,
arrive as a single top-level `errors` entry whose `extensions.code` is `USER_INPUT_ERROR`, with
`data` null and no row written.

The plugin registers four `error.*` message keys from its own `i18n/en.json`, which is published
with the package. To translate them, or to override the English wording, register your own
translation resource for the same keys.

## List names

A list name is stored after whitespace canonicalisation only — surrounding whitespace removed and
internal runs of whitespace collapsed to a single space. Nothing else is altered: the name is
neither escaped, stripped nor entity-encoded at rest, so reading it back returns the string you
submitted, byte for byte. Uniqueness is enforced per customer and channel by a database constraint
over a canonicalised form of the name, which makes the comparison case-insensitive but
accent-preserving, so `Café` and `Cafe` remain two distinct lists.

Because the stored name is buyer-supplied free text that is returned verbatim, it is data rather
than markup, and a consumer that displays it is responsible for escaping it on output.

## Sharing

**Sharing is not implemented in this release.** The shape of it is published so that adding it
later needs no change to the contract: both read queries accept `includeShared: Boolean = false`,
and `ReorderList.viewerAccess` reports `access: OWNED` with an empty `grantedCapabilities` list.
Passing either value of `includeShared` is accepted and returns the same page, because the shared
set is empty by construction. Treat `grantedCapabilities` as always empty for now.

## Data lifecycle

The plugin's only lifecycle behaviour is a database cascade: a list's rows are removed when the row
they reference is removed, and deleting a list removes its lines. Note that this is a hard-delete
cascade, and that deleting a customer through the platform is a _soft_ delete — so it does not fire,
and a soft-deleted customer's list rows persist. This plugin ships no retention, anonymisation or
purge behaviour of its own to remove them.
