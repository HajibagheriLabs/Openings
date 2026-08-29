import type { NextConfig } from "next";

/* ===========================================================================
   SECURITY HEADERS
   ---------------------------------------------------------------------------
   Set here rather than in vercel.json so they apply to `next start` and to a
   local `npm run dev` too. A header that only exists in production is a header
   nobody tests.
   =========================================================================== */

/**
 * ═══ THE CONTENT SECURITY POLICY ═══
 *
 * WHAT THIS APPLICATION ACTUALLY LOADS, which is what the policy is built
 * from rather than from a template:
 *
 *   scripts   Next's own bundles, from this origin. Nothing else — there is no
 *             analytics tag, no tag manager, and Stripe.js is NOT loaded:
 *             checkout is a full-page redirect to checkout.stripe.com, so the
 *             card form runs on Stripe's origin under Stripe's policy, not
 *             inside this one. That is why `script-src` names no third party.
 *   styles    Tailwind, compiled into a stylesheet from this origin, plus the
 *             handful of inline `style` attributes React writes for the
 *             ribbon's geometry (`top`, `height`) and the hold bar's width.
 *   fonts     Epilogue and Hanken Grotesk, SELF-HOSTED by next/font. No
 *             fonts.googleapis.com, no fonts.gstatic.com.
 *   images    Own assets, plus `data:` for the inline SVG icons and `blob:`
 *             for anything Next generates.
 *   fetch     Same origin. Server Actions post back here; the booking page
 *             polls through an action; the agenda opens an EventSource on
 *             /api/admin/agenda/stream.
 *
 * WHY 'unsafe-inline' IS IN script-src, said plainly rather than hidden:
 * React streams a page by writing inline `$RC(...)` calls into the document to
 * reveal Suspense boundaries as they resolve, and next/script writes the
 * bootstrap the same way. Removing it means minting a nonce per request in the
 * proxy and threading it through, which the Edge proxy in this project
 * deliberately does not do — see the note at the top of src/proxy.ts about it
 * not being a security boundary. The honest position: this CSP is a strong
 * defence against loading a THIRD-PARTY script and a weak one against an
 * injected inline one, and the second is covered by React escaping every value
 * it renders and by there being no `dangerouslySetInnerHTML` anywhere in this
 * codebase.
 *
 * STRIPE'S DOMAINS ARE ALLOWED even though the current flow only redirects:
 * `frame-src` and `connect-src` cover 3-D Secure challenges and the embedded
 * form, and `form-action` covers the redirect being reached by a form post
 * rather than by `location.assign`. Allowing them costs nothing and means a
 * later change to embedded checkout is not a mystery outage.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * ═══ THE POLICY IS RELAXED IN DEVELOPMENT, AND ONLY THERE ═══
 *
 * Two allowances below are gated on the environment, because Next's dev server
 * genuinely needs them and production genuinely does not. Both were found by
 * turning the policy on and reading the console, not by guessing:
 *
 *   'unsafe-eval'   React's development build uses `eval()` to reconstruct
 *                   callstacks across the server/client boundary. It says so
 *                   in the error it throws when blocked, and it says — truly —
 *                   that it never uses eval in production.
 *   ws: / wss:      Hot module replacement is a WebSocket to this origin.
 *                   `'self'` does not reliably cover a `ws:` URL, and
 *                   `upgrade-insecure-requests` rewrites `ws://localhost` to
 *                   `wss://localhost`, which nothing is listening on. So the
 *                   schemes are named explicitly and the upgrade directive is
 *                   left out of the development policy entirely.
 *
 * Shipping one policy for both would have meant either a broken dev server or
 * — far worse, and the usual outcome — `'unsafe-eval'` in production because
 * that was what made the warnings stop.
 */
const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],

  "script-src": [
    "'self'",
    "'unsafe-inline'",
    ...(IS_PRODUCTION ? [] : ["'unsafe-eval'"]),
    "https://js.stripe.com",
  ],

  /* Tailwind's stylesheet, plus React's inline style attributes. */
  "style-src": ["'self'", "'unsafe-inline'"],

  /* next/font self-hosts both faces. Nothing external. */
  "font-src": ["'self'", "data:"],

  "img-src": ["'self'", "data:", "blob:", "https://*.stripe.com"],

  /* Server Actions, the availability poll, and the agenda's EventSource —
     all same-origin. The ws: schemes are HMR, and development only. */
  "connect-src": [
    "'self'",
    "https://api.stripe.com",
    ...(IS_PRODUCTION ? [] : ["ws:", "wss:"]),
  ],

  /* 3-D Secure and the embedded form, if this ever stops redirecting. */
  "frame-src": [
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://checkout.stripe.com",
  ],

  /* Nothing may frame US. The modern replacement for X-Frame-Options, and the
     one browsers honour when both are present. */
  "frame-ancestors": ["'none'"],

  /* Where a form may post. 'self' for every form in the app; Stripe because
     the hand-off is allowed to become a POST. */
  "form-action": ["'self'", "https://checkout.stripe.com"],

  /* No <base> tag anywhere; forbidding one removes a whole class of injected
     relative-URL rewrites. */
  "base-uri": ["'self'"],

  /* No Flash, no Java, no PDF plugin surface. */
  "object-src": ["'none'"],

  /* Belt and braces with HSTS. Production only: on http://localhost it
     rewrites the HMR socket to wss:// and breaks the dev server. */
  ...(IS_PRODUCTION ? { "upgrade-insecure-requests": [] } : {}),
};

function contentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, values]) =>
      values.length ? `${directive} ${values.join(" ")}` : directive,
    )
    .join("; ");
}

/**
 * The rest of the headers, and what each one is actually for.
 *
 * `Strict-Transport-Security` is deliberately NOT sent in development: it
 * would pin `localhost` to https in the browser's HSTS store for two years,
 * and every other project on that machine would then fail to load over http.
 * That is a genuinely painful thing to undo, so it is gated on NODE_ENV.
 */
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy(),
  },
  {
    /* Never guess a type. Stops a text file the browser decides is JavaScript. */
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    /* Send the origin to other sites and the full path only to our own, so a
       manage token — which lives IN THE PATH and is a live credential — is
       never handed to a third party in a Referer header. This is a real leak
       vector for this application specifically, not a generic best practice. */
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    /* Nothing in a booking page needs a camera, a microphone or a location.
       Denying them means a compromised script cannot ask either. `payment` is
       denied too: card entry happens on Stripe's origin, never on this one. */
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
  {
    /* Superseded by frame-ancestors above, kept for older browsers that only
       understand this one. */
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    /* Do not leak this origin's URLs into a cross-origin window's opener. */
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
];

const PRODUCTION_ONLY_HEADERS = [
  {
    /* Two years, subdomains included, and preload-eligible. Only in
       production — see the note above about pinning localhost. */
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        /* Every route, including API routes and the webhook. */
        source: "/:path*",
        headers: [
          ...SECURITY_HEADERS,
          ...(IS_PRODUCTION ? PRODUCTION_ONLY_HEADERS : []),
        ],
      },
      {
        /**
         * The manage page carries a credential in its URL.
         *
         * `noindex, nofollow` is already in the page's metadata; this adds the
         * header form, which crawlers that never execute the page still read,
         * and `noarchive` so a link that leaks into a crawl is not preserved
         * in a cache after the appointment is over.
         */
        source: "/manage/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
