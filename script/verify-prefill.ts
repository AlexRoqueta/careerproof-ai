/* Verification script for resume title extraction.
 *
 * Run with:  npx tsx script/verify-prefill.ts
 *
 * Asserts that prefillFromResumeText returns the expected job_title for
 * every canonical resume scenario the app supports. Each case represents
 * a real resume the user has reported as broken or important.
 */
import { prefillFromResumeText } from "../server/ai";

type Case = {
  name: string;
  filename: string;
  body: string;
  expect_title: string | RegExp;
  expect_description_includes?: string;
};

const cases: Case[] = [
  {
    name: "AlexRoquetaResume.pdf preserves multi-part Sr. Program Manager title",
    filename: "AlexRoquetaResume.pdf",
    body: `ALEX ROQUETA
Sr. Program Manager | Technology Operations | Cloud Solutions | IoT
Development
E 949 233-9090     roqueta.alex@gmail.com linkedin.com/in/roqueta   8 Potters Bnd, Ladera Ranch
EXPERIENCE                                                                     SUMMARY
Sr. Program Manager                                                            Accomplished Technical Program Manager with`,
    expect_title: /Sr\. Program Manager \| Technology Operations \| Cloud Solutions \| IoT Development/,
    expect_description_includes: "technology operations",
  },
  {
    name: "Heart_Surgeon_Resume.pdf with generic fallback body resolves from filename",
    filename: "Heart_Surgeon_Resume.pdf",
    body: `Senior Professional with multi-year experience across product, technology, and client-facing roles.
Selected Experience`,
    expect_title: "Heart Surgeon",
    expect_description_includes: "cardiac",
  },
  {
    name: "Heart Surgeon resume with strong header preserved",
    filename: "Heart_Surgeon_Resume.pdf",
    body: `JANE DOE, MD
Heart Surgeon — Cardiothoracic
Hospital`,
    expect_title: /Heart Surgeon/i,
    expect_description_includes: "cardiac",
  },
  {
    name: "Sewer_Worker_Sample_Resume.pdf resolves to Sewer Worker",
    filename: "Sewer_Worker_Sample_Resume.pdf",
    body: `Senior Professional with multi-year experience across product, technology, and client-facing roles.`,
    expect_title: "Sewer Worker",
    expect_description_includes: "sewer",
  },
  {
    name: "professional_companion_resume.pdf resolves to Professional Companion (no .pdf leak)",
    filename: "professional_companion_resume.pdf",
    body: `Senior Professional with multi-year experience.`,
    expect_title: "Professional Companion",
    expect_description_includes: "companionship",
  },
  {
    name: "Modern nursing resume header keeps Registered Nurse",
    filename: "Modern nursing resume.pdf",
    body: `KRISTI LAAR
REGISTERED NURSE
CONTACT
111 1st Avenue
Redmond, WA`,
    expect_title: /Registered Nurse/i,
    expect_description_includes: "nursing",
  },
  {
    name: "Nursing filename only also resolves to a nursing role",
    filename: "Modern nursing resume.pdf",
    body: `Senior Professional with multi-year experience.`,
    expect_title: /Nurse/,
    expect_description_includes: "nursing",
  },
  {
    name: "First_Grade_Teacher_Resume.pdf resolves to First Grade Teacher",
    filename: "First_Grade_Teacher_Resume.pdf",
    body: `MARY SMITH\nFirst Grade Teacher\nElementary School`,
    expect_title: /First Grade Teacher|Teacher/,
  },
  {
    name: "Paralegal resume resolves correctly",
    filename: "Paralegal resume.pdf",
    body: `JANE DOE\nParalegal\nLaw Firm`,
    expect_title: "Paralegal",
  },
  {
    name: "Graphic designer header is preserved",
    filename: "Color block resume.pdf",
    body: `Graphic Designer\nIAN HANSSON\nUI/UX Engineer\nDeveloper`,
    expect_title: /Graphic Designer|UX Designer/,
  },
];

let failed = 0;
for (const c of cases) {
  const source = `${c.filename}\n${c.body}`;
  const out = prefillFromResumeText(source);
  const titleOk =
    c.expect_title instanceof RegExp
      ? c.expect_title.test(out.job_title)
      : out.job_title === c.expect_title;
  const descOk =
    !c.expect_description_includes ||
    out.job_description.toLowerCase().includes(c.expect_description_includes.toLowerCase());

  const ok = titleOk && descOk;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    failed += 1;
    console.log(`        got title       : ${JSON.stringify(out.job_title)}`);
    console.log(`        expected title  : ${c.expect_title}`);
    if (c.expect_description_includes) {
      console.log(`        description     : ${out.job_description.slice(0, 140)}...`);
      console.log(`        wanted substr   : ${c.expect_description_includes}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} verification cases passed.`);
