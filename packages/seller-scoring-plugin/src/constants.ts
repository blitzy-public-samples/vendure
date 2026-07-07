/**
 * @description
 * The DI token used to inject the resolved {@link SellerScoringPluginOptions} into
 * providers such as the SellerScoringService and the Admin resolvers.
 *
 * @since 3.8.0
 */
export const SELLER_SCORING_PLUGIN_OPTIONS = Symbol('SELLER_SCORING_PLUGIN_OPTIONS');

/**
 * @description
 * The logger context string used in all `Logger.*` calls emitted by this plugin.
 *
 * @since 3.8.0
 */
export const loggerCtx = 'SellerScoringPlugin';
