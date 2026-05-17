/**
 * Static verification for the "404 after login" fix.
 *
 * This script reads the source files (NOT the build output) and asserts
 * the route definitions and SignIn navigation pattern are in place.
 * Run with: `npx tsx script/verify-routes.ts`
 *
 * Exits with code 1 (and a diagnostic message) if any of the contracts
 * the routing fix depends on is missing — so CI can guard against a
 * regression that silently reintroduces the bug.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname ?? __dirname, "..");
const appTsx = readFileSync(resolve(repoRoot, "client/src/App.tsx"), "utf8");
const signInTsx = readFileSync(
  resolve(repoRoot, "client/src/pages/SignIn.tsx"),
  "utf8",
);

const failures: string[] = [];

function assertMatch(haystack: string, needle: RegExp | string, message: string) {
  const ok =
    typeof needle === "string"
      ? haystack.includes(needle)
      : needle.test(haystack);
  if (!ok) failures.push(message);
}

// --- App.tsx contracts ---------------------------------------------------

// ShellRoutes must include fail-safe aliases so authenticated users who
// land on /signin, /login, /signup, or /analyze never see NotFound.
assertMatch(
  appTsx,
  /<Route\s+path="\/analyze"\s+component=\{Analyze\}/,
  "App.tsx: ShellRoutes is missing the /analyze route alias",
);
assertMatch(
  appTsx,
  /<Route\s+path="\/signin"\s+component=\{Analyze\}/,
  "App.tsx: ShellRoutes is missing the /signin fail-safe (must render Analyze for signed-in users)",
);
assertMatch(
  appTsx,
  /<Route\s+path="\/login"\s+component=\{Analyze\}/,
  "App.tsx: ShellRoutes is missing the /login fail-safe (must render Analyze for signed-in users)",
);
assertMatch(
  appTsx,
  /<Route\s+path="\/signup"\s+component=\{Analyze\}/,
  "App.tsx: ShellRoutes is missing the /signup fail-safe (must render Analyze for signed-in users)",
);

// AppRouter must redirect signed-in users away from auth-only locations.
assertMatch(
  appTsx,
  /AUTH_ONLY_PATHS/,
  "App.tsx: AUTH_ONLY_PATHS constant is missing — signed-in redirect cannot fire",
);
assertMatch(
  appTsx,
  /AUTH_ONLY_PATHS\.has\(location\)/,
  "App.tsx: AppRouter does not check AUTH_ONLY_PATHS — /signin will fall through to NotFound",
);

// Unauthenticated branch must still serve Landing at "/" and SignIn at "/signin".
assertMatch(
  appTsx,
  /if\s*\(\s*location\s*===\s*"\/signin"\s*\)\s*\{\s*return\s+<SignIn\s*\/>/,
  "App.tsx: unauthenticated /signin must render SignIn",
);
assertMatch(
  appTsx,
  /return\s+<Landing\s*\/>;/,
  "App.tsx: unauthenticated branch must return <Landing />",
);

// Payment callback normalization must remain in place.
assertMatch(
  appTsx,
  /useNormalizePaymentCallback/,
  "App.tsx: payment callback normalization was removed (breaks Stripe redirect)",
);

// --- SignIn.tsx contracts ------------------------------------------------

assertMatch(
  signInTsx,
  /from\s+"wouter"/,
  "SignIn.tsx: must import useLocation from wouter for explicit navigation",
);
assertMatch(
  signInTsx,
  /goToDashboard/,
  "SignIn.tsx: goToDashboard helper is missing",
);

// Every mutation that establishes a session must call goToDashboard().
const mutationBlocks = signInTsx.match(/onSuccess:\s*async\s*\(\)\s*=>\s*\{[^}]*\}/g) ?? [];
const sessionMutations = mutationBlocks.filter(
  (block) => block.includes("invalidateQueries"),
);
if (sessionMutations.length < 4) {
  failures.push(
    `SignIn.tsx: expected at least 4 session-establishing onSuccess handlers, found ${sessionMutations.length}`,
  );
}
for (const block of sessionMutations) {
  if (!block.includes("goToDashboard()")) {
    failures.push(
      "SignIn.tsx: a session-establishing onSuccess handler is missing goToDashboard() — login will leave the URL on /signin",
    );
    break;
  }
}

// --- Report ---------------------------------------------------------------

if (failures.length > 0) {
  console.error("Route verification failed:\n");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("OK: all route/sign-in invariants present.");
console.log("  - ShellRoutes fail-safes: /analyze, /signin, /login, /signup");
console.log("  - AppRouter redirects auth-only paths when signed in");
console.log("  - SignIn mutations explicitly navigate to /");
console.log("  - Landing + /signin + payment callback normalization preserved");
