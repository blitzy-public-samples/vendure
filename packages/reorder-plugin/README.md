# Vendure Reorder Plugin

Adds named reorder lists carrying a per-line quantity to the Vendure Shop API, so a returning buyer can curate a reusable purchase list instead of rebuilding one from search results.

## Installation

```bash
npm install @vendure/reorder-plugin
```

### Platform version, and what the compatibility range does and does not say

The plugin declares `compatibility: '>=3.3.0'`. That is a statement about **what it is built
against** — which Vendure versions it will boot on — and the platform enforces it by refusing to
start a server below the floor. It is **not** a statement that every version at or above the floor
carries current security fixes, and no value in that field could make it one, because the check only
looks downwards.

Choose the platform version by Vendure's own release and advisory notes, not by this range. This
package is developed against Vendure **3.7.0**, and Vendure's **3.7.2** patch release fixes four
reported vulnerabilities affecting 3.7.0 — one critical, one high and two medium — alongside
channel-scoping fixes on entity update and delete paths. **Run 3.7.2 or later.** None of those
defects is in this plugin and none of them is reachable through its eight operations, but they are
reachable through the platform's own pre-existing routes in the same server, so the version you
deploy on is what decides your exposure to them.

The floor is deliberately left at the 3.3 line rather than narrowed to exclude the affected
releases: narrowing it would refuse to boot on the whole 3.3–3.7.1 range, which is a support-policy
decision for the maintainers rather than a change this package should make on its own.

**The plugin also says this at run time, not only here.** During bootstrap it writes one `warn` line
under the `ReorderPlugin` log context unless the platform it is running on is a release known to carry
the fixes. It reads the platform's own `VENDURE_VERSION`, so it reports the server it is in rather than
whatever a manifest says. A document is read once, by whoever installs the package; a deployment that
inherits an old platform months later has nothing telling it so, and the compatibility range cannot,
because that mechanism only refuses versions below its floor.

It says only what the version establishes, which is three different things and not one:

| Running version                            | What the line says                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Below 3.7.2 — e.g. `3.7.0`                 | The release is affected by the four advisories, named individually.                                                 |
| A pre-release of 3.7.2 — e.g. `3.7.2-rc.1` | Semantic versioning orders it **before** 3.7.2, so it is **not established** that the build carries all four fixes. |
| Not a valid version — e.g. `03.8.0`        | The posture **could not be determined** and must be checked by hand.                                                |
| 3.7.2 or later, including `3.8.0-alpha.2`  | Nothing. A pre-release of a later release still orders above 3.7.2, so it carries the fixes and produces no line.   |

The middle two matter because the alternatives are both dishonest: calling an unreadable version
affected asserts a vulnerability from ignorance, and calling it fixed asserts safety from the same
ignorance. Build metadata is ignored, as semantic versioning requires — `3.7.2+build.5` is `3.7.2`,
and `3.7.2+0.build.01` is too, since build identifiers may carry leading zeros.

The version is checked against the **full Semantic Versioning 2.0.0 grammar** before any comparison,
because precedence is only defined between two valid versions. That is not pedantry: `03.8.0` is not a
version, but a permissive `major.minor.patch` shape reads it as major 3 — _later_ than the floor — and
so goes quiet. The same is true of `3.8.0-..` and `3.8.0+.`, which carry empty identifiers the
specification forbids, and of `3.7.2-01`, whose numeric pre-release identifier may not carry a leading
zero even though a build identifier may. Every one of those becomes "could not be determined", which
speaks, rather than "fixed", which does not.

The line is a **warning and never a refusal**: a plugin that declined to start over its host's patch
level would convert a documented risk into a certain outage and would take an availability decision
belonging to the deployment. It also states in terms that the defects are the platform's and are
neither introduced nor fixable by this plugin, so it cannot send an investigation to the wrong place.

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

**Each call to `init()` returns a registration bound to the values that call resolved.** If one
process holds two servers — a multi-tenant host, or a test file that builds two configurations
before booting either — each server enforces the bounds its own `init()` was given, whichever
order they were created and booted in. `ReorderPlugin.options` remains readable and reports the
most recent initialisation; the set a particular server is serving with is the one injected into
its own providers.

## Database migration

The plugin registers two new database entities of its own — `ReorderList` (table `reorder_list`)
and `ReorderListLine` (table `reorder_list_line`). It adds no column, relation or custom field to
any core entity, so the schema change is purely additive — but the two new tables still have to be
created, so after adding the plugin to your configuration you must register and run the migration this
package ships before the new operations will work.

The plugin ships that migration. It is compiled into the published package at
`lib/src/migrations/`, and lives at `src/migrations/` in a source checkout. The supported way to
register it is by value, from the package root:

```ts
import type { VendureConfig } from '@vendure/core';
import { reorderPluginMigrations } from '@vendure/reorder-plugin';

export const config: VendureConfig = {
    dbConnectionOptions: {
        // ...
        migrations: [
            // ...your own migrations
            ...reorderPluginMigrations,
        ],
    },
};
```

Registering the classes rather than a path is what makes one registration correct in both layouts this
package runs in: TypeORM accepts a migration class wherever it accepts a glob, and a class is resolved
by the module system, so no path arithmetic over `src/` versus `lib/src/` is needed. A deployment that
prefers globs can name the emitted files instead, and one pattern serves both layouts:

```ts
import path from 'path';

const reorderPluginRoot = path.dirname(require.resolve('@vendure/reorder-plugin/package.json'));

// Equivalent to the above; prefer the class registration unless your tooling needs a path.
const migrationGlob = path.join(reorderPluginRoot, 'lib/src/migrations/*.js');
```

Then apply it with the platform's own migration lifecycle — `runMigrations` to apply and
`revertLastMigration` to reverse — as described in the
[Vendure migrations guide](https://docs.vendure.io/guides/developer-guide/migrations/). Rolling back is
a separate, deliberate operation rather than the next line of the same script: `revertLastMigration`
reverses whichever migration was applied most recently, so it removes these two tables only while this
one is the last applied.

### The order this migration expects

Its two tables reference `customer`, `channel` and `product_variant`, so those must already exist when
it runs. On a database that is provisioned by migrations end to end — which is what a production
deployment should be — the order is simply:

1. Apply your own migrations, so the core schema is in place.
2. Apply this plugin's migration, which creates `reorder_list` and `reorder_list_line`.
3. Boot the server with `synchronize` off, so nothing else can alter the schema behind the migration
   history.

Against a **synchronization-driven** database the order is not available, and this is worth stating
plainly rather than leaving to be discovered. A connection with `synchronize: true` lets the schema
builder create these two tables from the entity metadata, after which running the migration will
verify that schema and record itself as applied rather than create anything. That is a supported
outcome — the migration checks the tables it finds against its own frozen minimum and refuses if they
fall short of it — but the schema builder, not the migration, is what authored them. Do not mix the two
in one startup sequence: a migration run that precedes schema creation cannot succeed, and
`runMigrations` reports such a failure by setting `process.exitCode` rather than by throwing, so a
startup chain that ignores the exit code will carry on and synchronize regardless.

`packages/dev-server` in this repository is exactly such a synchronization-driven harness — it ships no
core migrations of its own — so it registers this plugin's migration only for the migration commands
and never for a server boot or a population run. Making that harness migration-owned end to end would
mean authoring core migrations for it, which are files outside this package and therefore outside what
this change may add; the harness's synchronization-driven boot is its own long-standing design and is
left as it is.

The three-step order above is not only documented, it is **executed**: an end-to-end test drops the
tables synchronization created, applies this migration with `synchronize` off, and then drives
`createReorderList`, `addItemToReorderList` and `activeCustomerReorderList` over a Shop API whose
connection can no longer create anything — so what those operations run against is provably the
migration's own output. It runs on PostgreSQL, MySQL, MariaDB and sql.js alike.

**The migration is engine-portable, and no SQL appears in it.** Rather than carrying the DDL of one
engine, it describes the two tables it creates and hands that description to the same query-runner
API the platform's schema builder uses, which renders the right DDL for PostgreSQL, MySQL, MariaDB
and the SQLite family. It also honours a configured non-default database schema in both directions.
You do not need to generate a migration of your own for these two tables.

**The description is frozen in the migration itself, not read from the entity classes.** Every table,
column, width, named unique, named index, named check constraint and cascading reference is written
out as a literal in the file, so what the migration creates is fixed at its own timestamp and cannot
drift when a later release adds a column to one of these entities — that column belongs to that
release's own migration. Only three things are resolved when the migration runs, because only three
depend on the deployment rather than on the schema: the identifier columns' physical type and
generation strategy, taken from the platform's own `Customer.id`, which these tables reference; the
inherited `createdAt` / `updatedAt` type, precision and default, taken from the driver's declaration
of them; and the qualified table names, built through the driver so a configured schema is honoured.

Because of that, running the migration against a database whose tables already exist does not
silently adopt them. It compares what it finds against a **frozen minimum** and refuses to be recorded
as applied if anything falls short of it, naming each shortfall.

What that minimum covers: every frozen column, with every attribute the engine reports for it — type,
declared and display width, precision, scale, default, character set, collation, nullability,
membership of the row identifier, generation and identity generation, generated expression and
storage, scalar-versus-array value shape, signedness, zero fill, enumerated members and type name, and
spatial type and reference identifier; every named unique by its subject and its deferrability; every
named index by its ordered subject, its uniqueness, its partial-index predicate, its spatial,
full-text and null-filtered kinds and its full-text parser; every named check by its condition; and
every reference by its name, its leaving columns, its target table and columns, both referential
actions, its deferrability and the schema and database its target sits in.

**Deferrability is read from each engine's own catalogue, not from TypeORM's table view.** It deserves
its own note because it is the one property where "TypeORM reported nothing" and "the engine holds
nothing" are different facts, and treating them as one would let a real deferred constraint pass. Two
gaps in TypeORM 0.3.x make that concrete: the SQLite family _writes_ a reference's `DEFERRABLE` clause
into the table definition it stores and has no loader that reads it back, and PostgreSQL's unique
loader reads deferrability fields that its own constraints query never selects. So on those two, a
genuinely deferred constraint is invisible to the generic view.

The migration therefore consults the engine directly, and what it can establish is different per engine
because the engines themselves are different — each of these was measured, not cited:

| Engine          | Where a deferred constraint can exist                                                                                                 | How the migration establishes it              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| PostgreSQL      | references and uniques                                                                                                                | `pg_constraint.condeferrable` / `condeferred` |
| SQLite family   | references (a unique admits no such clause)                                                                                           | the definition stored in `sqlite_master`      |
| MySQL / MariaDB | neither — the grammar refuses the clause outright, answering `ER_PARSE_ERROR`, and the driver has no notion of it in either direction | nothing to establish                          |
| anything else   | unknown                                                                                                                               | **refused** rather than assumed immediate     |

That last row is deliberate. On an engine this package makes no claim about, an existing table is not
recorded as this migration's work at all, because there is no way to show its constraints fire when the
plugin's error handling needs them to. A fresh database is unaffected — the check runs only where a
table of the name already stands.

It matters rather than being a curiosity: a deferred constraint is checked at `COMMIT` instead of at the
statement, so a deferred unique moves the violation past the `catch` that turns
`UQ_reorder_list_customer_channel_name_key` into `ReorderListNameConflictError`, and a deferred cascade
lets a parent delete and its child cascade sit apart until commit.

The evidence is split accordingly, and the split is worth knowing if you read the suite. Cases that
genuinely defer a live constraint and then read the engine back cover PostgreSQL for both classes and
the SQLite family for references; a further case removes the catalogue reading entirely to show an
unanswerable question is refused rather than defaulted. Cases that hand a deferred reading to the
comparator cover the same code path on MySQL and MariaDB, where no live deferral is possible to create —
those are evidence about the comparison, not about a live schema, and the suite says so.

What it deliberately tolerates: a **surplus**. An extra column, index, constraint or reference belongs
to a later migration, or to a newer entity synchronised into the same table, and is not this
migration's business — so the check is "does the table carry everything this timestamp created, as this
timestamp created it", not "is the table identical to what this timestamp created".

What it excludes, and why: a column's `ON UPDATE` clause, which two of the four engines do not report
at all; a column's comment, which the SQLite family reports as an empty string and which changes
nothing about the stored value; a column's single-column uniqueness flag, since both uniques here are
composite and are checked as named objects; an index's "built concurrently" flag, which describes the
statement that built an index rather than the index itself and which no engine stores; and named check
constraints on MySQL and MariaDB, where TypeORM never created them — see the limitation note below.
Those four are the whole of the exclusion list: every other property TypeORM reports for a column,
unique, index, check or reference is compared.

One documented limitation, on the MySQL family only: TypeORM 0.3.x cannot create `CHECK`
constraints there and discards them silently, so the two named check constraints on these tables are
created on PostgreSQL and the SQLite family and **not** on MySQL or MariaDB. Nothing stops you
provisioning them yourself on those two engines — the plugin's own existing-table check tolerates
objects it did not create — but this plugin will not create them and does not look to see whether you
have. The two named unique constraints and the named index do exist on all four engines (the MySQL
family stores each unique constraint as a named unique index, keeping both the name and the
guarantee).

**What still holds on every engine, and what does not.** Both invariants the missing constraints
express are enforced twice over by the plugin, and neither enforcement depends on a check
constraint existing:

- `quantity` — every request that could set it validates the **resulting** value first and refuses a
  non-integer, a non-positive value or one above `maxQuantityPerLine` with a top-level
  `USER_INPUT_ERROR` before any write. One of the three writes additionally carries the bound **in the
  statement's own `WHERE`**: the accumulating add is predicated on
  `quantity <= maxQuantityPerLine - increment`, so the database itself declines the write when the
  resulting value would breach it. The other two — the insert of a new line, and the absolute set of
  `adjustReorderListLine` — carry ownership and identity conjuncts only, so on those two paths the
  in-process guard is what refuses a bad value and the check constraint is what would have stood
  behind it.
- `lineCount` — it is written only by three guarded statements: an increment predicated on
  `lineCount < maxLinesPerList`, a decrement predicated on `lineCount > 0`, and a compare-and-set
  repair predicated on the row and its stale counter. The floor is therefore in the decrement's own
  predicate, evaluated by the database, on all four engines; on the repair path it is an in-process
  guard, which refuses any total that is not a non-negative safe integer before the statement is
  built.

What is genuinely lost on MySQL and MariaDB is therefore two things. First, the last line of defence
against a write that does not go through this plugin at all — direct SQL against these two tables,
another application sharing the schema, or a future code path that bypasses the service. Second, on
the three paths whose statements carry no value predicate (the line insert, the absolute quantity
set, and the counter repair), the database-side backstop behind the in-process guard. On PostgreSQL
and the SQLite family both are present; on MySQL and MariaDB such a write is accepted, and a
non-positive `quantity` or a negative `lineCount` can be persisted. If you share this schema with
anything that writes to `reorder_list` or `reorder_list_line` directly, treat those two invariants as
that writer's responsibility on those engines. This gap is tracked as conflict **C-E** and is
**unresolved**: closing it needs a maintainer ruling, because the only mechanism available on those
engines is engine-specific DDL added to the migration by hand, which the project's own migration
policy forbids. See the plugin's migration end-to-end suite, which states the conflict in full and
asserts the gap positively rather than skipping over it.

**The plugin says this at run time too, on the engines where it applies.** Booting on MySQL or MariaDB
writes one `warn` line under the `ReorderPlugin` log context, naming both constraints exactly and
attributing the shortfall to the object-relational mapper rather than the engine, which supports them.
It states the consequence in the terms that matter — everything the plugin serves is still guarded, and
what is missing is the backstop against a write that does not come through the plugin. The reason it
exists is that the person who later points a reporting job or a repair script at these tables is
usually not the person who read this file, and the schema does not tell them.

It reads the configured engine type, issues no statement of any kind, and never refuses to start. That
also bounds what it is entitled to claim: engine type establishes what the mapper does, not what is in
your catalogue, so the line says the constraints are absent **unless something outside this plugin
provisioned them** and says outright that it did not look. If you provisioned them yourself they are in
force and the line does not apply to you.

That mechanism was built and measured against MySQL 8.0.43 and MariaDB 11.5.2 before being withdrawn,
and the migration's own header records what a ruling on it would have to weigh, so the decision can be
taken on facts rather than re-measured. In short: the frozen conditions cannot be reused verbatim,
because both engines accept an ANSI-quoted `CHECK` and then read the quoted column as a _string
literal_, producing a correctly named constraint that refuses every valid row; a check can be present
and inert on MySQL, which records `NOT ENFORCED` while still reporting the original condition, in a
column MariaDB does not have at all; and covering the `synchronize` provisioning path as well as the
migration means the plugin issues `ALTER TABLE` while starting up, so a deployment whose database user
lacks `ALTER` either fails to boot or continues silently without the constraint. **A plugin should not
make that availability decision about someone else's deployment on its own authority**, which is why
this package ships the documented gap rather than the unsanctioned mechanism.

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

## Concurrency, and one engine difference worth knowing

Every mutation runs in one transaction and takes the list row before any line row, so two requests
against one list cannot deadlock by approaching the two rows in opposite orders. A request that will
write only a line — adding to an existing line, or adjusting one — holds the list row in **shared**
mode, which lets two such requests proceed together and meet at the line row, where an accumulation
is a single `quantity = quantity + n` evaluated by the engine and therefore loses no update.

**On MySQL and MariaDB that same request holds the list row exclusively instead, so two of them
against one list serialise.** The reason is measured rather than precautionary: with the shared mode
there, two accumulations onto one line deadlock at the line row if that line is removed beneath them,
and because Vendure runs each service transaction as a savepoint inside the resolver's transaction, an
InnoDB deadlock destroys that savepoint and surfaces as an unrecoverable error rather than as the
retriable deadlock it is. Serialising the pair prevents the cycle. The effect is a small loss of
concurrency between two line writes on the same list on those two engines, and nothing else: the
arithmetic, the bounds and every published result are identical on all four engines.

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
