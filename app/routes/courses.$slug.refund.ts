import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import {
  REFUND_WINDOW_DAYS,
  submitRefundRequest,
  type RefundIneligibilityReason,
} from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

const ineligibleResponses: Record<
  RefundIneligibilityReason,
  { status: number; message: string }
> = {
  "no-purchase": { status: 403, message: "You haven't bought this course." },
  "pending-request": {
    status: 409,
    message: "You already have a pending refund request for this course.",
  },
  "window-closed": {
    status: 403,
    message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
  },
  "watched-too-much": {
    status: 403,
    message: "You have watched too much of this course to request a refund.",
  },
  "completed-too-much": {
    status: 403,
    message: "You have completed too much of this course to request a refund.",
  },
  "claimed-team-seat": {
    status: 403,
    message: "A claimed team seat can't be refunded. Ask your team admin.",
  },
};

// Refund Eligibility rejections go back to the form, where they are shown as a
// toast like the validation errors, rather than replacing the course page with
// an error. The spec asks for this.
function rejection(message: string, status: number) {
  return data({ errors: { refund: message } }, { status });
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Log in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const result = submitRefundRequest({
    learnerId: currentUserId,
    courseId: course.id,
    reason: parsed.data.reason,
    today: new Date(),
  });

  if (!result.eligible) {
    const { status, message } = ineligibleResponses[result.reason];
    return rejection(message, status);
  }

  // There is no mail transport yet, so the confirmation goes to the server log.
  const { email } = result;
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
