/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
    EventBus,
    Fulfillment,
    FulfillmentStateTransitionEvent,
    ID,
    Logger,
    Order,
    OrderStateTransitionEvent,
    RefundStateTransitionEvent,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SellerScoringService } from '../services/seller-scoring.service';

import { OrderEventsSubscriber } from './order-events.subscriber';

/**
 * Unit tests for {@link OrderEventsSubscriber}. All collaborators are mocked:
 *  - `EventBus.ofType(...)` returns a fake observable whose `subscribe` captures the
 *    handler callback per event class, so `register()` wiring can be asserted and each
 *    callback invoked directly.
 *  - `TransactionalConnection.getRepository(...)` returns per-entity repo mocks used by
 *    the fulfillment/order relation-hydration reads.
 *  - `SellerScoringService.recalculate` is a spy.
 *
 * `Logger.error` is spied so the "log-and-swallow" error boundary (which guarantees a
 * scoring failure can never disrupt the originating order/fulfillment/refund
 * transaction) can be asserted without noisy output.
 */
type RepoMock = { findOne: ReturnType<typeof vi.fn> };

const SELLER_ID: ID = 'S1';

describe('OrderEventsSubscriber', () => {
    let subscriber: OrderEventsSubscriber;
    let orderRepo: RepoMock;
    let fulfillmentRepo: RepoMock;
    let connection: TransactionalConnection;
    let eventBus: EventBus;
    // A direct handle on the `ofType` mock fn. Asserting on this (rather than on
    // `eventBus.ofType`) avoids the `unbound-method` lint rule that fires when a class
    // method reference is passed around, while still verifying the subscription count.
    let ofTypeMock: ReturnType<typeof vi.fn>;
    let service: { recalculate: ReturnType<typeof vi.fn> };
    let handlers: Map<any, (event: any) => void>;
    let loggerError: ReturnType<typeof vi.spyOn>;
    const ctx = RequestContext.empty();

    beforeEach(() => {
        orderRepo = { findOne: vi.fn().mockResolvedValue(null) };
        fulfillmentRepo = { findOne: vi.fn().mockResolvedValue(null) };
        connection = {
            getRepository: vi.fn((_ctx: any, entity: any) => {
                if (entity === Order) {
                    return orderRepo;
                }
                if (entity === Fulfillment) {
                    return fulfillmentRepo;
                }
                throw new Error('Unexpected entity requested from the mock connection');
            }),
        } as unknown as TransactionalConnection;

        handlers = new Map();
        ofTypeMock = vi.fn((type: any) => ({
            subscribe: (cb: (event: any) => void) => {
                handlers.set(type, cb);
                return { unsubscribe: vi.fn() };
            },
        }));
        eventBus = { ofType: ofTypeMock } as unknown as EventBus;

        service = { recalculate: vi.fn().mockResolvedValue(undefined) };
        subscriber = new OrderEventsSubscriber(
            eventBus,
            connection,
            service as unknown as SellerScoringService,
        );
        loggerError = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        loggerError.mockRestore();
    });

    describe('register', () => {
        it('subscribes exactly once to the three domain event types', () => {
            subscriber.register();

            expect(ofTypeMock).toHaveBeenCalledTimes(3);
            expect(handlers.has(OrderStateTransitionEvent)).toBe(true);
            expect(handlers.has(RefundStateTransitionEvent)).toBe(true);
            expect(handlers.has(FulfillmentStateTransitionEvent)).toBe(true);
        });

        it('routes an OrderStateTransitionEvent to handleOrders with the event order', () => {
            const handleOrders = vi.spyOn(subscriber as any, 'handleOrders').mockResolvedValue(undefined);
            subscriber.register();
            const order = { id: 'o1' } as unknown as Order;

            handlers.get(OrderStateTransitionEvent)!({ ctx, order });

            expect(handleOrders).toHaveBeenCalledWith(ctx, [order]);
        });

        it('routes a RefundStateTransitionEvent to handleOrders with the event order', () => {
            const handleOrders = vi.spyOn(subscriber as any, 'handleOrders').mockResolvedValue(undefined);
            subscriber.register();
            const order = { id: 'o2' } as unknown as Order;

            handlers.get(RefundStateTransitionEvent)!({ ctx, order });

            expect(handleOrders).toHaveBeenCalledWith(ctx, [order]);
        });

        it('routes a FulfillmentStateTransitionEvent to handleFulfillment', () => {
            const handleFulfillment = vi
                .spyOn(subscriber as any, 'handleFulfillment')
                .mockResolvedValue(undefined);
            subscriber.register();
            const fulfillment = { id: 'f1' } as unknown as Fulfillment;

            handlers.get(FulfillmentStateTransitionEvent)!({ ctx, fulfillment });

            expect(handleFulfillment).toHaveBeenCalledWith(ctx, fulfillment);
        });
    });

    describe('handleOrders (seller resolution + recalculation)', () => {
        it('recalculates the seller resolved from an order channel', async () => {
            const orders = [{ id: 'o1', channels: [{ sellerId: SELLER_ID }] }] as unknown as Order[];

            await (subscriber as any).handleOrders(ctx, orders);

            expect(service.recalculate).toHaveBeenCalledTimes(1);
            expect(service.recalculate).toHaveBeenCalledWith(ctx, SELLER_ID);
        });

        it('deduplicates so each seller is recalculated at most once per event', async () => {
            const orders = [
                { id: 'o1', channels: [{ sellerId: SELLER_ID }] },
                { id: 'o2', channels: [{ sellerId: SELLER_ID }] },
            ] as unknown as Order[];

            await (subscriber as any).handleOrders(ctx, orders);

            expect(service.recalculate).toHaveBeenCalledTimes(1);
        });

        it('recalculates every distinct seller across an order spanning multiple channels', async () => {
            const orders = [
                { id: 'o1', channels: [{ sellerId: 'S1' }, { sellerId: 'S2' }] },
            ] as unknown as Order[];

            await (subscriber as any).handleOrders(ctx, orders);

            expect(service.recalculate).toHaveBeenCalledTimes(2);
            expect(service.recalculate).toHaveBeenCalledWith(ctx, 'S1');
            expect(service.recalculate).toHaveBeenCalledWith(ctx, 'S2');
        });

        it('ignores channels with a null sellerId (e.g. the default channel)', async () => {
            const orders = [{ id: 'o1', channels: [{ sellerId: null }] }] as unknown as Order[];

            await (subscriber as any).handleOrders(ctx, orders);

            expect(service.recalculate).not.toHaveBeenCalled();
        });

        it('hydrates the channels relation when the order payload lacks it', async () => {
            const orders = [{ id: 'o1' }] as unknown as Order[];
            orderRepo.findOne.mockResolvedValue({ id: 'o1', channels: [{ sellerId: 'S3' }] });

            await (subscriber as any).handleOrders(ctx, orders);

            expect(orderRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'o1' },
                relations: { channels: true },
            });
            expect(service.recalculate).toHaveBeenCalledWith(ctx, 'S3');
        });

        it('logs and swallows a recalculation error (never disrupts the source transaction)', async () => {
            const orders = [{ id: 'o1', channels: [{ sellerId: SELLER_ID }] }] as unknown as Order[];
            service.recalculate.mockRejectedValue(new Error('scoring boom'));

            await expect((subscriber as any).handleOrders(ctx, orders)).resolves.toBeUndefined();
            expect(loggerError).toHaveBeenCalledTimes(1);
            expect(loggerError.mock.calls[0][0]).toContain('scoring boom');
        });

        it('stringifies a thrown non-Error value that has no message', async () => {
            const orders = [{ id: 'o1', channels: [{ sellerId: SELLER_ID }] }] as unknown as Order[];
            // Reject with a value that has no `.message`, exercising the `String(err)` fallback.
            service.recalculate.mockRejectedValue('bare string failure');

            await expect((subscriber as any).handleOrders(ctx, orders)).resolves.toBeUndefined();
            expect(loggerError).toHaveBeenCalledWith('bare string failure', expect.any(String));
        });
    });

    describe('handleFulfillment (relation hydration + delegation)', () => {
        it('reloads the fulfillment with orders+channels and recalculates the seller', async () => {
            fulfillmentRepo.findOne.mockResolvedValue({
                id: 'f1',
                orders: [{ id: 'o1', channels: [{ sellerId: 'S4' }] }],
            });
            const fulfillment = { id: 'f1' } as unknown as Fulfillment;

            await (subscriber as any).handleFulfillment(ctx, fulfillment);

            expect(fulfillmentRepo.findOne).toHaveBeenCalledWith({
                where: { id: 'f1' },
                relations: { orders: { channels: true } },
            });
            expect(service.recalculate).toHaveBeenCalledWith(ctx, 'S4');
        });

        it('does nothing when the fulfillment has no attached orders', async () => {
            fulfillmentRepo.findOne.mockResolvedValue(null);
            const fulfillment = { id: 'f1' } as unknown as Fulfillment;

            await (subscriber as any).handleFulfillment(ctx, fulfillment);

            expect(service.recalculate).not.toHaveBeenCalled();
        });

        it('logs and swallows a hydration/read error', async () => {
            fulfillmentRepo.findOne.mockRejectedValue(new Error('db read boom'));
            const fulfillment = { id: 'f1' } as unknown as Fulfillment;

            await expect((subscriber as any).handleFulfillment(ctx, fulfillment)).resolves.toBeUndefined();
            expect(loggerError).toHaveBeenCalledTimes(1);
            expect(loggerError.mock.calls[0][0]).toContain('db read boom');
        });

        it('stringifies a thrown non-Error hydration failure that has no message', async () => {
            // Reject with a value that has no `.message`, exercising the `String(err)` fallback.
            fulfillmentRepo.findOne.mockRejectedValue('bare hydration failure');
            const fulfillment = { id: 'f1' } as unknown as Fulfillment;

            await expect((subscriber as any).handleFulfillment(ctx, fulfillment)).resolves.toBeUndefined();
            expect(loggerError).toHaveBeenCalledWith('bare hydration failure', expect.any(String));
        });
    });
});
