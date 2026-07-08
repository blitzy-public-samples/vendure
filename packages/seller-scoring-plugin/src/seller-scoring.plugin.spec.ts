/* eslint-disable @typescript-eslint/no-non-null-assertion */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SELLER_SCORING_PLUGIN_OPTIONS } from './constants';
import { OrderEventsSubscriber } from './event-subscribers/order-events.subscriber';
import { SellerScoringPlugin } from './seller-scoring.plugin';

/**
 * Unit tests for the {@link SellerScoringPlugin} class itself: the static `init()`
 * option-merging contract, the options DI-provider factory, and the
 * `onApplicationBootstrap` → subscriber wiring. The plugin's `@VendurePlugin`
 * decorator metadata (entities, adminApiExtensions, dashboard path) is validated by
 * the e2e suite; here we exercise the executable runtime behaviour.
 */
describe('SellerScoringPlugin', () => {
    describe('init', () => {
        it('applies the default slaHours of 48 when omitted', () => {
            const returned = SellerScoringPlugin.init({ flaggingThreshold: 70 });

            // `init` returns the plugin class itself so it can be dropped straight into
            // the VendureConfig `plugins` array.
            expect(returned).toBe(SellerScoringPlugin);
            expect(SellerScoringPlugin.options).toEqual({ slaHours: 48, flaggingThreshold: 70 });
        });

        it('lets an explicit slaHours override the default', () => {
            SellerScoringPlugin.init({ slaHours: 24, flaggingThreshold: 60 });

            expect(SellerScoringPlugin.options).toEqual({ slaHours: 24, flaggingThreshold: 60 });
        });
    });

    describe('SELLER_SCORING_PLUGIN_OPTIONS provider', () => {
        it('exposes the resolved options via the injection-token useFactory', () => {
            SellerScoringPlugin.init({ slaHours: 36, flaggingThreshold: 55 });

            // The @VendurePlugin decorator stores providers under the NestJS
            // 'providers' module-metadata key. Locate the options provider and invoke
            // its factory to assert it returns exactly the statically-stored options.
            const providers: any[] = Reflect.getMetadata('providers', SellerScoringPlugin) ?? [];
            const optionsProvider = providers.find(
                p => p && typeof p === 'object' && p.provide === SELLER_SCORING_PLUGIN_OPTIONS,
            );

            expect(optionsProvider).toBeDefined();
            expect(typeof optionsProvider.useFactory).toBe('function');
            expect(optionsProvider.useFactory()).toEqual({ slaHours: 36, flaggingThreshold: 55 });
        });
    });

    describe('onApplicationBootstrap', () => {
        let subscriber: { register: ReturnType<typeof vi.fn> };
        let plugin: SellerScoringPlugin;

        beforeEach(() => {
            subscriber = { register: vi.fn() };
            plugin = new SellerScoringPlugin(subscriber as unknown as OrderEventsSubscriber);
        });

        it('registers the EventBus subscriptions exactly once via the subscriber', () => {
            plugin.onApplicationBootstrap();

            expect(subscriber.register).toHaveBeenCalledTimes(1);
        });
    });
});
