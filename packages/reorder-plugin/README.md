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

This is stated here, in the package's own documentation, and deliberately nowhere else. The plugin
writes no boot-time `warn` line naming the four advisories and the release that fixes them, and that
silence is a decision rather than an omission: a hardcoded advisory list and version floor inside a
feature plugin has no way to refresh itself, so it would eventually tell an operator something that
had stopped being true, and a plugin's bootstrap log is not where a platform's patch posture
belongs. Follow Vendure's own release and advisory notes, which are current by construction.

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
Whatever you do supply is checked before a request can ever reach it, never at request time, and a
malformed value **fails startup with a named configuration error identifying the offending key**. A
bound that silently degraded to "admit everything" would be worse than no bound at all, because
nothing would fail while the guarantee was gone.

That check runs **twice**, and the second run is not redundant. `init()` validates all five values
as it resolves them, which is what refuses a bad configuration at the point it is written. Bootstrap
then re-validates the same five against the registration it is actually about to serve with — five
integer comparisons, and the only check that covers a server registered with the bare
`ReorderPlugin` class, whose `init()` never ran. Bootstrap also applies the one bound `init()`
cannot, because it is a property of the server rather than of the option set: both page sizes are
checked against that server's own `apiOptions.shopListQueryLimit`, above which every read omitting
`take` would fail on a server that had started healthily and reported nothing.

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
`lib/src/migrations/`, and lives at `src/migrations/` in a source checkout.

> **Read this before you register it: the shipped file is PostgreSQL DDL, and applies on PostgreSQL
> only.** It is the platform migration generator's own output, and `generateMigration` serialises the
> statements one configured engine's schema builder logged into `queryRunner.query(<SQL>)` calls — so an
> emitted migration is bound to the engine it was generated against, and this one was generated against
> PostgreSQL. Applying it on MySQL, MariaDB or the SQLite family fails: `SERIAL`,
> `TIMESTAMP … DEFAULT now()` and `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` are not all legal on
> those engines, and a double-quoted identifier is a string literal on the MySQL family. **If you deploy
> on any other engine, generate your own file** — see
> [If you deploy on another engine](#if-you-deploy-on-another-engine) below. This is a property of the
> emitted form rather than an omission: the platform's migration lifecycle is the only sanctioned way to
> produce one of these files, and one run of it produces one dialect.

On PostgreSQL, register it the way you register any other migration in a Vendure project — by naming its
file in `dbConnectionOptions.migrations`. Resolve this package's own directory through the module system
rather than writing a relative path from your configuration file, so the pattern keeps working wherever
that file lives:

```ts
import type { VendureConfig } from '@vendure/core';
import path from 'path';

const reorderPluginRoot = path.dirname(require.resolve('@vendure/reorder-plugin/package.json'));

export const config: VendureConfig = {
    dbConnectionOptions: {
        // ...
        migrations: [
            // ...your own migrations
            path.join(reorderPluginRoot, 'lib/src/migrations/*.js'),
        ],
    },
};
```

**Name one layout, not both.** An installed package carries only the compiled tree, so the single pattern
above is enough there; a source checkout of this repository carries `src/migrations/*.ts` instead, which is
what `packages/dev-server` names. A configuration naming both would match two files declaring the same
migration class, and TypeORM refuses the whole configuration in that case rather than de-duplicating
(`MigrationExecutor.checkForDuplicateMigrations`).

The migration class is deliberately **not** exported from the package root. The root publishes exactly what
you configure the plugin through — `ReorderPlugin`, `ReorderPluginOptions`, `ReorderList` and
`ReorderListLine` — and a migration is registered by file, so nothing about the registration above needs a
symbol from this package.

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
builder create these two tables from the entity metadata, at which point the migration has nothing left
to create: its first `CREATE TABLE` fails on an object that already exists, `runMigrations` logs the
failure and the schema is the schema builder's rather than the migration's. There is no adopt-what-you-
find path — the file is a list of statements, not a reconciler — so the two mechanisms must not be mixed
in one startup sequence in either order. Note also how such a failure is reported: `runMigrations` sets
`process.exitCode` rather than throwing, so a startup chain that ignores the exit code carries on — and
synchronizes regardless only where its own configuration turns synchronization on. Where it does not, the
chain carries on against whatever schema the failed migration left.

`packages/dev-server` in this repository is exactly such a synchronization-driven harness — it ships no
core migrations of its own, and **every branch of its connection configuration except one** turns
`synchronize` on over the `false` its own `dbConnectionOptions` declares — MariaDB, MySQL, PostgreSQL and
native SQLite all do. The exception is `sqljs`, which sets no `synchronize` at all, so on `DB=sqljs` the
declared `false` stands — and that changes the outcome rather than only the setting: a migration that
fails there leaves the schema **empty**, because nothing else provisions it, and the boot proceeds to
serve against it, so the first request touching either table fails on a missing table rather than on the
migration. On the other four branches the same failed migration costs nothing but a non-zero exit code.
It registers this plugin's migration in the one place a registration belongs, `dbConnectionOptions.migrations`,
and its start script calls `runMigrations` before `bootstrap`. **The visible consequence is worth stating
rather than leaving to be met in a log**: on that harness's default MariaDB the boot-time `runMigrations`
refuses the shipped PostgreSQL DDL, logs the refusal, leaves `process.exitCode` at `1` without throwing,
and `bootstrap` then synchronizes the two tables exactly as it always has — so the server comes up and
serves, with one failed migration reported on the way past. That is noise in a development harness rather
than a fault in either half, and it is the same reporting behaviour a production startup chain has to
account for. Making the harness migration-owned end to end would mean authoring core migrations for it,
which are files outside this package; its synchronization-driven boot is its own long-standing design and
is left as it is.

The three-step order above is not only documented, it is **executed**, on whichever engine the run
configures. `e2e/reorder-list-migration.e2e-spec.ts` applies a migration to an isolated database
through the platform lifecycle — this checked-in file where the dialect matches it, and that
engine's own lifecycle emission otherwise — and nothing is dropped first, because the harness
registers no plugin and so the schema builder never created either table: the suite asserts they
were absent beforehand, which is what makes the migration provably their only author. It then reads
the named objects out of the engine's own catalogue, attempts the write each named constraint
forbids straight through the repository so the refusal is demonstrably the database's, and runs the
data-bearing up, down and up cycle that checks the seeded core rows survive the revert.

A SEPARATE block in the same file covers schema qualification, and it is provisioned differently on
purpose: `synchronisedDataSource` opens each schema with `migrations: []`, `migrationsRun: false`
and `synchronize: true`, so what it exercises is a separately SYNCHRONIZED schema-qualified fixture
and not the migrated schema above. That is the right provisioning for what it asks, because the
question is whether every statement resolves to the schema its connection was configured with rather
than to the search path. It drives the service rather than the Shop API — `adjustReorderListLine`,
`addItemToReorderList` and `removeReorderListLine` — against a non-default configured schema, while
an adversarial list of the same identifier, owned by somebody else, sits in the search path, so a
statement that resolved to the wrong schema would read the decoy and be caught. That block runs on
PostgreSQL alone, since it is the only configured engine that renders a qualified identifier. The
Shop API paths over all eight operations are covered by the four functional suites, against those
suites' own synchronized schema.

**The statements are frozen in the file, not read from the entity classes.** Every table, column,
width, named unique, named index, named check constraint and cascading reference is written out as
literal SQL, so what the migration creates is fixed at its own timestamp and cannot drift when a later
release adds a column to one of these entities — that column belongs to that release's own migration.
Nothing in the file is resolved at run time, and that includes the things a deployment might reasonably
expect to be: the identifier columns are `SERIAL` and `integer` because that is what the generating
connection's `EntityIdStrategy` produced, and `down()` names the `public` schema its own connection was
configured with when it drops the index by name. A deployment on another identifier strategy or another
schema regenerates the file against its own connection, which is the same answer as for another engine.

One operational note for a test harness rather than a deployment. `@vendure/testing`'s sql.js initializer
caches a populated database per spec file and, **when that cache exists, disables synchronization while
loading it** — so a snapshot captured before these two tables existed is restored without them and every
case then fails on a missing table. After adding this plugin, or after any change to its two entities,
delete the cached seed data for the affected package (`<package>/e2e/__data__`) once. It is regenerated on
the next run.

### If you deploy on another engine

Generate your own file, through the same platform lifecycle, and register that instead of the one this
package ships. Nothing about it is special: it is what the shipped file is, run against your connection
rather than against PostgreSQL.

```ts
import { generateMigration } from '@vendure/core';

// `config` is your own VendureConfig with ReorderPlugin registered and this package's shipped
// migration NOT named in `dbConnectionOptions.migrations` — the generator must not be handed the
// migration it is being asked to decide the need for.
await generateMigration(config, { name: 'add-reorder-lists', outputDir: './src/migrations' });
```

Run it against a database that carries your core schema and neither plugin table, which is the position
a first deployment of this plugin is in. The output creates `reorder_list` and then `reorder_list_line`
with every column, named unique, named index and cascading reference this package declares — and every
named check constraint the engine can carry, which on MySQL and MariaDB is none, for the reason the
[limitation note](#one-documented-limitation) records. Apply and reverse it with `runMigrations` and
`revertLastMigration` exactly as above.

This is not advice given untested. The plugin's own migration end-to-end suite takes that route on every
engine it runs on: where the shipped file's dialect matches the connection it applies the shipped file,
and everywhere else it generates the engine's own emission at the top of the run and applies that. The
whole data-bearing up → down → up cycle, every named object read back out of the engine's own catalogue,
and the write each named constraint forbids are measured that way on **sql.js, MariaDB, MySQL and
PostgreSQL** — so what differs between engines is the file, not the coverage. Native SQLite is
unverified, and named as such rather than implied: `@vendure/testing` exports no initializer for it.

### One documented limitation

On the MySQL family only: TypeORM 0.3.x cannot create `CHECK` constraints there and discards them
silently, so the two named check constraints on these tables are created on PostgreSQL and the SQLite
family and **not** on MySQL or MariaDB. That is measured rather than inferred — the emission this
package's own suite generates for those two engines carries neither constraint, because TypeORM returns
early before a check ever reaches the statement log. Nothing stops you provisioning them yourself on
those two engines, but **this plugin will not create them and never looks to see whether you have**: it
carries no reconciler and inspects no existing table. The two named unique constraints and the named
index do exist on all four engines (the MySQL family stores each unique constraint as a named unique
index, keeping both the name and the guarantee).

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

Two mechanisms for closing the gap were built and measured against MySQL 8.0.43 and MariaDB 11.5.2
before being withdrawn — engine-specific `CHECK` DDL in the migration, and a boot-time `warn` line
reporting the shortfall — and the migration's own header records what a ruling on the first would have
to weigh, so the decision can be taken on facts rather than re-measured. In short: the frozen
conditions cannot be reused verbatim, because both engines accept an ANSI-quoted `CHECK` and then read the quoted column as a _string
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
| `defaultReorderListsPageSize`     | `number` — integer, finite, at least 1, no greater than `shopListQueryLimit`          | `25`    | The `take` applied to `activeCustomerReorderLists` when a caller supplies none                               |
| `defaultReorderListLinesPageSize` | `number` — integer, finite, at least 1, no greater than `shopListQueryLimit`          | `50`    | The `take` applied to `ReorderList.lines` when a caller supplies none                                        |

Both page-size defaults sit below the platform's own `apiOptions.shopListQueryLimit`, which defaults to
`100`. The plugin never bypasses that limit — `ignoreQueryLimits` stays false on every query — so a caller
asking for more rows than the Shop API permits is refused by the platform exactly as it would be on any
other paginated query.

**If you lower `shopListQueryLimit` below either page size, the server will not start.** That is deliberate
and it is checked when the plugin is bootstrapped: a page size is applied as the `take` of a Shop list query,
and the platform refuses a `take` above the limit rather than clamping it, so a page size above the limit
would leave every read that omits `take` failing with `USER_INPUT_ERROR` on a server that started and
reported nothing wrong. The boot instead fails with `ReorderPluginConfigurationError` naming which of the two
page sizes exceeds the limit and what the limit is. A page size exactly equal to the limit is accepted,
because the platform's own test is strictly greater. The other three options are unaffected by this limit.

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

Every write takes the list row before any line row, so two requests against one list cannot deadlock
by approaching the two rows in opposite orders. A request that will write only a line — adding to an
existing line, or adjusting one — holds the list row in **shared** mode, which lets two such requests
proceed together and meet at the line row, where an accumulation is a single `quantity = quantity + n`
evaluated by the engine and therefore loses no update.

Five of the six mutations run as exactly one transaction per request. `addItemToReorderList` is the
exception, and deliberately: it runs in _manual_ transaction mode, so **one request can execute more
than one transaction**. Each of its bounded attempts opens a fresh transaction at the top level, runs
to a decision, and either commits or rolls back completely before the next attempt begins — which is
what lets an attempt that resolved a line another request then removed be redone as an insert, holding
none of the locks the previous attempt took. The number of attempts is bounded, every attempt is
atomic on its own, and only one of them can commit a change. There is no partial result: an attempt
that does not commit leaves nothing behind, including the capacity it had claimed.

**On MySQL and MariaDB a line-only write holds the list row exclusively instead, so two of them
against one list serialise.** The reason is measured rather than precautionary: with the shared mode
there, two accumulations onto one line deadlock at the line row if that line is removed beneath them.
Serialising the pair prevents the cycle. That matters most for the five auto-mode mutations, where
Vendure runs the service transaction as a savepoint inside the resolver's transaction and an InnoDB
deadlock destroys the savepoint, surfacing as an unrecoverable error rather than as the retriable
deadlock it is; on the manual-mode add path a deadlock would surface as itself, but it is still a
failed request and is prevented for the same reason. The effect is a small loss of concurrency between
two line writes on the same list on those two engines, and nothing else: the arithmetic, the bounds
and every published result are identical on all four engines.

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

A list name is stored after whitespace canonicalisation only — surrounding whitespace removed and internal
runs of whitespace collapsed to a single space. **After that canonicalisation, nothing else is altered**: the
name is neither escaped, stripped nor entity-encoded at rest, so reading it back returns exactly what
canonicalisation produced, code point for code point. Submit `"  Weekly   order  "` and you get back
`"Weekly order"` — the whitespace is the one thing that changes, and it changes before the row is written.
Uniqueness is enforced per customer and channel by a database constraint over a canonicalised form of the
name, which makes the comparison case-insensitive but accent-preserving, so `Café` and `Cafe` remain two
distinct lists.

A name is refused as malformed on exactly four grounds, and it is worth knowing the list is that short:

1. Its canonical form is empty.
2. Its canonical form exceeds 191 characters.
3. The canonical form carries any of: a C0 control character (`U+0000`–`U+001F`, less the tab, newline and
   carriage return that whitespace canonicalisation itself consumes — so `U+000B` and `U+000C` **are**
   refused), `U+007F`–`U+009F`, `U+200B` zero-width space, or `U+FEFF`.
4. The canonical key derived from it — the same value lower-cased and Unicode-normalised, which is what the
   uniqueness constraint compares — exceeds 191 characters even though the display value did not. NFC
   composition can lengthen a string, so this is a real fourth ground rather than a restatement of the
   second, and it is the one a caller is least likely to expect.

All four arrive as a single top-level `errors` entry with `extensions.code` `USER_INPUT_ERROR` and no row
written. Everything not in that list is stored. In particular an emoji sequence, a variation selector, a zero-width joiner or
non-joiner, a soft hyphen, a bidirectional mark and a combining grapheme joiner are all accepted and
round-trip code point for code point — a name is buyer-supplied text, and refusing characters that
ordinary orthography and ordinary emoji are built from would reject names a buyer legitimately typed.

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

## Package scripts

This package declares the conventional `build`, `watch`, `lint`, `test`, `e2e`, `bench` and `ci`. Of
those, `bench` is deliberately an empty target: this feature asserts no service-level, latency or
throughput figure anywhere, so there is nothing for a benchmark to hold to and the plugin ships no
`*.bench.ts`. The script therefore passes `--passWithNoTests`, so the workspace aggregate that runs
it reports a clean status rather than failing on an empty file set.

Two further scripts behave unlike the rest and are documented here so their exit status is not
misread:

| Script                            | What it asserts                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `typecheck:error-code-exhaustive` | Type-checks `e2e/error-code-exhaustive.fixture.ts`, and is expected to exit **non-zero** |
| `typecheck:error-code-defaulted`  | Type-checks `e2e/error-code-defaulted.fixture.ts`, and is expected to exit **zero**      |

The two fixtures are byte-identical apart from one terminal branch: an exhaustive `switch` over the
published Shop `ErrorCode` with no `default`, versus the same `switch` with one. A non-zero status on the
first is therefore the evidence rather than a defect — it is what shows the enum grew when this plugin
declared its four error results — and a clean compile there would be the regression. Each is the single
entry of its own compiler project (`e2e/tsconfig.error-code-*.json`), because one invocation cannot
produce two opposite statuses.

**They are only meaningful inside a generation window, and outside it they fail for an unrelated
reason.** Both fixtures import `../.generated/shop-error-codes`, which is a build product rather than a
checked-in file: the read suite's own case introspects a running server, generates that module from the
live schema, invokes these two scripts, asserts the two statuses, and removes the module again. Run
either script on its own and it exits non-zero with `error TS2307: Cannot find module
'../.generated/shop-error-codes'` — the module is simply absent, which says nothing about
exhaustiveness. That distinction is itself asserted rather than left to a reader: the exhaustive
project's failure is required to carry `TS2322` and **not** `TS2307`, so a missing module can never be
mistaken for the evidence. Run them through `npm run e2e` instead, which is where the window exists —
and where the resolved compiler is asserted to be the version the workspace pins.
