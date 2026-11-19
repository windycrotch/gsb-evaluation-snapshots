import { describe, expect, it, vi } from "vitest";
import { ItemCollection } from "../../src/modules/ItemCollection";
import { LiveSpatialIndex } from "../../src/modules/LiveSpatialIndex";
import { SpatialIndex, type SpatialItem } from "../../src/modules/SpatialIndex";

interface Marker extends SpatialItem {
    id: string;
}

function markers(count: number): Marker[] {
    return Array.from({ length: count }, (_, i) => ({ id: `m${i}`, x: i * 10, y: 0, size: 2 }));
}

function createCollection(items: Marker[] = []) {
    return new ItemCollection<Marker>(items, { keyOf: (item) => item.id });
}

/** Point query box around a world coordinate. */
function at(index: LiveSpatialIndex<Marker>, x: number, y = 0): Marker[] {
    return index.query(x - 0.5, y - 0.5, x + 0.5, y + 0.5);
}

describe("LiveSpatialIndex", () => {
    describe("construction", () => {
        it("indexes the collection's existing items in draw order", () => {
            const items = markers(5);
            const live = new LiveSpatialIndex(createCollection(items));

            expect(live.size).toBe(5);
            expect(live.query(-1, -1, 41, 1)).toEqual(items);
            expect(at(live, 20).map((m) => m.id)).toEqual(["m2"]);
        });

        it("starts empty for an empty collection", () => {
            const live = new LiveSpatialIndex(createCollection());
            expect(live.size).toBe(0);
            expect(live.query(-100, -100, 100, 100)).toEqual([]);
        });
    });

    describe("incremental changes", () => {
        it("hits inserted items immediately", () => {
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection);

            collection.insert({ id: "new", x: 100, y: 50, size: 4 });

            expect(live.size).toBe(3);
            expect(at(live, 100, 50).map((m) => m.id)).toEqual(["new"]);
            // Appended occurrences sort after existing ones in draw order.
            expect(live.query(-1, -1, 101, 51).map((m) => m.id)).toEqual(["m0", "m1", "new"]);
        });

        it("moves hits from the old bounds to the new bounds without changing order", () => {
            const collection = createCollection(markers(3));
            const live = new LiveSpatialIndex(collection);

            collection.update("m1", { x: 500, y: 500 });

            expect(at(live, 10)).toEqual([]);
            expect(at(live, 500, 500).map((m) => m.id)).toEqual(["m1"]);
            // Registration order is kept: m1 still sorts between m0 and m2.
            expect(live.query(-100, -100, 1000, 1000).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
        });

        it("reflects size changes in the bounding box", () => {
            const collection = createCollection([{ id: "a", x: 0, y: 0, size: 2 }]);
            const live = new LiveSpatialIndex(collection);

            expect(at(live, 5)).toEqual([]);
            collection.update("a", { size: 20 });
            expect(at(live, 5).map((m) => m.id)).toEqual(["a"]);
            collection.update("a", { size: 2 });
            expect(at(live, 5)).toEqual([]);
        });

        it("stops hitting removed items and keeps the survivors' relative order", () => {
            const collection = createCollection(markers(5));
            const live = new LiveSpatialIndex(collection);

            expect(collection.remove("m1")).toBe(true);
            expect(collection.remove("m3")).toBe(true);

            expect(live.size).toBe(3);
            expect(at(live, 10)).toEqual([]);
            expect(at(live, 30)).toEqual([]);
            expect(live.query(-1, -1, 41, 1).map((m) => m.id)).toEqual(["m0", "m2", "m4"]);
        });

        it("mirrors every change into the exact index operations", () => {
            const index = new SpatialIndex<Marker>();
            const insert = vi.spyOn(index, "insert");
            const update = vi.spyOn(index, "update");
            const remove = vi.spyOn(index, "remove");
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection, index);

            collection.insert({ id: "x", x: 100, y: 0 });
            collection.update("x", { x: 200 });
            collection.remove("x");

            expect(insert).toHaveBeenCalledTimes(1);
            expect(update).toHaveBeenCalledTimes(1);
            expect(remove).toHaveBeenCalledTimes(1);
            expect(live.size).toBe(2);
        });
    });

    describe("batches", () => {
        it("refreshes the index once, when the outermost batch ends", () => {
            const index = new SpatialIndex<Marker>();
            const collection = createCollection(markers(3));
            const live = new LiveSpatialIndex(collection, index);
            const update = vi.spyOn(index, "update");

            collection.batch(() => {
                collection.update("m0", { x: 1000 });
                collection.update("m1", { x: 2000 });
                // Mid-batch the index still holds the pre-batch geometry.
                expect(update).not.toHaveBeenCalled();
                expect(at(live, 1000)).toEqual([]);
                expect(at(live, 0).map((m) => m.id)).toEqual(["m0"]);
            });

            expect(update).toHaveBeenCalledTimes(2);
            expect(at(live, 0)).toEqual([]);
            expect(at(live, 1000).map((m) => m.id)).toEqual(["m0"]);
            expect(at(live, 2000).map((m) => m.id)).toEqual(["m1"]);
        });

        it("applies a merged insert/update/remove list in one notification", () => {
            const collection = createCollection(markers(3));
            const live = new LiveSpatialIndex(collection);
            const listener = vi.fn();
            collection.subscribe(listener);

            collection.batch(() => {
                collection.remove("m0");
                collection.update("m1", { x: 500 });
                collection.insert({ id: "tail", x: 500, y: 0, size: 2 });
                collection.batch(() => {
                    collection.update("m2", { y: 100 });
                });
            });

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener.mock.calls[0][0].map((change: { type: string }) => change.type)).toEqual([
                "remove",
                "update",
                "insert",
                "update",
            ]);
            expect(at(live, 0)).toEqual([]);
            expect(at(live, 500).map((m) => m.id)).toEqual(["m1", "tail"]);
            expect(at(live, 20, 100).map((m) => m.id)).toEqual(["m2"]);
            expect(live.query(-1000, -1000, 1000, 1000).map((m) => m.id)).toEqual(["m1", "m2", "tail"]);
        });

        it("still publishes applied changes when the batch callback throws", () => {
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection);

            expect(() =>
                collection.batch(() => {
                    collection.update("m0", { x: 300 });
                    throw new Error("batch failed");
                }),
            ).toThrow("batch failed");

            expect(at(live, 0)).toEqual([]);
            expect(at(live, 300).map((m) => m.id)).toEqual(["m0"]);
        });
    });

    describe("rejected changes", () => {
        it("keeps the index identical to the collection after rejections", () => {
            const collection = createCollection(markers(3));
            const live = new LiveSpatialIndex(collection);
            const before = live.query(-100, -100, 100, 100);

            expect(() => collection.insert({ id: "m0", x: 999, y: 999 })).toThrow("duplicate key");
            expect(() => collection.update("ghost", { x: 999 })).toThrow("unknown key");
            expect(() => collection.update("m1", { id: "m2" } as Partial<Marker>)).toThrow("cannot change key");
            expect(collection.remove("ghost")).toBe(false);

            expect(live.size).toBe(3);
            expect(live.query(-100, -100, 100, 100)).toEqual(before);
            expect(live.query(900, 900, 1000, 1000)).toEqual([]);
            expect(collection.size).toBe(3);
        });

        it("recovers and keeps syncing after a rejected mutation", () => {
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection);

            expect(() => collection.insert({ id: "m1", x: 500, y: 0 })).toThrow("duplicate key");
            collection.insert({ id: "ok", x: 500, y: 0, size: 2 });

            expect(at(live, 500).map((m) => m.id)).toEqual(["ok"]);
            expect(live.size).toBe(3);
        });
    });

    describe("throwing listeners", () => {
        it("reflects applied changes even when an earlier subscriber throws", () => {
            const collection = createCollection(markers(2));
            collection.subscribe(() => {
                throw new Error("listener failed");
            });
            const live = new LiveSpatialIndex(collection);

            expect(() => collection.update("m0", { x: 400 })).toThrow("listener failed");

            expect(collection.get("m0")!.x).toBe(400);
            expect(at(live, 0)).toEqual([]);
            expect(at(live, 400).map((m) => m.id)).toEqual(["m0"]);
        });

        it("reflects applied changes even when a later subscriber throws", () => {
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection);
            collection.subscribe(() => {
                throw new Error("listener failed");
            });

            expect(() => collection.insert({ id: "n", x: 50, y: 0 })).toThrow("listener failed");

            expect(collection.size).toBe(3);
            expect(at(live, 50).map((m) => m.id)).toEqual(["n"]);
        });

        it("keeps syncing afterwards once the throwing listener is gone", () => {
            const collection = createCollection(markers(1));
            const live = new LiveSpatialIndex(collection);
            const unsubscribe = collection.subscribe(() => {
                throw new Error("listener failed");
            });

            expect(() => collection.update("m0", { x: 100 })).toThrow("listener failed");
            unsubscribe();
            collection.update("m0", { x: 200 });

            expect(at(live, 100)).toEqual([]);
            expect(at(live, 200).map((m) => m.id)).toEqual(["m0"]);
        });
    });

    describe("destroy", () => {
        it("is idempotent and freezes the index", () => {
            const collection = createCollection(markers(3));
            const live = new LiveSpatialIndex(collection);

            live.destroy();
            live.destroy();

            collection.update("m0", { x: 1000 });
            collection.insert({ id: "late", x: 2000, y: 0 });
            collection.remove("m1");

            expect(live.size).toBe(3);
            expect(at(live, 1000)).toEqual([]);
            expect(at(live, 2000)).toEqual([]);
            expect(live.query(-1, -1, 21, 1).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
        });

        it("stops touching the index and stops receiving notifications", () => {
            const index = new SpatialIndex<Marker>();
            const collection = createCollection(markers(2));
            const live = new LiveSpatialIndex(collection, index);
            const insert = vi.spyOn(index, "insert");
            const update = vi.spyOn(index, "update");
            const remove = vi.spyOn(index, "remove");

            live.destroy();
            collection.insert({ id: "n", x: 10, y: 0 });
            collection.update("m0", { x: 20 });
            collection.remove("m1");

            expect(insert).not.toHaveBeenCalled();
            expect(update).not.toHaveBeenCalled();
            expect(remove).not.toHaveBeenCalled();
            // The collection itself is unaffected by the detached index.
            expect(collection.size).toBe(2);
        });
    });
});
