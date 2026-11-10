import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  LessonProgressStatus,
  coupons,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  RefundStatus,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundIneligibilityReason =
  | "no-purchase"
  | "pending-request"
  | "window-closed"
  | "watched-too-much"
  | "completed-too-much"
  | "claimed-team-seat";

export type RefundOffer =
  | { eligible: true; refundAmount: number; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibilityReason };

export type RefundRequestConfirmationEmail = {
  to: string;
  subject: string;
  body: string;
};

export type SubmitRefundRequestResult =
  | {
      eligible: true;
      refundRequest: typeof refunds.$inferSelect;
      email: RefundRequestConfirmationEmail;
    }
  | { eligible: false; reason: RefundIneligibilityReason };

type Purchase = typeof purchases.$inferSelect;

/** Which Learner's purchase of which course, judged on which calendar day. */
export type RefundCheck = {
  learnerId: number;
  courseId: number;
  today: Date;
};

function getLatestPurchase(learnerId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(
      and(eq(purchases.userId, learnerId), eq(purchases.courseId, courseId))
    )
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

export function getLessonIdsForCourse(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

// Watch time is the furthest position reached in each lesson, summed, so
// seeking back and re-watching a lesson does not count twice.
function getSecondsWatched(learnerId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, learnerId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(learnerId: number, lessonIds: number[]) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, learnerId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function hasPendingRefundRequest(purchaseId: number) {
  const pending = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Pending)
      )
    )
    .get();

  return pending !== undefined;
}

// A seat that came out of a team licence, and has been claimed, belongs to
// the team: the buyer cannot hand it back on their own.
function hasClaimedTeamSeat(purchaseId: number) {
  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();

  return claimedSeat !== undefined;
}

export function getRefundOffer(input: RefundCheck): RefundOffer {
  const check = checkRefundEligibility(input);
  if (!check.eligible) return check;

  return {
    eligible: true,
    refundAmount: check.purchase.amountPaid,
    lastDayInWindow: check.lastDayInWindow,
  };
}

/**
 * Re-checks Refund Eligibility (the page the Learner submitted from may be
 * stale) and, if they are still eligible, records a Pending Refund Request.
 * The confirmation email is returned for the caller to deliver.
 */
export function submitRefundRequest(
  input: RefundCheck & { reason: string }
): SubmitRefundRequestResult {
  const check = checkRefundEligibility(input);
  if (!check.eligible) return check;

  const { purchase } = check;

  const refundRequest = db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Pending,
      reason: input.reason,
    })
    .returning()
    .get();

  const recipient = db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, purchase.id))
    .get();

  if (!recipient) {
    throw new Error(`Purchase ${purchase.id} has no Learner or course`);
  }

  const email = buildRefundRequestConfirmation({
    ...recipient,
    refundAmount: purchase.amountPaid,
  });

  return { eligible: true, refundRequest, email };
}

function checkRefundEligibility(input: RefundCheck):
  | { eligible: true; purchase: Purchase; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibilityReason } {
  // Refund Eligibility applies to the Learner's most recent purchase.
  const purchase = getLatestPurchase(input.learnerId, input.courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasPendingRefundRequest(purchase.id)) {
    return { eligible: false, reason: "pending-request" };
  }

  const lastDayInWindow = getLastDayInWindow(purchase.createdAt);
  if (calendarDay(input.today) > lastDayInWindow) {
    return { eligible: false, reason: "window-closed" };
  }

  const lessonIds = getLessonIdsForCourse(input.courseId);

  if (
    getSecondsWatched(input.learnerId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS
  ) {
    return { eligible: false, reason: "watched-too-much" };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(input.learnerId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  if (hasClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "claimed-team-seat" };
  }

  return { eligible: true, purchase, lastDayInWindow };
}

/**
 * The confirmation the Learner gets in their inbox after submitting a Refund
 * Request.
 */
function buildRefundRequestConfirmation(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  refundAmount: number;
}): RefundRequestConfirmationEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your Refund Request for "${input.courseTitle}". Your Refund will be ${formatPrice(input.refundAmount)}, the amount you paid. Our team reviews every Refund Request by hand. You do not need to do anything else — we will email you again when it is done.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/** The Learner's own Pending Refund Requests, as shown on Settings. */
export function listPendingRefundRequests(learnerId: number) {
  return db
    .select({
      id: refunds.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      refundAmount: purchases.amountPaid,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(refunds.status, RefundStatus.Pending)
      )
    )
    .all();
}

// The Refund Window is counted in whole calendar days, not hours: a Learner
// who buys at 23:00 still gets the whole of their 14th day.
function calendarDay(when: Date) {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function getLastDayInWindow(purchasedAtIso: string) {
  const lastDay = new Date(purchasedAtIso);
  lastDay.setDate(lastDay.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(lastDay);
}
