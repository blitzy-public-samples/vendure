import { getSellerScoreDocument } from '@/graphql/operations';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
    Alert,
    AlertDescription,
    AlertTitle,
    api,
    Badge,
    type ChartConfig,
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type DashboardPageBlockDefinition,
    type PageContextValue,
    Progress,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useLocalFormat,
} from '@vendure/dashboard';
import { ClockIcon, FlagIcon, GaugeIcon, TriangleAlertIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

/**
 * The score is reported by the plugin's Admin API on a fixed 0–100 scale. Kept as a
 * named domain constant (rather than a bare literal) so the chart axis and the progress
 * clamp document the score scale they operate on.
 */
const SCORE_SCALE_MAX = 100;

/**
 * @description
 * Local, hand-written shape of a single immutable score snapshot as selected by
 * {@link getSellerScoreDocument} (`SellerScoreSnapshot`). All fields are non-null per the
 * plugin's Admin API schema.
 */
interface SellerScoreSnapshotData {
    id: string;
    score: number;
    fulfillmentSla: number;
    cancellationReturnRate: number;
    calculatedAt: string;
}

/**
 * @description
 * Local, hand-written shape of the `SellerScore` fields consumed by this block.
 *
 * `score`, `fulfillmentSla`, `cancellationReturnRate` and `lastCalculatedAt` are nullable:
 * a `null` `score` means the seller had **no orders in the trailing 90-day window**, which
 * this block renders as an explicit "no score yet" state — never as `0`.
 */
interface SellerScoreData {
    id: string;
    sellerId: string;
    score: number | null;
    fulfillmentSla: number | null;
    cancellationReturnRate: number | null;
    lastCalculatedAt: string | null;
    flagged: boolean;
    seller: { id: string; name: string } | null;
    history: SellerScoreSnapshotData[];
}

/**
 * @description
 * Result shape of the `GetSellerScore` query. `sellerScore` is nullable (the seller may
 * not have a score row yet).
 */
interface SellerScoreQueryResult {
    sellerScore: SellerScoreData | null;
}

/**
 * Formats the composite score to a single decimal place so the exact values produced by
 * the scoring service render deterministically (e.g. `85.0`, `0.0`).
 */
function formatScore(value: number): string {
    return value.toFixed(1);
}

/**
 * Formats a `[0, 1]` metric fraction as a one-decimal percentage readout (e.g. `80.0%`).
 */
function formatFractionAsPercent(fraction: number): string {
    return `${(fraction * SCORE_SCALE_MAX).toFixed(1)}%`;
}

/**
 * Renders a single labelled metric row: the metric name, its percentage readout, and a
 * progress bar. The underlying value is a fraction in `[0, 1]`; it is scaled to the
 * `0–100` range the {@link Progress} primitive expects and clamped defensively.
 */
function MetricBar({ label, fraction }: Readonly<{ label: ReactNode; fraction: number | null }>) {
    const safeFraction = typeof fraction === 'number' ? fraction : 0;
    const percentValue = Math.min(SCORE_SCALE_MAX, Math.max(0, safeFraction * SCORE_SCALE_MAX));
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium tabular-nums">{formatFractionAsPercent(safeFraction)}</span>
            </div>
            <Progress value={percentValue} />
        </div>
    );
}

/**
 * Renders the seller's score history as a chronological trend line (oldest → newest, the
 * order returned by the Admin API field resolver). Colours resolve to the dashboard chart
 * design token via the {@link ChartContainer} config (`--color-score`), never a hardcoded
 * value.
 */
function ScoreHistoryChart({ history }: Readonly<{ history: SellerScoreSnapshotData[] }>) {
    const { t } = useLingui();
    const { formatDate } = useLocalFormat();

    const chartData = history.map(snapshot => ({
        date: formatDate(snapshot.calculatedAt),
        score: snapshot.score,
    }));

    const chartConfig = {
        score: {
            label: t`Score`,
            color: 'var(--chart-1)',
        },
    } satisfies ChartConfig;

    return (
        <ChartContainer config={chartConfig} className="w-full">
            <LineChart accessibilityLayer data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} />
                <YAxis domain={[0, SCORE_SCALE_MAX]} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line dataKey="score" type="monotone" stroke="var(--color-score)" dot={false} />
            </LineChart>
        </ChartContainer>
    );
}

/**
 * The seller-detail page block component. Reads the current seller id from the page
 * context, loads that seller's score via the fixed `sellerScore` Admin API query, and
 * renders the composite score, the per-metric breakdown, and the score history.
 *
 * Note on layout: the dashboard's page-block framework already wraps an extension block's
 * content in a `Card` (with the block `title` rendered as the `CardTitle`) when the block
 * is placed in the `main`/`side` column — verified in the dashboard `PageBlock`
 * implementation. This component therefore renders its content directly and deliberately
 * does NOT add its own `Card`, to avoid a redundant nested card. This mirrors the
 * convention used by the existing in-repo dashboard extension blocks.
 *
 * This block is strictly read-and-review: it displays data only and exposes no control
 * that suspends, deactivates, or removes a seller.
 */
function SellerScoreBlockComponent({ context }: Readonly<{ context: PageContextValue }>) {
    const { formatDate } = useLocalFormat();

    const sellerId = context.entity?.id as string | undefined;
    const enabled = !!sellerId && sellerId !== 'new';

    const { data, isPending, isError } = useQuery({
        queryKey: ['sellerScore', sellerId],
        queryFn: async (): Promise<SellerScoreQueryResult> => {
            // Narrow `sellerId` to a definite string for the query variables. The query is
            // only `enabled` when `sellerId` is set, so this guard is not reached in practice.
            if (!sellerId) {
                return { sellerScore: null };
            }
            const result = await api.query(getSellerScoreDocument, { sellerId });
            // The dashboard's static gql.tada introspection does not include the plugin's
            // runtime Admin API types, so we narrow the result to the locally-declared,
            // authoritative shape. At runtime the server provides these fields.
            return result as SellerScoreQueryResult;
        },
        enabled,
    });

    // Guard for the create/new page and the initial render before the seller entity is
    // available. The query is likewise disabled via `enabled`, so nothing is fetched.
    if (!enabled) {
        return null;
    }

    if (isPending) {
        return (
            <div className="text-sm text-muted-foreground">
                <Trans>Loading…</Trans>
            </div>
        );
    }

    // Error state (MANDATORY): the `sellerScore` query failed. This MUST be handled before the
    // null-score branch below — otherwise a failed request would fall through to `score === null`
    // and be misrendered as the "no orders in window" notice, telling the admin the seller has no
    // recent orders when in fact the data could not be loaded. Rendered as a destructive Alert that
    // is visually distinct from both the null-score notice and a real score.
    if (isError) {
        return (
            <Alert variant="destructive">
                <TriangleAlertIcon className="h-4 w-4" />
                <AlertTitle>
                    <Trans>Unable to load performance score</Trans>
                </AlertTitle>
                <AlertDescription>
                    <Trans>
                        The seller performance score could not be loaded. This does not mean the seller has no
                        orders — please try again.
                    </Trans>
                </AlertDescription>
            </Alert>
        );
    }

    const score = data?.sellerScore ?? null;

    // Null-score state (MANDATORY): the seller has no orders in the trailing 90-day window,
    // so no performance score has been calculated. This is rendered as an explicit notice
    // and MUST remain visually distinct from a real `0.0` score — never render `0` here.
    if (!score || typeof score.score !== 'number') {
        return (
            <Alert>
                <TriangleAlertIcon className="h-4 w-4" />
                <AlertTitle>
                    <Trans>No score yet</Trans>
                </AlertTitle>
                <AlertDescription>
                    <Trans>
                        This seller has no orders in the last 90 days, so no performance score has been
                        calculated.
                    </Trans>
                </AlertDescription>
            </Alert>
        );
    }

    const flagged = score.flagged === true;
    const history = score.history ?? [];

    return (
        <div className="space-y-4">
            {flagged ? (
                <Alert variant="destructive">
                    <FlagIcon className="h-4 w-4" />
                    <AlertTitle>
                        <Trans>Below threshold — flagged for review</Trans>
                    </AlertTitle>
                    <AlertDescription>
                        <Trans>The composite score is below the configured flagging threshold.</Trans>
                    </AlertDescription>
                </Alert>
            ) : null}

            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <GaugeIcon className="h-4 w-4" />
                    <Trans>Composite score</Trans>
                </span>
                <Badge variant={flagged ? 'destructive' : 'secondary'} className="text-base tabular-nums">
                    {formatScore(score.score)}
                </Badge>
            </div>

            <Tabs defaultValue="breakdown">
                <TabsList>
                    <TabsTrigger value="breakdown">
                        <Trans>Breakdown</Trans>
                    </TabsTrigger>
                    <TabsTrigger value="history">
                        <Trans>History</Trans>
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="breakdown" className="space-y-4 pt-2">
                    <MetricBar label={<Trans>Fulfillment SLA</Trans>} fraction={score.fulfillmentSla} />
                    <MetricBar
                        label={<Trans>Cancellation / return rate</Trans>}
                        fraction={score.cancellationReturnRate}
                    />
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ClockIcon className="h-3.5 w-3.5" />
                        {score.lastCalculatedAt ? (
                            <span>
                                <Trans>Last calculated</Trans>: {formatDate(score.lastCalculatedAt)}
                            </span>
                        ) : (
                            <Trans>Never calculated</Trans>
                        )}
                    </div>
                </TabsContent>
                <TabsContent value="history" className="pt-2">
                    {history.length > 0 ? (
                        <ScoreHistoryChart history={history} />
                    ) : (
                        <div className="text-sm text-muted-foreground">
                            <Trans>No history yet</Trans>
                        </div>
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}

/**
 * @description
 * Dashboard page block that surfaces a seller's Seller Performance Score on the
 * seller-detail page. It renders the current composite score (with a destructive badge
 * and alert when the seller is flagged), the per-metric breakdown (fulfillment SLA and
 * cancellation/return rate), and the full score history — satisfying User Flow 1.
 *
 * Consumed by the plugin's dashboard extension entry (`dashboard/index.tsx`), which places
 * this definition in `pageBlocks`. Attaches after the seller detail `main-form` block at
 * `pageId: 'seller-detail'`.
 *
 * @since 3.8.0
 */
export const sellerScoreBlock: DashboardPageBlockDefinition = {
    id: 'seller-score',
    title: <Trans>Seller performance score</Trans>,
    location: {
        pageId: 'seller-detail',
        column: 'side',
        position: { blockId: 'main-form', order: 'after' },
    },
    component: SellerScoreBlockComponent,
};
