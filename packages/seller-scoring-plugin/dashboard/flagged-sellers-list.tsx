import type { ResultOf, VariablesOf } from '@/graphql/graphql';
import { getFlaggedSellersDocument, recalculateSellerScoreDocument } from '@/graphql/operations';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
    Alert,
    AlertDescription,
    AlertTitle,
    api,
    Badge,
    Button,
    DashboardRouteDefinition,
    DataTable,
    Page,
    PageBlock,
    PageTitle,
    Progress,
    useLocalFormat,
} from '@vendure/dashboard';
import { Flag, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

/**
 * @description
 * A single row of the Flagged Sellers table. Each item is a `SellerScore` returned
 * by the fixed `flaggedSellers` Admin API query, which — by contract — only ever
 * returns sellers whose current composite score is below the configured flagging
 * threshold (`flagged === true`, non-null `score`). The nullable metric fields are
 * still coalesced defensively before display so the table never renders a literal
 * `null`/`undefined`.
 *
 * @since 3.8.0
 */
type FlaggedSeller = ResultOf<typeof getFlaggedSellersDocument>['flaggedSellers'][number];

/**
 * @description
 * Variables accepted by the per-row Recalculate mutation. Derived from the operation
 * document so the `sellerId` type always matches the Admin API `ID` scalar exactly.
 */
type RecalculateVariables = VariablesOf<typeof recalculateSellerScoreDocument>;

/**
 * Shared React Query cache key for the flagged-sellers list. Reused by the list query,
 * the manual refresh control, and the post-recalculation invalidation so that a seller
 * whose recalculated score rises back above the threshold drops off the list on refetch.
 */
const FLAGGED_SELLERS_QUERY_KEY = ['flaggedSellers'] as const;

/**
 * Converts a 0–1 metric fraction (e.g. `FulfillmentSLA`, `CancellationReturnRate`) into
 * a percentage in the inclusive range [0, 100], suitable for both textual display and the
 * `Progress` component's `value` prop. Null/undefined fractions coalesce to `0`.
 */
function metricToPercent(fraction: number | null | undefined): number {
    const percent = (fraction ?? 0) * 100;
    if (percent < 0) {
        return 0;
    }
    if (percent > 100) {
        return 100;
    }
    return percent;
}

/**
 * @description
 * The data table that lists every currently-flagged seller together with the metrics
 * driving the flag and a per-row Recalculate action. Consumes exactly two operations
 * from the plugin's fixed Admin API surface: the `flaggedSellers` query and the
 * `recalculateSellerScore` mutation. It performs no client-side re-filtering — the set
 * of rows is authoritative as returned by the server.
 */
function FlaggedSellersTable() {
    const { t } = useLingui();
    const { formatDate } = useLocalFormat();
    const queryClient = useQueryClient();

    const { data, isPending } = useQuery({
        queryKey: FLAGGED_SELLERS_QUERY_KEY,
        queryFn: () => api.query(getFlaggedSellersDocument),
    });
    const rows: FlaggedSeller[] = data?.flaggedSellers ?? [];

    const refreshFlaggedSellers = () => {
        void queryClient.invalidateQueries({ queryKey: FLAGGED_SELLERS_QUERY_KEY });
    };

    const recalculate = useMutation({
        mutationFn: (variables: RecalculateVariables) =>
            api.mutate(recalculateSellerScoreDocument, variables),
        onSuccess: () => {
            toast.success(t`Seller score recalculated`);
            // A seller whose score now sits at/above the threshold is no longer flagged
            // and will disappear from the list once the query refetches.
            refreshFlaggedSellers();
        },
        onError: () => {
            toast.error(t`Failed to recalculate seller score`);
        },
    });

    const columnHelper = createColumnHelper<FlaggedSeller>();
    const columns = [
        columnHelper.accessor('seller', {
            header: t`Seller`,
            cell: ({ row }) => (
                <span className="font-medium">
                    {row.original.seller?.name ?? String(row.original.sellerId)}
                </span>
            ),
        }),
        columnHelper.accessor('score', {
            header: t`Current score`,
            cell: ({ row }) => (
                <Badge variant="destructive" className="tabular-nums">
                    {row.original.score != null ? row.original.score.toFixed(1) : '—'}
                </Badge>
            ),
        }),
        columnHelper.accessor('fulfillmentSla', {
            header: t`Fulfillment SLA`,
            cell: ({ row }) => {
                const percent = metricToPercent(row.original.fulfillmentSla);
                return (
                    <div className="flex flex-col gap-1 w-32">
                        <span className="text-sm tabular-nums">{percent.toFixed(1)}%</span>
                        <Progress value={percent} />
                    </div>
                );
            },
        }),
        columnHelper.accessor('cancellationReturnRate', {
            header: t`Cancellation / return rate`,
            cell: ({ row }) => {
                const percent = metricToPercent(row.original.cancellationReturnRate);
                return (
                    <div className="flex flex-col gap-1 w-32">
                        <span className="text-sm tabular-nums">{percent.toFixed(1)}%</span>
                        <Progress value={percent} />
                    </div>
                );
            },
        }),
        columnHelper.accessor('lastCalculatedAt', {
            header: t`Last calculated`,
            cell: ({ row }) =>
                row.original.lastCalculatedAt ? (
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {formatDate(row.original.lastCalculatedAt, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: 'numeric',
                        })}
                    </span>
                ) : (
                    <span className="text-sm text-muted-foreground">
                        <Trans>Never</Trans>
                    </span>
                ),
        }),
        columnHelper.display({
            id: 'actions',
            header: t`Actions`,
            cell: ({ row }) => (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={recalculate.isPending}
                    onClick={() => recalculate.mutate({ sellerId: row.original.sellerId })}
                >
                    <RefreshCw className="h-4 w-4" />
                    <Trans>Recalculate</Trans>
                </Button>
            ),
        }),
    ];

    // Healthy/normal case: no seller is currently below the threshold. This reads as a
    // positive, reassuring state rather than an error.
    if (!isPending && rows.length === 0) {
        return (
            <Alert>
                <Flag className="h-4 w-4" />
                <AlertTitle>
                    <Trans>No sellers are currently flagged</Trans>
                </AlertTitle>
                <AlertDescription>
                    <Trans>Every seller is performing at or above the configured score threshold.</Trans>
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <DataTable
            columns={columns}
            data={rows}
            totalItems={rows.length}
            isLoading={isPending}
            onRefresh={refreshFlaggedSellers}
        />
    );
}

/**
 * @description
 * Dedicated **Flagged Sellers** dashboard route (satisfies User Flow 2). Renders a list
 * view of every seller currently below the configured flagging threshold, backed by the
 * `flaggedSellers` Admin API query, with columns for the seller, current score, the two
 * driving metrics (fulfillment SLA and cancellation/return rate), and the last-calculated
 * time — plus a per-row Recalculate action wired to the `recalculateSellerScore` mutation.
 *
 * The view is strictly read-and-review: Recalculate is the only mutation exposed here. It
 * never auto-suspends, deactivates, or removes a seller — a human reviews the metrics and
 * decides on next steps.
 *
 * `index.tsx` imports this definition and registers it under `defineDashboardExtension`'s
 * `routes` array.
 *
 * @since 3.8.0
 */
export const flaggedSellersList: DashboardRouteDefinition = {
    path: '/flagged-sellers',
    navMenuItem: {
        sectionId: 'catalog',
        id: 'flagged-sellers',
        url: '/flagged-sellers',
        title: 'Flagged sellers',
        icon: Flag,
    },
    loader: () => ({ breadcrumb: 'Flagged sellers' }),
    component: () => (
        <Page pageId="flagged-sellers-list">
            <PageTitle>
                <Trans>Flagged sellers</Trans>
            </PageTitle>
            <PageBlock column="main" blockId="flagged-sellers-table">
                <FlaggedSellersTable />
            </PageBlock>
        </Page>
    ),
};
