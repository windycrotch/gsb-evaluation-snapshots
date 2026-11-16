import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
    ItemCollection,
    isItemCollection,
    type DrawItems,
    type ItemCollectionChange,
    type ItemKey,
    type ReadonlyItemCollection,
} from "../../src/modules/ItemCollection";
import type { Rect } from "../../src/types/draw-object";

interface Item {
    id: ItemKey;
    x: number;
    style?: { color: string; opacity?: number };
}

const collection = (items: readonly Item[] = []) => new ItemCollection(items, { keyOf: (item) => item.id });

describe("ItemCollection", () => {
    it("owns a stable dense backing array, preserving constructor item references", () => {
        const original = { id: "first", x: 0 };
        const input = [original];
        const source = collection(input);
        const items = source.items;

        source.insert({ id: "second", x: 1 });
        source.update("first", { x: 2 });
        source.remove("second");

        expect(source.items).toBe(items);
        expect(source.items).toEqual([{ id: "first", x: 2 }]);
        expect(source.size).toBe(1);
        expect(input).toEqual([original]);
        expect(original.x).toBe(0);
        expect(source.get("missing")).toBeUndefined();
        expect(source.keyAt(0)).toBe("first");
        expect(source.keyAt(1)).toBeUndefined();
        expect(source.keyAt(-1)).toBeUndefined();
    });

    it("rejects duplicate constructor keys and runtime keys outside string/number", () => {
        expect(() =>
            collection([
                { id: "a", x: 0 },
                { id: "a", x: 1 },
            ]),
        ).toThrow("duplicate key a");
        expect(() => new ItemCollection([{ x: 0 }], { keyOf: () => null as unknown as ItemKey })).toThrow(
            "keys must be strings or numbers",
        );
    });

    it("distinguishes string and numeric keys and uses Map equality for numeric keys", () => {
        const source = collection([
            { id: 1, x: 0 },
            { id: "1", x: 1 },
            { id: NaN, x: 2 },
            { id: 0, x: 3 },
        ]);
        source.update(NaN, { x: 4 });
        source.update(-0, { id: -0, x: 5 });
        expect(source.get(1)?.x).toBe(0);
        expect(source.get("1")?.x).toBe(1);
        expect(source.get(NaN)?.x).toBe(4);
        expect(source.get(0)?.x).toBe(5);
        expect(() => source.insert({ id: NaN, x: 6 })).toThrow("duplicate key");
    });

    it("applies shallow patches and immutable updaters without changing item order", () => {
        const first = { id: "a", x: 0, style: { color: "red", opacity: 0.5 } };
        const second = { id: "b", x: 1 };
        const source = collection([first, second]);
        const changes: ItemCollectionChange<Item>[] = [];
        source.subscribe((next) => changes.push(...next));

        const patched = source.update("a", { style: { color: "blue" } });
        const updated = source.update("a", (item) => ({ ...item, x: item.x + 3 }));
        const copied = source.update("a", (item) => item);

        expect(patched).toEqual({ id: "a", x: 0, style: { color: "blue" } });
        expect(updated).toEqual({ id: "a", x: 3, style: { color: "blue" } });
        expect(copied).toEqual(updated);
        expect(copied).not.toBe(updated);
        expect(source.items[0]).toBe(copied);
        expect(source.items[1]).toBe(second);
        expect(first).toEqual({ id: "a", x: 0, style: { color: "red", opacity: 0.5 } });
        expect(changes[0]).toEqual({ type: "update", key: "a", previous: first, item: patched, index: 0 });
    });

    it("fails invalid mutations before changing the backing array or notifying", () => {
        const source = collection([
            { id: "a", x: 0 },
            { id: "b", x: 1 },
        ]);
        const before = [...source.items];
        const listener = vi.fn();
        source.subscribe(listener);

        expect(() => source.insert({ id: "a", x: 8 })).toThrow("duplicate key a");
        expect(() => source.update("unknown", { x: 8 })).toThrow("unknown key unknown");
        expect(() => source.update("a", { id: "b", x: 8 })).toThrow("cannot change key");
        expect(() => source.update("a", (item) => ({ ...item, id: "new" }))).toThrow("cannot change key");
        expect(() => source.update("a", { id: null as unknown as ItemKey })).toThrow("keys must be");
        expect(source.remove("missing")).toBe(false);
        expect(source.items).toEqual(before);
        source.items.forEach((item, index) => expect(item).toBe(before[index]));
        expect(source.get("new")).toBeUndefined();
        expect(source.size).toBe(2);
        expect(listener).not.toHaveBeenCalled();
    });

    it("compacts removals, updates shifted indexes, and appends reinsertions", () => {
        const a = { id: "a", x: 0 };
        const source = collection([a, { id: "b", x: 1 }, { id: "c", x: 2 }]);
        const changes: ItemCollectionChange<Item>[] = [];
        source.subscribe((next) => changes.push(...next));

        expect(source.remove("a")).toBe(true);
        source.update("c", { x: 3 });
        source.insert(a);

        expect(source.items.map((item) => item.id)).toEqual(["b", "c", "a"]);
        expect([source.keyAt(0), source.keyAt(1), source.keyAt(2)]).toEqual(["b", "c", "a"]);
        expect(changes.map(({ type, key, index }) => ({ type, key, index }))).toEqual([
            { type: "remove", key: "a", index: 0 },
            { type: "update", key: "c", index: 1 },
            { type: "insert", key: "a", index: 2 },
        ]);
    });

    it("groups nested batches in mutation order and returns the callback result", () => {
        const source = collection([{ id: "a", x: 0 }]);
        const listener = vi.fn();
        source.subscribe(listener);

        const result = source.batch(() => {
            source.insert({ id: "b", x: 1 });
            source.batch(() => source.update("a", { x: 2 }));
            source.remove("b");
            expect(listener).not.toHaveBeenCalled();
            return 42;
        });

        expect(result).toBe(42);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].map((change: ItemCollectionChange<Item>) => change.type)).toEqual([
            "insert",
            "update",
            "remove",
        ]);
        source.batch(() => source.remove("missing"));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("flushes successful changes when a batch callback fails, without rollback", () => {
        const source = collection();
        const callbackError = new Error("callback failed");
        const listener = vi.fn();
        source.subscribe(listener);

        expect(() =>
            source.batch(() => {
                source.insert({ id: "a", x: 0 });
                throw callbackError;
            }),
        ).toThrow(callbackError);

        expect(source.size).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
        source.insert({ id: "b", x: 1 });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("queues reentrant changes until all current subscribers receive the earlier batch", () => {
        const source = collection();
        const calls: string[] = [];
        source.subscribe((changes) => {
            calls.push(`first:${String(changes[0].key)}`);
            if (changes[0].key === "a") {
                source.batch(() => {
                    source.insert({ id: "b", x: 1 });
                    source.update("b", { x: 2 });
                });
            }
        });
        source.subscribe((changes) => calls.push(`second:${changes.map((change) => change.key).join(",")}`));

        source.insert({ id: "a", x: 0 });

        expect(calls).toEqual(["first:a", "second:a", "first:b", "second:b,b"]);
        expect(source.items).toEqual([
            { id: "a", x: 0 },
            { id: "b", x: 2 },
        ]);
    });

    it("notifies every subscriber and queued batch before rethrowing the first listener error", () => {
        const source = collection();
        const firstError = new Error("first failure");
        const secondError = new Error("second failure");
        source.subscribe((changes) => {
            if (changes[0].key === "a") {
                source.insert({ id: "b", x: 1 });
            }
            throw firstError;
        });
        const observed = vi.fn();
        source.subscribe(observed);
        source.subscribe(() => {
            throw secondError;
        });

        expect(() => source.insert({ id: "a", x: 0 })).toThrow(firstError);

        expect(observed.mock.calls.map(([changes]) => changes[0].key)).toEqual(["a", "b"]);
        expect(source.size).toBe(2);
        expect(() => source.update("b", { x: 2 })).toThrow(firstError);
        expect(observed).toHaveBeenCalledTimes(3);
        expect(source.get("b")?.x).toBe(2);
    });

    it("preserves a batch callback error when a listener also throws", () => {
        const source = collection();
        const callbackError = new Error("callback failure");
        source.subscribe(() => {
            throw new Error("listener failure");
        });
        const observed = vi.fn();
        source.subscribe(observed);

        expect(() =>
            source.batch(() => {
                source.insert({ id: "a", x: 0 });
                throw callbackError;
            }),
        ).toThrow(callbackError);
        expect(observed).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes idempotently and does not replay queued changes to new subscribers", () => {
        const source = collection();
        const late = vi.fn();
        const removed = vi.fn();
        let unsubscribe = () => {};
        source.subscribe((changes) => {
            if (changes[0].key === "a") {
                source.insert({ id: "b", x: 1 });
                source.subscribe(late);
                unsubscribe();
                unsubscribe();
            }
        });
        unsubscribe = source.subscribe(removed);

        source.insert({ id: "a", x: 0 });
        expect(removed).not.toHaveBeenCalled();
        expect(late).not.toHaveBeenCalled();
        source.insert({ id: "c", x: 2 });
        expect(late).toHaveBeenCalledTimes(1);
        expect(late.mock.calls[0][0][0].key).toBe("c");
    });

    it("delivers only the pending batch tail to subscribers added after earlier changes", () => {
        const source = collection();
        const early = vi.fn();
        const late = vi.fn();
        const afterLastChange = vi.fn();
        source.subscribe(early);
        let captured: readonly Item[] = [];

        source.batch(() => {
            source.insert({ id: "a", x: 0 });
            captured = [...source.items];
            source.subscribe(late);
            source.update("a", { x: 1 });
            source.insert({ id: "b", x: 2 });
            source.subscribe(afterLastChange);
        });

        expect(captured).toEqual([{ id: "a", x: 0 }]);
        expect(early.mock.calls[0][0].map((change: ItemCollectionChange<Item>) => change.type)).toEqual([
            "insert",
            "update",
            "insert",
        ]);
        expect(late.mock.calls[0][0].map((change: ItemCollectionChange<Item>) => change.type)).toEqual([
            "update",
            "insert",
        ]);
        expect(afterLastChange).not.toHaveBeenCalled();
        source.update("b", { x: 3 });
        expect(late).toHaveBeenCalledTimes(2);
        expect(afterLastChange).toHaveBeenCalledTimes(1);
    });

    it("recognizes only explicit live collections", () => {
        const source = collection();
        expect(isItemCollection(source)).toBe(true);
        for (const value of [null, undefined, [], new Set(), { items: [], subscribe() {} }, "items"]) {
            expect(isItemCollection(value)).toBe(false);
        }
    });

    it("replays applied changes after a sequence, in order, without exposing internal state", () => {
        const first = { id: "a", x: 0 };
        const source = collection([first]);
        expect(source.changesSince(0)).toEqual({ changes: [], sequence: 0 });

        source.insert({ id: "b", x: 1 });
        source.update("a", { x: 2 });
        source.remove("b");

        const all = source.changesSince(0);
        expect(all.sequence).toBe(3);
        expect(all.changes.map(({ type, key, index }) => ({ type, key, index }))).toEqual([
            { type: "insert", key: "b", index: 1 },
            { type: "update", key: "a", index: 0 },
            { type: "remove", key: "b", index: 1 },
        ]);
        expect(all.changes[1]).toMatchObject({
            type: "update",
            key: "a",
            item: { id: "a", x: 2 },
            previous: first,
            index: 0,
        });
        expect((all.changes[1] as Extract<ItemCollectionChange<Item>, { type: "update" }>).previous).toBe(first);

        const tail = source.changesSince(2);
        expect(tail.sequence).toBe(3);
        expect(tail.changes.map((change) => change.key)).toEqual(["b"]);
        expect(tail.changes[0].type).toBe("remove");

        expect(source.changesSince(3)).toEqual({ changes: [], sequence: 3 });
        expect(source.changesSince(99)).toEqual({ changes: [], sequence: 3 });

        // Both the array and its records are frozen, and the array is a copy:
        // no caller can rewrite the log the next read returns.
        expect(Object.isFrozen(all.changes)).toBe(true);
        expect(all.changes.every((change) => Object.isFrozen(change))).toBe(true);
        expect(() => (all.changes as ItemCollectionChange<Item>[]).push(all.changes[0])).toThrow(TypeError);
        expect(() => {
            (all.changes[0] as { key: ItemKey }).key = "tampered";
        }).toThrow(TypeError);
        expect(source.changesSince(0)).toEqual(all);
        expect(source.changesSince(0).changes).not.toBe(all.changes);
    });

    it("rejects invalid change-log cursors without touching the collection", () => {
        const source = collection([{ id: "a", x: 0 }]);
        source.insert({ id: "b", x: 1 });
        const items = source.items;
        const log = source.changesSince(0);

        for (const invalid of [-1, -0.5, 1.5, NaN, Infinity, -Infinity]) {
            expect(() => source.changesSince(invalid)).toThrow(TypeError);
        }
        for (const invalid of ["1", null, undefined, true, {}]) {
            expect(() => source.changesSince(invalid as unknown as number)).toThrow(TypeError);
        }

        expect(source.items).toBe(items);
        expect(source.items.map((item) => item.id)).toEqual(["a", "b"]);
        expect(source.changesSince(0)).toEqual(log);
    });

    it("rejects replaceAll atomically, reusing the duplicate-key and invalid-key errors", () => {
        const first = { id: "a", x: 0 };
        const second = { id: "b", x: 1 };
        const source = collection([first, second]);
        const items = source.items;
        const listener = vi.fn();
        source.subscribe(listener);
        const log = source.changesSince(0);

        expect(() =>
            source.replaceAll([
                { id: "c", x: 2 },
                { id: "c", x: 3 },
            ]),
        ).toThrow("ItemCollection: duplicate key c");
        // A key already held by the collection is still unique in the new list.
        expect(() =>
            source.replaceAll([
                { id: "a", x: 2 },
                { id: "a", x: 3 },
            ]),
        ).toThrow("ItemCollection: duplicate key a");
        expect(() =>
            source.replaceAll([
                { id: "c", x: 2 },
                { id: null as unknown as ItemKey, x: 3 },
            ]),
        ).toThrow("keys must be strings or numbers");

        expect(source.items).toBe(items);
        expect(source.items).toHaveLength(2);
        expect(source.items[0]).toBe(first);
        expect(source.items[1]).toBe(second);
        expect(source.changesSince(0)).toEqual(log);
        expect(listener).not.toHaveBeenCalled();
    });

    it("replaces every item in one batch notification while keeping the array identity", () => {
        const first = { id: "a", x: 0 };
        const second = { id: "b", x: 1 };
        const source = collection([first, second]);
        const items = source.items;
        const listener = vi.fn();
        source.subscribe(listener);
        const startsAt = source.changesSince(0).sequence;

        const next = [
            { id: "c", x: 2 },
            { id: "a", x: 9 },
        ];
        source.replaceAll(next);

        expect(source.items).toBe(items);
        expect(source.items).toEqual(next);
        expect(source.items[0]).toBe(next[0]);
        expect(source.items[1]).toBe(next[1]);
        expect([source.keyAt(0), source.keyAt(1), source.keyAt(2)]).toEqual(["c", "a", undefined]);
        expect(source.size).toBe(2);
        expect(source.get("b")).toBeUndefined();
        expect(source.get("a")).toEqual({ id: "a", x: 9 });

        expect(listener).toHaveBeenCalledTimes(1);
        const delivered = listener.mock.calls[0][0] as readonly ItemCollectionChange<Item>[];
        expect(delivered.map(({ type, key, index }) => ({ type, key, index }))).toEqual([
            { type: "remove", key: "b", index: 1 },
            { type: "remove", key: "a", index: 0 },
            { type: "insert", key: "c", index: 0 },
            { type: "insert", key: "a", index: 1 },
        ]);

        const log = source.changesSince(startsAt);
        expect(log.sequence).toBe(startsAt + delivered.length);
        expect(log.changes).toEqual(delivered);
        // Every applied entry occupies its own consecutive sequence.
        const cursor = log.sequence - delivered.length;
        delivered.forEach((_change, offset) => {
            expect(source.changesSince(cursor + offset).changes).toEqual(delivered.slice(offset));
        });
        expect(source.changesSince(cursor + delivered.length).changes).toEqual([]);
    });

    it("merges replaceAll into an enclosing batch and keeps reentrant log order", () => {
        const source = collection([{ id: "a", x: 0 }]);
        const calls: ItemKey[][] = [];
        let reentered = false;
        source.subscribe((changes) => {
            calls.push(changes.map((change) => change.key));
            if (!reentered) {
                reentered = true;
                source.insert({ id: "nested", x: 1 });
            }
        });

        source.batch(() => {
            source.insert({ id: "b", x: 1 });
            source.replaceAll([
                { id: "c", x: 2 },
                { id: "d", x: 3 },
            ]);
        });

        expect(calls).toEqual([["b", "b", "a", "c", "d"], ["nested"]]);
        expect(source.changesSince(0).changes.map((change) => [change.type, change.key])).toEqual([
            ["insert", "b"],
            ["remove", "b"],
            ["remove", "a"],
            ["insert", "c"],
            ["insert", "d"],
            ["insert", "nested"],
        ]);
        expect(source.changesSince(0).sequence).toBe(6);
        expect(source.items.map((item) => item.id)).toEqual(["c", "d", "nested"]);
    });

    it("keeps the log aligned with applied changes when listeners throw", () => {
        const source = collection();
        const firstError = new Error("first failure");
        const secondError = new Error("second failure");
        source.subscribe(() => {
            throw firstError;
        });
        const observed = vi.fn();
        source.subscribe(observed);
        source.subscribe(() => {
            throw secondError;
        });

        expect(() => source.insert({ id: "a", x: 0 })).toThrow(firstError);
        expect(observed).toHaveBeenCalledTimes(1);
        expect(source.changesSince(0)).toEqual({
            changes: [{ type: "insert", key: "a", item: { id: "a", x: 0 }, index: 0 }],
            sequence: 1,
        });

        const callbackError = new Error("callback failure");
        expect(() =>
            source.batch(() => {
                source.insert({ id: "b", x: 1 });
                source.replaceAll([{ id: "c", x: 2 }]);
                throw callbackError;
            }),
        ).toThrow(callbackError);

        // Every listener saw the whole batch, and the first error was rethrown.
        expect(observed).toHaveBeenCalledTimes(2);
        expect(source.changesSince(0).changes.map(({ type, key }) => [type, key])).toEqual([
            ["insert", "a"],
            ["insert", "b"],
            ["remove", "b"],
            ["remove", "a"],
            ["insert", "c"],
        ]);
        expect(source.changesSince(0).sequence).toBe(5);

        // A cursor from the failure point still replays exactly the tail.
        expect(source.changesSince(2).changes.map(({ type, key }) => [type, key])).toEqual([
            ["remove", "b"],
            ["remove", "a"],
            ["insert", "c"],
        ]);
        expect(source.items.map((item) => item.id)).toEqual(["c"]);
    });

    it("exposes a covariant read-only source and unconstrained change types", () => {
        interface Seat {
            id: string;
        }
        const source = new ItemCollection<Rect<Seat>>([{ x: 0, y: 0, size: 1, data: { id: "a" } }], {
            keyOf: (item) => item.data!.id,
        });
        const readOnly: ReadonlyItemCollection<Rect> = source;
        const drawItems: DrawItems<Rect> = source;
        const listener: (changes: readonly ItemCollectionChange<unknown>[]) => void = vi.fn();
        readOnly.subscribe(listener);

        expectTypeOf<ReadonlyItemCollection<Rect<Seat>>>().toMatchTypeOf<ReadonlyItemCollection<Rect>>();
        expectTypeOf<ItemCollectionChange<Rect<Seat>>>().toMatchTypeOf<ItemCollectionChange<unknown>>();
        expect(drawItems).toBe(source);
    });
});
