/**
 * What a mutation hands back to a form.
 *
 * Two shapes, and the failure carries FIELD ERRORS rather than one blob of
 * text, because a form that says "something was wrong" makes the person read
 * every input again. The client marks the field; the toast carries the
 * summary.
 *
 * No `server-only` — the client components import these types.
 */

export type FieldErrors<TField extends string = string> = Partial<
  Record<TField, string>
>;

export type MutationResult<TField extends string = string> =
  | { ok: true; message: string; id?: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: FieldErrors<TField>;
    };

/**
 * A refusal with somewhere to go.
 *
 * Deleting something with history attached is not a validation failure and not
 * an error — it is a legitimate request the product declines, and the decline
 * has to say how much history and where to see it. Errors say what happened
 * and what to do.
 */
export type BlockedResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      blocked?: {
        futureCount: number;
        totalCount: number;
        /** Where those appointments are. */
        href: string;
      };
    };
