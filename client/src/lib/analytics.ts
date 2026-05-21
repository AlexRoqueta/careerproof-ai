/**
 * Lightweight, vendor-agnostic analytics layer.
 *
 * Supports three providers, all optional and all loaded lazily:
 *   - Meta Pixel       (VITE_META_PIXEL_ID)
 *   - Google Analytics 4 (VITE_GA_MEASUREMENT_ID)
 *   - PostHog          (VITE_POSTHOG_KEY, VITE_POSTHOG_HOST)
 *
 * When an env var is absent the matching provider stays silent — no
 * network calls, no console noise, no thrown errors. This lets us ship
 * the same bundle to environments that do or do not track.
 *
 * `track(name, params?)` is the single entry point used across the app.
 * It fans out to whichever providers are configured and, where it makes
 * sense, also maps the call to the matching Meta standard event so the
 * Pixel reports clean funnel metrics out of the box.
 */

type Params = Record<string, unknown>;

const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;

const META_PIXEL_ID = env.VITE_META_PIXEL_ID?.trim() || "";
const GA_MEASUREMENT_ID = env.VITE_GA_MEASUREMENT_ID?.trim() || "";
const POSTHOG_KEY = env.VITE_POSTHOG_KEY?.trim() || "";
const POSTHOG_HOST =
  env.VITE_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; version?: string };
    _fbq?: unknown;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    posthog?: {
      init: (key: string, opts: Record<string, unknown>) => void;
      capture: (event: string, props?: Record<string, unknown>) => void;
      __loaded?: boolean;
    };
  }
}

let initialized = false;
let gaInitialized = false;
let gaInitializedId = "";

/**
 * Inject all configured provider snippets. Safe to call repeatedly — the
 * first call wins and subsequent calls are no-ops.
 */
export function initAnalytics(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try {
    if (META_PIXEL_ID) loadMetaPixel(META_PIXEL_ID);
  } catch {
    /* ignore — never break the app for analytics */
  }
  try {
    if (GA_MEASUREMENT_ID) loadGA(GA_MEASUREMENT_ID);
  } catch {
    /* ignore */
  }
  try {
    if (POSTHOG_KEY) loadPostHog(POSTHOG_KEY, POSTHOG_HOST);
  } catch {
    /* ignore */
  }
}

function loadMetaPixel(id: string) {
  /* Standard Meta Pixel bootstrap. Re-implemented in TS so we can avoid
   * eval and the `n.callMethod.apply` shape pasted from FB docs. The
   * queue + flush behavior is the same: calls placed before the script
   * is ready land in fbq.queue and fire once it loads. */
  if (window.fbq) return;
  const fbq = function (this: unknown, ...args: unknown[]) {
    // @ts-ignore — Meta's loader uses callMethod when present.
    (fbq as any).callMethod
      ? // @ts-ignore
        (fbq as any).callMethod.apply(fbq, args)
      : (fbq as any).queue.push(args);
  } as Window["fbq"] & ((...args: unknown[]) => void);
  (fbq as any).push = fbq;
  (fbq as any).loaded = true;
  (fbq as any).version = "2.0";
  (fbq as any).queue = [];
  window.fbq = fbq as Window["fbq"];
  if (!window._fbq) window._fbq = fbq;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://connect.facebook.net/en_US/fbevents.js";
  const first = document.getElementsByTagName("script")[0];
  first?.parentNode?.insertBefore(s, first);
  window.fbq!("init", id);
  window.fbq!("track", "PageView");
}

function loadGA(id: string) {
  // Guard per-ID, not on presence of window.gtag: if some other code stubbed
  // gtag without configuring this measurement ID, GA would silently never fire.
  if (gaInitialized && gaInitializedId === id) return;

  // Standard Google tag snippet ordering: dataLayer + gtag stub MUST exist
  // before the gtag.js script loads, and gtag must push `arguments` (not a
  // plain array) so the loaded library recognizes queued commands.
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments as unknown as unknown[]);
    };
  }
  // @ts-ignore — gtag's stub accepts the literal "js" command with a Date.
  window.gtag("js", new Date());
  window.gtag("config", id, { send_page_view: true });

  gaInitialized = true;
  gaInitializedId = id;

  // Inject the loader last. The queued commands above will replay once it lands.
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src^="https://www.googletagmanager.com/gtag/js"]`,
  );
  if (!existing) {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
  }
}

function loadPostHog(key: string, host: string) {
  if (window.posthog?.__loaded) return;
  /* Minimal PostHog loader. We avoid importing the full SDK so the
   * bundle stays light when PostHog is not configured. The official
   * snippet is reproduced almost verbatim. */
  const script = document.createElement("script");
  script.async = true;
  script.src = `${host.replace(/\/$/, "")}/static/array.js`;
  document.head.appendChild(script);
  const stub: any = {
    _i: [],
    init(k: string, opts: Record<string, unknown>) {
      stub._i.push([k, opts]);
    },
    capture() {
      /* queued by the loader once the real lib lands */
    },
  };
  window.posthog = stub;
  // The real lib reads _i and replays init calls.
  stub.init(key, { api_host: host, capture_pageview: true });
}

/**
 * Fire an event across every configured provider. Names should be the
 * canonical funnel names defined in EVENTS. Params are passed through
 * as-is to GA and PostHog; the Meta mapping in META_STANDARD_EVENTS
 * decides whether to also emit a Meta standard event.
 */
export function track(name: string, params: Params = {}): void {
  if (typeof window === "undefined") return;
  if (!initialized) initAnalytics();

  // Meta — custom event always; standard event if mapped.
  if (META_PIXEL_ID && window.fbq) {
    try {
      window.fbq("trackCustom", name, params);
      const standard = META_STANDARD_EVENTS[name];
      if (standard) window.fbq("track", standard, params);
    } catch {
      /* ignore */
    }
  }

  // GA4 — every event ships through `event`. We check gaInitialized rather
  // than window.gtag presence so we don't get fooled by a third-party stub.
  if (GA_MEASUREMENT_ID && gaInitialized && window.gtag) {
    try {
      window.gtag("event", name, params);
    } catch {
      /* ignore */
    }
  }

  // PostHog — capture with the canonical name.
  if (POSTHOG_KEY && window.posthog?.capture) {
    try {
      window.posthog.capture(name, params);
    } catch {
      /* ignore */
    }
  }
}

/* Public canonical event names. Use these instead of stringly typed
 * names at call sites so a typo surfaces at compile time. */
export const EVENTS = {
  landing_view: "landing_view",
  landing_cta_click: "landing_cta_click",
  signup_started: "signup_started",
  signup_completed: "signup_completed",
  signin_completed: "signin_completed",
  input_method_selected: "input_method_selected",
  resume_uploaded: "resume_uploaded",
  linkedin_import_started: "linkedin_import_started",
  linkedin_import_completed: "linkedin_import_completed",
  ai_autofill_started: "ai_autofill_started",
  ai_autofill_completed: "ai_autofill_completed",
  analysis_started: "analysis_started",
  analysis_completed: "analysis_completed",
  report_viewed: "report_viewed",
  buy_credits_clicked: "buy_credits_clicked",
  checkout_started: "checkout_started",
  checkout_success: "checkout_success",
  sample_report_viewed: "sample_report_viewed",
} as const;

/* Map our funnel events to Meta standard events where the semantic
 * match is clear. Anything not in this map only fires as a custom
 * event. */
const META_STANDARD_EVENTS: Record<string, string> = {
  landing_view: "PageView",
  signup_started: "Lead",
  signup_completed: "CompleteRegistration",
  checkout_started: "InitiateCheckout",
  checkout_success: "Purchase",
};

/** Convenience: tag the active visitor (e.g. after sign-in) where the
 * provider supports it. Safe to call when no provider is configured. */
export function identify(userId: string | number, traits?: Params): void {
  if (typeof window === "undefined") return;
  if (POSTHOG_KEY && window.posthog && typeof (window.posthog as any).identify === "function") {
    try {
      (window.posthog as any).identify(String(userId), traits ?? {});
    } catch {
      /* ignore */
    }
  }
  if (GA_MEASUREMENT_ID && gaInitialized && window.gtag) {
    try {
      window.gtag("set", { user_id: String(userId) });
    } catch {
      /* ignore */
    }
  }
}
