import { describe, expect, it, vi } from "vitest";
import {
  CompletionReview,
  type CompletionReviewRun,
} from "../src/completion-review.js";
import type { ShadowReport } from "../src/types.js";

interface Job {
  epoch: number;
  shadowId: string;
}

interface RunningJob {
  job: Job;
  review?: CompletionReviewRun;
}

function createHarness(maxParallel = 1) {
  let epoch = 1;
  const active = new Map<string, RunningJob>();
  const deliver = vi.fn();
  const onReviewCompleted = vi.fn();
  const review = new CompletionReview<Job>({
    currentEpoch: () => epoch,
    maxParallel: () => maxParallel,
    activeCount: () => active.size,
    activeShadowIds: () => new Set(active.keys()),
    launch: (job, run) => active.set(job.shadowId, { job, review: run }),
    deliver,
    onReviewCompleted,
  });
  return {
    active,
    deliver,
    onReviewCompleted,
    review,
    setEpoch: (value: number) => {
      epoch = value;
    },
    finish: (shadowId: string) => {
      const running = active.get(shadowId);
      active.delete(shadowId);
      review.slotAvailable();
      review.complete(running?.review);
    },
  };
}

describe("CompletionReview", () => {
  it("queues checks and delivers one batch after every sibling finishes", () => {
    const harness = createHarness();
    const request = harness.review.begin(1);
    harness.review.schedule(request, [job("a"), job("b")]);

    expect([...harness.active.keys()]).toEqual(["a"]);
    harness.active.get("a")?.review?.accept(report("a"));
    harness.finish("a");

    expect([...harness.active.keys()]).toEqual(["b"]);
    expect(harness.deliver).not.toHaveBeenCalled();

    harness.active.get("b")?.review?.accept(report("b"));
    harness.finish("b");

    expect(harness.deliver).toHaveBeenCalledOnce();
    expect(harness.deliver).toHaveBeenCalledWith([report("a"), report("b")]);
  });

  it("invalidates queued and late work from a superseded request", () => {
    const harness = createHarness(2);
    const previous = harness.review.begin(1);
    harness.review.schedule(previous, [job("old")]);
    const staleRun = harness.active.get("old")?.review;

    const current = harness.review.begin(1);
    harness.review.schedule(current, [job("current")]);
    staleRun?.accept(report("old"));
    harness.finish("old");
    harness.active.get("current")?.review?.accept(report("current"));
    harness.finish("current");

    expect(harness.deliver).toHaveBeenCalledOnce();
    expect(harness.deliver).toHaveBeenCalledWith([report("current")]);
  });

  it("starts queued work when an unrelated Shadow run releases a slot", () => {
    const harness = createHarness();
    harness.active.set("heartbeat", { job: job("heartbeat") });
    const request = harness.review.begin(1);
    harness.review.schedule(request, [job("final")]);

    expect(harness.active.has("final")).toBe(false);
    harness.finish("heartbeat");

    expect(harness.active.has("final")).toBe(true);
  });

  it("rejects scheduling after the request epoch is stale", () => {
    const harness = createHarness();
    const request = harness.review.begin(1);
    harness.setEpoch(2);

    expect(harness.review.schedule(request, [job("stale")])).toBe(false);
    expect(harness.active.size).toBe(0);
  });

  it("notifies onReviewCompleted only when all jobs complete without invalidation", () => {
    const harness = createHarness(2);
    const request = harness.review.begin(1);
    harness.review.schedule(request, [job("a"), job("b")]);

    harness.finish("a");
    expect(harness.onReviewCompleted).not.toHaveBeenCalled();

    harness.finish("b");
    expect(harness.onReviewCompleted).toHaveBeenCalledOnce();
    expect(harness.onReviewCompleted).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does not notify onReviewCompleted when review is invalidated before finishing", () => {
    const harness = createHarness(2);
    const request = harness.review.begin(1);
    harness.review.schedule(request, [job("a"), job("b")]);

    harness.finish("a");
    harness.review.invalidate();
    harness.finish("b");

    expect(harness.onReviewCompleted).not.toHaveBeenCalled();
  });
});

function job(shadowId: string): Job {
  return { epoch: 1, shadowId };
}

function report(shadowId: string): ShadowReport {
  return {
    shadowId,
    shadowName: shadowId,
    content: `${shadowId} report`,
    epoch: 1,
    runId: `${shadowId}-run`,
  };
}
