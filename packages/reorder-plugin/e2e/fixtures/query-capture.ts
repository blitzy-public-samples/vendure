/**
 * The canonical query-capture instrument for the reorder plugin's end-to-end suite.
 */
import { generateMigration, resetConfig, VendureConfig } from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
    DataSource,
    DataSourceOptions,
    MigrationInterface,
    QueryRunner,
    Logger as TypeOrmLoggerInterface,
} from 'typeorm';
import * as ts from 'typescript';

import { describeTeardownStage, redactTeardownDiagnostic } from './concurrency-barrier';

/**
 * The leading-keyword classification of a captured statement.
 */
export type CapturedStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'other';

export interface CapturedStatement {
    query: string;
    parameters: unknown[];
    /** Leading-keyword classification. See {@link CapturedStatementKind}. */
    kind: CapturedStatementKind;
    /**
     * The TypeORM driver type of the connection that issued the statement — `'postgres'`, `'mysql'`,
     * `'mariadb'`, `'sqljs'` and so on — or `undefined` when no query runner was supplied.
     */
    dialect?: string;
    /**
     * The table tokens extracted from table *positions* only — after `FROM`, `INTO`, `UPDATE` and every `JOIN` form
     * — lower-cased and de-duplicated in first-seen order.
     */
    tables: string[];
    /**
     * The table (or tables) this statement **writes**, taken from its own outermost `INSERT INTO` /
     * `UPDATE` / `DELETE FROM` clause and never from a sub-query — empty for a statement that is not a
     * row-level write.
     */
    targetTables: string[];
    sequence: number;
    /**
     * A stable identifier for the `QueryRunner` that issued the statement, so statements can be
     * grouped by connection and by transaction. `undefined` when TypeORM supplied no query runner.
     */
    runnerId: number | undefined;
    /**
     * `queryRunner.isTransactionActive` as observed at capture time, or `undefined` when no query
     * runner was supplied or the flag could not be read.
     */
    inTransaction: boolean | undefined;
    /**
     * Set only for a statement TypeORM reported through `logQueryError`. The error is attached to
     * the statement's existing record rather than producing a second one; see
     * {@link QueryCaptureLogger.logQueryError}.
     */
    error?: string;
}

/**
 * One message observed through TypeORM's general-purpose `log` hook.
 */
export interface CapturedLogMessage {
    level: 'log' | 'info' | 'warn';
    message: string;
}

/**
 * The `mergeConfig`-ready fragment returned by {@link queryCaptureConfig}.
 *
 * A fresh plain object wrapping the class instance. The instance itself is what must survive the
 * merge, and it does, because `mergeConfig` assigns a class instance by reference.
 */
export interface QueryCaptureConfigFragment {
    dbConnectionOptions: {
        logger: QueryCaptureLogger;
    };
}

/**
 * The identifier-quoting characters the four target engines emit. `dataSource.driver.escape()`
 * produces backticks on MySQL and MariaDB and double quotes on PostgreSQL and SQLite — the shipped
 * idiom that makes this engine-dependent is at
 * `packages/core/e2e/migrate-product-option-groups.e2e-spec.ts:L35`. Square brackets are included
 * so a bracket-quoted identifier degrades to the same token form.
 */
const IDENTIFIER_QUOTE_CHARACTERS = /["`[\]]/g;

/**
 * Words that may sit between a table-introducing keyword and the table itself:
 * `CREATE TABLE IF NOT EXISTS "x"`, `DROP TABLE IF EXISTS "x"` and PostgreSQL's `FROM ONLY "t"`.
 * None of them is a table name in this schema, so reading past them is unambiguous.
 */
const SKIPPABLE_PRE_TABLE_WORDS = ['if', 'not', 'exists', 'only'];

/**
 * Words which, standing **immediately** before `UPDATE`, mean that `UPDATE` introduces no table: `SELECT ... FOR
 * UPDATE`, `... ON UPDATE CASCADE` and PostgreSQL's `INSERT ... ON CONFLICT DO UPDATE SET col = ...`.
 */
const NON_TABLE_UPDATE_PREDECESSORS = ['for', 'on', 'do'];

/**
 * SQL syntax words that can occupy a table position in an unusual or malformed scan and are
 * certainly not tables in this schema.
 */
const NON_TABLE_IDENTIFIERS = [
    'action',
    'and',
    'as',
    'cascade',
    'default',
    'dual',
    'locked',
    'no',
    'not',
    'nowait',
    'null',
    'of',
    'on',
    'or',
    'outfile',
    'restrict',
    'select',
    'set',
    'share',
    'skip',
    'values',
    'where',
];

/**
 * The single-word clause keywords that end a `WHERE` portion. Truncating at these is what stops a column named only
 * in the sort or in a `RETURNING` list from counting as a predicate conjunct.
 */
const WHERE_TERMINATOR_WORDS = [
    'having',
    'limit',
    'offset',
    'returning',
    'window',
    'union',
    'intersect',
    'except',
];

/**
 * The two-word clause keywords that end a `WHERE` portion, as a first word and the second words that
 * complete it. `ORDER` alone does not terminate — `ORDER BY` does — so the pair is required, which is
 * also what keeps a column named `order` from being read as a clause boundary.
 */
const WHERE_TERMINATOR_PAIRS: Array<{ readonly first: string; readonly seconds: string[] }> = [
    { first: 'group', seconds: ['by'] },
    { first: 'order', seconds: ['by'] },
    { first: 'fetch', seconds: ['first', 'next'] },
    { first: 'for', seconds: ['update', 'share'] },
];

/**
 * The character budget applied to the statement text in {@link QueryCaptureLogger.format}. It is a
 * control value for a diagnostic dump and expresses no claim about the statement it truncates.
 */
const DEFAULT_FORMATTED_QUERY_LENGTH = 240;

/**
 * The row-level DML keywords, lower-cased, in the order they are searched for. Used by the
 * common-table-expression walk in {@link classifyStatement} to identify both the terminal statement
 * of a `WITH` and a data-modifying CTE body.
 */
const DML_LEADING_KEYWORDS: Array<{ readonly word: string; readonly kind: CapturedStatementKind }> = [
    { word: 'select', kind: 'select' },
    { word: 'insert', kind: 'insert' },
    { word: 'replace', kind: 'insert' },
    { word: 'update', kind: 'update' },
    { word: 'delete', kind: 'delete' },
];

/**
 * The kinds that count as a row-level write, and therefore what {@link QueryCaptureLogger.writesFor}
 * returns. Declared here rather than beside that method because {@link classifyStatement}'s
 * common-table-expression walk consults it too — a data-modifying CTE is classified by the same rule
 * that decides whether a statement is a write at all.
 */
const WRITE_KINDS: CapturedStatementKind[] = ['insert', 'update', 'delete'];

function isWhitespace(character: string | undefined): boolean {
    return (
        character === ' ' ||
        character === '\t' ||
        character === '\n' ||
        character === '\r' ||
        character === '\f'
    );
}

function isIdentifierStart(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierCharacter(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

/**
 * Replaces every identifier-quoting character with a space, so one code path handles all four
 * engines. Replacing rather than deleting matters: it keeps `"reorder_list"("createdAt"` from
 * collapsing into a single token.
 */
function stripIdentifierQuotes(query: string): string {
    return query.replace(IDENTIFIER_QUOTE_CHARACTERS, ' ');
}

/**
 * Removes leading whitespace, leading SQL comments (`-- line` and block comments) and any leading
 * `(` so that classification looks at the statement's real first keyword.
 */
function stripLeadingNoise(query: string, lexicon: DialectLexicon = UNKNOWN_LEXICON): string {
    let text = query;
    for (;;) {
        const trimmed = text.replace(/^\s+/, '');
        if (trimmed.indexOf('--') === 0) {
            const lineEnd = trimmed.indexOf('\n');
            text = lineEnd === -1 ? '' : trimmed.slice(lineEnd + 1);
            continue;
        }
        if (trimmed.charAt(0) === '#' && lexicon.hashComments) {
            text =
                skipHashComment(trimmed, 0) >= trimmed.length
                    ? ''
                    : trimmed.slice(skipHashComment(trimmed, 0));
            continue;
        }
        if (trimmed.indexOf('/*') === 0) {
            const blockEnd = skipBlockComment(trimmed, 0, lexicon);
            if (executableCommentBodyRuns(trimmed, 0, lexicon)) {
                // The engine executes this body, so the statement's real leading keyword is inside it —
                text = executableCommentBody(trimmed, 0, blockEnd) + trimmed.slice(blockEnd);
                continue;
            }
            text = blockEnd >= trimmed.length ? '' : trimmed.slice(blockEnd);
            continue;
        }
        if (trimmed.charAt(0) === '(') {
            text = trimmed.slice(1);
            continue;
        }
        return trimmed;
    }
}

/**
 * The leading keyword of a statement fragment, lower-cased, or `undefined` when the fragment starts
 * with something that is not a word. Leading whitespace, SQL comments and an opening `(` are
 * discarded first, so `  /* hint *&#47; ( select 1 )` yields `select`.
 */
function leadingKeyword(fragment: string, lexicon: DialectLexicon = UNKNOWN_LEXICON): string | undefined {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(stripLeadingNoise(fragment, lexicon));
    return match === null ? undefined : match[1].toLowerCase();
}

/**
 * Maps a leading keyword to the kind it introduces, or `undefined` when the word introduces no
 * row-level DML.
 */
function dmlKindForKeyword(word: string | undefined): CapturedStatementKind | undefined {
    if (word === undefined) {
        return undefined;
    }
    for (const candidate of DML_LEADING_KEYWORDS) {
        if (candidate.word === word) {
            return candidate.kind;
        }
    }
    return undefined;
}

/**
 * Classifies a `WITH` statement by **parsing its common-table-expression prologue structurally**, definition by
 * definition, and then reading the keyword that follows the last one.
 */
function classifyCteStatement(
    query: string,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): CapturedStatementKind | undefined {
    const withKeyword = readWord(query, 0, lexicon);
    if (withKeyword === undefined || withKeyword.word !== 'with') {
        return undefined;
    }
    let index = withKeyword.end;
    const recursive = readWord(query, index, lexicon);
    if (recursive !== undefined && recursive.word === 'recursive') {
        index = recursive.end;
    }

    let cteBodyWrite: CapturedStatementKind | undefined;
    for (;;) {
        let cursor = skipTrivia(query, index, lexicon);
        if (cursor >= query.length) {
            return undefined;
        }
        const aliasCharacter = query.charAt(cursor);
        if (aliasCharacter === '"' || aliasCharacter === '`' || aliasCharacter === '[') {
            cursor = skipQuotedIdentifier(query, cursor);
        } else {
            const alias = readWord(query, cursor, lexicon);
            if (alias === undefined) {
                return undefined;
            }
            cursor = alias.end;
        }

        let next = skipTrivia(query, cursor, lexicon);
        if (query.charAt(next) === '(') {
            const closing = findMatchingParenthesis(query, next, lexicon);
            if (closing === -1) {
                return undefined;
            }
            cursor = closing + 1;
            next = skipTrivia(query, cursor, lexicon);
        }

        const asKeyword = readWord(query, cursor, lexicon);
        if (asKeyword === undefined || asKeyword.word !== 'as') {
            return undefined;
        }
        cursor = asKeyword.end;
        const notKeyword = readWord(query, cursor, lexicon);
        if (notKeyword !== undefined && notKeyword.word === 'not') {
            cursor = notKeyword.end;
        }
        const materialized = readWord(query, cursor, lexicon);
        if (materialized !== undefined && materialized.word === 'materialized') {
            cursor = materialized.end;
        }

        const bodyStart = skipTrivia(query, cursor, lexicon);
        if (query.charAt(bodyStart) !== '(') {
            return undefined;
        }
        const bodyEnd = findMatchingParenthesis(query, bodyStart, lexicon);
        if (bodyEnd === -1) {
            return undefined;
        }
        const bodyKind = dmlKindForKeyword(leadingKeyword(query.slice(bodyStart + 1, bodyEnd), lexicon));
        if (cteBodyWrite === undefined && bodyKind !== undefined && WRITE_KINDS.indexOf(bodyKind) !== -1) {
            cteBodyWrite = bodyKind;
        }
        index = bodyEnd + 1;

        const afterBody = skipTrivia(query, index, lexicon);
        if (query.charAt(afterBody) !== ',') {
            index = afterBody;
            break;
        }
        index = afterBody + 1;
    }

    const terminalWord = readWord(query, index, lexicon);
    const terminal = dmlKindForKeyword(terminalWord === undefined ? undefined : terminalWord.word);
    if (terminal !== undefined && WRITE_KINDS.indexOf(terminal) !== -1) {
        return terminal;
    }
    if (cteBodyWrite !== undefined) {
        return cteBodyWrite;
    }
    return terminal;
}

/**
 * Returns the index of the `)` matching the `(` at `openIndex`, or `-1` when the statement is
 * unbalanced.
 */
function findMatchingParenthesis(
    text: string,
    openIndex: number,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): number {
    let depth = 0;
    let index = openIndex;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'") {
            index = skipStringLiteral(text, index);
            continue;
        }
        if (character === '"' || character === '`' || character === '[') {
            index = skipQuotedIdentifier(text, index);
            continue;
        }
        if (character === '-' && text.charAt(index + 1) === '-') {
            index = skipLineComment(text, index);
            continue;
        }
        if (character === '#' && lexicon.hashComments) {
            index = skipHashComment(text, index);
            continue;
        }
        if (character === '/' && text.charAt(index + 1) === '*') {
            // Nested where the engine nests: a PostgreSQL CTE body containing `/* a /* b *&#47; c *&#47;`
            index = skipBlockComment(text, index, lexicon);
            continue;
        }
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
        index++;
    }
    return -1;
}

/**
 * Returns the index immediately after the `--` line comment starting at `openIndex`. An unterminated
 * comment consumes the rest of the text.
 */
function skipLineComment(text: string, openIndex: number): number {
    const lineEnd = text.indexOf('\n', openIndex);
    return lineEnd === -1 ? text.length : lineEnd + 1;
}

/**
 * Returns the index immediately after the block comment starting at `openIndex`. An unterminated comment consumes
 * the rest of the text.
 */
function skipBlockComment(
    text: string,
    openIndex: number,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): number {
    if (!lexicon.nestedBlockComments) {
        const blockEnd = text.indexOf('*/', openIndex + 2);
        return blockEnd === -1 ? text.length : blockEnd + 2;
    }
    let depth = 1;
    let index = openIndex + 2;
    while (index < text.length) {
        if (text.charAt(index) === '/' && text.charAt(index + 1) === '*') {
            depth++;
            index += 2;
            continue;
        }
        if (text.charAt(index) === '*' && text.charAt(index + 1) === '/') {
            depth--;
            index += 2;
            if (depth === 0) {
                return index;
            }
            continue;
        }
        index++;
    }
    return text.length;
}

/**
 * Returns the index immediately after a `#` line comment, which runs to the end of the line.
 */
function skipHashComment(text: string, openIndex: number): number {
    const lineEnd = text.indexOf('\n', openIndex);
    return lineEnd === -1 ? text.length : lineEnd + 1;
}

/**
 * Returns the index immediately after the quoted identifier starting at `openIndex`, for all three
 * quoting styles the four target engines use: `"pg and sqlite"`, `` `mysql and mariadb` `` and
 * `[bracketed]`. A doubled closing quote (`""`) is treated as an escaped quote inside the identifier,
 * which is the SQL convention.
 */
function skipQuotedIdentifier(text: string, openIndex: number): number {
    const opener = text.charAt(openIndex);
    const closer = opener === '[' ? ']' : opener;
    let index = openIndex + 1;
    while (index < text.length) {
        if (text.charAt(index) === closer) {
            if (closer !== ']' && text.charAt(index + 1) === closer) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index++;
    }
    return text.length;
}

/**
 * Returns the index of the next character that is neither whitespace nor part of a comment, starting
 * at `fromIndex`. This is the one place trivia is defined, so every structural scan in this module
 * skips exactly the same things.
 */
function skipTrivia(text: string, fromIndex: number, lexicon: DialectLexicon = UNKNOWN_LEXICON): number {
    let index = fromIndex;
    while (index < text.length) {
        const character = text.charAt(index);
        if (isWhitespace(character)) {
            index++;
            continue;
        }
        if (character === '-' && text.charAt(index + 1) === '-') {
            index = skipLineComment(text, index);
            continue;
        }
        if (character === '#' && lexicon.hashComments) {
            // Trivia on MySQL and MariaDB. Without this a `#` note anywhere inside a CTE prologue —
            // parse dead, the statement classifies `other`, and the delete disappears from writesFor().
            index = skipHashComment(text, index);
            continue;
        }
        if (character === '/' && text.charAt(index + 1) === '*') {
            index = skipBlockComment(text, index, lexicon);
            continue;
        }
        return index;
    }
    return text.length;
}

/**
 * Reads the bare word at `fromIndex` — after skipping trivia — returning it lower-cased together with
 * the index just past it. Returns `undefined` when the next thing is not a bare word, which includes a
 * quoted identifier, a literal, a parenthesis and the end of the text.
 */
function readWord(
    text: string,
    fromIndex: number,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): { word: string; end: number } | undefined {
    const start = skipTrivia(text, fromIndex, lexicon);
    if (start >= text.length || !isIdentifierStart(text.charAt(start))) {
        return undefined;
    }
    let end = start;
    while (end < text.length && isIdentifierCharacter(text.charAt(end))) {
        end++;
    }
    return { word: text.slice(start, end).toLowerCase(), end };
}

/**
 * Returns the index immediately after the single-quoted string literal starting at `openIndex`,
 * honouring the SQL doubling convention (`''`) for an embedded quote. Where the literal is never
 * closed, the end of the text is returned, so a malformed statement terminates the scan rather than
 * looping.
 */
function skipStringLiteral(text: string, openIndex: number): number {
    let index = openIndex + 1;
    while (index < text.length) {
        if (text.charAt(index) === "'") {
            if (text.charAt(index + 1) === "'") {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index++;
    }
    return text.length;
}

/**
 * @description Extracts the tables a statement references, from table **positions** only.
 */
export function extractStatementTables(query: string, dialect?: string): string[] {
    if (typeof query !== 'string' || query.length === 0) {
        return [];
    }
    const tables: string[] = [];
    try {
        const tokens = tokeniseForTableScan(query, lexiconFor(dialect));
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.kind !== 'word') {
                // Only a *bare* word can introduce a table. A quoted token is a name or a value, never
                // syntax, which is what stops MySQL's `SELECT "FROM" reorder_list` — a table-less select
                // unrelated statement could then stand in for a missing plugin write.
                continue;
            }
            if (!introducesTable(tokens, index)) {
                continue;
            }
            for (const candidate of tableTokensAfter(tokens, index + 1)) {
                const normalised = candidate.toLowerCase();
                if (NON_TABLE_IDENTIFIERS.indexOf(normalised) === -1 && tables.indexOf(normalised) === -1) {
                    tables.push(normalised);
                }
            }
        }
    } catch {
        // test, so the statement is reported as referencing no table rather than throwing. The
        // statement itself is still captured, and `format()` still shows its text.
        return [];
    }
    return tables;
}

/**
 * @description The table (or tables) a row-level write **actually targets**, as distinct from every table the
 * statement mentions.
 */
export function extractStatementTargetTables(query: string, dialect?: string): string[] {
    if (typeof query !== 'string' || query.length === 0) {
        return [];
    }
    try {
        if (WRITE_KINDS.indexOf(classifyStatement(query, dialect)) === -1) {
            return [];
        }
        const tokens = tokeniseForTableScan(query, lexiconFor(dialect));
        const targets = writeTargetsFromTokens(tokens);
        return targets.length > 0 ? targets : extractStatementTables(query, dialect);
    } catch {
        return extractStatementTables(query, dialect);
    }
}

/**
 * Locates the target list of the first row-level write keyword at parenthesis depth zero.
 */
function writeTargetsFromTokens(tokens: ScanToken[]): string[] {
    let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'other') {
            if (token.text === '(') {
                depth++;
            } else if (token.text === ')') {
                depth = depth > 0 ? depth - 1 : 0;
            }
            continue;
        }
        if (token.kind !== 'word' || depth !== 0) {
            continue;
        }
        if (token.text === 'with') {
            // A CTE-prefixed statement. Refused here, and answered by the caller's fallback.
            return [];
        }
        if (token.text === 'insert' || token.text === 'replace') {
            // `INSERT INTO t`, and the MySQL forms that put a modifier first — `INSERT IGNORE INTO t`,
            // depth-zero `INTO`; where the dialect omits `INTO` altogether the name follows the keyword
            // directly. `INTO` is skipped here rather than through {@link SKIPPABLE_PRE_TABLE_WORDS},
            // other statement form is read.
            const intoIndex = depthZeroWordIndex(tokens, index + 1, 'into');
            return normaliseTableNames(
                tableTokensAfter(tokens, intoIndex === -1 ? index + 1 : intoIndex + 1),
            );
        }
        if (token.text === 'update' && !isNonTableUpdate(tokens, index)) {
            // The certifiable shape is `UPDATE <one table> [alias] SET ...`. Recognized MySQL/MariaDB write
            // modifiers are skipped by {@link skipWriteModifiers} before the target is read. A join, a comma
            // {@link writeTargetsFromTokens}'s own note on why refusing beats guessing here.
            const setIndex = depthZeroWordIndex(tokens, index + 1, 'set');
            const updateFrom = skipWriteModifiers(tokens, index + 1);
            if (setIndex === -1 || depthZeroWordIndexBefore(tokens, updateFrom, setIndex, 'join') !== -1) {
                return [];
            }
            const updateTargets = normaliseTableNames(tableTokensAfter(tokens, updateFrom));
            return updateTargets.length === 1 ? updateTargets : [];
        }
        if (token.text === 'delete') {
            // The certifiable shape is `DELETE FROM <one table> ...`, which also covers PostgreSQL's
            // Recognized MySQL/MariaDB modifiers before `FROM` are skipped by {@link skipWriteModifiers}.
            const fromIndex = depthZeroWordIndex(tokens, index + 1, 'from');
            if (
                fromIndex === -1 ||
                namesIdentifierBetween(tokens, skipWriteModifiers(tokens, index + 1), fromIndex) ||
                depthZeroWordIndex(tokens, fromIndex + 1, 'join') !== -1
            ) {
                return [];
            }
            const deleteTargets = normaliseTableNames(tableTokensAfter(tokens, fromIndex + 1));
            return deleteTargets.length === 1 ? deleteTargets : [];
        }
    }
    return [];
}

/**
 * Words MySQL and MariaDB permit between a write keyword and its target table.
 */
const WRITE_MODIFIER_WORDS = ['low_priority', 'high_priority', 'quick', 'delayed', 'ignore', 'concurrent'];

/** The first index at or after `from` whose token is not a {@link WRITE_MODIFIER_WORDS} entry. */
function skipWriteModifiers(tokens: ScanToken[], from: number): number {
    let cursor = from;
    while (
        cursor < tokens.length &&
        tokens[cursor].kind === 'word' &&
        WRITE_MODIFIER_WORDS.indexOf(tokens[cursor].text) !== -1
    ) {
        cursor++;
    }
    return cursor;
}

/**
 * Whether `[from, to)` contains any identifier — a bare word or a quoted name — at depth zero.
 *
 * Used to detect a write-target list, whose presence is what distinguishes MySQL's multi-table
 * `DELETE a, b FROM ...` from the ordinary `DELETE FROM ...` this scan can certify.
 */
function namesIdentifierBetween(tokens: ScanToken[], from: number, to: number): boolean {
    let depth = 0;
    for (let index = from; index < to && index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'other') {
            if (token.text === '(') {
                depth++;
            } else if (token.text === ')') {
                depth = depth > 0 ? depth - 1 : 0;
            }
            continue;
        }
        if (depth === 0 && (token.kind === 'word' || token.kind === 'quoted')) {
            return true;
        }
    }
    return false;
}

/** {@link depthZeroWordIndex} bounded above by `to`, for scanning one clause rather than the remainder. */
function depthZeroWordIndexBefore(tokens: ScanToken[], from: number, to: number, word: string): number {
    const found = depthZeroWordIndex(tokens.slice(from, Math.min(to, tokens.length)), 0, word);
    return found === -1 ? -1 : from + found;
}

/**
 * The index of the next bare `word` token equal to `word` at parenthesis depth zero, starting at `from`, or
 * `-1`. Depth is tracked from the starting point, so a sub-query opened after it cannot supply the match.
 */
function depthZeroWordIndex(tokens: ScanToken[], from: number, word: string): number {
    let depth = 0;
    for (let index = from; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'other') {
            if (token.text === '(') {
                depth++;
            } else if (token.text === ')') {
                depth = depth > 0 ? depth - 1 : 0;
            }
            continue;
        }
        if (depth === 0 && token.kind === 'word' && token.text === word) {
            return index;
        }
    }
    return -1;
}

/** One lexical token of a statement, as much as the table scan needs to distinguish. */
interface ScanToken {
    /**
     * `word` is a bare keyword or identifier; `quoted` is a delimited identifier, carrying its decoded
     * text; `other` is punctuation. Literals and comments produce no token at all — they are the text
     * the database will not execute, and a table name written inside one is data.
     */
    readonly kind: 'word' | 'quoted' | 'other';
    readonly text: string;
}

/**
 * Tokenises a statement for the table scan, discarding everything the database will not execute.
 */
function tokeniseForTableScan(query: string, lexicon: DialectLexicon): ScanToken[] {
    const tokens: ScanToken[] = [];
    let index = 0;
    const length = query.length;
    while (index < length) {
        const character = query.charAt(index);
        if (isWhitespace(character)) {
            index++;
            continue;
        }
        if (character === "'") {
            index = skipStringLiteral(query, index);
            continue;
        }
        const dollarQuote = matchDollarQuoteAt(query, index);
        if (dollarQuote !== undefined) {
            index = dollarQuote;
            continue;
        }
        if (character === '-' && query.charAt(index + 1) === '-') {
            index = skipLineComment(query, index);
            continue;
        }
        if (character === '#' && lexicon.hashComments) {
            // A `#` comment is trivia on MySQL and MariaDB, so neither it nor the rest of its line may
            // contribute tokens — otherwise the words inside it read as syntax and can invent a table.
            index = skipHashComment(query, index);
            continue;
        }
        if (character === '/' && query.charAt(index + 1) === '*') {
            const end = skipBlockComment(query, index, lexicon);
            if (executableCommentBodyRuns(query, index, lexicon)) {
                // Not a comment on this engine. `/*! ... *&#47;` and MariaDB's `/*M! ... *&#47;` are
                // *executed* by the MySQL family, so `/*! DELETE FROM reorder_list *&#47;` really does
                // delete rows. Dropping the body would leave the statement with no tables and a kind of
                // therefore tokenised in place — recursively, so a nested quoted or dotted name inside it
                for (const inner of tokeniseForTableScan(executableCommentBody(query, index, end), lexicon)) {
                    tokens.push(inner);
                }
            }
            index = end;
            continue;
        }
        if (character === '"' || character === '`' || character === '[') {
            const end = skipQuotedIdentifier(query, index);
            if (character === '"' && lexicon.doubleQuote === 'string') {
                // The engine reads this as a string literal, so it is data and produces no token.
                index = end;
                continue;
            }
            const closer = character === '[' ? ']' : character;
            const closed = end - 1 > index && query.charAt(end - 1) === closer;
            const content = closed ? query.slice(index + 1, end - 1).replace(/""/g, '"') : '';
            tokens.push({ kind: 'quoted', text: content });
            index = end;
            continue;
        }
        if (isIdentifierStart(character)) {
            let wordEnd = index;
            while (wordEnd < length && isIdentifierCharacter(query.charAt(wordEnd))) {
                wordEnd++;
            }
            tokens.push({ kind: 'word', text: query.slice(index, wordEnd).toLowerCase() });
            index = wordEnd;
            continue;
        }
        tokens.push({ kind: 'other', text: character });
        index++;
    }
    return tokens;
}

/**
 * Whether the block comment at `openIndex` is one the target engine will **execute**, so that its body must be read
 * as SQL rather than discarded.
 */
function executableCommentBodyRuns(text: string, openIndex: number, lexicon: DialectLexicon): boolean {
    return isExecutableBlockComment(text, openIndex, lexicon);
}

/**
 * The executable body of the comment spanning `[openIndex, end)` — everything after the `/*!` or `/*M!`
 * marker and its optional version digits, and before the closing `*&#47;`.
 */
function executableCommentBody(text: string, openIndex: number, end: number): string {
    let cursor = openIndex + 2;
    if (text.charAt(cursor) === 'M' || text.charAt(cursor) === 'm') {
        cursor += 1;
    }
    if (text.charAt(cursor) === '!') {
        cursor += 1;
    }
    while (cursor < end && /[0-9]/.test(text.charAt(cursor))) {
        cursor += 1;
    }
    const closingLength = text.slice(end - 2, end) === '*/' ? 2 : 0;
    return text.slice(cursor, Math.max(cursor, end - closingLength));
}

/**
 * The end index of a PostgreSQL dollar-quoted literal opening at `index`, or `undefined` when one does
 * not open there. `$1` is not one: a tag cannot begin with a digit, which is what keeps placeholders and
 * dollar quoting apart.
 */
function matchDollarQuoteAt(query: string, index: number): number | undefined {
    if (query.charAt(index) !== '$') {
        return undefined;
    }
    const opener = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(query.slice(index));
    if (opener === null) {
        return undefined;
    }
    const tag = opener[0];
    const closing = query.indexOf(tag, index + tag.length);
    return closing === -1 ? query.length : closing + tag.length;
}

function introducesTable(tokens: ScanToken[], index: number): boolean {
    const word = tokens[index].text;
    if (word === 'from' || word === 'into' || word === 'join' || word === 'table' || word === 'references') {
        return true;
    }
    if (word === 'update') {
        return !isNonTableUpdate(tokens, index);
    }
    if (word === 'to') {
        return adjacentWord(tokens, index, 1) === 'rename';
    }
    if (word === 'on') {
        return statementIsIndexDdl(tokens);
    }
    return false;
}

/**
 * Whether the `UPDATE` at `index` is the tail of a clause rather than the head of a statement:
 * `FOR UPDATE`, `ON UPDATE`, `ON DUPLICATE KEY UPDATE` or `ON CONFLICT DO UPDATE`.
 */
function isNonTableUpdate(tokens: ScanToken[], index: number): boolean {
    const previous = adjacentWord(tokens, index, 1);
    if (previous === undefined) {
        return false;
    }
    if (NON_TABLE_UPDATE_PREDECESSORS.indexOf(previous) !== -1) {
        return true;
    }
    if (previous === 'key') {
        // `KEY UPDATE` alone is not enough: it suppresses only as MySQL's `ON DUPLICATE KEY UPDATE`.
        return adjacentWord(tokens, index, 2) === 'duplicate';
    }
    return false;
}

/**
 * The text of the token `offset` positions before `index`, but **only** when it is a bare word. Any
 * punctuation or quoted token in that position yields `undefined`, which is what makes the caller's
 * matching adjacent rather than a backwards search.
 */
function adjacentWord(tokens: ScanToken[], index: number, offset: number): string | undefined {
    const position = index - offset;
    if (position < 0) {
        return undefined;
    }
    const token = tokens[position];
    return token.kind === 'word' ? token.text : undefined;
}

/** True when the statement's leading words are `CREATE [UNIQUE] INDEX` or `DROP INDEX`. */
function statementIsIndexDdl(tokens: ScanToken[]): boolean {
    const words: string[] = [];
    for (const token of tokens) {
        if (token.kind === 'word') {
            words.push(token.text);
            if (words.length === 4) {
                break;
            }
        }
    }
    if (words.length < 2) {
        return false;
    }
    if (words[0] !== 'create' && words[0] !== 'drop') {
        return false;
    }
    return words.indexOf('index') > 0 && words.indexOf('index') <= 2;
}

/**
 * Words that cannot be a table alias, so a comma after one of them is not a table-list separator.
 *
 * This list is what keeps `UPDATE reorder_list SET "name" = $1, "nameKey" = $2` from filing `nameKey`
 * as a second table: without it, `SET` reads as an alias and the comma that separates two assignments
 * reads as the comma that separates two tables.
 */
const NON_ALIAS_WORDS = [
    'set',
    'where',
    'on',
    'using',
    'values',
    'value',
    'select',
    'join',
    'inner',
    'outer',
    'left',
    'right',
    'full',
    'cross',
    'natural',
    'straight_join',
    'group',
    'order',
    'limit',
    'offset',
    'having',
    'window',
    'returning',
    'union',
    'except',
    'intersect',
    'into',
    'from',
    'for',
    'lock',
    'partition',
    'default',
    'duplicate',
    'key',
    'do',
    'conflict',
    'with',
    'as',
];

/**
 * Every table name introduced at or after `index`, reading past the words that may sit between a table-introducing
 * keyword and its table (`IF NOT EXISTS`, `ONLY`), and **following a comma-separated table list to its end**. Empty
 * when no name follows — which is the answer for `FROM (SELECT ...)`, where the next token is punctuation.
 */
function tableTokensAfter(tokens: ScanToken[], index: number): string[] {
    const found: string[] = [];
    let cursor = index;
    let expectingName = true;
    while (cursor < tokens.length) {
        const token = tokens[cursor];
        if (expectingName) {
            if (token.kind === 'word' && SKIPPABLE_PRE_TABLE_WORDS.indexOf(token.text) !== -1) {
                cursor++;
                continue;
            }
            if (token.kind !== 'word' && token.kind !== 'quoted') {
                return found;
            }
            // `REFERENCES catalog.schema.reorder_list` are all ordinary PostgreSQL, and stopping at the
            let table = token.text;
            cursor++;
            while (
                cursor + 1 < tokens.length &&
                tokens[cursor].kind === 'other' &&
                tokens[cursor].text === '.' &&
                (tokens[cursor + 1].kind === 'word' || tokens[cursor + 1].kind === 'quoted')
            ) {
                table = tokens[cursor + 1].text;
                cursor += 2;
            }
            found.push(table);
            expectingName = false;
            continue;
        }
        if (token.kind === 'other' && token.text === ',') {
            cursor++;
            expectingName = true;
            continue;
        }
        if (token.kind === 'word' && token.text === 'as') {
            cursor++;
            continue;
        }
        if (token.kind === 'word' && NON_ALIAS_WORDS.indexOf(token.text) === -1) {
            cursor++;
            continue;
        }
        if (token.kind === 'quoted') {
            cursor++;
            continue;
        }
        return found;
    }
    return found;
}

/**
 * @description Classifies a statement on its first keyword, after leading whitespace, leading SQL comments and a
 * leading `(` have been discarded.
 */
export function classifyStatement(query: string, dialect?: string): CapturedStatementKind {
    if (typeof query !== 'string' || query.length === 0) {
        return 'other';
    }
    try {
        const lexicon = lexiconFor(dialect);
        const leading = stripLeadingNoise(stripIdentifierQuotes(query), lexicon);
        const words = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/.exec(leading);
        if (words === null) {
            return 'other';
        }
        const first = words[1].toUpperCase();
        const second = (words[2] ?? '').toUpperCase();
        switch (first) {
            case 'SELECT':
                return extractStatementTables(query, dialect).length === 0 ? 'other' : 'select';
            case 'WITH': {
                // A common-table-expression prologue hides the statement's real keyword behind its
                // through. See `classifyCteStatement` for the two cheaper implementations that both
                const cteKind = classifyCteStatement(stripLeadingNoise(query, lexicon), lexicon);
                if (cteKind === undefined) {
                    return 'other';
                }
                if (cteKind === 'select') {
                    return extractStatementTables(query, dialect).length === 0 ? 'other' : 'select';
                }
                return cteKind;
            }
            case 'INSERT':
            case 'REPLACE':
                return 'insert';
            case 'UPDATE':
                return 'update';
            case 'DELETE':
                return 'delete';
            case 'BEGIN':
            case 'COMMIT':
            case 'ROLLBACK':
            case 'SAVEPOINT':
                return 'transaction';
            case 'START':
            case 'SET':
            case 'RELEASE':
                return second === 'TRANSACTION' || second === 'SAVEPOINT' ? 'transaction' : 'other';
            default:
                return 'other';
        }
    } catch {
        // `extractStatementTables` degrades to an empty list.
        return 'other';
    }
}

/**
 * @description
 * The pure single-statement predicate: does this statement reference this table, token-exactly?
 *
 * The function is total and never throws.
 */
export function statementReferencesTable(query: string, tableName: string): boolean {
    if (typeof tableName !== 'string' || tableName.length === 0) {
        return false;
    }
    return extractStatementTables(query).indexOf(tableName.toLowerCase()) !== -1;
}

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveStatementText(statement: CapturedStatement | string): string {
    return typeof statement === 'string' ? statement : statement.query;
}

/**
 * Every quoted run of a statement replaced by spaces of the same length, delimiters included.
 */
function blankQuotedRuns(text: string): string {
    let output = '';
    let index = 0;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'" || character === '"' || character === '`' || character === '[') {
            const end =
                character === "'" ? skipStringLiteral(text, index) : skipQuotedIdentifier(text, index);
            output += ' '.repeat(end - index);
            index = end;
            continue;
        }
        output += character;
        index += 1;
    }
    return output;
}

/**
 * @description What kind of row lock a statement asks the engine for: `'exclusive'`, `'shared'`, or `'none'`.
 */
export function classifyLockClause(statement: CapturedStatement | string): 'exclusive' | 'shared' | 'none' {
    const text = resolveStatementText(statement);
    if (typeof text !== 'string' || text.length === 0) {
        return 'none';
    }
    // Through the shared resolver, which reads the captured statement's own `dialect` — the field the
    // recorder fills — and falls back to the fail-closed lexicon for a bare string that carries no dialect.
    const lexicon = lexiconForStatement(statement, undefined);
    const scannable = blankQuotedRuns(blankComments(text, lexicon));
    if (/\bFOR\s+UPDATE\b/i.test(scannable)) {
        return 'exclusive';
    }
    if (/\bFOR\s+SHARE\b/i.test(scannable) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(scannable)) {
        return 'shared';
    }
    return 'none';
}

/**
 * The quote-stripped `WHERE` portion of a statement together with the number of positional `?` placeholders that
 * precede it.
 */
interface WherePortion {
    text: string;
    /** How many `?` placeholders occur in the statement before this portion begins. */
    placeholderOffset: number;
}

/**
 * Returns the quote-stripped `WHERE` portion of a statement — from the first `WHERE` keyword up to
 * the first clause keyword that ends a `WHERE` — or `undefined` when the statement has no `WHERE`.
 *
 * The truncation is what stops a column or a value that appears only in an `ORDER BY`, a `LIMIT` or a
 * `RETURNING` list from being read as part of the predicate.
 */
function extractWherePortion(query: string, lexicon: DialectLexicon): string | undefined {
    const portion = extractWherePortionWithOffset(query, lexicon);
    return portion === undefined ? undefined : portion.text;
}

/**
 * The same extraction as {@link extractWherePortion}, additionally reporting how many positional placeholders
 * precede the predicate. Only the predicate-shape helpers need the offset; everything else uses the simpler form.
 */
function extractWherePortionWithOffset(query: string, lexicon: DialectLexicon): WherePortion | undefined {
    if (typeof query !== 'string' || query.length === 0) {
        return undefined;
    }
    const length = query.length;
    let index = 0;
    let depth = 0;
    let placeholders = 0;
    let predicateStart = -1;
    let placeholderOffset = 0;
    while (index < length) {
        const character = query.charAt(index);
        if (character === '-' && query.charAt(index + 1) === '-') {
            index = skipLineComment(query, index);
            continue;
        }
        if (character === '#' && lexicon.hashComments) {
            // Trivia on the MySQL family, so a `#` note cannot contribute a keyword to this scan and
            // make a comment look like a terminator or a `WHERE`. On engines where `#` is an operator
            index = skipHashComment(query, index);
            continue;
        }
        if (character === '/' && query.charAt(index + 1) === '*') {
            index = skipBlockComment(query, index, lexicon);
            continue;
        }
        if (character === "'") {
            index = skipStringLiteral(query, index);
            continue;
        }
        if (character === '"' || character === '`' || character === '[') {
            index = skipQuotedIdentifier(query, index);
            continue;
        }
        if (character === '(') {
            depth++;
            index++;
            continue;
        }
        if (character === ')') {
            if (depth === 0) {
                return undefined;
            }
            depth--;
            index++;
            continue;
        }
        if (character === '?') {
            placeholders++;
            index++;
            continue;
        }
        if (character === ';' && depth === 0 && predicateStart !== -1) {
            // A statement separator ends the predicate as surely as a clause keyword does. Reading
            // comparison parse and costs a correctly scoped statement its certification. Whether text
            // {@link findDepthZeroStatementExpansion}.
            return buildWherePortion(query, predicateStart, index, placeholderOffset, lexicon);
        }
        if (isIdentifierStart(character)) {
            let end = index;
            while (end < length && isIdentifierCharacter(query.charAt(end))) {
                end++;
            }
            const word = query.slice(index, end).toLowerCase();
            if (predicateStart === -1) {
                if (depth === 0 && word === 'where') {
                    predicateStart = end;
                    placeholderOffset = placeholders;
                }
            } else if (depth === 0 && isWhereTerminatorAt(query, word, end, lexicon)) {
                return buildWherePortion(query, predicateStart, index, placeholderOffset, lexicon);
            }
            index = end;
            continue;
        }
        index++;
    }
    if (predicateStart === -1 || depth !== 0) {
        return undefined;
    }
    return buildWherePortion(query, predicateStart, length, placeholderOffset, lexicon);
}

/**
 * Whether the word just read begins a clause that ends a `WHERE` portion. A two-word terminator
 * requires its second word, so `ORDER` alone is not one and a column named `order` cannot end a
 * predicate.
 */
function isWhereTerminatorAt(
    query: string,
    word: string,
    wordEnd: number,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): boolean {
    if (WHERE_TERMINATOR_WORDS.indexOf(word) !== -1) {
        return true;
    }
    for (const pair of WHERE_TERMINATOR_PAIRS) {
        if (pair.first !== word) {
            continue;
        }
        const second = readWord(query, wordEnd, lexicon);
        if (second !== undefined && pair.seconds.indexOf(second.word) !== -1) {
            return true;
        }
    }
    return false;
}

/**
 * Replaces every SQL comment with an equal run of spaces, leaving string literals and quoted
 * identifiers untouched — a comment marker written inside a literal or a quoted column name is
 * data, not a comment, and must survive.
 */
function blankComments(text: string, lexicon: DialectLexicon = UNKNOWN_LEXICON): string {
    let output = '';
    let index = 0;
    const length = text.length;
    while (index < length) {
        const character = text.charAt(index);
        if (character === "'" || character === '"' || character === '`' || character === '[') {
            const literalEnd =
                character === "'" ? skipStringLiteral(text, index) : skipQuotedIdentifier(text, index);
            output += text.slice(index, literalEnd);
            index = literalEnd;
            continue;
        }
        if (character === '-' && text.charAt(index + 1) === '-') {
            const following = text.charAt(index + 2);
            if (following !== '' && !isWhitespace(following)) {
                // Not trivia either: MySQL and MariaDB require whitespace after `--`, so `--1` is
                // {@link findUncertifiableLexicalForm} can refuse it.
                output += '--';
                index += 2;
                continue;
            }
            const commentEnd = skipLineComment(text, index);
            output += ' '.repeat(commentEnd - index);
            index = commentEnd;
            continue;
        }
        if (character === '/' && text.charAt(index + 1) === '*') {
            const commentEnd = skipBlockComment(text, index, lexicon);
            const body = text.slice(index + 2, commentEnd);
            if (isExecutableBlockComment(text, index, lexicon) || body.indexOf('/*') !== -1) {
                // Not trivia. A MySQL or MariaDB executable comment (`/*!`, `/*M!`) runs on those
                // engines, and a nested `/*` ends the comment in different places on PostgreSQL than
                // {@link findUncertifiableLexicalForm} see them and refuse to certify.
                output += text.slice(index, commentEnd);
            } else {
                output += ' '.repeat(commentEnd - index);
            }
            index = commentEnd;
            continue;
        }
        output += character;
        index += 1;
    }
    return output;
}

/**
 * Builds the portion record: comments are blanked first — a comment anywhere inside the predicate
 * would otherwise be parsed as part of a leaf's operand and sink the whole conjunct — and the
 * identifier quotes are stripped second, so the downstream leaf parse sees bare column names.
 */
function buildWherePortion(
    query: string,
    predicateStart: number,
    predicateEnd: number,
    placeholderOffset: number,
    lexicon: DialectLexicon,
): WherePortion {
    const slice = blankComments(query.slice(predicateStart, predicateEnd), lexicon);
    // Where the engine reads `"..."` as a string, the region is data and is blanked with the other
    const withoutQuotedData = lexicon.doubleQuote === 'string' ? blankDoubleQuotedStrings(slice) : slice;
    return {
        text: stripIdentifierQuotes(withoutQuotedData),
        placeholderOffset,
    };
}

/**
 * Replaces every double-quoted region with an equal run of spaces, for the engines that read those
 * regions as string literals. Offsets are preserved so any measurement already taken stays valid.
 */
function blankDoubleQuotedStrings(text: string): string {
    let output = '';
    let index = 0;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'" || character === '`' || character === '[') {
            const end =
                character === "'" ? skipStringLiteral(text, index) : skipQuotedIdentifier(text, index);
            output += text.slice(index, end);
            index = end;
            continue;
        }
        if (character === '"') {
            const end = skipQuotedIdentifier(text, index);
            output += ' '.repeat(end - index);
            index = end;
            continue;
        }
        output += character;
        index += 1;
    }
    return output;
}

/**
 * True when `token` occurs in `text` as a standalone literal rather than as part of a longer
 * identifier or number. Written without a lookbehind so it stays portable, and with `.` and `$`
 * treated as part of a token so `1` does not match inside `1.5`, `list_1` or `$12`.
 */
function containsStandaloneToken(text: string, token: string): boolean {
    if (token.length === 0) {
        return false;
    }
    return new RegExp(`(^|[^\\w.$])${escapeForRegExp(token)}($|[^\\w.$])`).test(text);
}

// beside the row's own identifier** (FEATURE-001-01 §2.6.1.1). Three shapes satisfy a text search for

/**
 * A boolean predicate as parsed from a `WHERE` portion. `and` and `or` carry their operands; a `leaf`
 * is a single comparison (or any fragment that is not a conjunction or disjunction), and `negated`
 * records that it sat under a `NOT`, which is what stops a negated predicate from being read as a
 * scope.
 */
type PredicateNode =
    | { readonly kind: 'and'; readonly children: PredicateNode[] }
    | { readonly kind: 'or'; readonly children: PredicateNode[] }
    | { readonly kind: 'leaf'; readonly text: string; readonly negated: boolean }
    | { readonly kind: 'uncertifiable'; readonly text: string; readonly reason: string };

/** The parts of a single comparison leaf, once one has been recognised. */
interface LeafComparison {
    /** The compared column, being the last segment of a possibly alias-qualified path. */
    readonly column: string;
    /**
     * The relation the column was qualified by — the segment immediately before the column, so
     * `"ReorderList"."id"` yields `ReorderList` — or `undefined` when the column stood alone.
     */
    readonly qualifier: string | undefined;
    /** The comparison operator, normalised to lower case. */
    readonly operator: string;
    /** The other side of the comparison: a placeholder, a numeric literal or a quoted literal. */
    readonly operand: string;
}

/** An identifier path such as `id`, `ReorderList . id` or `public . reorder_list . id`. */
const LEAF_PATH_SOURCE = '[A-Za-z_][A-Za-z0-9_$]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_$]*)*';

/** A bound placeholder (`$1`, `?`, `:name`) or an inline literal, which is how sql.js renders numbers. */
const LEAF_OPERAND_SOURCE = "\\$\\d+|\\?|:[A-Za-z_][A-Za-z0-9_$]*|-?\\d+(?:\\.\\d+)?|'(?:[^']|'')*'";

/** The comparison operators a leaf may carry. Ordered longest-first so `<=` is not read as `<`. */
const LEAF_OPERATOR_SOURCE = '<=|>=|<>|!=|=|<|>';

/** `column <op> operand`, anchored so that nothing more complex is accepted as a comparison. */
const LEAF_COLUMN_FIRST = new RegExp(
    `^\\s*(${LEAF_PATH_SOURCE})\\s*(${LEAF_OPERATOR_SOURCE})\\s*(${LEAF_OPERAND_SOURCE})\\s*$`,
);

/** `operand <op> column`, the same comparison written the other way round. */
const LEAF_OPERAND_FIRST = new RegExp(
    `^\\s*(${LEAF_OPERAND_SOURCE})\\s*(${LEAF_OPERATOR_SOURCE})\\s*(${LEAF_PATH_SOURCE})\\s*$`,
);

/**
 * `column <op> column` — a comparison of two identifier paths and nothing else.
 */
const LEAF_COLUMN_PAIR = new RegExp(
    `^\\s*(${LEAF_PATH_SOURCE})\\s*(${LEAF_OPERATOR_SOURCE})\\s*(${LEAF_PATH_SOURCE})\\s*$`,
);

/**
 * Rewrites every positional `?` in a predicate into the explicit `$n` form, numbering from the
 * supplied offset, so that one code path resolves a placeholder on all four engines. String literals
 * are skipped.
 */
function normalisePlaceholders(portion: string, placeholderOffset: number): string {
    let normalised = '';
    let ordinal = placeholderOffset;
    let index = 0;
    while (index < portion.length) {
        const character = portion.charAt(index);
        if (character === "'") {
            const end = skipStringLiteral(portion, index);
            normalised += portion.slice(index, end);
            index = end;
            continue;
        }
        if (character === '?') {
            ordinal++;
            normalised += `$${String(ordinal)}`;
            index++;
            continue;
        }
        normalised += character;
        index++;
    }
    return normalised;
}

/**
 * The boolean constructs this parser deliberately refuses to interpret, each with the reason it cannot be
 * interpreted safely. Encountering any of them makes the fragment **uncertifiable**: it is neither read as a
 * conjunction nor as a disjunction, and {@link predicateRequires} answers `false`.
 */
const UNCERTIFIABLE_OPERATORS: Array<{ readonly token: string; readonly reason: string }> = [
    {
        token: '||',
        reason:
            '`||` is logical OR on MySQL and MariaDB in their default SQL mode, and string ' +
            'concatenation on PostgreSQL and SQLite, so its boolean lexicon is engine-dependent',
    },
    {
        token: '&&',
        reason:
            '`&&` is logical AND on MySQL and MariaDB, and an unrelated operator on PostgreSQL, ' +
            'so its boolean lexicon is engine-dependent',
    },
];

/**
 * The shared reason for every `CASE`-family word: the construct delimits itself with `END` rather than
 * with parentheses, so its internal `AND`s are not connectives even though they sit at depth zero.
 */
const CASE_NOT_A_CONNECTIVE_REASON =
    'a CASE expression delimits itself with END rather than parentheses, so the AND and OR inside ' +
    'it sit at parenthesis depth zero without being connectives — the whole construct is one ' +
    'operand, and splitting on those keywords invents conjuncts that do not constrain anything';

/**
 * Words that must never appear at the top level of a predicate fragment, because their presence there
 * means the boolean skeleton was **mis-read** rather than that the predicate is complicated.
 */
const UNCERTIFIABLE_WORDS: Array<{ readonly word: string; readonly reason: string }> = [
    {
        word: 'xor',
        reason:
            'MySQL and MariaDB `XOR` is an exclusive disjunction, which cannot carry a mandatory ' +
            'conjunct at all',
    },
    { word: 'case', reason: CASE_NOT_A_CONNECTIVE_REASON },
    { word: 'when', reason: CASE_NOT_A_CONNECTIVE_REASON },
    { word: 'then', reason: CASE_NOT_A_CONNECTIVE_REASON },
    { word: 'else', reason: CASE_NOT_A_CONNECTIVE_REASON },
    { word: 'end', reason: CASE_NOT_A_CONNECTIVE_REASON },
];

/**
 * @description How an engine reads a double-quoted region — the one lexical difference between the four target
 * engines that changes what a predicate *means* rather than merely how it is spelled.
 */
export type DoubleQuoteMeaning = 'identifier' | 'string' | 'unknown';

/**
 * TypeORM driver types that read `"..."` as an identifier. PostgreSQL and CockroachDB follow the SQL
 * standard; every SQLite build accepts double-quoted identifiers.
 */
const IDENTIFIER_QUOTING_DRIVERS = [
    'postgres',
    'aurora-postgres',
    'cockroachdb',
    'sqlite',
    'sqljs',
    'better-sqlite3',
    'expo',
    'capacitor',
    'nativescript',
    'oracle',
    'mssql',
    'spanner',
];

/** TypeORM driver types that read `"..."` as a string literal in their default SQL mode. */
const STRING_QUOTING_DRIVERS = ['mysql', 'mariadb', 'aurora-mysql'];

/**
 * Resolves how a driver reads a double-quoted region, returning `'unknown'` for a driver this module
 * has not been taught — which makes every double-quoted region in its statements refuse rather than be
 * guessed at.
 */
export function doubleQuoteMeaningFor(driverType: string | undefined): DoubleQuoteMeaning {
    if (typeof driverType !== 'string' || driverType.length === 0) {
        return 'unknown';
    }
    const normalised = driverType.toLowerCase();
    if (IDENTIFIER_QUOTING_DRIVERS.indexOf(normalised) !== -1) {
        return 'identifier';
    }
    if (STRING_QUOTING_DRIVERS.indexOf(normalised) !== -1) {
        return 'string';
    }
    return 'unknown';
}

/**
 * @description Everything about a driver's **lexis** that changes what text the engine executes.
 */
export interface DialectLexicon {
    /** How `"..."` reads. */
    readonly doubleQuote: DoubleQuoteMeaning;
    /** Whether `#` begins a comment running to end of line. */
    readonly hashComments: boolean;
    /** Whether block comments nest, so that the comment ends at the last matching delimiter. */
    readonly nestedBlockComments: boolean;
    /** Whether the body of `/*! ... *&#47;` is executed. */
    readonly executesLegacyComments: boolean;
    /** Whether the body of `/*M! ... *&#47;` is executed. */
    readonly executesMariaComments: boolean;
}

/** Driver types whose block comments nest: the PostgreSQL family only. */
const NESTED_COMMENT_DRIVERS = ['postgres', 'aurora-postgres', 'cockroachdb'];

/** Driver types that treat `#` as a line comment and execute `/*! ... *&#47;`. */
const MYSQL_FAMILY_DRIVERS = ['mysql', 'mariadb', 'aurora-mysql'];

/**
 * @description Resolves the full lexical model for a driver type. An unrecognised or absent driver yields the fail-
 * closed model, and **fail-closed means a different thing per field**:
 */
export function lexiconFor(driverType: string | undefined): DialectLexicon {
    const normalised = typeof driverType === 'string' ? driverType.toLowerCase() : '';
    const known = normalised.length > 0 && doubleQuoteMeaningFor(normalised) !== 'unknown';
    if (!known) {
        return {
            doubleQuote: 'unknown',
            hashComments: true,
            nestedBlockComments: false,
            executesLegacyComments: true,
            executesMariaComments: true,
        };
    }
    const mysqlFamily = MYSQL_FAMILY_DRIVERS.indexOf(normalised) !== -1;
    return {
        doubleQuote: doubleQuoteMeaningFor(normalised),
        hashComments: mysqlFamily,
        nestedBlockComments: NESTED_COMMENT_DRIVERS.indexOf(normalised) !== -1,
        executesLegacyComments: mysqlFamily,
        executesMariaComments: normalised === 'mariadb',
    };
}

/** The fail-closed lexicon, used where no driver type is available at all. */
const UNKNOWN_LEXICON: DialectLexicon = lexiconFor(undefined);

/** Resolves the lexicon for a captured statement, or from an explicitly supplied driver type. */
function lexiconForStatement(
    statement: CapturedStatement | string,
    dialect: string | undefined,
): DialectLexicon {
    if (dialect !== undefined) {
        return lexiconFor(dialect);
    }
    if (typeof statement === 'string') {
        return UNKNOWN_LEXICON;
    }
    return lexiconFor(statement.dialect);
}

/**
 * The reasons a **lexical** form makes text uncertifiable. Each is a place where the four target engines disagree
 * about where a comment or a literal ends, and every one of them can therefore hide a live top-level disjunction
 * from a scanner that picks one engine's rule.
 */
const UNCERTIFIABLE_LEXICAL_REASONS = {
    backslash:
        'a backslash escapes the following character inside a string literal on MySQL and MariaDB ' +
        "and does not on PostgreSQL or SQLite, so `'x\\'y'` ends the literal in different places " +
        'and what follows it can be a live disjunction on one engine and inert text on another',
    hashComment:
        '`#` opens a line comment on MySQL and MariaDB only, so the same text is a predicate on ' +
        'one engine and a comment on another, and whatever follows on the next line stays live',
    unspacedDashes:
        'MySQL and MariaDB require whitespace after `--` for it to open a comment, so `--1 OR 1 = 1` ' +
        'is a comment on PostgreSQL and SQLite and subtraction followed by a live disjunction there',
    executableComment:
        'a MySQL or MariaDB executable comment (`/*!` or `/*M!`) is inert on other engines and ' +
        'executes there, so its body can add a disjunction the parser would read as a comment',
    nestedComment:
        'PostgreSQL nests block comments and MySQL, MariaDB and SQLite do not, so a `/*` inside a ' +
        'block comment makes the comment end in different places on different engines',
    dollarQuote:
        'a PostgreSQL dollar-quoted literal is a literal there and is not one anywhere else, so its ' +
        'body is data on one engine and SQL syntax — connectives included — on the others',
    ambiguousDoubleQuote:
        'a double-quoted region is an identifier on PostgreSQL and SQLite and a string literal on ' +
        'MySQL and MariaDB unless ANSI_QUOTES is set, and the engine for this statement is not known, ' +
        'so whether the region names a column or carries a value cannot be decided',
    nonIdentifierQuotedRegion:
        'a double-quoted region holding something other than a plain identifier is not a column name ' +
        'even on the engines that quote identifiers this way, so it cannot be read as one',
};

/** An unquoted SQL identifier: what a double-quoted region must contain to be read as a name. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function isAmbiguousDoubleQuotedRegion(text: string, openIndex: number): boolean {
    const end = skipQuotedIdentifier(text, openIndex);
    const closed = text.charAt(end - 1) === '"' && end - 1 > openIndex;
    if (!closed) {
        return true;
    }
    const content = text.slice(openIndex + 1, end - 1).replace(/""/g, '"');
    return !PLAIN_IDENTIFIER.test(content);
}

/**
 * A PostgreSQL dollar-quote opener: `$$`, or `$tag$` where the tag is an identifier. A bound
 * placeholder is deliberately excluded, because `$1` is `$` followed by a **digit** and a dollar-quote
 * tag cannot begin with one — so the two syntaxes do not collide and refusing one does not refuse the
 * other.
 */
const DOLLAR_QUOTE_OPENER = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** The reasons a **structural** form makes a whole statement uncertifiable. */
const UNCERTIFIABLE_STATEMENT_REASONS = {
    setOperator:
        'a set operator adds a branch with a predicate of its own, so scoping the first branch ' +
        'scopes nothing: the other branch can return every row',
    statementSeparator:
        'a statement separator introduces a second statement whose predicate this parser does not ' +
        'read at all',
};

/**
 * Reports the first lexical form that makes `text` uncertifiable, or `undefined` when it contains
 * none. Every reason is listed in {@link UNCERTIFIABLE_LEXICAL_REASONS}.
 */
function findUncertifiableLexicalForm(text: string, lexicon: DialectLexicon): string | undefined {
    if (text.indexOf('\\') !== -1) {
        return UNCERTIFIABLE_LEXICAL_REASONS.backslash;
    }
    if (DOLLAR_QUOTE_OPENER.test(text)) {
        return UNCERTIFIABLE_LEXICAL_REASONS.dollarQuote;
    }
    let index = 0;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'") {
            index = skipStringLiteral(text, index);
            continue;
        }
        if (character === '"') {
            if (lexicon.doubleQuote === 'unknown') {
                // column at all, so the statement is not certifiable. This is the whole reason the
                // engine is carried on a captured statement.
                return UNCERTIFIABLE_LEXICAL_REASONS.ambiguousDoubleQuote;
            }
            if (lexicon.doubleQuote === 'string') {
                // The engine reads this as a string literal, and a literal is never a column, so it is
                // rather than a predicate on `customerId`, which is exactly what the engine does.
                index = skipQuotedIdentifier(text, index);
                continue;
            }
            if (isAmbiguousDoubleQuotedRegion(text, index)) {
                return UNCERTIFIABLE_LEXICAL_REASONS.nonIdentifierQuotedRegion;
            }
            index = skipQuotedIdentifier(text, index);
            continue;
        }
        if (character === '`' || character === '[') {
            // Backticks and brackets are identifier quotes on every engine that accepts them at all and
            index = skipQuotedIdentifier(text, index);
            continue;
        }
        if (character === '#') {
            return UNCERTIFIABLE_LEXICAL_REASONS.hashComment;
        }
        if (character === '-' && text.charAt(index + 1) === '-') {
            const following = text.charAt(index + 2);
            if (following !== '' && !isWhitespace(following)) {
                return UNCERTIFIABLE_LEXICAL_REASONS.unspacedDashes;
            }
            index = skipLineComment(text, index);
            continue;
        }
        if (character === '/' && text.charAt(index + 1) === '*') {
            const commentEnd = skipBlockComment(text, index, lexicon);
            if (isExecutableBlockComment(text, index, lexicon)) {
                return UNCERTIFIABLE_LEXICAL_REASONS.executableComment;
            }
            if (text.slice(index + 2, commentEnd).indexOf('/*') !== -1) {
                return UNCERTIFIABLE_LEXICAL_REASONS.nestedComment;
            }
            index = commentEnd;
            continue;
        }
        index++;
    }
    return undefined;
}

/**
 * True when the block comment at `openIndex` is one the MySQL family **executes**: `/*!` in either
 * engine, and MariaDB's `/*M!` form, each optionally carrying a version number. Its body is inert on
 * every other engine, which is exactly what makes it dangerous — it reads as a comment here and runs
 * there.
 */
function isExecutableBlockComment(
    text: string,
    openIndex: number,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): boolean {
    const marker = text.charAt(openIndex + 2);
    if (marker === '!') {
        // `/*! ... *&#47;` executes on MySQL and MariaDB, and is read under the fail-closed default.
        return lexicon.executesLegacyComments;
    }
    if ((marker === 'M' || marker === 'm') && text.charAt(openIndex + 3) === '!') {
        // `/*M! ... *&#47;` is MariaDB's own marker: MySQL treats it as an ordinary comment and runs
        // nothing, so reading its body on MySQL would invent a statement the server never saw.
        return lexicon.executesMariaComments;
    }
    return false;
}

/**
 * Reports the first **structural** expansion that makes a whole statement uncertifiable — a depth-zero
 * set operator, or a statement separator followed by more text — or `undefined` when there is none.
 */
function findDepthZeroStatementExpansion(
    query: string,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): string | undefined {
    let depth = 0;
    let index = 0;
    while (index < query.length) {
        const character = query.charAt(index);
        if (character === "'") {
            index = skipStringLiteral(query, index);
            continue;
        }
        if (character === '"' || character === '`' || character === '[') {
            index = skipQuotedIdentifier(query, index);
            continue;
        }
        if (character === '-' && query.charAt(index + 1) === '-') {
            index = skipLineComment(query, index);
            continue;
        }
        if (character === '#' && lexicon.hashComments) {
            // Trivia on the MySQL family. Without this, a `UNION` written inside a `#` note would be
            // read as a real depth-zero set operator and refuse a statement that is perfectly scoped.
            index = skipHashComment(query, index);
            continue;
        }
        if (character === '/' && query.charAt(index + 1) === '*') {
            index = skipBlockComment(query, index, lexicon);
            continue;
        }
        if (character === '(') {
            depth++;
            index++;
            continue;
        }
        if (character === ')') {
            depth = depth > 0 ? depth - 1 : 0;
            index++;
            continue;
        }
        if (depth === 0) {
            if (character === ';' && query.slice(index + 1).replace(/\s+/g, '').length > 0) {
                return UNCERTIFIABLE_STATEMENT_REASONS.statementSeparator;
            }
            if (isIdentifierStart(character)) {
                const word = readWord(query, index, lexicon);
                if (word !== undefined) {
                    if (SET_OPERATORS.indexOf(word.word) !== -1) {
                        return UNCERTIFIABLE_STATEMENT_REASONS.setOperator;
                    }
                    index = word.end;
                    continue;
                }
            }
        }
        index++;
    }
    return undefined;
}

/** The set operators that add a branch carrying its own predicate. `UNION ALL` opens with `union`. */
const SET_OPERATORS = ['union', 'intersect', 'except'];

function findUncertifiableConstruct(text: string, lexicon: DialectLexicon): string | undefined {
    const lexical = findUncertifiableLexicalForm(text, lexicon);
    if (lexical !== undefined) {
        return lexical;
    }
    let depth = 0;
    let index = 0;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'") {
            index = skipStringLiteral(text, index);
            continue;
        }
        if (character === '"' || character === '`' || character === '[') {
            index = skipQuotedIdentifier(text, index);
            continue;
        }
        if (character === '(') {
            depth++;
            index++;
            continue;
        }
        if (character === ')') {
            depth = depth > 0 ? depth - 1 : 0;
            index++;
            continue;
        }
        if (depth === 0) {
            for (const operator of UNCERTIFIABLE_OPERATORS) {
                if (text.slice(index, index + operator.token.length) === operator.token) {
                    return operator.reason;
                }
            }
            if (isIdentifierStart(character)) {
                let end = index;
                while (end < text.length && isIdentifierCharacter(text.charAt(end))) {
                    end++;
                }
                const word = text.slice(index, end).toLowerCase();
                for (const candidate of UNCERTIFIABLE_WORDS) {
                    if (word === candidate.word) {
                        return candidate.reason;
                    }
                }
                index = end;
                continue;
            }
        }
        index++;
    }
    return undefined;
}

/**
 * Splits a predicate on a boolean keyword at parenthesis depth zero, skipping string literals, and
 * returns the parts. A single-element result means the keyword does not occur at the top level.
 *
 * Only the word forms are split here; the symbol forms are refused outright by
 * {@link findUncertifiableConstruct}, which {@link parsePredicate} consults first.
 */
function splitTopLevel(text: string, keyword: 'and' | 'or'): string[] {
    const parts: string[] = [];
    let depth = 0;
    let partStart = 0;
    let index = 0;
    let pendingBetween = false;
    while (index < text.length) {
        const character = text.charAt(index);
        if (character === "'") {
            index = skipStringLiteral(text, index);
            continue;
        }
        if (character === '(') {
            depth++;
            index++;
            continue;
        }
        if (character === ')') {
            depth = depth > 0 ? depth - 1 : 0;
            index++;
            continue;
        }
        if (depth === 0 && isIdentifierStart(character)) {
            let end = index;
            while (end < text.length && isIdentifierCharacter(text.charAt(end))) {
                end++;
            }
            const word = text.slice(index, end).toLowerCase();
            if (word === 'between') {
                pendingBetween = true;
            } else if (word === keyword && !(keyword === 'and' && pendingBetween)) {
                parts.push(text.slice(partStart, index));
                partStart = end;
            } else if (word === 'and' && pendingBetween) {
                pendingBetween = false;
            }
            index = end;
            continue;
        }
        index++;
    }
    parts.push(text.slice(partStart));
    return parts;
}

/** True when the whole fragment is one parenthesised group, so it can be unwrapped and re-parsed. */
function isFullyParenthesised(text: string, lexicon: DialectLexicon = UNKNOWN_LEXICON): boolean {
    const trimmed = text.replace(/^\s+|\s+$/g, '');
    if (trimmed.charAt(0) !== '(') {
        return false;
    }
    return findMatchingParenthesis(trimmed, 0, lexicon) === trimmed.length - 1;
}

/**
 * Parses a predicate into a {@link PredicateNode}. `OR` binds loosest, then `AND`; a fully
 * parenthesised fragment is unwrapped; a leading `NOT` marks the fragment negated so nothing inside
 * it counts as a scope.
 */
function parsePredicate(text: string, lexicon: DialectLexicon, negated = false): PredicateNode {
    const trimmed = text.replace(/^\s+|\s+$/g, '');
    if (isFullyParenthesised(trimmed, lexicon)) {
        return parsePredicate(trimmed.slice(1, trimmed.length - 1), lexicon, negated);
    }
    const uncertifiable = findUncertifiableConstruct(trimmed, lexicon);
    if (uncertifiable !== undefined) {
        return { kind: 'uncertifiable', text: trimmed, reason: uncertifiable };
    }
    const disjuncts = splitTopLevel(trimmed, 'or');
    if (disjuncts.length > 1) {
        return combine('or', trimmed, disjuncts, lexicon, negated);
    }
    const conjuncts = splitTopLevel(trimmed, 'and');
    if (conjuncts.length > 1) {
        return combine('and', trimmed, conjuncts, lexicon, negated);
    }
    const withoutNot = /^not\b([\s\S]*)$/i.exec(trimmed);
    if (withoutNot !== null) {
        return parsePredicate(withoutNot[1], lexicon, true);
    }
    return { kind: 'leaf', text: trimmed, negated };
}

/**
 * Builds a conjunction or disjunction from already-split parts, **propagating any child's refusal to
 * the whole node**.
 */
function combine(
    kind: 'and' | 'or',
    text: string,
    parts: string[],
    lexicon: DialectLexicon,
    negated: boolean,
): PredicateNode {
    const children = parts.map(part => parsePredicate(part, lexicon, negated));
    for (const child of children) {
        if (child.kind === 'uncertifiable') {
            return { kind: 'uncertifiable', text, reason: child.reason };
        }
    }
    return kind === 'and' ? { kind: 'and', children } : { kind: 'or', children };
}

/**
 * Recognises a leaf as a single comparison, in either operand order, and returns its parts. Anything
 * more complex than `column <op> operand` — a function call, an `EXISTS`, an `IN (...)`, a comparison
 * of two columns — is **not** a recognised comparison, which is what keeps a subquery from being read
 * as a scope.
 */
function parseLeafComparison(leafText: string): LeafComparison | undefined {
    const columnFirst = LEAF_COLUMN_FIRST.exec(leafText);
    if (columnFirst !== null) {
        return {
            column: lastPathSegment(columnFirst[1]),
            qualifier: pathQualifier(columnFirst[1]),
            operator: columnFirst[2].toLowerCase(),
            operand: columnFirst[3],
        };
    }
    const operandFirst = LEAF_OPERAND_FIRST.exec(leafText);
    if (operandFirst !== null) {
        return {
            column: lastPathSegment(operandFirst[3]),
            qualifier: pathQualifier(operandFirst[3]),
            operator: operandFirst[2].toLowerCase(),
            operand: operandFirst[1],
        };
    }
    return undefined;
}

/** The final segment of an identifier path, so `ReorderList . customerId` yields `customerId`. */
function lastPathSegment(identifierPath: string): string {
    const segments = identifierPath.split('.');
    return segments[segments.length - 1].replace(/^\s+|\s+$/g, '').toLowerCase();
}

/**
 * The segment immediately before the column in an identifier path — the relation the column belongs
 * to — or `undefined` when the column was written unqualified.
 */
function pathQualifier(identifierPath: string): string | undefined {
    const segments = identifierPath.split('.');
    if (segments.length < 2) {
        return undefined;
    }
    return segments[segments.length - 2].replace(/^\s+|\s+$/g, '').toLowerCase();
}

/**
 * Resolves a comparison's operand to a comparable string: a `$n` placeholder to its bound parameter,
 * an inline numeric literal to itself, a quoted literal to its unescaped content. A `:name`
 * placeholder resolves to `undefined`, because a named placeholder carries no position and a captured
 * statement never contains one — TypeORM has already rewritten it by the time the logger sees it.
 */
function resolveOperand(operand: string, parameters: readonly unknown[]): unknown {
    if (operand.charAt(0) === '$') {
        const ordinal = parseInt(operand.slice(1), 10);
        if (isNaN(ordinal) || ordinal < 1 || !Array.isArray(parameters) || ordinal > parameters.length) {
            return undefined;
        }
        return parameters[ordinal - 1];
    }
    if (operand.charAt(0) === ':') {
        return undefined;
    }
    if (operand.charAt(0) === "'") {
        return operand.slice(1, operand.length - 1).replace(/''/g, "'");
    }
    return operand;
}

function operandMatchesValue(resolved: unknown, value: unknown): boolean {
    if (value === null) {
        return resolved === null;
    }
    if (resolved === null || resolved === undefined) {
        return false;
    }
    return String(resolved) === String(value);
}

/**
 * Whether a required column-and-value predicate is a **mandatory** conjunct of the parsed predicate:
 * satisfied by at least one operand of every conjunction, and by **every** operand of every
 * disjunction — which is what "the predicate cannot be satisfied without it" means.
 */
function predicateRequires(
    node: PredicateNode,
    requirement: ScopedPredicate,
    parameters: readonly unknown[],
): boolean {
    if (node.kind === 'and') {
        for (const child of node.children) {
            if (predicateRequires(child, requirement, parameters)) {
                return true;
            }
        }
        return false;
    }
    if (node.kind === 'or') {
        for (const child of node.children) {
            if (!predicateRequires(child, requirement, parameters)) {
                return false;
            }
        }
        return node.children.length > 0;
    }
    if (node.kind === 'uncertifiable') {
        // tell, it must not say that it does — see {@link UNCERTIFIABLE_OPERATORS}.
        return false;
    }
    if (node.negated) {
        return false;
    }
    const comparison = parseLeafComparison(node.text);
    if (comparison === undefined || comparison.operator !== '=') {
        return false;
    }
    if (comparison.column !== requirement.column.toLowerCase()) {
        return false;
    }
    //    and in a self-join those are the same table — see {@link LeafComparison.qualifier}.
    //    suite asking for `customerId` *of `ReorderList`* has said the statement is qualified; a bare
    //    `customerId` token is then not the thing it asked about.
    const declaredRelation =
        typeof requirement.relation === 'string' && requirement.relation.length > 0
            ? requirement.relation.toLowerCase()
            : undefined;
    if (comparison.qualifier !== declaredRelation) {
        return false;
    }
    if (!('value' in requirement)) {
        return true;
    }
    if (requirement.value === undefined) {
        return false;
    }
    return operandMatchesValue(resolveOperand(comparison.operand, parameters), requirement.value);
}

/**
 * Whether some leaf of the parsed predicate satisfies `test` **as a mandatory conjunct**: present in at least
 * one operand of every conjunction, and in *every* operand of every disjunction, and never under a `NOT`.
 */
function predicateRequiresLeaf(node: PredicateNode, test: (leafText: string) => boolean): boolean {
    if (node.kind === 'and') {
        for (const child of node.children) {
            if (predicateRequiresLeaf(child, test)) {
                return true;
            }
        }
        return false;
    }
    if (node.kind === 'or') {
        for (const child of node.children) {
            if (!predicateRequiresLeaf(child, test)) {
                return false;
            }
        }
        return node.children.length > 0;
    }
    if (node.kind === 'uncertifiable') {
        return false;
    }
    if (node.negated) {
        return false;
    }
    return test(node.text);
}

/**
 * Blanks the parts of a leaf that must not contribute a column name: string literals, and any
 * parenthesised group containing a `SELECT` — that is, a subquery. A function call such as
 * `LOWER(nameKey)` is deliberately left intact, because the column really is constrained there.
 */
function leafTextForMention(leafText: string, lexicon: DialectLexicon = UNKNOWN_LEXICON): string {
    let masked = '';
    let index = 0;
    while (index < leafText.length) {
        const character = leafText.charAt(index);
        if (character === "'") {
            const end = skipStringLiteral(leafText, index);
            masked += ' ';
            index = end;
            continue;
        }
        if (character === '(') {
            const closing = findMatchingParenthesis(leafText, index, lexicon);
            const end = closing === -1 ? leafText.length : closing + 1;
            const group = leafText.slice(index, end);
            masked += /\bselect\b/i.test(group) ? ' ' : group;
            index = end;
            continue;
        }
        masked += character;
        index++;
    }
    return masked;
}

/**
 * Whether a column is constrained by a **mandatory** conjunct of the parsed predicate. Looser than
 * {@link predicateRequires} in that any comparison operator counts and no value is checked — a
 * conditional write's `lineCount < :max` guard is a predicate on `lineCount` — but identical in the
 * structural rule: every branch of every disjunction must carry it.
 */
function predicateMentionsColumn(
    node: PredicateNode,
    column: string,
    lexicon: DialectLexicon = UNKNOWN_LEXICON,
): boolean {
    if (node.kind === 'and') {
        for (const child of node.children) {
            if (predicateMentionsColumn(child, column, lexicon)) {
                return true;
            }
        }
        return false;
    }
    if (node.kind === 'or') {
        for (const child of node.children) {
            if (!predicateMentionsColumn(child, column, lexicon)) {
                return false;
            }
        }
        return node.children.length > 0;
    }
    if (node.kind === 'uncertifiable') {
        // Fail closed, identically to {@link predicateRequires}, and for the stronger of the two
        return false;
    }
    if (node.negated) {
        return false;
    }
    return containsStandaloneToken(
        leafTextForMention(node.text, lexicon).toLowerCase(),
        column.toLowerCase(),
    );
}

/**
 * Parses a statement's `WHERE` portion, with its placeholders normalised, or returns `undefined`
 * when the statement carries no predicate.
 */
function parseStatementPredicate(query: string, lexicon: DialectLexicon): PredicateNode | undefined {
    // The statement-level refusals are applied to the whole query before the predicate is located,
    // because both of them change which rows the statement returns without changing the `WHERE`
    // portion at all — see {@link findDepthZeroStatementExpansion}. The lexical refusals are applied
    // here too, not only inside {@link parsePredicate}, because an ambiguous comment or literal
    // anywhere in the statement can move where the predicate is judged to end.
    const lexical = findUncertifiableLexicalForm(query, lexicon);
    if (lexical !== undefined) {
        return { kind: 'uncertifiable', text: query, reason: lexical };
    }
    const expansion = findDepthZeroStatementExpansion(query, lexicon);
    if (expansion !== undefined) {
        return { kind: 'uncertifiable', text: query, reason: expansion };
    }
    const portion = extractWherePortionWithOffset(query, lexicon);
    if (portion === undefined) {
        return undefined;
    }
    return parsePredicate(normalisePlaceholders(portion.text, portion.placeholderOffset), lexicon);
}

/**
 * @description
 * One required predicate: a column, and optionally the value it must be compared against.
 */
export interface ScopedPredicate {
    column: string;
    /**
     * The relation the column must belong to — the alias **as it appears in the statement**, so
     * `ReorderList` for TypeORM's `"ReorderList"."customerId"`, matched case-insensitively.
     */
    relation?: string;
    value?: unknown;
}

/**
 * @description True when **every** required column-and-value predicate is a **mandatory conjunct** of the
 * statement's `WHERE`: present in at least one operand of every conjunction, and in **every** operand of every
 * disjunction, with the required value bound to the required column.
 */
export function whereRequiresScopedPredicates(
    statement: CapturedStatement | string,
    requirements: ScopedPredicate[],
    dialect?: string,
): boolean {
    if (!Array.isArray(requirements) || requirements.length === 0) {
        return false;
    }
    try {
        const predicate = parseStatementPredicate(
            resolveStatementText(statement),
            lexiconForStatement(statement, dialect),
        );
        if (predicate === undefined) {
            return false;
        }
        const parameters =
            typeof statement === 'string' || !Array.isArray(statement.parameters) ? [] : statement.parameters;
        for (const requirement of requirements) {
            if (
                requirement === null ||
                typeof requirement !== 'object' ||
                typeof requirement.column !== 'string' ||
                requirement.column.length === 0
            ) {
                return false;
            }
            if (!predicateRequires(predicate, requirement, parameters)) {
                return false;
            }
        }
        return true;
    } catch {
        // A malformed statement is reported as not satisfying the requirement rather than throwing, so
        return false;
    }
}

/**
 * @description
 * One relation named in a sub-query's `FROM` clause, together with the alias it was given.
 *
 * `alias` is `undefined` for a relation written without one, in which case its columns are qualified by the
 * table name or not at all.
 */
interface SubqueryRelation {
    /** The table name, lower-cased, taken as the last segment of a possibly schema-qualified name. */
    readonly table: string;
    /** The alias the `FROM` clause introduced, lower-cased, or `undefined` where it introduced none. */
    readonly alias: string | undefined;
}

/**
 * Clauses that decouple a sub-query's row count from the rows its predicate matched, and are therefore refused
 * outright inside an ownership sub-query.
 */
const ROW_COUNT_DECOUPLING_WORDS = ['group', 'having', 'window', 'order', 'limit', 'offset', 'fetch'];

/**
 * Whether a sub-query returns exactly one row per row its predicate matched — the property that makes the
 * enclosing `EXISTS` mean "a row satisfying this predicate is there".
 */
function subqueryReturnsOneRowPerMatch(subquery: string, lexicon: DialectLexicon): boolean {
    const tokens = tokeniseForTableScan(subquery, lexicon);
    // A sub-query that does not OPEN with `SELECT` is some other statement form — a `WITH` prelude, a
    if (tokens.length === 0 || tokens[0].kind !== 'word' || tokens[0].text !== 'select') {
        return false;
    }
    let depth = 0;
    let fromIndex = -1;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'other' && token.text === '(') {
            depth++;
            continue;
        }
        if (token.kind === 'other' && token.text === ')') {
            depth = depth > 0 ? depth - 1 : 0;
            continue;
        }
        if (depth !== 0 || token.kind !== 'word') {
            continue;
        }
        if (ROW_COUNT_DECOUPLING_WORDS.indexOf(token.text) !== -1) {
            return false;
        }
        if (token.text === 'from' && fromIndex === -1) {
            fromIndex = index;
        }
    }
    // `SELECT`, then exactly one projection token, then `FROM`. A longer projection list, a qualified column,
    // a function call and `DISTINCT` all put more than one token here.
    if (fromIndex !== 2) {
        return false;
    }
    const projection = tokens[1];
    return projection.kind === 'other' && projection.text === '1';
}

/**
 * The single relation a sub-query reads, or `undefined` where it reads none, reads more than one, or is written in a
 * form this scan cannot read.
 */
function subqueryRelation(subquery: string, lexicon: DialectLexicon): SubqueryRelation | undefined {
    const tokens = tokeniseForTableScan(subquery, lexicon);
    let depth = 0;
    let fromIndex = -1;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'other' && token.text === '(') {
            depth++;
            continue;
        }
        if (token.kind === 'other' && token.text === ')') {
            depth = depth > 0 ? depth - 1 : 0;
            continue;
        }
        if (depth === 0 && token.kind === 'word' && token.text === 'from') {
            if (fromIndex !== -1) {
                return undefined;
            }
            fromIndex = index;
        }
    }
    if (fromIndex === -1) {
        return undefined;
    }
    let cursor = fromIndex + 1;
    if (cursor >= tokens.length) {
        return undefined;
    }
    if (tokens[cursor].kind !== 'word' && tokens[cursor].kind !== 'quoted') {
        return undefined;
    }
    let table = tokens[cursor].text;
    cursor++;
    while (
        cursor + 1 < tokens.length &&
        tokens[cursor].kind === 'other' &&
        tokens[cursor].text === '.' &&
        (tokens[cursor + 1].kind === 'word' || tokens[cursor + 1].kind === 'quoted')
    ) {
        table = tokens[cursor + 1].text;
        cursor += 2;
    }
    let alias: string | undefined;
    if (cursor < tokens.length && tokens[cursor].kind === 'word' && tokens[cursor].text === 'as') {
        cursor++;
        if (cursor >= tokens.length || (tokens[cursor].kind !== 'word' && tokens[cursor].kind !== 'quoted')) {
            return undefined;
        }
        alias = tokens[cursor].text.toLowerCase();
        cursor++;
    } else if (
        cursor < tokens.length &&
        (tokens[cursor].kind === 'quoted' ||
            (tokens[cursor].kind === 'word' && NON_ALIAS_WORDS.indexOf(tokens[cursor].text) === -1))
    ) {
        alias = tokens[cursor].text.toLowerCase();
        cursor++;
    }
    if (cursor < tokens.length) {
        const next = tokens[cursor];
        if (next.kind !== 'word' || next.text !== 'where') {
            return undefined;
        }
    }
    return { table: table.toLowerCase(), alias };
}

/**
 * @description One scope comparison a correlated ownership sub-query must carry: a column, the relation it may be
 * qualified by, and — unlike {@link ScopedPredicate}, from which this narrows — the value it must be compared
 * against, **required**.
 */
export interface CorrelatedOwnershipScopePredicate extends ScopedPredicate {
    /**
     * The **decoded** value the column must be compared against — not the external `T_n` form, for the
     * reason {@link statementCarriesParameterValue} documents.
     */
    value: NonNullable<unknown> | null;
}

/**
 * @description
 * The ownership predicate a statement must carry through a correlated `EXISTS` sub-query.
 *
 * Every part is required, because each one is a distinct way the sub-query can be satisfied without scoping
 * the row the statement is writing. See {@link whereRequiresCorrelatedOwnership}.
 */
export interface CorrelatedOwnershipRequirement {
    table: string;
    /**
     * The correlation that ties the sub-query to the row the enclosing statement addresses, rather than to
     * the table at large.
     */
    correlation: {
        column: string;
        /** The enclosing statement's column it must be compared to — the child's reference to its parent. */
        outerColumn: string;
        /**
         * The relation the outer column must be qualified by, where the engine qualifies it.
         */
        outerRelation?: string;
    };
    predicates: CorrelatedOwnershipScopePredicate[];
}

/**
 * @description True when the statement's `WHERE` **requires** a correlated `EXISTS` sub-query that scopes the row
 * being addressed to its owner — the table, the correlation and every scope comparison all verified, and every value
 * resolved to its bound parameter.
 */
export function whereRequiresCorrelatedOwnership(
    statement: CapturedStatement | string,
    requirement: CorrelatedOwnershipRequirement,
    dialect?: string,
): boolean {
    try {
        if (!isUsableOwnershipRequirement(requirement)) {
            return false;
        }
        const lexicon = lexiconForStatement(statement, dialect);
        const predicate = parseStatementPredicate(resolveStatementText(statement), lexicon);
        if (predicate === undefined) {
            return false;
        }
        const parameters =
            typeof statement === 'string' || !Array.isArray(statement.parameters) ? [] : statement.parameters;
        const resolvedDialect =
            dialect !== undefined ? dialect : typeof statement === 'string' ? undefined : statement.dialect;
        return predicateRequiresCorrelatedOwnership(predicate, {
            requirement,
            parameters,
            lexicon,
            dialect: resolvedDialect,
        });
    } catch {
        // A malformed statement or requirement is reported as not satisfying the claim rather than throwing,
        // so a parse problem can never be mistaken for a verified ownership predicate.
        return false;
    }
}

/** Everything the recursive walk needs, gathered once so the recursion carries one argument. */
interface OwnershipContext {
    readonly requirement: CorrelatedOwnershipRequirement;
    readonly parameters: readonly unknown[];
    readonly lexicon: DialectLexicon;
    readonly dialect: string | undefined;
}

/**
 * Whether a requirement is well formed enough to be verified at all.
 *
 * An empty `predicates` list is refused rather than treated as "no scope comparisons needed": a correlation
 * alone establishes that the parent row exists, not that the caller owns it, and an assertion that names no
 * scope asserts nothing. Every string that has to be matched must be a non-empty string.
 */
function isUsableOwnershipRequirement(requirement: CorrelatedOwnershipRequirement): boolean {
    if (requirement === null || typeof requirement !== 'object') {
        return false;
    }
    const correlation = requirement.correlation;
    if (
        typeof requirement.table !== 'string' ||
        requirement.table.length === 0 ||
        correlation === null ||
        typeof correlation !== 'object' ||
        typeof correlation.column !== 'string' ||
        correlation.column.length === 0 ||
        typeof correlation.outerColumn !== 'string' ||
        correlation.outerColumn.length === 0
    ) {
        return false;
    }
    if (!Array.isArray(requirement.predicates) || requirement.predicates.length === 0) {
        return false;
    }
    for (const predicate of requirement.predicates) {
        if (
            predicate === null ||
            typeof predicate !== 'object' ||
            typeof predicate.column !== 'string' ||
            predicate.column.length === 0
        ) {
            return false;
        }
        // caller can all present a predicate with no usable value — and {@link predicateRequires} reads an
        // ABSENT `value` as "require only that this column is compared", which for an ownership claim would
        if (!Object.prototype.hasOwnProperty.call(predicate, 'value') || predicate.value === undefined) {
            return false;
        }
    }
    return true;
}

/**
 * Whether a satisfying correlated `EXISTS` is a **mandatory** conjunct of the parsed predicate.
 *
 * The structural rule is {@link predicateRequires}'s, verbatim and for the same reason: one operand of a
 * conjunction is enough, every operand of a disjunction is required, an unreadable fragment refuses, and
 * nothing under a `NOT` counts.
 */
function predicateRequiresCorrelatedOwnership(node: PredicateNode, context: OwnershipContext): boolean {
    if (node.kind === 'and') {
        for (const child of node.children) {
            if (predicateRequiresCorrelatedOwnership(child, context)) {
                return true;
            }
        }
        return false;
    }
    if (node.kind === 'or') {
        for (const child of node.children) {
            if (!predicateRequiresCorrelatedOwnership(child, context)) {
                return false;
            }
        }
        return node.children.length > 0;
    }
    if (node.kind === 'uncertifiable' || node.negated) {
        return false;
    }
    return leafIsCorrelatedOwnership(node.text, context);
}

/**
 * Whether one leaf is an `EXISTS` sub-query satisfying the whole requirement.
 *
 * The leaf must be the `EXISTS` and nothing else: its parenthesised group has to close at the end of the
 * fragment, so `EXISTS (...) = 1`, `EXISTS (...) IS NULL` and any other construct wrapping it are refused
 * rather than read through.
 */
function leafIsCorrelatedOwnership(leafText: string, context: OwnershipContext): boolean {
    const trimmed = leafText.replace(/^\s+|\s+$/g, '');
    const opener = /^exists\s*\(/i.exec(trimmed);
    if (opener === null) {
        return false;
    }
    const openIndex = trimmed.indexOf('(');
    const closeIndex = findMatchingParenthesis(trimmed, openIndex, context.lexicon);
    if (closeIndex !== trimmed.length - 1) {
        return false;
    }
    const subquery = trimmed.slice(openIndex + 1, closeIndex);
    // The sub-query is re-examined for the refusals the outer statement was already checked for, because a
    // every row of the outer statement.
    if (
        findUncertifiableLexicalForm(subquery, context.lexicon) !== undefined ||
        findDepthZeroStatementExpansion(subquery, context.lexicon) !== undefined
    ) {
        return false;
    }
    // The sub-query must return a row PER MATCHING ROW rather than a row per statement, which is what makes
    // the `EXISTS` mean "such a row is there" at all — see {@link subqueryReturnsOneRowPerMatch}.
    if (!subqueryReturnsOneRowPerMatch(subquery, context.lexicon)) {
        return false;
    }
    const relation = subqueryRelation(subquery, context.lexicon);
    if (relation === undefined || relation.table !== context.requirement.table.toLowerCase()) {
        return false;
    }
    // Belt and braces over the same token stream the attribution scan uses: the sub-query must touch the one
    const tables = extractStatementTables(subquery, context.dialect);
    if (tables.length !== 1 || tables[0] !== relation.table) {
        return false;
    }
    // split into leaves, so every `?` inside this sub-query already carries its statement-wide `$n` position;
    const portion = extractWherePortionWithOffset(subquery, context.lexicon);
    if (portion === undefined) {
        return false;
    }
    const subPredicate = parsePredicate(portion.text, context.lexicon);
    if (!predicateRequiresCorrelation(subPredicate, relation, context.requirement.correlation)) {
        return false;
    }
    for (const scoped of context.requirement.predicates) {
        if (!predicateRequiresScopeWithinSubquery(subPredicate, relation, scoped, context.parameters)) {
            return false;
        }
    }
    return true;
}

function predicateRequiresScopeWithinSubquery(
    subPredicate: PredicateNode,
    relation: SubqueryRelation,
    scoped: CorrelatedOwnershipScopePredicate,
    parameters: readonly unknown[],
): boolean {
    if (typeof scoped.relation === 'string' && scoped.relation.length > 0) {
        return predicateRequires(subPredicate, scoped, parameters);
    }
    for (const qualifier of relationQualifiers(relation)) {
        if (predicateRequires(subPredicate, { ...scoped, relation: qualifier }, parameters)) {
            return true;
        }
    }
    return false;
}

/**
 * Every spelling by which a column of a single-relation sub-query may legitimately name that relation: the
 * alias the `FROM` introduced, the table itself, and no qualifier at all.
 */
function relationQualifiers(relation: SubqueryRelation): Array<string | undefined> {
    const qualifiers: Array<string | undefined> = [undefined, relation.table];
    if (relation.alias !== undefined && relation.alias !== relation.table) {
        qualifiers.push(relation.alias);
    }
    return qualifiers;
}

/**
 * Whether the sub-query's predicate **requires** the correlation to the enclosing statement's row.
 *
 * The comparison is column-to-column, which is why {@link parseLeafComparison} cannot be reused: it requires a
 * placeholder or a literal on one side, deliberately, so that no column pair is ever read as a scope. Here the
 * pair is the property under test.
 */
function predicateRequiresCorrelation(
    node: PredicateNode,
    relation: SubqueryRelation,
    correlation: CorrelatedOwnershipRequirement['correlation'],
): boolean {
    if (node.kind === 'and') {
        for (const child of node.children) {
            if (predicateRequiresCorrelation(child, relation, correlation)) {
                return true;
            }
        }
        return false;
    }
    if (node.kind === 'or') {
        for (const child of node.children) {
            if (!predicateRequiresCorrelation(child, relation, correlation)) {
                return false;
            }
        }
        return node.children.length > 0;
    }
    if (node.kind === 'uncertifiable' || node.negated) {
        return false;
    }
    const pair = LEAF_COLUMN_PAIR.exec(node.text);
    if (pair === null || pair[2] !== '=') {
        return false;
    }
    const left = { column: lastPathSegment(pair[1]), qualifier: pathQualifier(pair[1]) };
    const right = { column: lastPathSegment(pair[3]), qualifier: pathQualifier(pair[3]) };
    return (
        isCorrelationPair(left, right, relation, correlation) ||
        isCorrelationPair(right, left, relation, correlation)
    );
}

/** One ordering of a column pair: `inner` read as the sub-query's side and `outer` as the statement's. */
function isCorrelationPair(
    inner: { column: string; qualifier: string | undefined },
    outer: { column: string; qualifier: string | undefined },
    relation: SubqueryRelation,
    correlation: CorrelatedOwnershipRequirement['correlation'],
): boolean {
    if (
        inner.column !== correlation.column.toLowerCase() ||
        outer.column !== correlation.outerColumn.toLowerCase()
    ) {
        return false;
    }
    if (relationQualifiers(relation).indexOf(inner.qualifier) === -1) {
        return false;
    }
    if (typeof correlation.outerRelation === 'string' && correlation.outerRelation.length > 0) {
        return outer.qualifier === correlation.outerRelation.toLowerCase();
    }
    // enclosing statement writes — TypeORM does one on some engines and the other on others. What it may NOT
    if (outer.qualifier === undefined) {
        return true;
    }
    return outer.qualifier !== relation.alias && outer.qualifier !== relation.table;
}

/**
 * @description True when the statement's `WHERE` constrains **every** one of the given columns as a mandatory
 * conjunct, quote-agnostically.
 */
export function whereMentionsColumns(
    statement: CapturedStatement | string,
    columnNames: string[],
    dialect?: string,
): boolean {
    if (!Array.isArray(columnNames) || columnNames.length === 0) {
        return false;
    }
    try {
        const lexicon = lexiconForStatement(statement, dialect);
        const predicate = parseStatementPredicate(resolveStatementText(statement), lexicon);
        if (predicate === undefined) {
            return false;
        }
        for (const columnName of columnNames) {
            if (typeof columnName !== 'string' || columnName.length === 0) {
                return false;
            }
            if (!predicateMentionsColumn(predicate, columnName, lexicon)) {
                return false;
            }
        }
        return true;
    } catch {
        // A malformed statement is reported as not carrying the columns rather than throwing, so a
        return false;
    }
}

/**
 * @description True when the statement carries the given value — either as one of its bound parameters, or as an
 * inline literal in its predicate.
 */
export function statementCarriesParameterValue(
    statement: CapturedStatement | readonly unknown[],
    value: unknown,
): boolean {
    try {
        const isRawArray = Array.isArray(statement);
        const parameters: readonly unknown[] = isRawArray
            ? (statement as readonly unknown[])
            : (statement as CapturedStatement).parameters;
        if (value === null || value === undefined) {
            if (!Array.isArray(parameters)) {
                return false;
            }
            for (const parameter of parameters) {
                if (parameter === value) {
                    return true;
                }
            }
            return false;
        }
        const target = String(value);
        if (Array.isArray(parameters)) {
            for (const parameter of parameters) {
                if (parameter !== null && parameter !== undefined && String(parameter) === target) {
                    return true;
                }
            }
        }
        if (isRawArray) {
            return false;
        }
        // The SQLite family inlines a numeric value into the statement text instead of binding it,
        const text = (statement as CapturedStatement).query;
        if (typeof text !== 'string' || text.length === 0) {
            return false;
        }
        const portion = extractWherePortion(text, lexiconFor((statement as CapturedStatement).dialect));
        return containsStandaloneToken(portion === undefined ? stripIdentifierQuotes(text) : portion, target);
    } catch {
        return false;
    }
}

/**
 * @description
 * What {@link QueryCaptureLogger.format} may put in a diagnostic.
 *
 * @docsCategory testing
 */
export interface QueryCaptureFormatOptions {
    /**
     * @description Renders every bound value and every quoted literal VERBATIM instead of describing it.
     */
    readonly revealValues?: boolean;
}

/**
 * Describes one bound value WITHOUT disclosing it: its type, and for a sized value its size.
 */
function describeParameterForDiagnostic(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value);
    }
    if (typeof value === 'string') {
        return `string(${value.length})`;
    }
    if (value instanceof Date) {
        return 'date';
    }
    if (ArrayBuffer.isView(value)) {
        return `binary(${value.byteLength})`;
    }
    if (Array.isArray(value)) {
        return `array(${value.length})`;
    }
    if (typeof value === 'function') {
        return 'function';
    }
    return typeof value === 'object' ? 'object' : typeof value;
}

/** The whole parameter list, described rather than disclosed. */
function describeParametersForDiagnostic(parameters: readonly unknown[] | undefined): string {
    if (parameters === undefined) {
        return 'none';
    }
    return `[${parameters.map(describeParameterForDiagnostic).join(', ')}]`;
}

/**
 * Replaces every single-quoted literal in a statement with a description of its length.
 */
function redactQuotedLiterals(sql: string): string {
    let redacted = '';
    let index = 0;
    while (index < sql.length) {
        const character = sql[index];
        if (character !== "'") {
            redacted += character;
            index++;
            continue;
        }
        let length = 0;
        let cursor = index + 1;
        let closed = false;
        while (cursor < sql.length) {
            if (sql[cursor] === '\\' && cursor + 1 < sql.length) {
                length += 1;
                cursor += 2;
                continue;
            }
            if (sql[cursor] === "'") {
                if (sql[cursor + 1] === "'") {
                    length += 1;
                    cursor += 2;
                    continue;
                }
                closed = true;
                cursor++;
                break;
            }
            length += 1;
            cursor++;
        }
        redacted += `'<redacted:${length}>'`;
        if (!closed) {
            // An unterminated literal — a truncated statement, or one this scanner cannot read. Everything
            return redacted;
        }
        index = cursor;
    }
    return redacted;
}

/**
 * The shortest bound string this redactor will look for inside a driver's own message.
 *
 * A value this short cannot be a credential, and replacing it globally would corrupt the message it was
 * meant to make safe — a one-character parameter occurs in almost every word of an error text.
 */
const MIN_REDACTED_VALUE_LENGTH = 4;

/**
 * Replaces the values a statement actually bound, wherever a driver's message repeats them.
 */
function redactKnownValues(text: string, parameters: readonly unknown[] | undefined): string {
    if (parameters === undefined) {
        return text;
    }
    let redacted = text;
    for (const value of parameters) {
        if (typeof value === 'string' && value.length >= MIN_REDACTED_VALUE_LENGTH) {
            redacted = redacted.split(value).join(`<redacted:${value.length}>`);
        }
    }
    return redacted;
}

/**
 * Renders a value to a string without ever throwing. Circular structures fall back to a plain
 * `String()` rendering, mirroring the `stringifyParams` idiom in
 * `packages/core/src/config/logger/typeorm-logger.ts:L88-L95`.
 */
function safeStringify(value: unknown): string {
    try {
        const rendered = JSON.stringify(value);
        return rendered === undefined ? String(value) : rendered;
    } catch {
        try {
            return String(value);
        } catch {
            return '[unstringifiable]';
        }
    }
}

/**
 * Reads the TypeORM driver type from a query runner's own connection, or `undefined` when there is no
 * runner or the options cannot be read. Every access is guarded because a logger must never be the
 * reason a query fails.
 */
function resolveDriverType(queryRunner: QueryRunner | undefined): string | undefined {
    if (queryRunner === undefined) {
        return undefined;
    }
    try {
        const type = queryRunner.connection?.options?.type;
        return typeof type === 'string' ? type : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reads `queryRunner.isTransactionActive` defensively, returning `undefined` when no runner was
 * supplied or the flag cannot be read.
 */
function resolveTransactionState(queryRunner: QueryRunner | undefined): boolean | undefined {
    if (queryRunner === undefined || queryRunner === null) {
        return undefined;
    }
    try {
        return queryRunner.isTransactionActive === true;
    } catch {
        // A driver whose accessor throws must not turn a captured statement into a test failure.
        return undefined;
    }
}

function normaliseTableNames(tableNames: readonly string[]): string[] {
    const normalised: string[] = [];
    for (const tableName of tableNames) {
        if (typeof tableName === 'string' && tableName.length > 0) {
            const lowered = tableName.toLowerCase();
            if (normalised.indexOf(lowered) === -1) {
                normalised.push(lowered);
            }
        }
    }
    return normalised;
}

/**
 * @description The canonical query-capture instrument: a TypeORM `Logger` that records every statement the data
 * source executes inside an explicitly opened window, so a specification can assert an **exact** statement count,
 * the order of the statements, the shape of their predicates and their bound parameters.
 */
export class QueryCaptureLogger implements TypeOrmLoggerInterface {
    private readonly capturedStatements: CapturedStatement[] = [];
    private readonly capturedSchemaMessages: string[] = [];
    private readonly capturedMigrationMessages: string[] = [];
    private readonly capturedLogMessages: CapturedLogMessage[] = [];
    private readonly capturedSlowQueryNotices: string[] = [];

    /**
     * A stable identifier per `QueryRunner`. A `WeakMap` is used deliberately: the runner is not
     * retained, so installing this logger for the lifetime of a server introduces no leak. Runner
     * identifiers are *not* reset by {@link reset}, so grouping stays meaningful across windows
     * within one server.
     */
    private readonly runnerIds = new WeakMap<QueryRunner, number>();

    private captureEnabled = false;
    private nextSequence = 0;
    private nextRunnerId = 1;

    /**
     * @description
     * Every statement captured in the current window, in issue order, including the
     * transaction-control statements. The array instance is stable across {@link reset}, which
     * truncates it in place, so a reference taken once stays live.
     */
    get statements(): readonly CapturedStatement[] {
        return this.capturedStatements;
    }

    /**
     * @description
     * Messages TypeORM reported through `logSchemaBuild` while capture was enabled. Populated
     * because installing this logger displaces core's `TypeOrmLogger`, so these diagnostics would
     * otherwise be lost entirely.
     */
    get schemaMessages(): readonly string[] {
        return this.capturedSchemaMessages;
    }

    /**
     * @description
     * Messages TypeORM reported through `logMigration` while capture was enabled — the surface the
     * migration suite inspects while applying and reverting.
     */
    get migrationMessages(): readonly string[] {
        return this.capturedMigrationMessages;
    }

    /**
     * @description
     * Messages TypeORM reported through its general-purpose `log` hook while capture was enabled.
     */
    get logMessages(): readonly CapturedLogMessage[] {
        return this.capturedLogMessages;
    }

    /**
     * @description
     * The text of every statement TypeORM reported through `logQuerySlow` while capture was enabled.
     */
    get slowQueryNotices(): readonly string[] {
        return this.capturedSlowQueryNotices;
    }

    /**
     * @description
     * Whether the capture window is currently open. `false` on a fresh instance, by design.
     */
    get enabled(): boolean {
        return this.captureEnabled;
    }

    /**
     * @description
     * Opens the capture window. Prefer {@link capture}, which closes it again even when the
     * operation throws.
     */
    enable(): void {
        this.captureEnabled = true;
    }

    /**
     * @description
     * Closes the capture window. Statements issued while it is closed are not recorded at all.
     */
    disable(): void {
        this.captureEnabled = false;
    }

    /**
     * @description
     * Empties every captured collection and restarts `sequence` at 0. Call it from `beforeEach`, per
     * epic §11.6.1, so a count is scoped to one test rather than to a file.
     */
    reset(): void {
        this.capturedStatements.length = 0;
        this.capturedSchemaMessages.length = 0;
        this.capturedMigrationMessages.length = 0;
        this.capturedLogMessages.length = 0;
        this.capturedSlowQueryNotices.length = 0;
        this.nextSequence = 0;
    }

    /**
     * @description
     * An alias for {@link reset}, for a suite that reads more naturally with it.
     */
    clear(): void {
        this.reset();
    }

    /**
     * @description Runs `fn` with the capture window open and closes it in a `finally`, so a throwing or rejecting
     * operation still ends the window and the rejection still propagates unchanged.
     */
    async capture<T>(fn: () => Promise<T>): Promise<T> {
        const wasEnabled = this.captureEnabled;
        this.enable();
        try {
            return await fn();
        } finally {
            if (!wasEnabled) {
                this.disable();
            }
        }
    }

    /**
     * @description
     * Every captured statement that references at least one of the named tables, token-exactly and
     * case-insensitively, in issue order.
     */
    forTables(...tableNames: [string, ...string[]]): CapturedStatement[] {
        const wanted = normaliseTableNames(tableNames);
        if (wanted.length === 0) {
            return [];
        }
        return this.capturedStatements.filter(entry => {
            if (entry.kind === 'transaction') {
                return false;
            }
            for (const tableName of wanted) {
                if (entry.tables.indexOf(tableName) !== -1) {
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * @description
     * The `SELECT` statements among {@link forTables}. The refused-write contract of
     * FEATURE-001-01 §2.6.1.1 is two separately stated halves — "exactly one scoped `SELECT` ... and
     * no `INSERT`, `UPDATE` or `DELETE` at all" — so this and {@link writesFor} exist as separate
     * methods and are asserted independently.
     */
    selectsFor(...tableNames: [string, ...string[]]): CapturedStatement[] {
        return this.forTables(...tableNames).filter(entry => entry.kind === 'select');
    }

    /**
     * @description
     * The row-level write statements — `insert`, `update` and `delete` — whose **own write target** is one of
     * the named tables. This is how "and none was an `INSERT`, `UPDATE` or `DELETE`" is asserted by name.
     */
    writesFor(...tableNames: [string, ...string[]]): CapturedStatement[] {
        const wanted = normaliseTableNames(tableNames);
        if (wanted.length === 0) {
            return [];
        }
        return this.capturedStatements.filter(entry => {
            if (WRITE_KINDS.indexOf(entry.kind) === -1) {
                return false;
            }
            for (const tableName of wanted) {
                if (entry.targetTables.indexOf(tableName) !== -1) {
                    return true;
                }
            }
            return false;
        });
    }

    count(...tableNames: [string, ...string[]]): number {
        return this.forTables(...tableNames).length;
    }

    /**
     * @description Every statement captured that is not transaction control, **whatever table it names** — including
     * statements against tables this plugin does not own, and table-less probes.
     */
    nonTransactionStatements(): CapturedStatement[] {
        return this.capturedStatements.filter(entry => entry.kind !== 'transaction');
    }

    wholeRequestCount(): number {
        return this.nonTransactionStatements().length;
    }

    /**
     * @description A compact, deterministic, multi-line dump of everything captured — one line per statement,
     * carrying its sequence, kind, runner identifier, transaction state, extracted tables, the statement text
     * truncated to a character budget, and its parameters.
     */
    format(maxQueryLength = DEFAULT_FORMATTED_QUERY_LENGTH, options: QueryCaptureFormatOptions = {}): string {
        const budget =
            typeof maxQueryLength === 'number' && maxQueryLength > 0
                ? maxQueryLength
                : DEFAULT_FORMATTED_QUERY_LENGTH;
        const lines: string[] = [
            `QueryCaptureLogger: ${this.capturedStatements.length} statement(s), capture ${
                this.captureEnabled ? 'enabled' : 'disabled'
            }, engine ${resolveConfiguredEngine()}`,
        ];
        const reveal = options.revealValues === true;
        for (const entry of this.capturedStatements) {
            // REDACTED BEFORE TRUNCATED, so a literal cut in half by the budget cannot leave its opening
            const rendered = reveal ? entry.query : redactQuotedLiterals(entry.query);
            const text = rendered.length > budget ? `${rendered.slice(0, budget)}...` : rendered;
            const parts = [
                `#${entry.sequence}`,
                entry.kind,
                `runner=${String(entry.runnerId)}`,
                `tx=${String(entry.inTransaction)}`,
                `tables=[${entry.tables.join(', ')}]`,
            ];
            if (entry.error !== undefined) {
                // The driver's own message, with the values THIS statement bound removed from it and
                // {@link redactKnownValues} for why this is not the same scan the statement text gets.
                parts.push(
                    `error=${reveal ? entry.error : redactKnownValues(entry.error, entry.parameters)}`,
                );
            }
            const parameters = reveal
                ? safeStringify(entry.parameters)
                : describeParametersForDiagnostic(entry.parameters);
            lines.push(`${parts.join(' ')} :: ${text} :: params=${parameters}`);
        }
        if (this.capturedSlowQueryNotices.length > 0) {
            lines.push(`slow-query notices: ${String(this.capturedSlowQueryNotices.length)}`);
        }
        for (const message of this.capturedSchemaMessages) {
            lines.push(`schema: ${message}`);
        }
        for (const message of this.capturedMigrationMessages) {
            lines.push(`migration: ${message}`);
        }
        for (const message of this.capturedLogMessages) {
            lines.push(`log(${message.level}): ${message.message}`);
        }
        return lines.join('\n');
    }

    /**
     * @description
     * TypeORM's per-statement hook. Called unconditionally by every query runner *before* the
     * statement executes — see `node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js:L70` — which is
     * precisely why this instrument is exact rather than approximate.
     */
    logQuery(query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        this.recordStatement(query, parameters, queryRunner, undefined);
    }

    /**
     * @description TypeORM's failed-statement hook.
     */
    logQueryError(error: string | Error, query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        const errorText =
            typeof error === 'string' ? error : error instanceof Error ? error.message : safeStringify(error);
        const existing = this.findCapturedStatement(query, queryRunner, true);
        if (existing !== undefined) {
            existing.error = errorText;
            return;
        }
        this.recordStatement(query, parameters, queryRunner, errorText);
    }

    /**
     * @description
     * TypeORM's slow-statement hook, called *in addition* to `logQuery` and only when
     * `maxQueryExecutionTime` is configured (`node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js:L85-L87`),
     * which the shared test configuration does not set.
     */
    logQuerySlow(time: number, query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedSlowQueryNotices.push(typeof query === 'string' ? query : safeStringify(query));
        if (this.findCapturedStatement(query, queryRunner, false) === undefined) {
            this.recordStatement(query, parameters, queryRunner, undefined);
        }
    }

    /**
     * @description
     * TypeORM's schema-build hook. Recorded into {@link schemaMessages} rather than discarded,
     * because core's `TypeOrmLogger` is displaced by this one and would otherwise have surfaced it.
     */
    logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedSchemaMessages.push(typeof message === 'string' ? message : safeStringify(message));
    }

    /**
     * @description
     * TypeORM's migration hook. Recorded into {@link migrationMessages}, which is what the migration
     * suite inspects while applying and reverting.
     */
    logMigration(message: string, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedMigrationMessages.push(typeof message === 'string' ? message : safeStringify(message));
    }

    /**
     * @description
     * TypeORM's general-purpose log hook. Recorded into {@link logMessages} with the message
     * rendered to a string, so a suite can assert on it without a type guard.
     */
    log(level: 'log' | 'info' | 'warn', message: any, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedLogMessages.push({
            level,
            message: typeof message === 'string' ? message : safeStringify(message),
        });
    }

    /**
     * Appends one statement record. Every hook funnels through here, so the `enabled` gate and the
     * "never throw" guarantee are implemented once.
     */
    private recordStatement(
        query: string,
        parameters: any[] | undefined,
        queryRunner: QueryRunner | undefined,
        error: string | undefined,
    ): void {
        if (!this.captureEnabled) {
            return;
        }
        const entry = this.buildEntry(query, parameters, queryRunner, this.nextSequence);
        this.nextSequence = entry.sequence + 1;
        if (error !== undefined) {
            entry.error = error;
        }
        this.capturedStatements.push(entry);
    }

    /**
     * Builds one record, degrading rather than throwing. A throw inside a TypeORM logger hook
     * surfaces to the caller as a mysterious query failure, so a parse problem must never become a
     * failure in the code under test; the statement is still recorded, classified conservatively as
     * `other` with no table attributed.
     */
    private buildEntry(
        query: string,
        parameters: any[] | undefined,
        queryRunner: QueryRunner | undefined,
        sequence: number,
    ): CapturedStatement {
        try {
            const text = typeof query === 'string' ? query : safeStringify(query);
            // be known for certain. It decides how `"..."` in this statement is read, so a statement
            const dialect = resolveDriverType(queryRunner);
            return {
                query: text,
                parameters: Array.isArray(parameters) ? parameters.slice() : [],
                kind: classifyStatement(text, dialect),
                dialect,
                tables: extractStatementTables(text, dialect),
                targetTables: extractStatementTargetTables(text, dialect),
                sequence,
                runnerId: this.resolveRunnerId(queryRunner),
                inTransaction: resolveTransactionState(queryRunner),
            };
        } catch {
            return {
                query: typeof query === 'string' ? query : '',
                parameters: [],
                kind: 'other',
                tables: [],
                targetTables: [],
                sequence,
                runnerId: undefined,
                inTransaction: undefined,
            };
        }
    }

    /**
     * Finds the most recent captured statement with the same text, optionally requiring that it does
     * not already carry an error, and requiring a matching runner identifier when both are known.
     * The scan runs backwards, because the statement a second hook is reporting on is the latest
     * matching one.
     */
    private findCapturedStatement(
        query: string,
        queryRunner: QueryRunner | undefined,
        requireNoExistingError: boolean,
    ): CapturedStatement | undefined {
        if (typeof query !== 'string') {
            return undefined;
        }
        const runnerId = queryRunner === undefined ? undefined : this.runnerIds.get(queryRunner);
        for (let index = this.capturedStatements.length - 1; index >= 0; index--) {
            const candidate = this.capturedStatements[index];
            if (candidate.query !== query) {
                continue;
            }
            if (requireNoExistingError && candidate.error !== undefined) {
                continue;
            }
            if (
                runnerId !== undefined &&
                candidate.runnerId !== undefined &&
                candidate.runnerId !== runnerId
            ) {
                continue;
            }
            return candidate;
        }
        return undefined;
    }

    /**
     * Assigns and remembers a stable identifier for a query runner. Nothing is retained beyond the
     * runner's own lifetime, because the registry is a `WeakMap`.
     */
    private resolveRunnerId(queryRunner: QueryRunner | undefined): number | undefined {
        if (queryRunner === undefined || queryRunner === null) {
            return undefined;
        }
        const existing = this.runnerIds.get(queryRunner);
        if (existing !== undefined) {
            return existing;
        }
        const assigned = this.nextRunnerId;
        this.nextRunnerId = assigned + 1;
        this.runnerIds.set(queryRunner, assigned);
        return assigned;
    }
}

/**
 * @description The engine identifiers on which an **exact** statement count may be asserted.
 */
export const STATEMENT_COUNT_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

/**
 * @description
 * Why an exact statement count is asserted on one engine and the behaviour it evidences on all four.
 * Suitable for use as a skip reason at an assertion site.
 */
export const STATEMENT_COUNT_ENGINE_REASON =
    'Statement text and even statement count differ legitimately between drivers, so epic ' +
    '11.6.2 fixes the counted form of a claim to the sql.js job, where it is deterministic, and ' +
    'requires the behaviour that count evidences to be asserted on all four engine jobs.';

/**
 * @description
 * The database engine the e2e run is configured for, resolved exactly as
 * `e2e-common/test-config.ts`'s own `getDbConfig()` resolves it: `process.env.DB || 'sqljs'`.
 */
export function resolveConfiguredEngine(): string {
    return process.env.DB || 'sqljs';
}

/**
 * @description
 * Whether an exact statement count may be asserted on the given engine, defaulting to the engine the
 * run is configured for.
 */
export function isStatementCountEngine(engine?: string): boolean {
    const resolved = (typeof engine === 'string' && engine.length > 0 ? engine : resolveConfiguredEngine())
        .toLowerCase()
        .trim();
    return STATEMENT_COUNT_ENGINES.indexOf(resolved) !== -1;
}

/**
 * @description
 * A `mergeConfig`-ready fragment installing the instrument on `dbConnectionOptions.logger`.
 */
export function queryCaptureConfig(capture: QueryCaptureLogger): QueryCaptureConfigFragment {
    return {
        dbConnectionOptions: {
            logger: capture,
        },
    };
}

// The engine decides which artefact a run applies: the checked-in migration where the shipped DDL matches the
// engine, and otherwise the migration that engine's own lifecycle emits from the same entity metadata. Both

/**
 * @description
 * A migration produced by the platform's lifecycle, loaded and ready to hand to `runMigrations`.
 *
 * @since 3.8.0
 */
export interface LifecycleMigration {
    /** The class TypeORM will instantiate. Its name carries the trailing timestamp TypeORM orders by. */
    readonly migrationClass: new () => MigrationInterface;
    /** That class's name, which is also the name TypeORM records in its own bookkeeping table. */
    readonly className: string;
    /** The generated file's full text, so a caller can assert its dialect markers or its statements. */
    readonly source: string;
    /** Where the generator wrote it — always a temporary directory outside this repository. */
    readonly filePath: string;
    dispose(): Promise<void>;
}

/**
 * @description Whether the checked-in migration can be applied on the given connection.
 */
export function committedMigrationApplies(engine: string): boolean {
    return ['postgres', 'aurora-postgres'].includes(engine);
}

/**
 * @description Generates a migration for the engine `config` points at, through the platform's own lifecycle, and
 * loads the class out of the file it wrote.
 */
export async function generateLifecycleMigration(
    config: Partial<VendureConfig>,
    name: string,
): Promise<LifecycleMigration> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-lifecycle-migration-'));
    const dispose = async () => {
        await fs.remove(outputDir);
    };
    try {
        const filePath = await generateMigration(config, { name, outputDir });
        if (filePath === undefined) {
            throw new Error(
                'generateMigration wrote no file, so the schema it was diffed against already carries ' +
                    'every mapping the registered entities declare. A caller expecting the two plugin ' +
                    'tables has to diff against the core schema alone.',
            );
        }
        const source = await fs.readFile(filePath, 'utf-8');
        return { ...loadMigrationClass(source, filePath), source, filePath, dispose };
    } catch (err) {
        await dispose();
        throw err;
    }
}

/**
 * @description The SQL statements a generated migration file will actually execute, up and down, in order.
 */
export function extractGeneratedStatements(source: string): { up: string[]; down: string[] } {
    const prefix = 'await queryRunner.query(';
    const statements: { up: string[]; down: string[] } = { up: [], down: [] };
    let section: 'up' | 'down' | undefined;
    for (const line of source.split('\n')) {
        if (line.includes('public async up(')) {
            section = 'up';
            continue;
        }
        if (line.includes('public async down(')) {
            section = 'down';
            continue;
        }
        const trimmed = line.trim();
        if (section === undefined || !trimmed.startsWith(prefix)) {
            continue;
        }
        const body = trimmed.slice(prefix.length);
        const delimiter = body.charAt(0);
        if (delimiter !== '"' && delimiter !== '`') {
            throw new Error(
                `a generated statement opens with ${JSON.stringify(delimiter)} rather than a quote or a ` +
                    "backtick, so the generator's template has changed and this extraction is no longer valid",
            );
        }
        let statement = '';
        for (let index = 1; index < body.length; index++) {
            const character = body.charAt(index);
            if (character === '\\' && body.charAt(index + 1) === delimiter) {
                statement += delimiter;
                index++;
                continue;
            }
            if (character === delimiter) {
                break;
            }
            statement += character;
        }
        statements[section].push(statement);
    }
    return statements;
}

/**
 * @description
 * One teardown step: what it does, for a diagnosis, and how to do it.
 *
 * @since 3.8.0
 */
export interface CleanupStep {
    /** What this step releases, phrased to read inside "teardown attempted … and N of them failed: …". */
    readonly what: string;
    run(): Promise<unknown> | unknown;
}

/**
 * @description Attempts EVERY step, whatever any earlier one does, and reports all failures together afterwards.
 */
export async function attemptEveryCleanup(steps: readonly CleanupStep[]): Promise<void> {
    const failures: string[] = [];
    for (const step of steps) {
        try {
            await step.run();
        } catch (error) {
            // itself and therefore carries the statement and its bound parameters as enumerable properties —
            // The label is guarded too, and that is not belt-and-braces: the natural way to make a per-item
            failures.push(`${describeTeardownStage(step.what)} — ${redactTeardownDiagnostic(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `teardown attempted every step and ${failures.length} of ${steps.length} failed: ` +
                failures.join('; '),
        );
    }
}

/**
 * @description
 * The isolated database, and how to remove it again.
 *
 * @since 3.8.0
 */
export interface IsolatedDatabase {
    readonly dbConnectionOptions: DataSourceOptions;
    dispose(): Promise<void>;
}

/**
 * A database name (or file) unique to this clone and this caller.
 *
 * `CLONE_INDEX` is exported by the workspace for exactly this purpose — every host-global resource carries it —
 * so two clones running this package's suites against one database server address different databases.
 */
function isolatedName(label: string): string {
    const clone = (process.env.CLONE_INDEX ?? '000').replace(/[^a-z0-9]/gi, '');
    return `e2e_reorder_state_${label.replace(/[^a-z0-9]/gi, '_')}_${clone}`.toLowerCase();
}

/**
 * @description Creates the isolated database for the engine in use.
 */
export async function createIsolatedDatabase(
    serverConfig: Required<VendureConfig>,
    engine: string,
    label: string,
): Promise<IsolatedDatabase> {
    const options = serverConfig.dbConnectionOptions as unknown as Record<string, unknown>;
    if (engine === 'sqljs') {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-isolated-sqljs-'));
        const location = path.join(directory, `${isolatedName(label)}.sqlite`);
        return {
            dbConnectionOptions: {
                ...(options as object),
                type: 'sqljs',
                location,
                autoSave: true,
                database: undefined,
                synchronize: false,
                logging: false,
            } as unknown as DataSourceOptions,
            dispose: async () => {
                await fs.remove(directory);
            },
        };
    }

    const database = isolatedName(label);
    const maintenance = new DataSource({
        ...(options as object),
        // PostgreSQL requires a database to connect to before it can create another, and its always-present
        // maintenance database is the conventional one. The MySQL family connects without naming one at all.
        database: engine === 'postgres' ? 'postgres' : undefined,
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        entities: [],
        subscribers: [],
        migrations: [],
        logging: false,
    } as unknown as DataSourceOptions);
    await maintenance.initialize();
    try {
        await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
        await maintenance.query(`CREATE DATABASE ${database}`);
    } finally {
        await maintenance.destroy();
    }
    return {
        dbConnectionOptions: {
            ...(options as object),
            database,
            synchronize: false,
            logging: false,
        } as unknown as DataSourceOptions,
        dispose: async () => {
            const cleanup = new DataSource({
                ...(options as object),
                database: engine === 'postgres' ? 'postgres' : undefined,
                synchronize: false,
                migrationsRun: false,
                dropSchema: false,
                entities: [],
                subscribers: [],
                migrations: [],
                logging: false,
            } as unknown as DataSourceOptions);
            await cleanup.initialize();
            try {
                await cleanup.query(`DROP DATABASE IF EXISTS ${database}`);
            } finally {
                await cleanup.destroy();
            }
        },
    };
}

/**
 * @description
 * Opens a data source with the four overrides the platform's own migration entry points apply
 * (`packages/core/src/migrate.ts` L197-L205), plus no subscribers — Vendure's are dependency-injected and
 * nothing here resolves a Nest container.
 *
 * @since 3.8.0
 */
export async function openDataSource(options: DataSourceOptions): Promise<DataSource> {
    const dataSource = new DataSource({
        ...(options as object),
        migrationsRun: false,
        dropSchema: false,
        subscribers: [],
        logging: false,
    } as unknown as DataSourceOptions);
    await dataSource.initialize();
    return dataSource;
}

/**
 * Transpiles the generated migration file in memory and returns the migration class it exports.
 */
function loadMigrationClass(
    source: string,
    filePath: string,
): { migrationClass: new () => MigrationInterface; className: string } {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2019,
        },
        fileName: filePath,
    });
    const moduleExports: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function('exports', 'require', 'module', transpiled.outputText);
    evaluate(moduleExports, () => ({}), { exports: moduleExports });
    const candidates = Object.values(moduleExports).filter(
        (value): value is new () => MigrationInterface =>
            typeof value === 'function' &&
            typeof (value as { prototype?: { up?: unknown } }).prototype?.up === 'function',
    );
    if (candidates.length !== 1) {
        throw new Error(
            `the generated migration at ${filePath} exports ${candidates.length} migration classes, expected 1`,
        );
    }
    const migrationClass = candidates[0];
    if (!/\d+$/.test(migrationClass.name)) {
        throw new Error(
            `the generated migration class ${migrationClass.name} carries no trailing timestamp, which ` +
                'TypeORM needs to order it',
        );
    }
    return { migrationClass, className: migrationClass.name };
}

/**
 * Exposed so a suite that owns its own isolated schema — the migration suite does — can put the platform's
 * module-level configuration back after driving a migration entry point, without importing the platform's
 * reset directly and having to reason about ordering.
 */
export async function restorePlatformConfig(serverConfig: Required<VendureConfig>): Promise<void> {
    resetConfig();
    await preBootstrapConfig(serverConfig);
}
