import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initAnalytics, captureReferralFromUrl } from "@/lib/analytics";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Force dark mode synchronously before React renders. The inline bootstrap in
// index.html already does this for the very first paint, but we re-apply it
// here in case the Vite dev server or HMR has rewritten <html>. The app is
// intentionally dark-only — we do NOT honor prefers-color-scheme: light. No
// persistence (no localStorage / cookies allowed in the sandbox).
try {
  document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = "dark";
} catch {
  // DOM missing — leave as-is.
}

initAnalytics();
// Capture `?ref=<code>` once per session. The value is persisted in
// localStorage so later signup / purchase events attribute the visit.
captureReferralFromUrl();

createRoot(document.getElementById("root")!).render(<App />);
