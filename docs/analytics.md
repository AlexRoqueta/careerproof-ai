# Analytics & conversion tracking

CareerProof AI ships with a single, vendor-agnostic analytics module at
`client/src/lib/analytics.ts`. It supports three providers out of the
box. Every provider is **optional** — when an env var is absent, the
matching loader is skipped and no network calls are made. The same
bundle can therefore be deployed to environments that do or do not
track.

## Configure on Render (or any host)

Set any of the following client-side environment variables. They must
start with `VITE_` so Vite injects them into the client bundle at build
time.

| Variable                   | Required? | Purpose                                                                 |
| -------------------------- | --------- | ----------------------------------------------------------------------- |
| `VITE_META_PIXEL_ID`       | optional  | Meta Pixel ID. Enables PageView + funnel events + Meta standard events. |
| `VITE_GA_MEASUREMENT_ID`   | optional  | Google Analytics 4 measurement ID (e.g. `G-XXXXXXXXXX`).                |
| `VITE_POSTHOG_KEY`         | optional  | PostHog project API key.                                                |
| `VITE_POSTHOG_HOST`        | optional  | PostHog host. Defaults to `https://us.i.posthog.com`.                   |

All four variables can be left unset for local dev — the app stays
fully functional and simply doesn't report any analytics.

## Funnel events fired by the client

| Event name                    | When it fires                                            |
| ----------------------------- | -------------------------------------------------------- |
| `landing_view`                | Public landing page mounts.                              |
| `landing_cta_click`           | Any landing-page primary CTA is clicked.                 |
| `signup_started`              | User submits the create-account form.                    |
| `signup_completed`            | `/api/me/signup` returns success.                        |
| `signin_completed`            | `/api/me/signin` returns success.                        |
| `input_method_selected`       | User opens one of the three analyze input panels.        |
| `resume_uploaded`             | Resume upload `/api/resumes` succeeds.                   |
| `linkedin_import_started`     | LinkedIn import request begins.                          |
| `linkedin_import_completed`   | LinkedIn import returns parsed fields.                   |
| `ai_autofill_started`         | AI auto-fill request begins.                             |
| `ai_autofill_completed`       | AI auto-fill returns suggested fields.                   |
| `analysis_started`            | `/api/analyses` POST is dispatched.                      |
| `analysis_completed`          | `/api/analyses` POST resolves with an Analysis object.   |
| `report_viewed`               | `ReportView` mounts. Includes `locked` flag.             |
| `buy_credits_clicked`         | Any "Buy credits" / upsell CTA is clicked.               |
| `checkout_started`            | `/api/payments/create-checkout` is dispatched.           |
| `checkout_success`            | A purchase is confirmed (preview or via Stripe webhook). |
| `sample_report_viewed`        | The public `/sample-report` page is opened.              |

## Meta standard event mapping

For Meta Pixel users we also fire the matching Meta standard event when
the semantic match is clean:

| Funnel event         | Meta standard event   |
| -------------------- | --------------------- |
| `landing_view`       | `PageView`            |
| `signup_started`     | `Lead`                |
| `signup_completed`   | `CompleteRegistration`|
| `checkout_started`   | `InitiateCheckout`    |
| `checkout_success`   | `Purchase`            |

All other events fire only as Meta custom events.

## Public sample report

There is now a static, fully fleshed-out sample report at
`#/sample-report`. It is reachable without a session so prospective
users can scroll through the actual report structure before signing
up. The sample page also fires `sample_report_viewed`.
