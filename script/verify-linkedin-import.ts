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
import { parseLinkedInJobText, stripHtmlToText } from "../server/ai";
import { linkedinImportSchema } from "../shared/schema";

type Case = {
  name: string;
  input: string;
  expect_title?: string | RegExp;
  expect_company?: string | RegExp;
  expect_location?: string | RegExp;
  expect_description_includes?: string;
  expect_description_excludes?: string[];
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

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll LinkedIn import verification cases passed.`);
