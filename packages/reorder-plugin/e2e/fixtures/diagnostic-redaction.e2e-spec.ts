import { describe, expect, it } from 'vitest';

import {
    canonicaliseCell,
    describeRowDifferences,
    describeSettledOutcomes,
    describeTeardownStage,
    NO_ROW_DIFFERENCE,
    redactTeardownDiagnostic,
    rethrowRedacted,
    runAllTeardownStages,
} from './diagnostic-redaction';

/**
 * The DIAGNOSTIC-SECRECY CONTRACT of `diagnostic-redaction.ts`, tested where the real thing is tested:
 * against the actual driver and runtime messages it will be handed.
 *
 * ★ **WHY THIS SPEC EXISTS.** Every end-to-end suite in this package captures a live buyer's `customer`,
 * `user` and `session` rows in order to put them back, and every one of them runs raw statements against
 * those tables. A failure on any of those paths is assembled into a message, thrown, printed by the runner
 * and read in a build log — so this module is the difference between a CI log that says which teardown step
 * broke and one that publishes an authentication token, a buyer's address or the layout of the machine. A
 * redaction nobody asserts is a redaction the next edit to a message string can undo silently, because a
 * redaction that has stopped redacting still returns a string and every caller still compiles.
 *
 * ★ **WHY IT IS A FIXTURE SPEC RATHER THAN PART OF A FUNCTIONAL SUITE.** These cases are pure: no server,
 * no database, no seed. Living beside the module they test, they run in milliseconds and they fail for
 * exactly one reason. Held inside the create suite — where they began — each of them waited on a booted
 * Vendure server to say something about a string function. `concurrency-barrier.e2e-spec.ts` sets the same
 * pattern for the same reason. The `e2e-spec` suffix is what places it in the end-to-end run
 * [e2e-common/vitest.config.mts:L7], which owns everything under `e2e/`; the package's unit run reaches into
 * `src` and nowhere else.
 *
 * ★ **WHAT IS ASSERTED IS ALWAYS "NO PART OF IT SURVIVED", NEVER "THE VALUE WAS REPLACED".** A rule that
 * replaces the shapes it was taught is a denylist wearing a redaction's clothes, and the four cases at the
 * top of the teardown group are each a real message that walked straight past exactly such a rule.
 *
 * ★ **AN ADDITION TO THE PLANNED FILE SET, DECLARED HERE.** AAP §0.5.1.8 enumerates neither this file nor
 * the module it covers, so both are additions rather than planned artefacts — admitted by the in-scope
 * pattern `packages/reorder-plugin/e2e/fixtures/*.ts` (AAP §0.6.1.2) and declared here under §0.8.2's
 * no-silent-deviation obligation. It is kept for the reason its subject is kept: an instrument that decides
 * a security property, and whose negative cases are not committed, protects nothing against a later edit.
 */
describe('the diagnostic redaction every e2e suite shares', () => {
    const TOKEN = ['s3cr3t', 'session', 'token', '4f2c81b9'].join('-');
    const EMAIL = 'someone.real@example.invalid';
    /** A constraint name a driver would quote back at the caller, beside the value it refused. */
    const DUPLICATE_KEY_NAME = 'customer.UQ_email';
    const SECRETS = [TOKEN, EMAIL, 'Hayden', 'Zieme'];

    /**
     * A rejection shaped exactly as TypeORM raises one, driver fields and all.
     *
     * ★ THE SHAPE IS THE POINT. TypeORM copies the driver's error ONTO the `QueryFailedError` it raises, so
     * `query`, `parameters` and `driverError` are its own ENUMERABLE properties — which is why an ordinary
     * `Error` stringifies to `{}` and this does not, and why every helper that ever reached for
     * `String(reason)` or `JSON.stringify(outcome)` published the statement and its bound values. Anything
     * asserted against this object is asserted against the real hazard rather than a stand-in for it.
     */
    function driverRejection(): Error {
        return Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key 'UQ_reorder_list_line_list_variant'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                query: 'INSERT INTO `reorder_list_line` (`reorderListId`, `productVariantId`) VALUES (?, ?)',
                parameters: [7, 300],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );
    }

    /** Fails naming which secret leaked, without putting the secret itself in the message. */
    function expectNoSecretIn(text: string): void {
        for (const secret of SECRETS) {
            expect(
                text.includes(secret),
                `the diagnostic disclosed a value beginning "${secret.slice(0, 3)}"`,
            ).toBe(false);
        }
    }

    // ★ THE TEARDOWN DIAGNOSTIC CASES. Each is a REAL driver or runtime message, and each is one a rule
    // that redacted quoted runs and let the rest through would have published verbatim. What is asserted
    // is not "the value was replaced" but "no part of the message was reproduced at all": the output is
    // built from three fixed lists and a length, so the message text has nowhere to appear.
    it('reproduces no part of a MySQL failure that quoted the value it refused', () => {
        const redacted = redactTeardownDiagnostic(
            new Error(`Duplicate entry '${EMAIL}' for key '${DUPLICATE_KEY_NAME}'`),
        );

        expect(redacted).toContain('[unique-violation]');
        expect(redacted).toContain('mentioning customer');
        expect(redacted).toContain('message withheld');
        expectNoSecretIn(redacted);
        // Not one word of the driver's own sentence survives, quoted or otherwise.
        expect(redacted).not.toContain('Duplicate');
    });

    it('reproduces no part of a PostgreSQL detail, whose value is in PARENTHESES and never quoted', () => {
        // THE CASE THAT DEFEATED THE PREVIOUS RULE. There is no quoted run to find, so a quote-based
        // redaction published the buyer's address unchanged.
        const redacted = redactTeardownDiagnostic(
            new Error(
                'duplicate key value violates unique constraint "customer_email_key" ' +
                    `Key (emailAddress)=(${EMAIL}) already exists.`,
            ),
        );

        expect(redacted).toContain('[unique-violation]');
        expectNoSecretIn(redacted);
        expect(redacted).not.toContain('@');
        expect(redacted).not.toContain('emailAddress');
    });

    it('reproduces no part of an unquoted, undelimited token', () => {
        // THE SECOND CASE THAT DEFEATED IT: nothing to quote, nothing to parenthesise, and the token is
        // simply a word in a sentence.
        const redacted = redactTeardownDiagnostic(new Error(`failed to invalidate session token ${TOKEN}`));

        expectNoSecretIn(redacted);
        expect(redacted).toContain('mentioning session');
        expect(redacted).toContain('message withheld');
    });

    it('reproduces no part of an absolute filesystem path', () => {
        // THE THIRD: a path is a disclosure about the host, and it carries no delimiter either.
        const redacted = redactTeardownDiagnostic(
            new Error("ENOENT: no such file or directory, open '/home/runner/work/secrets/db.sqlite'"),
        );

        expect(redacted).toContain('[filesystem]');
        expect(redacted).not.toContain('/');
        expect(redacted).not.toContain('runner');
        expect(redacted).not.toContain('secrets');
    });

    it('names the driver code, because it is an enumerated constant rather than a value', () => {
        const err = Object.assign(new Error(`Duplicate entry '${EMAIL}' for key 'x'`), {
            name: 'QueryFailedError',
            code: 'ER_DUP_ENTRY',
        });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).toContain('QueryFailedError/ER_DUP_ENTRY');
        expectNoSecretIn(redacted);
    });

    it('refuses a driver code that is not one of the three enumerated shapes', () => {
        // A `code` carrying anything other than an ER_/SQLITE_ constant or a five-character SQLSTATE is
        // not a code as far as this helper is concerned, so it is dropped rather than printed.
        const err = Object.assign(new Error('failed'), { code: TOKEN });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).not.toContain(TOKEN);
        expect(redacted).toContain('Error [unclassified]');
    });

    it('does not name an error class it does not recognise', () => {
        const err = Object.assign(new Error('failed'), { name: `LeakedFrom-${TOKEN}` });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).toContain('<unrecognised-error-class>');
        expectNoSecretIn(redacted);
    });

    it('fails CLOSED on a phrasing nobody anticipated, reporting it by length alone', () => {
        // ★ THE PROPERTY THE WHOLE DESIGN RESTS ON. An engine, a library or a future platform version
        // phrases a failure in a way none of the three lists knows, and the result is not a message that
        // slipped through unredacted — it is a length. The exact-string assertion is deliberate: a future
        // edit that started echoing any part of the message would have to change this line to pass.
        const opaque = 'q7vn41xk';
        const message = `an engine nobody has written a pattern for refused ${opaque}`;

        const redacted = redactTeardownDiagnostic(new Error(message));

        expect(redacted).toBe(
            `Error [unclassified] mentioning nothing recognised (message withheld, ${String(
                message.length,
            )} chars)`,
        );
        expect(redacted).not.toContain(opaque);
    });

    it('renders a rejection that is not an Error, and reproduces none of it either', () => {
        const redacted = redactTeardownDiagnostic(`failed on '${TOKEN}'`);

        expect(redacted).toContain('string [unclassified]');
        expectNoSecretIn(redacted);
    });

    // ★ THE STAGE LABEL, WHICH IS THE ONE PART OF AN AGGREGATED TEARDOWN FAILURE REPRODUCED VERBATIM.
    // Keeping it verbatim is what makes a failure name the step that broke; guarding it is what stops a
    // future stage from publishing whatever it interpolated into its own name.
    it('keeps an ordinary stage label verbatim, because that is what identifies the step', () => {
        expect(describeTeardownStage('plugin rows')).toBe('plugin rows');
        expect(describeTeardownStage('core row restoration 3')).toBe('core row restoration 3');
        expect(describeTeardownStage('temporary directory 1 of 2')).toBe('temporary directory 1 of 2');
    });

    it('refuses a label carrying a filesystem path, forward or back slashed', () => {
        expect(describeTeardownStage('temporary directory /tmp/reorder-abc123')).toBe(
            '<unrenderable-stage-label>',
        );
        expect(describeTeardownStage('temporary directory C:\\Users\\runner\\reorder')).toBe(
            '<unrenderable-stage-label>',
        );
        // Replaced WHOLESALE rather than trimmed, because a trimmed path is still a path.
        expect(describeTeardownStage('/home/runner/work/secrets')).not.toContain('runner');
    });

    it('refuses a label carrying an address', () => {
        expect(describeTeardownStage(`restore ${EMAIL}`)).toBe('<unrenderable-stage-label>');
        expectNoSecretIn(describeTeardownStage(`restore ${EMAIL}`));
    });

    it('refuses a label that is merely too long, since every real one here is a few words', () => {
        // The case neither shape catches: a value interpolated that happens to carry no separator and no
        // `@`. Length is what is left, and it is enough, because a legitimate label is short by
        // construction.
        const overBudget = `restore ${'x'.repeat(90)}`;

        expect(describeTeardownStage(overBudget)).toBe('<unrenderable-stage-label>');
    });

    it('refuses a label carrying a control character, so a log record cannot be forged', () => {
        // ★ CWE-117. A newline or carriage return SPLITS ONE LOG RECORD INTO TWO, and the second half can be
        // spelled to read like a step that passed — so a label is a log-injection vector and not only a
        // disclosure one. None of the three original rules caught it: a newline is not a path separator, not
        // an `@`, and costs one character against the budget.
        const forged = 'writes\nfake-log-line: every teardown stage passed';
        const bell = 'writes\u0007then';
        const carriageReturn = 'writes\rthen';

        expect(describeTeardownStage(forged)).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage(bell)).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage(carriageReturn)).toBe('<unrenderable-stage-label>');
        // Replaced ENTIRELY rather than escaped: an escaped newline still reproduces the text around it.
        expect(describeTeardownStage(forged).includes('fake-log-line')).toBe(false);
    });

    it('refuses a label carrying an invisible or non-ASCII character', () => {
        // A zero-width space, a bidirectional override and a non-ASCII letter are each invisible or
        // misleading in a log while still carrying data, and none of them trips a separator, an `@` or the
        // budget. The rule is the complement of a small ASCII allowlist for exactly this reason.
        expect(describeTeardownStage('writes\u200bthen')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('writes\u202ethen')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('restore Café')).toBe('<unrenderable-stage-label>');
    });

    it('accepts both substitute forms, so a guarded label cannot be guarded twice into a different one', () => {
        // The substitutes are themselves labels — `describeTeardownStage` is applied at more than one layer,
        // and a driver that has already normalised a label hands the result to a renderer that normalises
        // again. Both forms must survive that, or a participant's identity would change between layers.
        expect(describeTeardownStage('<unrenderable-stage-label>')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('<participant-1>')).toBe('<participant-1>');
        expect(describeTeardownStage('<participant-12>')).toBe('<participant-12>');
    });

    /**
     * ★ THE END-TO-END PROPERTY, ASSERTED THROUGH THE AGGREGATOR RATHER THAN THROUGH ITS PARTS.
     *
     * The two cases above and the ten before them exercise `describeTeardownStage` and
     * `redactTeardownDiagnostic` directly, which pins what each one does and says nothing about whether
     * the aggregator uses them. That is exactly the gap an edit closes by accident: a future revision that
     * went back to interpolating `stage.what` raw would leave every one of those cases green. So this one
     * drives the real `runAllTeardownStages` with a stage whose label carries a path and whose failure
     * carries the same path, and reads the thrown aggregate — which is the string a build log receives.
     */
    it('routes both the label and the failure through their guards when it aggregates', async () => {
        const hostPath = '/tmp/reorder-abc123';
        let aggregated = '';

        try {
            await runAllTeardownStages([
                {
                    what: `temporary directory ${hostPath}`,
                    run: () => Promise.reject(new Error(`ENOENT, no such file or directory '${hostPath}'`)),
                },
            ]);
        } catch (err: unknown) {
            aggregated = err instanceof Error ? err.message : String(err);
        }

        expect(aggregated).toContain('Teardown did not complete cleanly');
        // The label was refused wholesale, and the failure was classified rather than reproduced.
        expect(aggregated).toContain('<unrenderable-stage-label>');
        expect(aggregated).toContain('[filesystem]');
        expect(aggregated).toContain('message withheld');
        // AND NOT ONE PATH CHARACTER SURVIVED. Asserting the separator rather than the path is the
        // stronger statement: it holds for a path this test never thought of.
        expect(aggregated).not.toContain(hostPath);
        expect(aggregated).not.toContain('/');
    });

    it('is bounded by construction, so no budget has to cut a literal in half', () => {
        const redacted = redactTeardownDiagnostic(new Error(`${'padding '.repeat(600)}${TOKEN}`));

        expect(redacted.length).toBeLessThan(200);
        expect(redacted).not.toContain('<truncated>');
        expectNoSecretIn(redacted);
    });

    // ★ THE SHAPES A REAL DRIVER FAILURE CARRIES BESIDE ITS MESSAGE. `JSON.stringify` of an ordinary
    // `Error` yields `{}`, because its own properties are non-enumerable — which is what made serialising a
    // rejected outcome look safe. A TypeORM `QueryFailedError` is not an ordinary Error: it copies the
    // driver's error onto itself, so `query`, `parameters` and the driver's own fields are ENUMERABLE OWN
    // PROPERTIES and a serialisation publishes every one of them. These two cases pin that this module reads
    // only the message, the class and an enumerated code, whatever else the object is carrying.
    it('reads nothing but the message, class and code from a driver error carrying query and parameters', () => {
        const driverFailure = Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key '${DUPLICATE_KEY_NAME}'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                query: 'INSERT INTO `customer` (`emailAddress`, `phoneNumber`) VALUES (?, ?)',
                parameters: [EMAIL, '+44 7700 900000'],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );

        const redacted = redactTeardownDiagnostic(driverFailure);

        expect(redacted).toContain('QueryFailedError/ER_DUP_ENTRY');
        expect(redacted).toContain('[unique-violation]');
        expectNoSecretIn(redacted);
        // NOT THE SQL, AND NOT THE BOUND VALUES.
        expect(redacted).not.toContain('INSERT');
        expect(redacted).not.toContain('VALUES');
        expect(redacted).not.toContain('phoneNumber');
        expect(redacted).not.toContain('7700');
        expect(redacted).not.toContain('23000');
    });

    it('reproduces no part of a statement fragment, even one with no value in it at all', () => {
        // A statement is a disclosure in its own right — it names columns and the shape of a write — and the
        // message is where a driver puts it.
        const redacted = redactTeardownDiagnostic(
            new Error(
                'error: syntax error at or near "SELCT" — ' +
                    'SELECT "id", "emailAddress", "passwordHash" FROM "user" WHERE "identifier" = $1',
            ),
        );

        expect(redacted).toContain('[syntax]');
        expect(redacted).not.toContain('SELECT');
        expect(redacted).not.toContain('passwordHash');
        expect(redacted).not.toContain('$1');
        // The schema name it mentioned IS reported, because that is this module's own literal and it is the
        // one datum that locates the fault.
        expect(redacted).toContain('mentioning user');
    });

    it('reproduces no part of a bound parameter that arrived as the whole rejection', () => {
        // A rejection that is a bare value rather than an Error: the parameter itself, thrown.
        const redacted = redactTeardownDiagnostic([TOKEN, EMAIL]);

        expect(redacted).toContain('object [unclassified]');
        expectNoSecretIn(redacted);
    });
    // ★ THE OUTCOME DESCRIBER, WHICH IS THE HELPER THE RACE CASES REACH FOR. Every barriered pair in this
    // package reports through it, and a participant of one writes straight through the repository — so the
    // reason it carries is the most sensitive error object the package ever holds. These cases exercise the
    // helper boundary itself rather than the redactor beneath it, because that boundary is where four separate
    // copies of the rendering used to interpolate `reason.message`.
    describe('the settled-outcome describer the race cases report through', () => {
        it('describes a rejected participant by class, code and errno and reproduces none of its message', () => {
            const described = describeSettledOutcomes([
                { label: 'writes-first', status: 'fulfilled' },
                { label: 'writes-the-duplicate', status: 'rejected', reason: driverRejection() },
            ]);

            expect(described).toContain('writes-first=fulfilled');
            expect(described).toContain('writes-the-duplicate REJECTED:');
            expect(described).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(described).toContain('[unique-violation]');
            // The named object IS reported, because it is one of this package's own literals and it is what
            // locates the fault.
            expect(described).toContain('UQ_reorder_list_line_list_variant');
            expectNoSecretIn(described);
            // AND NOTHING THE DRIVER CARRIED BESIDE ITS MESSAGE.
            expect(described).not.toContain('INSERT');
            expect(described).not.toContain('VALUES');
            expect(described).not.toContain('23000');
            expect(described).not.toContain('Duplicate');
        });

        it("describes a fulfilled participant through the caller's own value describer", () => {
            // A value is the suite's own domain object rather than anything a driver produced, so each suite
            // decides what about it is worth saying — and a rejected participant never reaches that callback.
            const described = describeSettledOutcomes(
                [
                    { label: 'a', status: 'fulfilled', value: 'ReorderList' },
                    { label: 'b', status: 'rejected', reason: driverRejection() },
                ],
                outcome => String((outcome as { value?: unknown }).value ?? 'unknown'),
            );

            expect(described).toContain('a=ReorderList');
            expect(described).toContain('b REJECTED:');
            expectNoSecretIn(described);
        });

        it('refuses a participant label that carries a value', () => {
            const described = describeSettledOutcomes([
                { label: `restores ${EMAIL}`, status: 'rejected', reason: new Error('failed') },
            ]);

            expect(described).toContain('<unrenderable-stage-label>');
            expectNoSecretIn(described);
        });

        it('describes a participant with no label at all', () => {
            const described = describeSettledOutcomes([{ status: 'rejected', reason: driverRejection() }]);

            expect(described.startsWith('REJECTED:')).toBe(true);
            expectNoSecretIn(described);
        });

        it('reports a numeric driver errno and refuses one outside the enumerated range', () => {
            const inRange = redactTeardownDiagnostic(Object.assign(new Error('lock'), { errno: 3572 }));
            const outOfRange = redactTeardownDiagnostic(
                Object.assign(new Error('lock'), { errno: 1_700_000_000_000 }),
            );

            expect(inRange).toContain('#3572');
            expect(outOfRange).not.toContain('1700000000000');
            expect(outOfRange).not.toContain('#');
        });
    });

    // ★ THE THROWING BOUNDARY. `runAllTeardownStages` covers a QUEUED restoration; what it cannot cover is a
    // restoration driven directly from a test body so the functional half can be asserted while the server is
    // still up. Those calls are outside the aggregator, and the statements they run bind CAPTURED CELLS — so a
    // driver failure from one arrives holding the very `customer`, `user` and `session` values the restoration
    // was putting back. These cases assert the boundary refuses to pass any of it on.
    describe('the redacting rethrow every raw restoration statement passes through', () => {
        it('raises a failure that reproduces no part of the statement, its parameters or its message', () => {
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', driverRejection());
            } catch (err: unknown) {
                thrown = err;
            }

            expect(thrown).toBeInstanceOf(Error);
            const message = (thrown as Error).message;
            // What a reader NEEDS: which step, which error class, which enumerated driver code and errno, how
            // the failure classifies, and which schema object the driver named.
            expect(message).toContain('a captured-row restoration statement failed');
            expect(message).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(message).toContain('[unique-violation]');
            // What it must NOT carry: the statement, the bound values, the driver's sentence, the SQLSTATE.
            expect(message).not.toContain('INSERT');
            expect(message).not.toContain('reorder_list_line` (`reorderListId');
            expect(message).not.toContain('VALUES');
            expect(message).not.toContain('23000');
            expect(message).not.toContain('Duplicate');
            expectNoSecretIn(message);
        });

        it('does not chain the original, because a cause is walked and printed by the runner', () => {
            // Attaching the caught error as `cause` would republish through the chain exactly what the
            // message no longer says — and it would do so invisibly, since the message itself would read
            // clean. Asserted rather than left to reading, because `cause` is the natural thing to add.
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', driverRejection());
            } catch (err: unknown) {
                thrown = err;
            }

            expect((thrown as { cause?: unknown }).cause).toBeUndefined();
            // And nothing arrived as an own enumerable property either, which is the other way a serialising
            // reporter would find the driver payload.
            expect(JSON.stringify(thrown)).toBe('{}');
        });

        it('refuses a step label that carries a value, so the boundary cannot be talked into leaking one', () => {
            let thrown: unknown;
            try {
                rethrowRedacted(`restoring ${EMAIL}`, new Error('nope'));
            } catch (err: unknown) {
                thrown = err;
            }

            expectNoSecretIn((thrown as Error).message);
        });

        it('measures a rejection that is a bare bound value rather than an Error', () => {
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', [TOKEN, EMAIL]);
            } catch (err: unknown) {
                thrown = err;
            }

            expectNoSecretIn((thrown as Error).message);
        });
    });

    // ★ THE ROW-DIFFERENCE DESCRIPTION the restoration assertion in every functional suite reports, and the
    // one the migration suite's revert assertion reports. The rows being compared are a real buyer's
    // `customer`, `user` and `session` rows, and on the migration path the whole seeded `customer` table — so
    // this description is the difference between naming the column that moved and publishing everyone's
    // contact details. It lived in four suites as four byte-identical copies before it lived here.
    describe('the row-difference description the restoration assertions report', () => {
        it('names the row and the column of a moved cell, and neither of its values', () => {
            const captured = [
                { id: 7, token: TOKEN, invalidated: false, expires: new Date(1_700_000_000_000) },
            ];
            const now = [{ id: 7, token: `${TOKEN}xx`, invalidated: true, expires: null }];

            const described = describeRowDifferences(captured, now);

            // The column, and the SHAPE of each side — which is enough to see that a 26-character string
            // became a 28-character one, and not enough to see either string.
            expect(described).toContain(
                `row 7.token moved (string(${String(TOKEN.length)}) -> string(${String(TOKEN.length + 2)}))`,
            );
            // Numbers, booleans and nulls are the identifiers and flags a reader needs, and none of them can
            // carry a credential, so those are rendered as themselves.
            expect(described).toContain('row 7.invalidated moved (false -> true)');
            expect(described).toContain('row 7.expires moved (date -> null)');
            expectNoSecretIn(described);
        });

        it('still detects a change the shape alone cannot distinguish', () => {
            // Same type and same length on both sides, so the two descriptions are identical — and the
            // difference is found anyway. This is the case that proves the COMPARISON is still over the full
            // values and did not become a comparison of the descriptions.
            const captured = [{ id: 5, emailAddress: EMAIL }];
            const now = [{ id: 5, emailAddress: 'X'.repeat(EMAIL.length) }];

            expect(describeRowDifferences(captured, now)).toBe(
                `row 5.emailAddress moved (string(${String(EMAIL.length)}) -> string(${String(EMAIL.length)}))`,
            );
        });

        it('reports a vanished row and an arrived row by identifier alone', () => {
            const described = describeRowDifferences([{ id: 7, token: TOKEN }], [{ id: 9, token: TOKEN }]);

            expect(described).toContain('row 7 is missing');
            expect(described).toContain('row 9 was added');
            expectNoSecretIn(described);
        });

        it('says nothing when every cell matches, which is what the restoration assertion requires', () => {
            const captured = [{ id: 7, token: TOKEN, expires: new Date(1_700_000_000_000) }];

            expect(describeRowDifferences(captured, [{ ...captured[0] }])).toBe(NO_ROW_DIFFERENCE);
        });

        it('compares through the same canonicalisation two drivers are folded onto', () => {
            // A boolean column arrives as `true` from PostgreSQL and as `1` from the MySQL family, and the
            // same stored value read twice must not read as a difference. This is what keeps a cross-engine
            // restoration assertion from failing on the driver rather than on the data.
            expect(canonicaliseCell(true)).toBe(canonicaliseCell(1));
            expect(canonicaliseCell(false)).toBe(canonicaliseCell(0));
            expect(describeRowDifferences([{ id: 1, enabled: true }], [{ id: 1, enabled: 1 }])).toBe(
                NO_ROW_DIFFERENCE,
            );
        });
    });
});
