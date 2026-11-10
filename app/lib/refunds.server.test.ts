import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

// Each test gets a fresh in-memory database, swapped in for the app's db
// module, so the rules are checked against real rows and real queries.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getRefundOffer,
  listPendingRefundRequests,
  submitRefundRequest,
} from "./refunds.server";

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

// Dates are built in local time because the Refund Window is counted in the
// server's calendar days.
const MARCH_1_AT_9AM = new Date(2026, 2, 1, 9, 0);

function buyCourse(
  options: {
    amountPaid?: number;
    country?: string | null;
    purchasedAt?: Date;
    learnerId?: number;
  } = {}
) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: options.learnerId ?? base.user.id,
      courseId: base.course.id,
      amountPaid: options.amountPaid ?? 9900,
      country: options.country ?? null,
      createdAt: (options.purchasedAt ?? MARCH_1_AT_9AM).toISOString(),
    })
    .returning()
    .get();
}

function addLessons(count: number) {
  const courseModule = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  return Array.from({ length: count }, (_, index) =>
    testDb
      .insert(schema.lessons)
      .values({
        moduleId: courseModule.id,
        title: `Lesson ${index + 1}`,
        position: index + 1,
      })
      .returning()
      .get()
  );
}

function watchUpTo(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function completeLesson(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: MARCH_1_AT_9AM.toISOString(),
    })
    .run();
}

function addTeamSeat(purchaseId: number, { claimed }: { claimed: boolean }) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: `SEAT-${purchaseId}-${team.id}`,
      purchaseId,
      redeemedByUserId: claimed ? base.instructor.id : null,
      redeemedAt: claimed ? MARCH_1_AT_9AM.toISOString() : null,
    })
    .run();
}

function addRefundRequest(purchaseId: number, status: schema.RefundStatus) {
  testDb
    .insert(schema.refunds)
    .values({ purchaseId, status, reason: "It was not what I expected." })
    .run();
}

function setListPrice(price: number) {
  testDb
    .update(schema.courses)
    .set({ price })
    .where(eq(schema.courses.id, base.course.id))
    .run();
}

function offerOnMarch2() {
  return getRefundOffer({
    learnerId: base.user.id,
    courseId: base.course.id,
    today: new Date(2026, 2, 2),
  });
}

describe("getRefundOffer", () => {
  it("offers a full-price buyer everything they paid, until the 14th day after purchase", () => {
    setListPrice(9900);
    buyCourse({ amountPaid: 9900 });

    const offer = getRefundOffer({
      learnerId: base.user.id,
      courseId: base.course.id,
      today: new Date(2026, 2, 2),
    });

    expect(offer).toEqual({
      eligible: true,
      refundAmount: 9900,
      lastDayInWindow: "2026-03-15",
    });
  });

  describe("Refund Window", () => {
    // A Learner who bought at 23:00 must still get the whole of their 14th
    // day, so the window is counted in calendar days, not hours.
    it("is still open late on the 14th calendar day after a late-evening purchase", () => {
      buyCourse({ purchasedAt: new Date(2026, 2, 1, 23, 0) });

      const offer = getRefundOffer({
        learnerId: base.user.id,
        courseId: base.course.id,
        today: new Date(2026, 2, 15, 23, 59),
      });

      expect(offer).toMatchObject({
        eligible: true,
        lastDayInWindow: "2026-03-15",
      });
    });

    it("is closed on the 15th calendar day", () => {
      buyCourse({ purchasedAt: new Date(2026, 2, 1, 23, 0) });

      const offer = getRefundOffer({
        learnerId: base.user.id,
        courseId: base.course.id,
        today: new Date(2026, 2, 16, 0, 1),
      });

      expect(offer).toEqual({ eligible: false, reason: "window-closed" });
    });
  });

  describe("watch limit", () => {
    // Watch time is the furthest point reached in each lesson, summed. Seeking
    // back and re-watching must not count twice.
    it("is still eligible just under 2 hours watched", () => {
      buyCourse();
      const [first, second] = addLessons(2);
      watchUpTo(first.id, 1800);
      watchUpTo(first.id, 3600);
      watchUpTo(first.id, 600);
      watchUpTo(second.id, 3599);

      expect(offerOnMarch2()).toMatchObject({ eligible: true });
    });

    it("is not eligible at exactly 2 hours watched", () => {
      buyCourse();
      const [first, second] = addLessons(2);
      watchUpTo(first.id, 3600);
      watchUpTo(second.id, 3600);

      expect(offerOnMarch2()).toEqual({
        eligible: false,
        reason: "watched-too-much",
      });
    });
  });

  describe("completion limit", () => {
    it("is still eligible with just under half the lessons completed", () => {
      buyCourse();
      const courseLessons = addLessons(5);
      completeLesson(courseLessons[0].id);
      completeLesson(courseLessons[1].id);

      expect(offerOnMarch2()).toMatchObject({ eligible: true });
    });

    it("is not eligible with exactly half the lessons completed", () => {
      buyCourse();
      const courseLessons = addLessons(4);
      completeLesson(courseLessons[0].id);
      completeLesson(courseLessons[1].id);

      expect(offerOnMarch2()).toEqual({
        eligible: false,
        reason: "completed-too-much",
      });
    });

    // With no lessons, "half the lessons" is 0 of 0. That must not be read as
    // 100% complete, nor divide by zero.
    it("is still eligible on a course with no lessons", () => {
      buyCourse();

      expect(offerOnMarch2()).toMatchObject({ eligible: true });
    });
  });

  describe("existing Refund Requests", () => {
    it("is not eligible while a Refund Request on the purchase is Pending", () => {
      const purchase = buyCourse();
      addRefundRequest(purchase.id, schema.RefundStatus.Pending);

      expect(offerOnMarch2()).toEqual({
        eligible: false,
        reason: "pending-request",
      });
    });

    // Only a Pending Refund Request blocks a new one. A Declined one has
    // been dealt with.
    it("is still eligible after a Refund Request was Declined", () => {
      const purchase = buyCourse();
      addRefundRequest(purchase.id, schema.RefundStatus.Declined);

      expect(offerOnMarch2()).toMatchObject({ eligible: true });
    });
  });

  describe("Refund Amount", () => {
    // The Refund Amount is always what the Learner paid, never the list
    // price. A buyer who paid less than the list price without a
    // purchasing-power price used to be promised the list price, which is
    // more than they paid.
    beforeEach(() => {
      setListPrice(9900);
    });

    it("is what a purchasing-power buyer paid", () => {
      buyCourse({ amountPaid: 2970, country: "IN" });

      expect(offerOnMarch2()).toMatchObject({ refundAmount: 2970 });
    });

    it("is what was paid when that is less than the list price without a purchasing-power price", () => {
      buyCourse({ amountPaid: 4900, country: "US" });

      expect(offerOnMarch2()).toMatchObject({ refundAmount: 4900 });
    });
  });

  describe("team seats", () => {
    // A claimed seat belongs to the team, so the buyer can't hand it back
    // alone. An unclaimed seat hasn't been given to anyone yet.
    it("is not eligible once a team seat on the purchase has been claimed", () => {
      const purchase = buyCourse();
      addTeamSeat(purchase.id, { claimed: true });

      expect(offerOnMarch2()).toEqual({
        eligible: false,
        reason: "claimed-team-seat",
      });
    });

    it("is still eligible while the team seat is unclaimed", () => {
      const purchase = buyCourse();
      addTeamSeat(purchase.id, { claimed: false });

      expect(offerOnMarch2()).toMatchObject({ eligible: true });
    });
  });

  it("offers nothing to a Learner who never bought the course", () => {
    const offer = getRefundOffer({
      learnerId: base.user.id,
      courseId: base.course.id,
      today: new Date(2026, 0, 1),
    });

    expect(offer).toEqual({ eligible: false, reason: "no-purchase" });
  });
});

describe("submitRefundRequest", () => {
  it("records a Pending Refund Request with the Learner's reason", () => {
    const purchase = buyCourse({ amountPaid: 4900 });

    const result = submitRefundRequest({
      learnerId: base.user.id,
      courseId: base.course.id,
      reason: "The pace was too fast for me.",
      today: new Date(2026, 2, 2),
    });

    expect(result).toMatchObject({
      eligible: true,
      refundRequest: {
        purchaseId: purchase.id,
        status: schema.RefundStatus.Pending,
        reason: "The pace was too fast for me.",
      },
    });
    expect(listPendingRefundRequests(base.user.id)).toMatchObject([
      {
        courseTitle: "Test Course",
        courseSlug: "test-course",
        refundAmount: 4900,
        reason: "The pace was too fast for me.",
      },
    ]);
  });

  // The email used to talk about a "Reversal". It must use the same words
  // the Learner saw in the app and promise what they actually paid.
  it("returns a confirmation email in Refund language that states the Refund Amount", () => {
    buyCourse({ amountPaid: 4900 });

    const result = submitRefundRequest({
      learnerId: base.user.id,
      courseId: base.course.id,
      reason: "The pace was too fast for me.",
      today: new Date(2026, 2, 2),
    });

    if (!result.eligible) throw new Error("expected an eligible submission");
    expect(result.email.to).toBe("test@example.com");
    expect(result.email.subject).toBe("Refund requested — Test Course");
    expect(result.email.body).toBe(
      [
        "Hi Test User,",
        "",
        'We have your Refund Request for "Test Course". Your Refund will be $49.00, the amount you paid. Our team reviews every Refund Request by hand. You do not need to do anything else — we will email you again when it is done.',
        "",
        "— The Cadence team",
      ].join("\n")
    );
    expect(result.email.body).not.toMatch(/reversal|chargeback/i);
  });

  // A stale tab or a crafted request reaches the action without passing
  // through the course page, so the action must apply the same rules.
  describe("refuses whenever getRefundOffer would refuse", () => {
    it("refuses a second Refund Request while the first is Pending", () => {
      buyCourse();
      const submit = () =>
        submitRefundRequest({
          learnerId: base.user.id,
          courseId: base.course.id,
          reason: "The pace was too fast for me.",
          today: new Date(2026, 2, 2),
        });

      submit();
      const second = submit();

      expect(second).toEqual({ eligible: false, reason: "pending-request" });
      expect(listPendingRefundRequests(base.user.id)).toHaveLength(1);
    });

    it("refuses and records nothing once the Refund Window has closed", () => {
      buyCourse();

      const result = submitRefundRequest({
        learnerId: base.user.id,
        courseId: base.course.id,
        reason: "The pace was too fast for me.",
        today: new Date(2026, 2, 16),
      });

      expect(result).toEqual({ eligible: false, reason: "window-closed" });
      expect(listPendingRefundRequests(base.user.id)).toEqual([]);
    });

    it("refuses a Learner who never bought the course", () => {
      const result = submitRefundRequest({
        learnerId: base.user.id,
        courseId: base.course.id,
        reason: "The pace was too fast for me.",
        today: new Date(2026, 2, 2),
      });

      expect(result).toEqual({ eligible: false, reason: "no-purchase" });
    });
  });
});

describe("listPendingRefundRequests", () => {
  it("returns only the Learner's own Pending Refund Requests", () => {
    const otherLearner = testDb
      .insert(schema.users)
      .values({
        name: "Other Learner",
        email: "other@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    const mine = buyCourse({ purchasedAt: new Date(2026, 2, 1) });
    const myEarlier = buyCourse({ purchasedAt: new Date(2026, 1, 1) });
    const theirs = buyCourse({ learnerId: otherLearner.id });
    addRefundRequest(mine.id, schema.RefundStatus.Pending);
    addRefundRequest(myEarlier.id, schema.RefundStatus.Declined);
    addRefundRequest(theirs.id, schema.RefundStatus.Pending);

    const pending = listPendingRefundRequests(base.user.id);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      courseTitle: "Test Course",
      refundAmount: mine.amountPaid,
    });
  });
});
