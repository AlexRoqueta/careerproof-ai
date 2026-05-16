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
    ["technology_context empty on fallback", !out.technology_context],
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

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll LinkedIn import verification cases passed.`);
