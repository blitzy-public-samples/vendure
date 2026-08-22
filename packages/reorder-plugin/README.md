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
`ReorderPlugin.init({})` — and `ReorderPlugin.init()` with no argument at all — is a valid call that
yields exactly the defaults in the table below. What that argument may not be is a non-object:
`null`, an array, a function or a primitive is refused with the same named configuration error
rather than read as "no options supplied", so a configuration expression that produced the wrong
thing fails the boot instead of quietly dropping the bounds you wrote. Whatever you do supply is
checked before a request can ever reach it, never at request time, and a malformed value **fails
startup with a named configuration error identifying the offending key**. A bound that silently
degraded to "admit everything" would be worse than no bound at all, because nothing would fail while
the guarantee was gone.

That check runs **twice**, and the second run is not redundant. `init()` validates all five values
as it resolves them, which is what refuses a bad configuration at the point it is written. Bootstrap
then re-validates the same five against the registration it is actually about to serve with — five
integer comparisons, and the only check that covers a server registered with the bare
`ReorderPlugin` class, whose `init()` never ran. Bootstrap also applies the one bound `init()`
cannot, because it is a property of the server rather than of the option set: both page sizes are
checked against that server's own `apiOptions.shopListQueryLimit`, above which every read omitting
`take` would fail on a server that had started healthily and reported nothing.

**Each call to `init()` returns a registration bound to the values that call resolved.** Its options
provider is a `useValue` capturing exactly the set that call resolved, fixed at creation, which no
later `init()` can reach or move; the bare `ReorderPlugin` class stays bound to the declared
defaults rather than to the latest initialisation; and `ReorderPlugin.options` remains readable as a
report of the most recent initialisation that nothing serves from. So a process that boots one server
serves exactly the bounds that registration carries, and the set it is serving with is the one
injected into its own providers.

**A process serves one plugin configuration, though, and it is whichever bootstrapped first.** The
platform evaluates `PluginModule.forRoot()` inside the `AppModule` decorator argument
(`packages/core/src/app.module.ts` L24) and imports that module once per process
(`packages/core/src/bootstrap.ts` L202), so the first configuration's plugin set is frozen into
`AppModule` for the life of the process. A second, differently configured `bootstrap()` in the same
process therefore does **not** get its own bounds: it serves the first configuration's
registrations. That is deterministic, and nothing this plugin can do changes it. **Run one server
per process** — separate processes, or separate workers — whenever two configurations must differ,
a test file that boots two of them included.

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
> [If you deploy on another engine](#if-you-deploy-on-another-engine) below, and
> [Which file each engine needs, and what is verified there](#which-file-each-engine-needs-and-what-is-verified-there)
> for the same split in table form. This is a property of the emitted form rather than an omission: the
> platform's migration lifecycle is the only sanctioned way to produce one of these files, and one run of it
> produces one dialect.

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

### Which file each engine needs, and what is verified there

The engine split is stated in prose three times — in the note above, again under
[If you deploy on another engine](#if-you-deploy-on-another-engine), and again in the migration file's own
header — and none of that helps a reader who scans for a coverage matrix and then reads the first one they
find. So here it is as a matrix. **Shipped file** is the checked-in
`src/migrations/1786838400000-add-reorder-lists.ts`. **Own emission** is the file the same platform
lifecycle writes when the generator is pointed at your own connection, which that section sets out in full.

| Engine        | Shipped file applies as-is                         | Own emission applies    | Data-bearing up → down → up verified | Named objects created       |
| ------------- | -------------------------------------------------- | ----------------------- | ------------------------------------ | --------------------------- |
| PostgreSQL 16 | **Yes** — this is the only engine it applies on    | It **is** that emission | Yes, through the shipped file        | 5 of 5                      |
| MariaDB 11.5  | No — errno 1064 `ER_PARSE_ERROR` on statement one  | Yes                     | Yes, through its own emission        | 3 of 5 — both `CHK_` absent |
| MySQL 8       | No — errno 1064 `ER_PARSE_ERROR` on statement one  | Yes                     | Yes, through its own emission        | 3 of 5 — both `CHK_` absent |
| sql.js        | No — `near "(": syntax error`                      | Yes                     | Yes, through its own emission        | 5 of 5                      |
| native SQLite | No — refused for the same dialect reason as sql.js | Not verified here       | Not verified here                    | Not verified here           |

**Read the "shipped file" and "verified" columns together; either one alone reverses the other's meaning.**
The round trip is verified on all four automated engines, and on three of them what is verified is that
engine's own emission and never this file.

Each refusal in the first column is measured rather than deduced: applying the shipped file's first
`CREATE TABLE` verbatim through each engine's own driver is accepted on PostgreSQL 16.15 and refused on
MariaDB 11.5.2, MySQL 8.0.43, sql.js 1.13.0 (SQLite 3.49.1) and native SQLite 3.49.2. "Verified" in the
fourth column means the plugin's own `e2e/reorder-list-migration.e2e-spec.ts` runs the whole cycle on that
engine — applying the shipped file where the dialect matches and generating and applying that engine's
emission where it does not. The two objects missing on the MySQL family are the named `CHECK` constraints,
for the reason [Engine-scoped limitations](#engine-scoped-limitations) records; both named unique objects
and the named index are created on all four engines, under their exact names.

**Native SQLite is not verified, and that is stated rather than implied.** `@vendure/testing` exports
initializers for sql.js, MySQL/MariaDB and PostgreSQL only, `e2e-common/test-config.ts` registers exactly
those four selectors, and the repository's engine jobs are `e2e (sqljs)`, `e2e (mariadb)`, `e2e (mysql)` and
`e2e (postgres)` — so nothing here exercises it, and no cell above should be read as a claim about it beyond
the dialect refusal, which is a property of the SQL rather than of any test.

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
[limitation note](#engine-scoped-limitations) records. Apply and reverse it with `runMigrations` and
`revertLastMigration` exactly as above.

This is not advice given untested. The plugin's own migration end-to-end suite takes that route on every
engine it runs on: where the shipped file's dialect matches the connection it applies the shipped file,
and everywhere else it generates the engine's own emission at the top of the run and applies that. The
whole data-bearing up → down → up cycle, every named object read back out of the engine's own catalogue,
and the write each named constraint forbids are measured that way on **sql.js, MariaDB, MySQL and
PostgreSQL** — so what differs between engines is the file, not the coverage. Native SQLite is
unverified, and named as such rather than implied: `@vendure/testing` exports no initializer for it.

### Engine-scoped limitations

There are two, and they are the same shape: a guarantee the schema is _declared_ to carry is not carried by
one engine family, while the plugin's own enforcement of the same invariant — a value predicate inside the
statement where there is one, an in-process guard before the write otherwise — holds on all four. The first
is a tracked, unresolved conflict; the second is simply how SQLite stores data. Neither changes any
published behaviour, and both are stated here because what they cost is identical: the last line of defence
against a write that does not come through this plugin at all.

#### The MySQL family carries neither named `CHECK` constraint

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

#### The SQLite family enforces neither a declared column width nor a 32-bit integer range

On sql.js and native SQLite only: a column's declared type is an _affinity_ rather than a constraint, so
the widths these two tables declare reach the stored schema and are then not applied to a value. Both of
these are measured on sql.js 1.13.0 (SQLite 3.49.1) and native SQLite 3.49.2, against tables carrying
exactly the declarations these entities produce, and each is refused on the other three engines:

- `name` and `nameKey` are declared `varchar(191)`, and `sqlite_master` reports them at that width — but a
  192-character `name` and a 382-character `nameKey` (the size 191 characters can reach after NFC
  composition, which is the second thing the bound exists to catch) are both **accepted and stored whole**,
  reading back at 192 and 382 characters with no truncation. PostgreSQL 16.15 refuses both with
  `22001 value too long for type character varying(191)`, MariaDB 11.5.2 and MySQL 8.0.43 with
  errno 1406 `ER_DATA_TOO_LONG` naming the column.
- `quantity` is declared `int`, which TypeORM renders as SQLite `integer` — a 64-bit storage class — so
  `2147483648` is **accepted and stored**, reading back unchanged. PostgreSQL refuses it with
  `22003 integer out of range` and the MySQL family with errno 1264 `ER_WARN_DATA_OUT_OF_RANGE`.
  `2147483647` is accepted on all four engines.

**What still holds there is what holds everywhere**, and it is the guard rather than the column: the
191-character bound is `MAX_LIST_NAME_LENGTH`, applied in process to both stored forms of a name before any
write; the quantity ceiling is `maxQuantityPerLine`, validated at startup against a signed 32-bit integer
and applied to the **resulting** quantity on every write path. Neither depends on an engine, so no request
through this plugin's eight operations can produce either value on any of the four. The published contract
is engine-independent for the same reason: the GraphQL `Int` a quantity is returned as is a signed 32-bit
integer everywhere.

**What is genuinely lost is the same single thing the MySQL family loses on the two `CHECK` objects**: the
last line of defence against a write that does not come through this plugin at all — direct SQL against
these two tables, or another application sharing the schema. On sql.js and native SQLite such a write is
accepted, an over-long name or an over-32-bit quantity is stored intact, and a later read returns it as
stored. If you share this schema with anything that writes to `reorder_list` or `reorder_list_line`
directly, treat the name width and the quantity range as that writer's responsibility on those two engines,
exactly as you would treat the two `CHECK` invariants on MySQL and MariaDB. Unlike the `CHECK` gap this is
not a tracked conflict and there is nothing to rule on: SQLite has no constrained-width text type and no
32-bit integer type to declare instead, so the declaration is already the strongest one available.

One qualification on the refusals quoted above, because it is a server setting rather than a property of
either column: on the MySQL family both are strict-mode behaviour. With `STRICT_TRANS_TABLES` in `sql_mode`
— the server default on the `mariadb:11.5` and `vendure/mysql-8-native-auth` images the engine jobs use —
the two writes are refused as quoted. With `sql_mode` emptied they are **accepted** on both engines instead,
silently: the 192-character name is truncated to 191 and `2147483648` is clamped to `2147483647`. Neither
this plugin nor Vendure sets `sql_mode`, so which of the two you get is your server's configuration, and a
non-strict server has the SQLite family's gap in a lossier form.

## Options

| Option                            | Type                                                                                                                  | Default | Enforced at                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `maxListsPerCustomer`             | `number` — integer, finite, at least 1                                                                                | `25`    | `createReorderList`, under a pessimistic row lock on the owning customer                                     |
| `maxLinesPerList`                 | `number` — integer, finite, at least 1                                                                                | `200`   | `addItemToReorderList` only — **not** `adjustReorderListLine`, which cannot breach a line-count bound        |
| `maxQuantityPerLine`              | `number` — integer units, finite, at least 1, no greater than a signed 32-bit integer                                 | `999`   | `addItemToReorderList` and `adjustReorderListLine`, applied to the **resulting** quantity, not the increment |
| `defaultReorderListsPageSize`     | `number` — integer, finite, at least 1, no greater than a signed 32-bit integer, no greater than `shopListQueryLimit` | `25`    | The `take` applied to `activeCustomerReorderLists` when a caller supplies none                               |
| `defaultReorderListLinesPageSize` | `number` — integer, finite, at least 1, no greater than a signed 32-bit integer, no greater than `shopListQueryLimit` | `50`    | The `take` applied to `ReorderList.lines` when a caller supplies none                                        |

Both page-size defaults sit below the platform's own `apiOptions.shopListQueryLimit`, which defaults to
`100`. The plugin never bypasses that limit — `ignoreQueryLimits` stays false on every query — so a caller
asking for more rows than the Shop API permits is refused by the platform exactly as it would be on any
other paginated query.

The two page-size options therefore carry two upper bounds, refused at two different moments and for
two different reasons. The signed 32-bit ceiling is refused by `ReorderPlugin.init()`, because a page
size is applied as the `take` of a Shop list query and is carried by the published GraphQL `Int` — a
value above that range could never be served, and that is knowable before any server exists.
`shopListQueryLimit` is refused later, when the plugin is bootstrapped into a server, because the
limit belongs to the configuration that server is being started with and `init()` cannot see it.

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
`skip`, `sort` and `filter` behave as they do elsewhere in the API, and so does any `take` of one or
more. Default sorting is a
total order — lists newest-first, lines oldest-first, each tie-broken by identifier — so paging
forward over rows sharing a timestamp will not show you the same row twice or skip one. When you
supply your own `sort`, the identifier tie-break is appended to it rather than replacing it.

Two details of that argument are worth knowing before you write a client against it, because both
are visible and neither is something this plugin chose.

**A `take` of zero or a negative number returns an empty page here, where some core list fields
return every row.** The plugin forwards whatever `take` you send, untouched, which is what makes an
over-limit request refused by the platform rather than quietly reduced to fit. The platform then
clamps a non-positive value to zero, and what happens next depends on the shape of the query rather
than on the field: a query with no relation join — which is what both of these reads are — carries
that zero through as a `LIMIT 0` and returns no rows, while a query that joins (core's `products`,
for instance) applies no limit at all and returns everything. So the same input gives you an empty
page from this plugin and a complete one from some core fields. The plugin's answer is the bounded
one and it never returns an unbounded page, but do not read a non-positive `take` as "no limit"
anywhere: if what you want is the configured default, omit `take` or send it as `null`.

**Introspection shows the generated `options` argument with a default of `null`**, as
`options: ReorderListListOptions = null` on the collection query and `options: ReorderListLineListOptions = null`
on the nested field, whereas core's own paginated fields show no default. That is the platform's
list-options generator: it adds the argument — this plugin must declare neither the argument nor its
input type, or the schema would not build — and it adds it with that default. It changes nothing you
can observe: omitting `options`, sending `options: null` and sending `options: {}` return the same
page, byte for byte.

There is no idempotency key on `addItemToReorderList`, and its absence is deliberate rather than an
oversight: delivery is at-least-once, so two deliveries of one add will accumulate.
`adjustReorderListLine` is the deterministic remedy, because it sets an absolute quantity instead
of adding to one.

### A saved line records intent, not availability

A line is kept whatever later happens to the variant behind it, and `productVariantId` always comes
back populated so you can show the line and let the buyer remove it. The nested `productVariant`
object is nullable and is `null` in exactly three cases, all of them "no longer resolvable in the
active channel": the variant belongs to another channel, its row has been soft-deleted, or the
channel-scoped load does not answer for that identifier.

**A variant that has merely been _disabled_ is not one of those cases: it is still resolvable, so
`productVariant` resolves normally.** Be aware of what that means for a storefront. Disabled means
not purchasable, and this payload carries no availability field of its own — deliberately — while
the Shop API's own `ProductVariant` type publishes no `enabled` field either, that flag being
Admin-only. `stockLevel` is not a stand-in, because a disabled variant can still report stock. So a
list can show a line for something the buyer cannot currently buy, and nothing in this response
marks it. Surfacing availability on a reorder list, and resolving a line that cannot be reordered,
are both later features; if you need the distinction today, resolve it against your own catalogue
read, which on the Shop API already omits a disabled variant.

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

### One timestamp difference, and it is the platform's rather than this plugin's

On MySQL and MariaDB, `updatedAt` is written truncated to whole seconds while `createdAt` keeps its
sub-second precision, so a row created and then updated inside the same second reports an `updatedAt`
_earlier_ than its `createdAt`. On PostgreSQL and the SQLite family both are sub-second and
monotonic.

This is not something these tables do. Both of them inherit `createdAt` and `updatedAt` from the
platform's own entity base class and re-declare neither, and the effect reproduces identically on
core tables — measured here on two tables carrying exactly the platform's column declarations, one
standing for a core entity and one for `reorder_list`, on both engines, with the same result on the
query-builder and repository write paths. It is left alone deliberately: a local workaround inside
this plugin would make these two tables behave unlike every other table in the schema.

Nothing in this feature depends on it. Both default sorts order by `createdAt` with the identifier as
a tie-break, so paging stays deterministic. The one thing to avoid is sorting or filtering on
`updatedAt` and expecting sub-second resolution on those two engines.

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

## Test suites, and what each engine proves

This section is about the package's own verification rather than about its behaviour: which suite
measures which claim, on which engine, and where a number a reader would reasonably expect to be
uniform legitimately is not. It is written down because three of those numbers read like regressions
and are none — a per-file coverage row well below eighty per cent, a block of tests reported as
skipped on three of the four engine jobs, and a suite whose test count differs by six between
PostgreSQL and everything else.

The package ships **three unit spec files**, run by `npm test`, and **six end-to-end suites** — create,
add-item, mutate, read, migration and compatibility — run by `npm run e2e` and pointed at an engine by
`DB=sqljs|postgres|mysql|mariadb`. Both are the conventional workspace targets described under
[Package scripts](#package-scripts); nothing below needs a bespoke command.

### Unit coverage is a unit-only measurement, and its low rows are the boundary of that measurement

`npm test` executes **526 cases across the three spec files** and is the only target that reports
coverage. Measured with the workspace's own v8 provider over `src/**/*.ts` with the spec files
excluded, this package's source reads:

| Source                                     | Lines       | Covered / total |
| ------------------------------------------ | ----------- | --------------- |
| `src/service/reorder-list.service.ts`      | 99.79 %     | 1976 / 1980     |
| `src/service/reorder-list-name.ts`         | 100 %       | 143 / 143       |
| `src/reorder.plugin.ts`                    | 96.51 %     | 388 / 402       |
| `src/api/api-extensions.ts`                | 100 %       | 8 / 8           |
| `src/api/reorder-list-entity.resolver.ts`  | 84.47 %     | 457 / 541       |
| `src/api/reorder-list-shop.resolver.ts`    | 56.37 %     | 84 / 149        |
| `src/api/reorder-list-result.resolver.ts`  | 53.40 %     | 47 / 88         |
| `src/entities/reorder-list-line.entity.ts` | 100 %       | 14 / 14         |
| `src/entities/reorder-list.entity.ts`      | 87.17 %     | 34 / 39         |
| `src/migrations/…-add-reorder-lists.ts`    | 20.83 %     | 10 / 48         |
| `src/constants.ts`, `src/types.ts`         | 100 %       | 17 / 17         |
| all of `src`, spec files excluded          | **92.68 %** | 3178 / 3429     |

**The low rows are a property of the runner that produced the report, not of the code they name.** The
shop resolver, the result resolver and the migration are the three places in this package whose bodies
a unit test cannot enter without standing up something larger than a unit. The shop resolver is a
delegating layer — it takes no ownership decision, performs
no validation, no ordering, no clamping and no error translation — so its method bodies run only once
the platform's GraphQL layer has resolved a request into them. The result resolver is six
`__resolveType` field resolvers, which run only when GraphQL has a union payload in hand to
discriminate. The migration's `up()` and `down()` bodies run only inside a real `queryRunner` against a
real engine. All three are executed heavily by the end-to-end matrix — the two resolvers through the
Shop API on all four engines, the migration through the data-bearing up → down → up cycle described
under [Database migration](#database-migration) — and the v8 provider does not aggregate two runners
into one report, so that execution appears in neither this table nor a second one.

The `reorder-list.entity.ts` row has the same explanation in miniature: what it leaves uncovered is the
collation resolver, and that function reads the bootstrapped platform configuration, which a unit test
has not built. Run the command below and the same caveat applies to the function percentages the text
reporter adds beside these line figures — on the two entity files those count the arrow thunks inside
`@ManyToOne(type => …)` and its neighbours, which TypeORM calls while it builds metadata rather than
when a test calls a method.

So read the `92.68 %` as what it is — a **scoped total for one runner**, not a per-file floor, and not a
claim that every file is covered to that depth. The threshold this package is actually held to is line
coverage over its new service methods, and that is the first two rows of the table: **99.79 %** and
**100 %**. Reproduce all of it with the workspace's own provider:

```bash
cd packages/reorder-plugin
npx vitest --config vitest.config.mts --run --coverage --coverage.provider=v8 \
  --coverage.all=true "--coverage.include=src/**/*.ts" "--coverage.exclude=src/**/*.spec.ts" \
  --coverage.reporter=text
```

### What each engine job runs, and where the counts legitimately differ

One end-to-end run on one engine reports:

| Engine job (`DB=`)            | Collected | Passed | Skipped | Migration suite alone |
| ----------------------------- | --------- | ------ | ------- | --------------------- |
| sql.js (`sqljs`, the default) | 371       | 352    | 19      | 51 of its 57 executed |
| PostgreSQL (`postgres`)       | 371       | 353    | 18      | 57 of its 57 executed |
| MariaDB (`mariadb`)           | 371       | 345    | 26      | 51 of its 57 executed |
| MySQL (`mysql`)               | 371       | 345    | 26      | 51 of its 57 executed |

**The column to watch is the first one.** Collected is a constant 371 on every engine, and that is the
number a regression would move: it is what shows no case is filtered out by filename or by
configuration, and that no stray `.only` quietly truncated a run — the shared end-to-end configuration
sets `allowOnly: true`, so an `.only` would shrink the collected count rather than fail the run. The
passed-and-skipped split differs by engine on purpose, every skip in it belongs to one of the four
classes below, and none of the four is a bare `.skip` — each is a condition on the engine the run is
configured for, so a skip that appeared on an engine not named below would itself be the finding.

**Concurrency, excluded on sql.js — 11 cases.** The forced-interleaving cases open two independent
connections and release them together from an explicit barrier, which is evidence only on an engine
that gives a test two genuinely concurrent transactions. `sqljs` is the in-process WebAssembly build
and serves effectively one connection, so all 11 are excluded there and belong to the three server
engines, each naming the engine it ran on in its own title. Four of the 11 are two complementary pairs
rather than four independent claims: a simultaneous rendezvous is measurable only where a line write
holds the parent row in shared mode, and a forced-ordering variant only where it holds it exclusively —
the engine difference described under
[Concurrency, and one engine difference worth knowing](#concurrency-and-one-engine-difference-worth-knowing).
Each server engine therefore runs nine of the 11 and reports the other two skipped as the complement
of its own locking mode. No server engine has a permanently skipped race.

**Exact statement counts, fixed to the sql.js job — 16 cases.** Statement text, and sometimes statement
count, differ legitimately between drivers, so the _counted_ form of a claim is asserted on the one
engine where it is deterministic, while the behaviour that count evidences is asserted on all four.
These are the 16 cases skipped on PostgreSQL, MariaDB and MySQL (11 in the mutate suite, four in
add-item, one in create); each announces itself in its own title, either as `[counted form, sqljs /
sqlite / better-sqlite3 only]` or by carrying the reason in full. Every one of them sits in a `describe`
whose behavioural siblings run on all four engines. The mutate suite's quantity group is the shape of
it: "issues no write at all for a refused quantity" is the counted case and runs on sql.js alone, while
"refuses a quantity of 0 without treating it as a removal, and writes nothing", "refuses a quantity of
-1 and leaves the line at its exact prior value", "refuses a quantity above the configured maximum with
its own message key" and "accepts the configured maximum itself, so the bound is inclusive" all run
everywhere. The instrument itself is exercised on every engine too, because the whole-request
assertion — the same number of statements for a page of three lists as for a page of six — carries no
engine gate at all.

**The shipped migration file, applied on PostgreSQL only — 2 cases.** This is a provenance statement,
and worth reading twice if you deploy on anything but PostgreSQL. Two cases apply _the file this package
ships_: the create suite's second staged checkpoint, and the compatibility suite's "a deployment
provisioned by the migration alone". Both are gated to PostgreSQL, because the shipped file is
PostgreSQL DDL and will not apply elsewhere — the same fact recorded under
[Database migration](#database-migration). **The shipped artefact therefore has runtime evidence on
PostgreSQL and on no other engine.** What the other three jobs do instead is generate that engine's own
emission through the platform's `generateMigration`, into a temporary directory outside this
repository, and apply and revert _that_ — which is exactly the route
[If you deploy on another engine](#if-you-deploy-on-another-engine) tells you to take, and the migration
suite asserts which of the two artefacts it used rather than leaving it implied. So the up → down → up
cycle, the named objects read back out of the engine's own catalogue and the write each named
constraint forbids are all evidenced on all four engines; the _file_ is evidenced on one. A deployment
on MySQL, MariaDB or the SQLite family generates its own, and this is the measurement that says so.

**Schema-qualified identifiers, PostgreSQL only — 6 cases, and the 57-versus-51 difference.** The
migration suite's schema-qualification block drives the service against a non-default configured schema
while a decoy list of the same identifier sits in the search path, as described under
[Database migration](#database-migration). PostgreSQL is the only configured engine that renders a
qualified identifier, so the block runs there and is skipped on the other three. **That is the whole of
the count difference in the table above** — 57 of that suite's cases executed on PostgreSQL against 51
elsewhere is this six-case block and nothing else, and it is not a regression on the three engines
reporting 51. Note that the suite still _collects_ 57 everywhere, as it must for the run-wide 371 to
hold: a skipped case is collected and then not executed, so the difference is in the executed count
alone.

One more engine difference produces no skip at all, and is called out here so a green result is not
read as more than it is. The two named `CHECK` constraints cannot be created on MySQL or MariaDB, for
the reason recorded under
[The MySQL family carries neither named `CHECK` constraint](#the-mysql-family-carries-neither-named-check-constraint).
The four cases that
cover them — one catalogue reading and one attempted bad write per constraint — are not skipped on
those two engines. They branch: where the engine emits named checks they assert the constraint present
in its catalogue and the write refused, and on the MySQL family they assert it **absent** from the
catalogue, with no check parsed off either table. That is the stronger design, because it measures the
gap per engine rather than inferring it from another, and it is why all four cases report as passing on
all four engines. The consequence belongs in the same breath as that pass, though: **there is no
positive catalogue evidence for those two objects on MySQL or MariaDB, because on those engines there
is nothing to find.** Reading "passes on all four engines" as "the constraint exists on all four" would
be reading it wrongly. Both invariants those constraints express are enforced by the plugin regardless,
on every engine, and that enforcement is what the functional suites measure.

Finally, **native SQLite is verified by nothing here.** No engine job selects it, and none can: the
shared harness registers initializers for `sqljs`, `postgres`, `mysql` and `mariadb` only, and
`@vendure/testing` publishes no initializer for the native driver. Worth knowing before you reach for
it: `DB=sqlite` is not refused either, because the harness's engine switch falls through to the sql.js
configuration for any value it does not recognise — so such a run passes, and passes on sql.js. Read a
green result from it as sql.js evidence and nothing more. It is named as unverified under
[If you deploy on another engine](#if-you-deploy-on-another-engine) for the same reason, and the honest
scope of these suites is the four engines in the table.

### Two things to know before you run these suites on a shared host

**A `-t` name filter that matches nothing exits 0 with everything skipped.** Run
`npm test -- -t "no-such-name"` and the result is exit status **0** with `Test Files 3 skipped (3)` and
`Tests 526 skipped (526)`. That is the runner's own behaviour and not something this package
configures — the pinned Vitest offers `--passWithNoTests`, which is about zero test _files_, and no
option that fails a run whose name filter executed zero _tests_. A filter that matches no file does
exit 1, so the two cases are not symmetric. The practical rule: an exit status of 0 from a hand-written
`-t` invocation says only that nothing failed, so read the executed count as well. The `test` script
itself passes no filter, so a plain `npm test` cannot land in this state.

**A suite's HTTP port depends on the contents of the `e2e` directory, so two concurrent runs on one
host are not reliably port-disjoint.** The shared harness derives each suite's port as a package base
port plus that spec file's index in `fs.readdirSync` of its own directory. The base for this package is
3250, so on a cold checkout the six suites bind 3254–3259 — and once `e2e/__data__` exists, that entry
sorts ahead of them and the whole block shifts by one, to 3255–3260. Both states are correct and each
is internally consistent; what they are not is the same. Two end-to-end runs sharing a host at
different cache states can therefore collide on a port even though neither is misconfigured, and a
collision surfaces as a boot failure in `beforeAll` rather than as an assertion. **Serialize
end-to-end runs on a shared host** — one at a time, per host, whatever the engines — and treat the port
range 3254–3260 as belonging to this package's suites while one is running. The derivation lives in the
shared `e2e-common` harness rather than in this package, so it is the same for every package in the
workspace and is not something this plugin can settle on its own. This is a different matter from the
staleness of that cache, which is covered under [Database migration](#database-migration): delete
`e2e/__data__` after any change to the two entities, and expect the ports to move back down by one
until the next run recreates it.
