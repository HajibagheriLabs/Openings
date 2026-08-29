import { db } from "@/db";
import { inviteFor } from "@/lib/notifications/compose";
import { loadNotificationSubject } from "@/lib/notifications/context";
import { INVITE_FILENAME, inviteContentType } from "@/lib/notifications/invite";
import { MANAGE_TOKEN_PARAM } from "@/lib/notifications/links";
import { readOwnAppointment } from "@/lib/scheduling/booking";

/**
 * The hosted copy of an appointment's calendar invitation.
 *
 * WHY IT EXISTS AT ALL. Every booking email already attaches the .ics, and for
 * Apple Mail and Outlook that is the end of it. Elsewhere it is a lottery: a
 * webmail that decides the attachment is a file offers a download instead of an
 * invitation, and a phone that cannot hand a downloaded file to a calendar
 * offers nothing. A plain https link returning the same bytes with the right
 * content type works in all of those, and costs one route.
 *
 * IT SERVES THE CURRENT INVITE, NOT THE ONE THAT WAS EMAILED. Same UID, and
 * whatever SEQUENCE and times the row is on now — so somebody who opens a
 * three-week-old confirmation after rescheduling gets the appointment as it
 * actually stands rather than a copy that would move their calendar backwards.
 *
 * AUTHORIZED BY THE MANAGE TOKEN, which is the same secret the manage page
 * uses and is compared the same way — hashed, in constant time, against the
 * hash on the row. An appointment id alone gets nothing.
 */
export const runtime = "nodejs";

/* Never cached at the edge, never prerendered. The invite changes when the
   appointment does, and it is addressed to exactly one person. */
export const dynamic = "force-dynamic";

/**
 * Everything that is not a valid, live invitation answers 404.
 *
 * A wrong token, an unknown id and an appointment that is still only HELD are
 * one response, on purpose: distinguishing them would turn this route into an
 * oracle for whether a given appointment id exists.
 */
function notFound(): Response {
  return new Response("No invitation here.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ appointmentId: string }> },
) {
  const { appointmentId } = await context.params;
  const token = new URL(request.url).searchParams.get(MANAGE_TOKEN_PARAM);

  if (!token) {
    return notFound();
  }

  /* The token check and the row read in one call — see `readOwnAppointment`. */
  const appointment = await readOwnAppointment(db, appointmentId, token);

  if (!appointment) {
    return notFound();
  }

  /**
   * A HELD appointment has no invitation.
   *
   * It is a slot reserved for eight minutes while somebody fills in a form.
   * Putting it in a calendar would create an event for a booking that does not
   * exist yet and, far more often than not, never will.
   */
  if (appointment.status === "held") {
    return notFound();
  }

  /**
   * CANCEL for a cancellation, REQUEST for everything else.
   *
   * Read from the row rather than from a query parameter: the point of a
   * hosted invite is that it tells the truth about the appointment right now,
   * and a caller who could ask for a REQUEST on a cancelled booking could put
   * a dead appointment back into somebody's calendar.
   *
   * `no_show` is NOT a cancellation here. The business kept the time and lost
   * it, which is a fact about the diary rather than about the customer's
   * calendar — striking a past event out of their history would rewrite
   * something that genuinely happened to their day.
   */
  const method = appointment.status === "cancelled" ? "CANCEL" : "REQUEST";

  const subject = await loadNotificationSubject(db, appointmentId, {
    /* Irrelevant here — nothing below composes an email. The calendar part is
       built from the appointment's own status. */
    kind: "confirmation",
  });

  if (!subject) {
    return notFound();
  }

  return new Response(inviteFor(subject, method), {
    status: 200,
    headers: {
      "content-type": inviteContentType(method),
      /* Named, so a client that saves rather than opens produces a file with a
         recognisable extension instead of a bare route segment. */
      "content-disposition": `attachment; filename="${INVITE_FILENAME}"`,
      /* One person's appointment, behind a secret in the URL. Never store it
         in a shared cache. */
      "cache-control": "private, no-store",
    },
  });
}
