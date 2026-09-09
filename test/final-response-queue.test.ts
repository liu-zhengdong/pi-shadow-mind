import { describe, expect, it } from "vitest";
import { FinalResponseQueue } from "../src/final-response-queue.js";

interface Item {
  epoch: number;
  shadowId: string;
}

describe("FinalResponseQueue", () => {
  it("queues all final-response checks behind the concurrency limit", () => {
    let activeCount = 0;
    const activeIds = new Set<string>();
    const launched: string[] = [];
    const queue = new FinalResponseQueue<Item>({
      currentEpoch: () => 1,
      maxParallel: () => 2,
      activeCount: () => activeCount,
      activeShadowIds: () => activeIds,
      launch: (item) => {
        launched.push(item.shadowId);
        activeIds.add(item.shadowId);
        activeCount += 1;
      },
    });

    queue.enqueue([item("a"), item("b"), item("c")]);
    expect(launched).toEqual(["a", "b"]);

    activeIds.delete("a");
    activeCount -= 1;
    queue.slotAvailable();
    expect(launched).toEqual(["a", "b", "c"]);
  });

  it("defers a final check while the same shadow is already running", () => {
    let activeCount = 1;
    const activeIds = new Set(["a"]);
    const launched: string[] = [];
    const queue = new FinalResponseQueue<Item>({
      currentEpoch: () => 1,
      maxParallel: () => 2,
      activeCount: () => activeCount,
      activeShadowIds: () => activeIds,
      launch: (queued) => {
        launched.push(queued.shadowId);
        activeIds.add(queued.shadowId);
        activeCount += 1;
      },
    });

    queue.enqueue([item("a"), item("b")]);
    expect(launched).toEqual(["b"]);

    activeIds.delete("a");
    activeCount -= 1;
    queue.slotAvailable();
    expect(launched).toEqual(["b", "a"]);
  });

  it("suppresses launching while canLaunch returns false", () => {
    let allowed = false;
    const launched: string[] = [];
    const queue = new FinalResponseQueue<Item>({
      currentEpoch: () => 1,
      maxParallel: () => 2,
      activeCount: () => 0,
      activeShadowIds: () => new Set(),
      canLaunch: () => allowed,
      launch: (queued) => {
        launched.push(queued.shadowId);
      },
    });

    queue.enqueue([item("a")]);
    expect(launched).toEqual([]);

    allowed = true;
    queue.slotAvailable();
    expect(launched).toEqual(["a"]);
  });
});

function item(shadowId: string): Item {
  return { epoch: 1, shadowId };
}
