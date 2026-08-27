import { describe, expect, it } from "vitest";
import { computeLightningFlash, LIGHTNING_BUCKET_MS, seedFromString } from "./lightning";

const SEED = seedFromString("campaign-under-test");

describe("seedFromString", () => {
  it("is a pure function of its input — same string, same seed, every call", () => {
    expect(seedFromString("abc-123")).toBe(seedFromString("abc-123"));
  });

  it("gives different campaigns different seeds (not a constant)", () => {
    expect(seedFromString("campaign-a")).not.toBe(seedFromString("campaign-b"));
  });
});

describe("computeLightningFlash", () => {
  it("is the WHOLE synchronization mechanism: same seed + same nowMs => byte-identical result on every call", () => {
    // This is the property the entire cross-client sync design leans on —
    // two connected clients calling this with the same campaign-derived
    // seed and their own Date.now() must get back the identical answer.
    const now = 1_700_000_000_123;
    const a = computeLightningFlash(SEED, now);
    const b = computeLightningFlash(SEED, now);
    expect(b).toEqual(a);
  });

  it("a different seed (different campaign) produces a different schedule", () => {
    const now = 1_700_000_000_123;
    const otherSeed = seedFromString("a-completely-different-campaign");
    // Not guaranteed to differ at every single instant, but the two seeds
    // must diverge somewhere across a real spread of time — otherwise the
    // seed would be doing nothing at all.
    let sawDifference = false;
    for (let i = 0; i < 200; i++) {
      const t = now + i * 137;
      if (computeLightningFlash(SEED, t).opacity !== computeLightningFlash(otherSeed, t).opacity) {
        sawDifference = true;
        break;
      }
    }
    expect(sawDifference).toBe(true);
  });

  it("opacity is always within [0, 1] and matches the active flag", () => {
    for (let i = 0; i < 5000; i++) {
      const state = computeLightningFlash(SEED, i * 977);
      expect(state.opacity).toBeGreaterThanOrEqual(0);
      expect(state.opacity).toBeLessThanOrEqual(1);
      if (!state.active) {
        expect(state.opacity).toBe(0);
      } else {
        expect(state.opacity).toBeGreaterThan(0);
      }
    }
  });

  it("bucket is exactly floor(nowMs / LIGHTNING_BUCKET_MS)", () => {
    for (const now of [0, 1, LIGHTNING_BUCKET_MS - 1, LIGHTNING_BUCKET_MS, LIGHTNING_BUCKET_MS * 7 + 42]) {
      expect(computeLightningFlash(SEED, now).bucket).toBe(Math.floor(now / LIGHTNING_BUCKET_MS));
    }
  });

  it("fires at least one real flash over a long enough stretch of wall-clock time", () => {
    // Coarse sanity check that this isn't a schedule that never actually
    // flashes — scan several bucket-widths of time at fine granularity.
    let sawActive = false;
    const start = 1_700_000_000_000;
    for (let t = start; t < start + LIGHTNING_BUCKET_MS * 6; t += 20) {
      if (computeLightningFlash(SEED, t).active) {
        sawActive = true;
        break;
      }
    }
    expect(sawActive).toBe(true);
  });

  it("a single flash never straddles a bucket boundary (each bucket's own schedule is self-contained)", () => {
    // For every bucket in a wide range there is exactly one contiguous
    // active window (never two — one flash per bucket by construction) and
    // it never reaches the FAR edge of the bucket (guaranteed by
    // OFFSET_FRACTION=0.8 leaving at least 20% of the bucket, 900ms, free —
    // comfortably more than the 380ms max flash duration).
    for (let bucket = 0; bucket < 50; bucket++) {
      const bucketStart = bucket * LIGHTNING_BUCKET_MS;
      let activeRuns = 0;
      let wasActive = false;
      let touchedFarEdge = false;
      for (let t = bucketStart; t < bucketStart + LIGHTNING_BUCKET_MS; t += 10) {
        const state = computeLightningFlash(SEED, t);
        if (state.active && !wasActive) activeRuns++;
        if (state.active && t >= bucketStart + LIGHTNING_BUCKET_MS - 10) touchedFarEdge = true;
        wasActive = state.active;
      }
      expect(activeRuns).toBeLessThanOrEqual(1);
      expect(touchedFarEdge).toBe(false);
    }
  });

  it("simulates two independently-polling clients and finds them in near-perfect agreement", () => {
    // The real end-to-end proof of synchronization: two "clients" polling
    // computeLightningFlash with the SAME seed but at slightly different
    // (but close) timestamps — exactly what two Playwright pages calling
    // Date.now() a few ms apart would produce. This is NOT expected to be
    // byte-identical at every single instant: two independent clocks
    // sampling a continuous on/off signal a few ms apart will occasionally
    // disagree for a few ms right at a flash's own start/end edge — that's
    // an unavoidable property of discretely sampling continuous time, not a
    // synchronization bug (contrast with an actually-broken design, where
    // every client independently randomizes its own schedule and would
    // disagree constantly, not just within a few ms of every edge). The
    // real claim: disagreement is rare and always within `skewMs` of a
    // flash boundary — never in the middle of a flash a first client is
    // confidently showing.
    const start = 1_700_000_000_000;
    const skewMs = 3;
    let samples = 0;
    let mismatches = 0;
    for (let t = start; t < start + LIGHTNING_BUCKET_MS * 20; t += 7) {
      const clientA = computeLightningFlash(SEED, t);
      const clientB = computeLightningFlash(SEED, t + skewMs);
      samples++;
      if (clientA.active !== clientB.active) mismatches++;
      // bucket must NEVER disagree at this skew — LIGHTNING_BUCKET_MS
      // (4500ms) is vastly larger than skewMs, so the only way two reads
      // land in different buckets is being within skewMs of a bucket
      // boundary, which this modest skew makes exceedingly rare; when it's
      // not a boundary case they must match exactly.
      if (Math.floor(t / LIGHTNING_BUCKET_MS) === Math.floor((t + skewMs) / LIGHTNING_BUCKET_MS)) {
        expect(clientB.bucket).toBe(clientA.bucket);
      }
    }
    // A mismatch can only occur within `skewMs` of one of the two flash
    // edges (start, end) per bucket — at most 2*skewMs of "risk" out of
    // every LIGHTNING_BUCKET_MS, i.e. well under 1% of samples at this
    // sample spacing. Assert comfortably above that noise floor.
    expect(samples).toBeGreaterThan(1000);
    expect(mismatches / samples).toBeLessThan(0.02);
  });
});
