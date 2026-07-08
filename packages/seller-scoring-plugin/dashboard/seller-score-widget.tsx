import { getFlaggedSellersDocument } from '@/graphql/operations';
import { Trans } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
    Alert,
    AlertDescription,
    AlertTitle,
    api,
    Badge,
    DashboardBaseWidget,
    type DashboardBaseWidgetProps,
    type DashboardWidgetDefinition,
} from '@vendure/dashboard';
import { FlagIcon, TriangleAlertIcon } from 'lucide-react';

/**
 * @description
 * Stable identifier for the flagged-sellers summary widget. Used both as the
 * `DashboardWidgetDefinition.id` and the `DashboardBaseWidget` id so the widget
 * has a single, consistent key across the dashboard grid.
 */
const FLAGGED_SELLERS_WIDGET_ID = 'flagged-sellers-widget';

/**
 * @description
 * Shared React Query cache key. This intentionally matches the key used by the
 * Flagged Sellers route (`flagged-sellers-list.tsx`) so both views read from a
 * single cache entry: recalculating a seller's score from the list view
 * refreshes this widget's count at the same time, and vice-versa.
 */
const FLAGGED_SELLERS_QUERY_KEY = ['flaggedSellers'] as const;

/**
 * @description
 * Local, hand-written shape of a single `SellerScore` row returned by the fixed
 * `flaggedSellers` Admin API query, aligned field-for-field with the plugin's
 * `SellerScore` type.
 */
interface FlaggedSellerData {
    id: string;
    sellerId: string;
    score: number | null;
    fulfillmentSla: number | null;
    cancellationReturnRate: number | null;
    lastCalculatedAt: string | null;
    flagged: boolean;
    seller: { id: string; name: string } | null;
}

/**
 * @description
 * Result shape of the `flaggedSellers` query (`[SellerScore!]!`). The dashboard's static
 * `gql.tada` introspection does not include the plugin's runtime Admin API schema
 * extension, so — exactly as the seller-detail block does — we narrow the query result to
 * this locally-declared, authoritative shape. At runtime the server provides these fields.
 */
interface FlaggedSellersQueryResult {
    flaggedSellers: FlaggedSellerData[];
}

/**
 * @description
 * Dashboard home widget body. Renders the number of sellers whose current
 * composite performance score is below the plugin's configured flagging
 * threshold, sourced exclusively from the fixed `flaggedSellers` Admin API
 * query. The widget is strictly read-only — it surfaces a count for
 * at-a-glance monitoring and performs no seller actions (the feature flags
 * only; a human reviews and decides on next steps).
 *
 * A count of `0` is rendered as a healthy, neutral state (a secondary badge),
 * never as an error; a count greater than `0` is emphasised with a
 * destructive badge to draw attention to sellers needing review.
 *
 * @since 3.8.0
 */
export function FlaggedSellersWidgetComponent(props: DashboardBaseWidgetProps) {
    const { data, isPending, isError } = useQuery({
        queryKey: FLAGGED_SELLERS_QUERY_KEY,
        // The dashboard's static gql.tada introspection does not include the plugin's
        // runtime Admin API types, so we narrow the result to the locally-declared,
        // authoritative shape ({@link FlaggedSellersQueryResult}). At runtime the server
        // provides these fields. This mirrors the seller-detail block's queryFn.
        queryFn: async (): Promise<FlaggedSellersQueryResult> =>
            (await api.query(getFlaggedSellersDocument)) as FlaggedSellersQueryResult,
    });

    // `flaggedSellers` is non-null in the Admin API schema ([SellerScore!]!),
    // but guard defensively so the widget renders `0` while the query is
    // pending or if the field is ever absent, rather than crashing.
    const count = data?.flaggedSellers?.length ?? 0;
    const hasFlagged = count > 0;

    return (
        <DashboardBaseWidget
            id={FLAGGED_SELLERS_WIDGET_ID}
            title="Flagged sellers"
            description="Sellers currently below the performance threshold"
        >
            {isPending ? (
                <span className="text-muted-foreground text-sm">
                    <Trans>Loading…</Trans>
                </span>
            ) : isError ? (
                // Error state (MANDATORY): the `flaggedSellers` query failed. This MUST be handled
                // before the healthy count below — otherwise a failed request would compute
                // `count = 0` and render the reassuring "No sellers flagged" state, hiding the
                // failure and falsely reassuring the admin. A count of `0` is only shown for a
                // successful response whose `flaggedSellers` array is genuinely empty.
                <Alert variant="destructive">
                    <TriangleAlertIcon className="h-4 w-4" />
                    <AlertTitle>
                        <Trans>Unable to load flagged sellers</Trans>
                    </AlertTitle>
                    <AlertDescription>
                        <Trans>The flagged sellers count could not be loaded. Please try again.</Trans>
                    </AlertDescription>
                </Alert>
            ) : (
                <div className="flex items-center gap-3">
                    <FlagIcon
                        className={hasFlagged ? 'text-destructive size-8' : 'text-muted-foreground size-8'}
                        aria-hidden="true"
                    />
                    <div className="flex flex-col items-start gap-1">
                        <Badge variant={hasFlagged ? 'destructive' : 'secondary'} className="text-base">
                            {count}
                        </Badge>
                        <span className="text-muted-foreground text-sm">
                            {hasFlagged ? <Trans>flagged sellers</Trans> : <Trans>No sellers flagged</Trans>}
                        </span>
                    </div>
                </div>
            )}
        </DashboardBaseWidget>
    );
}

/**
 * @description
 * Dashboard summary widget definition contributed to the dashboard home via the
 * plugin's `defineDashboardExtension({ widgets: [...] })` call in
 * `dashboard/index.tsx`. It surfaces the count of currently flagged sellers
 * (those whose current composite score is below the configured performance
 * threshold) for at-a-glance monitoring, satisfying the summary-widget portion
 * of Flow 2. Requires the `ReadSeller` permission so the widget is only shown
 * to administrators who are allowed to read seller data.
 *
 * @since 3.8.0
 */
export const sellerScoreWidget: DashboardWidgetDefinition = {
    id: FLAGGED_SELLERS_WIDGET_ID,
    name: 'Flagged sellers',
    component: FlaggedSellersWidgetComponent,
    defaultSize: { w: 3, h: 3 },
    requiresPermissions: ['ReadSeller'],
};
