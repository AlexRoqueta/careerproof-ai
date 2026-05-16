/* Verification script for the LinkedIn job-text parser.
 *
 * Run with:  npx tsx script/verify-linkedin-import.ts
 *
 * Exercises parseLinkedInJobText against representative pasted-from-
 * LinkedIn shapes:
 *
 *   1. A typical pasted job: title / company / location header followed
 *      by an "About the job" body. Chrome lines ("Apply", "300
 *      applicants", "Posted 2 days ago") must NOT pollute the
 *      description.
 *   2. An HTML page containing a JSON-LD <script type="application/
 *      ld+json"> JobPosting block — the most reliable parse path when
 *      the server-side fetch path succeeds. Title and company must
 *      lift directly from the structured data, and the description
 *      must be HTML-stripped.
 *   3. Empty input — must return an all-empty object, NOT throw, so the
 *      route handler can safely surface "fetch-failed" without
 *      crashing.
 *   4. Pasted text with no recognisable title — should still return the
 *      cleaned text as the description so the user has something to
 *      edit.
 *   5. The Zod schema rejects empty payloads (no URL AND no text) so
 *      the route can rely on schema validation for that edge case.
 *
 * Exits non-zero on any failure.
 */
import {
  parseLinkedInJobText,
  stripHtmlToText,
  extractLinkedInJobWithAI,
  cleanPastedLinkedInText,
  cleanLinkedInDescription,
  sanitizeLinkedInShortField,
  finalizeLinkedInResult,
  looksLikeLoggedOutPreview,
  descriptionPassesQualityGate,
  extractTechnologyContextFromRawText,
  __setLlmFetcherForTests,
} from "../server/ai";
import { linkedinImportSchema } from "../shared/schema";

type Case = {
  name: string;
  input: string;
  expect_title?: string | RegExp;
  expect_company?: string | RegExp;
  expect_location?: string | RegExp;
  expect_description_includes?: string;
  expect_description_excludes?: string[];
  expect_technology_context_includes?: string[];
  expect_empty?: boolean;
};

const PASTED_TYPICAL = `Easy Apply
Save
Senior Software Engineer
Acme Robotics Inc.
San Francisco, CA · Hybrid
300 applicants
Posted 2 days ago
About the job
We are looking for a Senior Software Engineer to join the platform team. You will design and ship large-scale distributed systems, mentor a small team, and partner with product on roadmap decisions.

Responsibilities
- Build and operate backend services in Go and TypeScript.
- Lead architecture for a high-throughput ingestion pipeline.
- Collaborate with product, design, and ML teams.

Requirements
- 7+ years of backend experience.
- Strong systems fundamentals.
- Experience with Kubernetes is a plus.

Show more
Report this job`;

const JSON_LD_HTML = `<!doctype html>
<html><head>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Product Designer",
  description: "<p>We are hiring a <strong>Staff Product Designer</strong> to lead the design system. You will partner with engineering and product.</p><ul><li>Own the design system</li><li>Mentor designers</li></ul>",
  hiringOrganization: { "@type": "Organization", name: "Northwind Labs" },
  jobLocation: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "New York",
      addressRegion: "NY",
      addressCountry: "US",
    },
  },
})}
</script>
</head><body>...</body></html>`;

const PROFILE_HEADLINE_AT = `Jane Doe
Senior Software Engineer at Acme Robotics
San Francisco Bay Area · 500+ connections
Contact
About
Backend engineer with a decade of experience scaling distributed systems and mentoring teams.
Experience
Acme Robotics
Senior Software Engineer
Full-time
Jan 2022 - Present · 3 yrs
San Francisco, CA · Hybrid
Built and operate the platform team's ingestion pipeline.
Northwind Labs
Software Engineer
Full-time
Jul 2018 - Dec 2021 · 3 yrs 6 mos
Education
Stanford University
B.S. Computer Science
2014 - 2018`;

const PROFILE_DOT_SEPARATOR = `Maria López
Staff Product Designer · Brightline Studio
New York, NY
Experience
Staff Product Designer
Brightline Studio · Full-time
Mar 2023 - Present
New York, NY
Senior Product Designer
Northwind Labs
Aug 2019 - Feb 2023 · 3 yrs 7 mos`;

const PROFILE_NO_PRESENT = `Sam Lee
Marketing Manager
Austin, Texas
Experience
Bluewave Coffee
Marketing Manager
Full-time
Feb 2024 - Apr 2026 · 2 yrs 3 mos
Austin, TX`;

/* A representative "messy" LinkedIn paste from a logged-out browser tab:
 * the clipboard includes the login form, cookie banner, masked profile
 * snippets, CSS class fragments, and a "Suggested for you" sidebar
 * widget. The actual profile content is interleaved with all of it. */
const PROFILE_PASTE_WITH_LOGIN_CHROME = `Skip to main content
LinkedIn
Welcome back
Email or phone
***@gmail.com
Password
Show
Forgot password?
Sign in
or
New to LinkedIn?
Join now
By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement, Privacy Policy, and Cookie Policy.

artdeco-button artdeco-button--secondary artdeco-button--3
.global-nav__nav { display: flex; }
![profile photo](https://media.licdn.com/dms/image/profile.jpg)

Alex Roqueta
Senior Program Manager / Technical Director
Ladera Ranch, California, United States · Contact info
500+ connections

Current company: Smart Staffing Solutions
Suggested current title: Sr. Program Manager

About
Senior Program Manager and Technical Director with 15+ years driving large-scale technical programs across IoT, Cloud, CRM, and Big Data platforms. I partner with cross-functional teams to deliver new product development end-to-end, from discovery to launch. Comfortable in Azure, SQL, and Jira-driven Agile environments. Passionate about customer experience and predictive analytics.

Specialties
Technical Program Management, IoT, CRM, Cloud, New Product Development, Big Data, Predictive Analytics, BI, Customer Experience, Product Development

Experience
Sr. Program Manager
Smart Staffing Solutions · Contract
Jan 2020 - Present · 6 yrs 4 mos
Corona, CA
- Lead cross-functional technical programs across IoT and Cloud platforms.
- Manage roadmaps in Jira and Confluence, partnering with engineering, product, and customer success.
- Built BI dashboards in SSRS and SAP Crystal Reports for executive reporting.
- Drove predictive analytics initiatives using Azure ML and SQL.

Program Manager
Acme Technologies
Mar 2014 - Dec 2019 · 5 yrs 10 mos
Irvine, CA

Suggested for you
People you may know
Show more

© 2026 LinkedIn Corporation
Cookie Policy
Privacy Policy
User Agreement`;

/* Logged-out preview chrome reported by the user in 2026-05. This is the
 * worst-case shape: barely any real profile content, CSS/Tailwind class
 * residue everywhere, consent CTAs repeated 3+ times, masked-star
 * garbage, and a "Suggested current title at Smart Staffing Solutions
 * Sr. Program Manager?" prompt. The cleaner must drop ALL of the
 * chrome and the title fallback must still produce something usable. */
const PROFILE_LOGGED_OUT_PREVIEW = `Skip to main content
LinkedIn
Welcome back
Email or phone
*** * *********** *********
Password
Show
Forgot password?
Sign in
or
New to LinkedIn?
Join now
By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement , Privacy Policy , and Cookie Policy .

Alex Roqueta
Senior Program Manager / Technical Director
Ladera Ranch, California, United States · Contact info

About:
Sr. Technical Program Manager/IOT innovator/Customer Experience Guru/Sr. Business-Systems
I drive end-to-end technical programs across IoT, Cloud, CRM, and Big Data platforms — partnering with engineering, product, and customer success to ship new product development at scale. Comfortable in Azure, SQL, SSRS, SAP Crystal Reports, Jira, and Confluence with predictive analytics initiatives.

By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement , Privacy Policy , and Cookie Policy .
New to LinkedIn? Join now
Experience & Education

*]:mb-0 text-[18px] text-color-text leading-regular group-hover:underline font-semibold">
Smart Staffing Solutions
*]:mb-0 not-first-middot leading-[1.75]">
*]:mb-0 [&>*]:text-md [&>*]:text-color-text-low-emphasis">

Is your current title at Smart Staffing Solutions Sr. Program Manager?

View Alex's full experience
See their title, tenure and more.
By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement , Privacy Policy , and Cookie Policy .
New to LinkedIn? Join now
By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement , Privacy Policy , and Cookie Policy .`;

const cases: Case[] = [
  {
    name: "LinkedIn profile — headline 'Title at Company' with current role",
    input: PROFILE_HEADLINE_AT,
    expect_title: /Senior Software Engineer/,
    expect_company: /Acme Robotics/,
  },
  {
    name: "LinkedIn profile — '·' separator headline and Experience block",
    input: PROFILE_DOT_SEPARATOR,
    expect_title: /Staff Product Designer/,
    expect_company: /Brightline Studio/,
  },
  {
    name: "LinkedIn profile — latest role even without 'Present' marker",
    input: PROFILE_NO_PRESENT,
    expect_title: /Marketing Manager/,
  },
  {
    name: "LinkedIn profile — paste with login/CSS chrome (user-reported case)",
    input: PROFILE_PASTE_WITH_LOGIN_CHROME,
    expect_title: /(Sr\.? Program Manager|Senior Program Manager)/i,
    expect_company: /Smart Staffing Solutions/,
    expect_location: /(Ladera Ranch|California|Corona)/,
    expect_description_includes: "current role",
    expect_description_excludes: [
      "Welcome back",
      "Email or phone",
      "Password",
      "Forgot password",
      "Sign in",
      "New to LinkedIn",
      "Cookie Policy",
      "Privacy Policy",
      "User Agreement",
      "artdeco-button",
      ".global-nav__nav",
      "Suggested for you",
      "***@gmail.com",
    ],
    expect_technology_context_includes: [
      "Technical Program Management",
      "IoT",
      "CRM",
      "Cloud",
    ],
  },
  {
    name: "LinkedIn profile — logged-out preview chrome (2026-05 user report)",
    input: PROFILE_LOGGED_OUT_PREVIEW,
    expect_title: /(Sr\.? Program Manager|Senior Program Manager|Sr\.? Technical Program Manager|Senior Program Manager \/ Technical Director)/i,
    expect_company: /Smart Staffing Solutions/,
    expect_description_excludes: [
      "By clicking Continue to join or sign in",
      "User Agreement",
      "Cookie Policy",
      "Privacy Policy",
      "New to LinkedIn",
      "View Alex",
      "See their title, tenure",
      "Experience & Education",
      "*]:mb-0",
      "text-[18px]",
      "text-color-text",
      "group-hover:underline",
      "leading-[1.75]",
      "[&>*]",
      "font-semibold",
      "not-first-middot",
      "*** * ***",
    ],
    expect_technology_context_includes: [
      "IoT",
      "Cloud",
    ],
  },
  {
    name: "typical pasted LinkedIn job",
    input: PASTED_TYPICAL,
    expect_title: /Senior Software Engineer/,
    expect_company: /Acme Robotics/,
    expect_location: /San Francisco/,
    expect_description_includes: "distributed systems",
    expect_description_excludes: [
      "Easy Apply",
      "300 applicants",
      "Posted 2 days ago",
      "Report this job",
    ],
  },
  {
    name: "HTML with JSON-LD JobPosting",
    input: JSON_LD_HTML,
    expect_title: /Staff Product Designer/,
    expect_company: /Northwind Labs/,
    expect_location: /New York/,
    expect_description_includes: "design system",
    expect_description_excludes: ["<p>", "<strong>", "</li>"],
  },
  {
    name: "empty input returns an empty result rather than throwing",
    input: "",
    expect_empty: true,
  },
  {
    name: "unstructured paste still returns the text as a description",
    input: "Just some loose text someone pasted in without any obvious title structure or chrome lines.",
    expect_description_includes: "loose text",
  },
];

let failed = 0;
for (const c of cases) {
  const out = parseLinkedInJobText(c.input);
  const checks: Array<[string, boolean]> = [];
  if (c.expect_empty) {
    checks.push([
      "empty title+description",
      out.job_title === "" && out.job_description === "",
    ]);
  }
  if (c.expect_title !== undefined) {
    checks.push([
      `title ~= ${c.expect_title}`,
      c.expect_title instanceof RegExp
        ? c.expect_title.test(out.job_title)
        : out.job_title === c.expect_title,
    ]);
  }
  if (c.expect_company !== undefined) {
    checks.push([
      `company ~= ${c.expect_company}`,
      c.expect_company instanceof RegExp
        ? c.expect_company.test(out.company)
        : out.company === c.expect_company,
    ]);
  }
  if (c.expect_location !== undefined) {
    checks.push([
      `location ~= ${c.expect_location}`,
      c.expect_location instanceof RegExp
        ? c.expect_location.test(out.location)
        : out.location === c.expect_location,
    ]);
  }
  if (c.expect_description_includes) {
    checks.push([
      `description includes "${c.expect_description_includes}"`,
      out.job_description.toLowerCase().includes(c.expect_description_includes.toLowerCase()),
    ]);
  }
  if (c.expect_description_excludes) {
    for (const banned of c.expect_description_excludes) {
      checks.push([
        `description excludes "${banned}"`,
        !out.job_description.toLowerCase().includes(banned.toLowerCase()),
      ]);
    }
  }
  if (c.expect_technology_context_includes) {
    for (const term of c.expect_technology_context_includes) {
      const tech = (out.technology_context ?? "").toLowerCase();
      checks.push([
        `technology_context includes "${term}"`,
        tech.includes(term.toLowerCase()),
      ]);
    }
  }
  const allOk = checks.every(([, ok]) => ok);
  console.log(`${allOk ? "PASS" : "FAIL"}  ${c.name}`);
  if (!allOk) {
    failed += 1;
    for (const [label, ok] of checks) {
      if (!ok) console.log(`        FAIL  ${label}`);
    }
    console.log(`        got title       : ${JSON.stringify(out.job_title)}`);
    console.log(`        got company     : ${JSON.stringify(out.company)}`);
    console.log(`        got location    : ${JSON.stringify(out.location)}`);
    console.log(`        got tech_context: ${JSON.stringify((out.technology_context ?? "").slice(0, 240))}`);
    console.log(`        description    : ${out.job_description.slice(0, 240).replace(/\n/g, " | ")}`);
  }
}

// Schema rejects "neither URL nor pasted text".
const schemaEmpty = linkedinImportSchema.safeParse({});
const schemaBothEmpty = linkedinImportSchema.safeParse({ url: "", pasted_text: "" });
const schemaWithUrl = linkedinImportSchema.safeParse({ url: "https://linkedin.com/jobs/view/123" });
const schemaWithText = linkedinImportSchema.safeParse({ pasted_text: "Title\nCompany\nDescription" });
const schemaChecks: Array<[string, boolean]> = [
  ["schema rejects {} payload", !schemaEmpty.success],
  ["schema rejects { url: '', pasted_text: '' }", !schemaBothEmpty.success],
  ["schema accepts URL-only payload", schemaWithUrl.success],
  ["schema accepts pasted-text-only payload", schemaWithText.success],
];
const schemaOk = schemaChecks.every(([, ok]) => ok);
console.log(`${schemaOk ? "PASS" : "FAIL"}  zod schema accepts URL-only / pasted-only and rejects empty payloads`);
if (!schemaOk) {
  failed += 1;
  for (const [label, ok] of schemaChecks) {
    if (!ok) console.log(`        FAIL  ${label}`);
  }
}

// stripHtmlToText smoke check (used by JSON-LD path).
const stripped = stripHtmlToText(
  "<p>Hello <strong>world</strong></p><script>bad()</script><br/><li>Item</li>",
);
const stripCheck =
  stripped.includes("Hello") &&
  stripped.includes("world") &&
  stripped.includes("Item") &&
  !stripped.includes("bad()") &&
  !stripped.includes("<");
console.log(`${stripCheck ? "PASS" : "FAIL"}  stripHtmlToText drops tags, scripts, and entities`);
if (!stripCheck) {
  failed += 1;
  console.log(`        got: ${JSON.stringify(stripped)}`);
}

/* Direct cleaner unit checks: login form / CSS / cookie residue must be
 * stripped both before parsing (cleanPastedLinkedInText) and from any
 * description that the heuristic or AI path produces
 * (cleanLinkedInDescription). */
const cleanerCases: Array<[string, () => boolean, () => string]> = [
  [
    "cleanPastedLinkedInText drops 'Welcome back' login block",
    () => {
      const out = cleanPastedLinkedInText(
        "Welcome back\nEmail or phone\n***@gmail.com\nPassword\nShow\nForgot password?\nSign in\nor\nNew to LinkedIn?\nJoin now\n\nAlex Roqueta\nSenior Program Manager / Technical Director",
      );
      return (
        !/welcome back/i.test(out) &&
        !/email or phone/i.test(out) &&
        !/forgot password/i.test(out) &&
        !/sign in/i.test(out) &&
        !/new to linkedin/i.test(out) &&
        /Alex Roqueta/.test(out) &&
        /Senior Program Manager/i.test(out)
      );
    },
    () => cleanPastedLinkedInText("Welcome back\nEmail or phone\nAlex Roqueta"),
  ],
  [
    "cleanPastedLinkedInText drops CSS-class fragments and masked-star lines",
    () => {
      const out = cleanPastedLinkedInText(
        "artdeco-button artdeco-button--secondary\n.global-nav__nav { display: flex; }\n*****\nReal content",
      );
      return !/artdeco-button/.test(out) && !/global-nav/.test(out) && !/\*\*\*\*\*/.test(out) && /Real content/.test(out);
    },
    () => cleanPastedLinkedInText("artdeco-button artdeco-button--secondary\nReal content"),
  ],
  [
    "cleanLinkedInDescription strips chrome lines even when AI leaks them",
    () => {
      const out = cleanLinkedInDescription(
        "LinkedIn profile summary / current role\n\nWelcome back\nEmail or phone\nPassword\nProgram management across IoT and Cloud platforms.\nCookie Policy",
      );
      return (
        !/welcome back/i.test(out) &&
        !/email or phone/i.test(out) &&
        !/cookie policy/i.test(out) &&
        /Program management/i.test(out)
      );
    },
    () =>
      cleanLinkedInDescription(
        "Welcome back\nEmail or phone\nProgram management across IoT and Cloud platforms.",
      ),
  ],
];
for (const [name, check, debug] of cleanerCases) {
  const ok = check();
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failed += 1;
    console.log(`        got: ${JSON.stringify(debug())}`);
  }
}

/* =====================================================================
 * AI extraction path — exercises extractLinkedInJobWithAI with a mock
 * LLM injected via __setLlmFetcherForTests. The verification environment
 * MUST NOT make a live LLM call, so we stub the fetcher and assert that:
 *
 *   1. When the AI returns valid JSON with extra fields
 *      (technology_context, employment_type, seniority), those flow
 *      through to the result and source_engine is "ai".
 *   2. When the AI errors (network failure / bad status), the result
 *      falls back to the heuristic parser, source_engine is "heuristic",
 *      and ai_error is reported.
 *   3. When the AI returns malformed (non-JSON) output, the result
 *      falls back to the heuristic parser.
 *   4. No provider configured (and no mock) -> heuristic-only path.
 * ===================================================================== */

const AI_PASTED = `Easy Apply
Save
Senior Software Engineer
Acme Robotics Inc.
San Francisco, CA · Hybrid
300 applicants
Posted 2 days ago
About the job
We are looking for a Senior Software Engineer to join the platform team. You will design and ship large-scale distributed systems built on Go, Kubernetes, and PostgreSQL, mentor a small team, and partner with product on roadmap decisions.

Responsibilities
- Build and operate backend services in Go and TypeScript.
- Lead architecture for a high-throughput ingestion pipeline.
- Collaborate with product, design, and ML teams.

Requirements
- 7+ years of backend experience.
- Strong systems fundamentals.
- Experience with Kubernetes is a plus.

Show more
Report this job`;

async function runAiCase(
  name: string,
  fetcher: Parameters<typeof __setLlmFetcherForTests>[0],
  assert: (out: Awaited<ReturnType<typeof extractLinkedInJobWithAI>>) => Array<[string, boolean]>,
): Promise<void> {
  __setLlmFetcherForTests(fetcher);
  try {
    const out = await extractLinkedInJobWithAI(AI_PASTED, { timeoutMs: 5_000 });
    const checks = assert(out);
    const ok = checks.every(([, v]) => v);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) {
      failed += 1;
      for (const [label, v] of checks) {
        if (!v) console.log(`        FAIL  ${label}`);
      }
      console.log(`        got: ${JSON.stringify(out).slice(0, 400)}`);
    }
  } finally {
    __setLlmFetcherForTests(null);
  }
}

await runAiCase(
  "AI extraction populates extended fields (technology_context, employment_type, seniority)",
  async ({ prompt }) => {
    if (!prompt.includes("PASTED TEXT")) throw new Error("prompt missing PASTED TEXT marker");
    return JSON.stringify({
      job_title: "Senior Software Engineer",
      company: "Acme Robotics",
      location: "San Francisco, CA (Hybrid)",
      job_description:
        "Senior backend engineer role on the platform team. Build and operate backend services in Go and TypeScript. Lead architecture for a high-throughput ingestion pipeline. Collaborate with product, design, and ML teams.",
      technology_context:
        "Go, TypeScript, Kubernetes, PostgreSQL, distributed systems. AI assistants are commonly used for code review and documentation.",
      employment_type: "Full-time",
      seniority: "Senior",
    });
  },
  (out) => [
    ["source_engine is 'ai'", out.source_engine === "ai"],
    ["job_title matches", /Senior Software Engineer/.test(out.job_title)],
    ["company matches", /Acme Robotics/.test(out.company)],
    ["location matches", /San Francisco/.test(out.location)],
    [
      "job_description contains 'distributed' or 'Go'",
      /distributed|\bGo\b/.test(out.job_description),
    ],
    [
      "technology_context populated and mentions Kubernetes",
      Boolean(out.technology_context) && /Kubernetes/i.test(out.technology_context ?? ""),
    ],
    ["employment_type populated", out.employment_type === "Full-time"],
    ["seniority populated", out.seniority === "Senior"],
    ["no ai_error", !out.ai_error],
    [
      "ai populates more fields than heuristic-only",
      Boolean(out.technology_context) || Boolean(out.employment_type) || Boolean(out.seniority),
    ],
  ],
);

await runAiCase(
  "AI extraction errors -> falls back to heuristic parser",
  async () => {
    throw new Error("anthropic_http_500");
  },
  (out) => [
    ["source_engine is 'heuristic'", out.source_engine === "heuristic"],
    ["ai_error reported", typeof out.ai_error === "string" && out.ai_error.length > 0],
    ["heuristic still found a title", /Senior Software Engineer/.test(out.job_title)],
    ["heuristic still found a description", out.job_description.length > 40],
    // technology_context is now mined from the raw cleaned text as a
    // safety net, so on heuristic fallback it should contain whatever
    // tech vocab the paste mentioned (here: Go, TypeScript, Kubernetes).
    [
      "technology_context populated by raw-text safety net",
      typeof out.technology_context === "string" && out.technology_context.length > 0,
    ],
  ],
);

await runAiCase(
  "AI extraction returns malformed output -> falls back to heuristic parser",
  async () => "not even close to JSON, just prose from a confused model.",
  (out) => [
    ["source_engine is 'heuristic'", out.source_engine === "heuristic"],
    ["ai_error reports parse_failed", out.ai_error === "parse_failed"],
    ["heuristic title preserved", /Senior Software Engineer/.test(out.job_title)],
  ],
);

// No fetcher and no env keys -> heuristic-only path.
{
  __setLlmFetcherForTests(null);
  const originalKeys = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await extractLinkedInJobWithAI(AI_PASTED);
    const checks: Array<[string, boolean]> = [
      ["source_engine is 'heuristic'", out.source_engine === "heuristic"],
      ["no ai_error (no attempt was made)", !out.ai_error],
      ["heuristic title preserved", /Senior Software Engineer/.test(out.job_title)],
    ];
    const ok = checks.every(([, v]) => v);
    console.log(`${ok ? "PASS" : "FAIL"}  No LLM configured -> heuristic-only path`);
    if (!ok) {
      failed += 1;
      for (const [label, v] of checks) {
        if (!v) console.log(`        FAIL  ${label}`);
      }
    }
  } finally {
    for (const [k, v] of Object.entries(originalKeys)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  }
}

// Empty input -> heuristic short-circuit returns empty object, source_engine "heuristic".
{
  __setLlmFetcherForTests(async () => {
    throw new Error("should not be called for empty input");
  });
  try {
    const out = await extractLinkedInJobWithAI("");
    const ok =
      out.source_engine === "heuristic" &&
      out.job_title === "" &&
      out.job_description === "" &&
      !out.ai_error;
    console.log(`${ok ? "PASS" : "FAIL"}  Empty input short-circuits before calling the LLM`);
    if (!ok) {
      failed += 1;
      console.log(`        got: ${JSON.stringify(out)}`);
    }
  } finally {
    __setLlmFetcherForTests(null);
  }
}

/* =====================================================================
 * Final-gate / preview-detection assertions for the 2026-05 user report.
 *
 * Verifies that:
 *   - parseLinkedInJobText (full pipeline) on the logged-out preview
 *     paste returns NO chrome/CSS/asterisk garbage in any field.
 *   - title fallback fires when Experience block is missing.
 *   - technology_context includes >= 6 meaningful items including IoT,
 *     Cloud/Azure, Big Data/Predictive Analytics, Program Management.
 *   - sanitizeLinkedInShortField drops chrome values entirely.
 *   - finalizeLinkedInResult synthesizes a clean description when given
 *     a noisy one.
 *   - looksLikeLoggedOutPreview returns true on the preview input.
 * ===================================================================== */

{
  const out = parseLinkedInJobText(PROFILE_LOGGED_OUT_PREVIEW);
  const blob = [
    out.job_title,
    out.company,
    out.location,
    out.job_description,
    out.technology_context ?? "",
  ].join("\n");
  const forbiddenInAnyField = [
    "By clicking Continue to join or sign in",
    "Cookie Policy",
    "User Agreement",
    "*]:mb-0",
    "text-[18px]",
    "text-color-text",
    "group-hover:underline",
    "New to LinkedIn",
    "[&>*]",
    "leading-[1.75]",
    "*** * ***",
    "font-semibold",
  ];
  const finalChecks: Array<[string, boolean]> = [
    ["title is nonblank", Boolean(out.job_title && out.job_title.trim())],
    [
      "title matches current/headline value",
      /(Sr\.? Program Manager|Senior Program Manager|Sr\.? Technical Program Manager|Senior Program Manager \/ Technical Director|Senior Program Manager  Technical Director)/i.test(
        out.job_title,
      ),
    ],
    ["company is Smart Staffing Solutions", /Smart Staffing Solutions/i.test(out.company)],
    ...forbiddenInAnyField.map(
      (banned): [string, boolean] => [
        `no field contains "${banned}"`,
        !blob.toLowerCase().includes(banned.toLowerCase()),
      ],
    ),
    [
      "technology_context has 6+ items",
      (out.technology_context ?? "").split(",").map((s) => s.trim()).filter(Boolean).length >= 6,
    ],
    [
      "technology_context includes IoT",
      /\bIoT\b/i.test(out.technology_context ?? ""),
    ],
    [
      "technology_context includes Cloud or Azure",
      /\b(Cloud|Azure)\b/i.test(out.technology_context ?? ""),
    ],
    [
      "technology_context includes Big Data or Predictive Analytics",
      /(Big Data|Predictive Analytics)/i.test(out.technology_context ?? ""),
    ],
    [
      "technology_context includes Program Management or Technical Program Management",
      /(Technical Program Management|Program Management)/i.test(out.technology_context ?? ""),
    ],
  ];
  const ok = finalChecks.every(([, v]) => v);
  console.log(`${ok ? "PASS" : "FAIL"}  Logged-out preview paste — no chrome/CSS in any field, title + tech populated`);
  if (!ok) {
    failed += 1;
    for (const [label, v] of finalChecks) {
      if (!v) console.log(`        FAIL  ${label}`);
    }
    console.log(`        title      : ${JSON.stringify(out.job_title)}`);
    console.log(`        company    : ${JSON.stringify(out.company)}`);
    console.log(`        location   : ${JSON.stringify(out.location)}`);
    console.log(`        tech_ctx   : ${JSON.stringify((out.technology_context ?? "").slice(0, 280))}`);
    console.log(`        desc[:280] : ${out.job_description.slice(0, 280).replace(/\n/g, " | ")}`);
  }
}

{
  const cases: Array<[string, () => boolean]> = [
    [
      "sanitizeLinkedInShortField drops CSS-class residue",
      () =>
        sanitizeLinkedInShortField('*]:mb-0 text-[18px] text-color-text leading-regular font-semibold">') === "",
    ],
    [
      "sanitizeLinkedInShortField drops consent CTA phrase",
      () =>
        sanitizeLinkedInShortField(
          "By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement",
        ) === "",
    ],
    [
      "sanitizeLinkedInShortField drops 'Experience & Education' section label",
      () => sanitizeLinkedInShortField("Experience & Education") === "",
    ],
    [
      "sanitizeLinkedInShortField drops Cookie Policy bare line",
      () => sanitizeLinkedInShortField("Cookie Policy") === "",
    ],
    [
      "sanitizeLinkedInShortField keeps a real title",
      () => sanitizeLinkedInShortField("Sr. Program Manager") === "Sr. Program Manager",
    ],
  ];
  for (const [name, check] of cases) {
    const ok = check();
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }
}

{
  // finalizeLinkedInResult synthesizes a clean description when given
  // an empty/noisy one but valid header fields.
  const out = finalizeLinkedInResult(
    {
      job_title: "Sr. Program Manager",
      company: "Smart Staffing Solutions",
      location: "Corona, CA",
      job_description:
        "By clicking Continue to join or sign in, you agree to LinkedIn's User Agreement",
      technology_context: "IoT, Cloud, Azure, Big Data, Program Management, Customer Experience",
    },
    "heuristic",
  );
  const ok =
    out.job_title === "Sr. Program Manager" &&
    out.company === "Smart Staffing Solutions" &&
    out.job_description.length > 40 &&
    !/cookie policy|user agreement|by clicking continue/i.test(out.job_description) &&
    /Sr\.? Program Manager/i.test(out.job_description) &&
    /Smart Staffing Solutions/i.test(out.job_description);
  console.log(`${ok ? "PASS" : "FAIL"}  finalizeLinkedInResult synthesises a clean description from header fields`);
  if (!ok) {
    failed += 1;
    console.log(`        got: ${JSON.stringify(out)}`);
  }
}

{
  // looksLikeLoggedOutPreview should be true for the logged-out paste
  // when only a stub description was extracted.
  const preview = looksLikeLoggedOutPreview(PROFILE_LOGGED_OUT_PREVIEW, {
    source_engine: "heuristic",
    job_title: "Sr. Program Manager",
    company: "Smart Staffing Solutions",
    location: "Ladera Ranch, California",
    job_description: "LinkedIn profile summary / current role",
    technology_context: "IoT, Cloud",
  });
  const ok = preview === true;
  console.log(`${ok ? "PASS" : "FAIL"}  looksLikeLoggedOutPreview detects the user-reported preview paste`);
  if (!ok) failed += 1;
}

/* =====================================================================
 * Footer / language-selector regression (2026-05-16 user report).
 *
 * The user reported that Job Description was filled with LinkedIn footer
 * + language-selector residue, e.g. "Accessibility", "Your California
 * Privacy Choices", "Copyright Policy", "Brand Policy", "Guest Controls",
 * language names ("العربية (Arabic)", "Deutsch", "Español", ...), and
 * Tailwind class fragments like py-4 / rounded-md.
 *
 * The parser must:
 *   1. Strip all of this chrome from any field.
 *   2. Either return an empty description or a short safe synthesised
 *      sentence; NEVER let footer/legal/language-selector noise become
 *      the Job Description.
 *   3. Still extract a rich technology_context when About / Specialties
 *      content is present anywhere in the paste.
 * ===================================================================== */

const PROFILE_FOOTER_LANGUAGE_SELECTOR = `LinkedIn profile summary / current role
About:
Accessibility
Your California Privacy Choices
Copyright Policy
Brand Policy
Guest Controls
language-selector__link !font-regular" data-tracking-control-name="language-selector-ar_AE" data-locale="ar_AE" role="menuitem" lang="ar_AE">
العربية (Arabic)
language-selector__link !font-regular" data-tracking-control-name="language-selector-bn_IN" data-locale="bn_IN" role="menuitem" lang="bn_IN">
বাংলা (Bangla)
language-selector__link !font-regular" data-tracking-control-name="language-selector-cs_CZ" data-locale="cs_CZ" role="menuitem" lang="cs_CZ">
čeština (Czech)
language-selector__link !font-regular" data-tracking-control-name="language-selector-da_DK" data-locale="da_DK" role="menuitem" lang="da_DK">
Dansk (Danish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-de_DE" data-locale="de_DE" role="menuitem" lang="de_DE">
Deutsch (German)
language-selector__link !font-regular" data-tracking-control-name="language-selector-el_GR" data-locale="el_GR" role="menuitem" lang="el_GR">
ελληνικά (Greek)
language-selector__link !font-regular" data-tracking-control-name="language-selector-en_US" data-locale="en_US" role="menuitem" lang="en_US">
English (English)
language-selector__link !font-regular" data-tracking-control-name="language-selector-es_ES" data-locale="es_ES" role="menuitem" lang="es_ES">
Español (Spanish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-fa_IR" data-locale="fa_IR" role="menuitem" lang="fa_IR">
فارسی (Persian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-fi_FI" data-locale="fi_FI" role="menuitem" lang="fi_FI">
Suomi (Finnish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-fr_FR" data-locale="fr_FR" role="menuitem" lang="fr_FR">
Français (French)
language-selector__link !font-regular" data-tracking-control-name="language-selector-hi_IN" data-locale="hi_IN" role="menuitem" lang="hi_IN">
हिंदी (Hindi)
language-selector__link !font-regular" data-tracking-control-name="language-selector-hu_HU" data-locale="hu_HU" role="menuitem" lang="hu_HU">
Magyar (Hungarian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-id_ID" data-locale="id_ID" role="menuitem" lang="id_ID">
Bahasa Indonesia (Indonesian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-it_IT" data-locale="it_IT" role="menuitem" lang="it_IT">
Italiano (Italian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-iw_IL" data-locale="iw_IL" role="menuitem" lang="iw_IL">
עברית (Hebrew)
language-selector__link !font-regular" data-tracking-control-name="language-selector-ja_JP" data-locale="ja_JP" role="menuitem" lang="ja_JP">
日本語 (Japanese)
language-selector__link !font-regular" data-tracking-control-name="language-selector-ko_KR" data-locale="ko_KR" role="menuitem" lang="ko_KR">
한국어 (Korean)
language-selector__link !font-regular" data-tracking-control-name="language-selector-mr_IN" data-locale="mr_IN" role="menuitem" lang="mr_IN">
मराठी (Marathi)
language-selector__link !font-regular" data-tracking-control-name="language-selector-ms_MY" data-locale="ms_MY" role="menuitem" lang="ms_MY">
Bahasa Malaysia (Malay)
language-selector__link !font-regular" data-tracking-control-name="language-selector-nl_NL" data-locale="nl_NL" role="menuitem" lang="nl_NL">
Nederlands (Dutch)
language-selector__link !font-regular" data-tracking-control-name="language-selector-no_NO" data-locale="no_NO" role="menuitem" lang="no_NO">
Norsk (Norwegian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-pa_IN" data-locale="pa_IN" role="menuitem" lang="pa_IN">
ਪੰਜਾਬੀ (Punjabi)
language-selector__link !font-regular" data-tracking-control-name="language-selector-pl_PL" data-locale="pl_PL" role="menuitem" lang="pl_PL">
Polski (Polish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-pt_BR" data-locale="pt_BR" role="menuitem" lang="pt_BR">
Português (Portuguese)
language-selector__link !font-regular" data-tracking-control-name="language-selector-ro_RO" data-locale="ro_RO" role="menuitem" lang="ro_RO">
Română (Romanian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-ru_RU" data-locale="ru_RU" role="menuitem" lang="ru_RU">
Русский (Russian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-sv_SE" data-locale="sv_SE" role="menuitem" lang="sv_SE">
Svenska (Swedish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-te_IN" data-locale="te_IN" role="menuitem" lang="te_IN">
తెలుగు (Telugu)
language-selector__link !font-regular" data-tracking-control-name="language-selector-th_TH" data-locale="th_TH" role="menuitem" lang="th_TH">
ภาษาไทย (Thai)
language-selector__link !font-regular" data-tracking-control-name="language-selector-tl_PH" data-locale="tl_PH" role="menuitem" lang="tl_PH">
Tagalog (Tagalog)
language-selector__link !font-regular" data-tracking-control-name="language-selector-tr_TR" data-locale="tr_TR" role="menuitem" lang="tr_TR">
Türkçe (Turkish)
language-selector__link !font-regular" data-tracking-control-name="language-selector-uk_UA" data-locale="uk_UA" role="menuitem" lang="uk_UA">
українська (Ukrainian)
language-selector__link !font-regular" data-tracking-control-name="language-selector-vi_VN" data-locale="vi_VN" role="menuitem" lang="vi_VN">
Tiếng Việt (Vietnamese)
language-selector__link !font-regular" data-tracking-control-name="language-selector-zh_CN" data-locale="zh_CN" role="menuitem" lang="zh_CN">
简体中文 (Chinese (Simplified))
language-selector__link !font-regular" data-tracking-control-name="language-selector-zh_TW" data-locale="zh_TW" role="menuitem" lang="zh_TW">
正體中文 (Chinese (Traditional))
py-4
" aria-hidden="true">
rounded-md">
Alex can help you find your next opportunity`;

/* The same kind of paste, but with real About / Specialties / current
 * Experience content interleaved with the footer / language-selector
 * noise. The parser must keep the tech context AND scrub all the chrome
 * from the description. */
const PROFILE_FOOTER_PLUS_REAL_ABOUT = `Alex Roqueta
Senior Program Manager / Technical Director
Ladera Ranch, California, United States · Contact info

About
Senior Technical Program Manager and Director with 15+ years driving large-scale technical programs across IoT, Cloud, CRM, and Big Data platforms. I partner with cross-functional teams to deliver new product development end-to-end. Comfortable in Azure, SQL, SSRS, SAP Crystal Reports, Jira, and Confluence-driven Agile environments. Passionate about customer experience and predictive analytics.

Specialties
Technical Program Management, IoT, CRM, Cloud, New Product Development, Big Data, Predictive Analytics, BI, Customer Experience, Product Development, Business Systems, Program Management

Experience
Sr. Program Manager
Smart Staffing Solutions · Contract
Jan 2020 - Present · 6 yrs 4 mos
Corona, CA
- Lead cross-functional technical programs across IoT and Cloud platforms.
- Manage roadmaps in Jira and Confluence, partnering with engineering, product, and customer success.
- Built BI dashboards in SSRS and SAP Crystal Reports for executive reporting.
- Drove predictive analytics initiatives using Azure ML and SQL.

Accessibility
Your California Privacy Choices
Copyright Policy
Brand Policy
Guest Controls
language-selector__link !font-regular" data-tracking-control-name="language-selector-ar_AE" data-locale="ar_AE" role="menuitem" lang="ar_AE">
العربية (Arabic)
language-selector__link !font-regular" data-tracking-control-name="language-selector-de_DE" data-locale="de_DE" role="menuitem" lang="de_DE">
Deutsch (German)
language-selector__link !font-regular" data-tracking-control-name="language-selector-es_ES" data-locale="es_ES" role="menuitem" lang="es_ES">
Español (Spanish)
py-4
" aria-hidden="true">
rounded-md">
Alex can help you find your next opportunity`;

/* Title + company only — no real About / Experience block. The parser
 * should still allow title/company to fill, but description must remain
 * blank or a safe synthesised one-liner; never the footer noise. */
const PROFILE_FOOTER_TITLE_COMPANY_ONLY = `Alex Roqueta
Sr. Program Manager
Smart Staffing Solutions

Accessibility
Your California Privacy Choices
Copyright Policy
Brand Policy
Guest Controls
language-selector__link !font-regular" data-tracking-control-name="language-selector-fr_FR" data-locale="fr_FR" role="menuitem" lang="fr_FR">
Français (French)
language-selector__link !font-regular" data-tracking-control-name="language-selector-de_DE" data-locale="de_DE" role="menuitem" lang="de_DE">
Deutsch (German)
py-4
" aria-hidden="true">
rounded-md">
Alex can help you find your next opportunity`;

const FOOTER_BANNED_FRAGMENTS = [
  "Accessibility",
  "Your California Privacy Choices",
  "California Privacy",
  "Copyright Policy",
  "Brand Policy",
  "Guest Controls",
  "language-selector",
  "data-tracking-control-name",
  "data-locale",
  'role="menuitem"',
  "العربية",
  "Arabic",
  "Deutsch",
  "Español",
  "Français",
  "py-4",
  "rounded-md",
  "aria-hidden",
  "Alex can help you find your next opportunity",
];

function assertNoFooterFragments(label: string, blob: string): void {
  for (const banned of FOOTER_BANNED_FRAGMENTS) {
    const ok = !blob.toLowerCase().includes(banned.toLowerCase());
    console.log(`${ok ? "PASS" : "FAIL"}  ${label} — no "${banned}"`);
    if (!ok) {
      failed += 1;
    }
  }
}

{
  // Case 1: footer/language-selector-only paste. Description must NOT
  // contain any chrome, and should either be blank or a clean synth.
  const out = parseLinkedInJobText(PROFILE_FOOTER_LANGUAGE_SELECTOR);
  const blob = [
    out.job_title,
    out.company,
    out.location,
    out.job_description,
    out.technology_context ?? "",
  ].join("\n");
  assertNoFooterFragments(
    "footer/language-selector-only paste — fields",
    blob,
  );
  const descOk =
    out.job_description === "" ||
    /^LinkedIn profile summary \/ current role/i.test(out.job_description);
  console.log(
    `${descOk ? "PASS" : "FAIL"}  footer/language-selector-only paste — description is blank or safe synth`,
  );
  if (!descOk) {
    failed += 1;
    console.log(`        got desc: ${JSON.stringify(out.job_description.slice(0, 280))}`);
  }
  const gate = descriptionPassesQualityGate(out.job_description);
  console.log(
    `${!gate ? "PASS" : "FAIL"}  footer/language-selector-only paste — quality gate REJECTS the description`,
  );
  if (gate) failed += 1;
}

{
  // Case 2: footer noise + real About / Specialties / current Experience.
  // Description must be clean (no chrome) AND technology_context must
  // include the rich set of terms.
  const out = parseLinkedInJobText(PROFILE_FOOTER_PLUS_REAL_ABOUT);
  const blob = [
    out.job_title,
    out.company,
    out.location,
    out.job_description,
    out.technology_context ?? "",
  ].join("\n");
  assertNoFooterFragments(
    "footer + real About — fields",
    blob,
  );
  const titleOk = /(Sr\.? Program Manager|Senior Program Manager|Senior Technical Program Manager)/i.test(
    out.job_title,
  );
  console.log(`${titleOk ? "PASS" : "FAIL"}  footer + real About — title populated`);
  if (!titleOk) failed += 1;
  const companyOk = /Smart Staffing Solutions/i.test(out.company);
  console.log(`${companyOk ? "PASS" : "FAIL"}  footer + real About — company populated`);
  if (!companyOk) failed += 1;
  const tech = (out.technology_context ?? "");
  const techExpected = [
    "Technical Program Management",
    "IoT",
    "CRM",
    "Cloud",
    "Azure",
    "Big Data",
    "Predictive Analytics",
    "BI",
    "SQL",
    "Jira",
    "Confluence",
    "Customer Experience",
    "Business Systems",
    "Program Management",
    "Product Development",
  ];
  let techHits = 0;
  for (const t of techExpected) {
    if (tech.toLowerCase().includes(t.toLowerCase())) techHits += 1;
  }
  const techRichEnough = techHits >= 8;
  console.log(
    `${techRichEnough ? "PASS" : "FAIL"}  footer + real About — technology_context is rich (${techHits}/${techExpected.length})`,
  );
  if (!techRichEnough) {
    failed += 1;
    console.log(`        got tech: ${JSON.stringify(tech.slice(0, 320))}`);
  }
}

{
  // Case 3: title + company only — description must NOT be footer noise.
  // Use the full route pipeline (extractLinkedInJobWithAI → finalize)
  // since that's the user-facing path the quality gate runs on.
  __setLlmFetcherForTests(null);
  // Drop any provider env keys so we exercise the heuristic-only path.
  const originalKeys = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let out: Awaited<ReturnType<typeof extractLinkedInJobWithAI>>;
  try {
    out = await extractLinkedInJobWithAI(PROFILE_FOOTER_TITLE_COMPANY_ONLY);
  } finally {
    for (const [k, v] of Object.entries(originalKeys)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  }
  const blob = [
    out.job_title,
    out.company,
    out.location,
    out.job_description,
    out.technology_context ?? "",
  ].join("\n");
  assertNoFooterFragments(
    "title+company only — fields",
    blob,
  );
  // Description must be blank or a safe synth header line — never the
  // footer noise.
  const descOk =
    out.job_description === "" ||
    /^LinkedIn profile summary \/ current role/i.test(out.job_description);
  console.log(
    `${descOk ? "PASS" : "FAIL"}  title+company only — description is blank or safe synth`,
  );
  if (!descOk) {
    failed += 1;
    console.log(`        got desc: ${JSON.stringify(out.job_description.slice(0, 280))}`);
  }
  // Title and company may flow through, OR be blank — but if filled,
  // they must not be footer fragments (covered by the no-fragments
  // assertions above).
  const titleOk =
    out.job_title === "" ||
    /(Sr\.? Program Manager|Senior Program Manager|Alex Roqueta)/i.test(out.job_title);
  console.log(`${titleOk ? "PASS" : "FAIL"}  title+company only — title is blank or clean`);
  if (!titleOk) failed += 1;
  const companyOk =
    out.company === "" ||
    /(Smart Staffing Solutions|Sr\.? Program Manager)/i.test(out.company);
  console.log(`${companyOk ? "PASS" : "FAIL"}  title+company only — company is blank or clean`);
  if (!companyOk) failed += 1;
}

{
  // Quality gate unit tests.
  const gateCases: Array<[string, string, boolean]> = [
    [
      "real About paragraph passes the gate",
      "About the role: Senior Program Manager responsible for cross-functional technical programs across IoT and Cloud platforms. Drives roadmap delivery with engineering, product, and customer success partners.",
      true,
    ],
    [
      "footer-only blob fails the gate",
      "Accessibility\nYour California Privacy Choices\nCopyright Policy\nBrand Policy\nGuest Controls\nlanguage-selector\nDeutsch\nEspañol\npy-4\nrounded-md",
      false,
    ],
    [
      "empty input fails the gate",
      "",
      false,
    ],
    [
      "short two-word blob fails the gate",
      "Senior Engineer",
      false,
    ],
  ];
  for (const [name, input, expected] of gateCases) {
    const got = descriptionPassesQualityGate(input);
    const ok = got === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  quality gate — ${name}`);
    if (!ok) {
      failed += 1;
      console.log(`        expected ${expected}, got ${got}`);
    }
  }
}

{
  // extractTechnologyContextFromRawText surfaces tech vocabulary even
  // when the description is going to be discarded by the gate.
  const tc = extractTechnologyContextFromRawText(
    "About: I drive IoT, Cloud, CRM, and Big Data programs in Azure with Jira and Confluence. Predictive Analytics. SAP Crystal Reports. Technical Program Management.",
  );
  const ok = /IoT/i.test(tc) && /Cloud/i.test(tc) && /Azure/i.test(tc) && /Jira/i.test(tc) && /Technical Program Management/i.test(tc);
  console.log(`${ok ? "PASS" : "FAIL"}  extractTechnologyContextFromRawText finds tech in a free-form blurb`);
  if (!ok) {
    failed += 1;
    console.log(`        got: ${JSON.stringify(tc)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll LinkedIn import verification cases passed.`);
