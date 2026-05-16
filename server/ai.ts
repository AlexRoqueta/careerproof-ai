/* =====================================================================
 * Mock AI provider — replace with real LLM call (OpenAI/Anthropic/etc).
 *
 * Boundary: this module is the ONLY place that fakes LLM output. The
 * rest of the backend treats it as a black box. To wire a real provider,
 * keep these function signatures and replace the body with the SDK call.
 * ===================================================================== */

export type AutomationRisk = "High" | "Medium" | "Low";

export interface AnalysisOutput {
  result_text: string;
  automation_risk: AutomationRisk;
  risk_score: number; // 1-100
  provider_used: string;
}

/* ---- Helpers ---- */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function riskFromTitle(title: string): { score: number; risk: AutomationRisk } {
  const t = title.toLowerCase();
  // High-automation indicators
  const high = [
    "data entry",
    "transcription",
    "bookkeep",
    "telemarket",
    "cashier",
    "translator",
    "proofread",
    "copy editor",
    "paralegal",
  ];
  // Low-automation indicators (high-touch, judgment-heavy, physical)
  const low = [
    "therap",
    "social worker",
    "surgeon",
    "nurse",
    "teacher",
    "electrician",
    "plumber",
    "firefighter",
    "designer",
    "founder",
    "strateg",
  ];
  if (high.some((k) => t.includes(k))) {
    const score = 72 + (hashStr(t) % 22); // 72-93
    return { score, risk: score >= 70 ? "High" : "Medium" };
  }
  if (low.some((k) => t.includes(k))) {
    const score = 12 + (hashStr(t) % 22); // 12-33
    return { score, risk: score >= 35 ? "Medium" : "Low" };
  }
  // Default: middle band, varies by title
  const score = 38 + (hashStr(t) % 32); // 38-69
  let risk: AutomationRisk = "Medium";
  if (score >= 70) risk = "High";
  else if (score < 35) risk = "Low";
  return { score, risk };
}

export function toTitleCase(value: string | null | undefined): string {
  if (!value) return "";
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "vs", "via", "with"]);
  const acronyms = new Set(["ai", "api", "cfo", "cio", "coo", "cto", "hr", "it", "qa", "seo", "ui", "ux"]);
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word, index, words) =>
      word
        .split(/([-/])/)
        .map((part) => {
          if (part === "-" || part === "/") return part;
          const cleaned = part.toLowerCase();
          if (acronyms.has(cleaned)) return cleaned.toUpperCase();
          if (index > 0 && index < words.length - 1 && smallWords.has(cleaned)) return cleaned;
          return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        })
        .join("")
    )
    .join(" ");
}

/* =====================================================================
 * Role-specific "Current AI Impact on This Profession" copy.
 *
 * Returned as a multi-paragraph string (the markdown formatter wraps
 * it in a section). Each entry describes how AI is *already* being
 * used in / against this profession today — actual tools, observed
 * disruption, current limits — rather than the 3-5 year horizon
 * covered elsewhere in the report.
 *
 * Matching is keyword-based against the title; falls back to a generic
 * paragraph that still references the user's description so the section
 * is never empty or visibly templated.
 * ===================================================================== */
function currentAiImpactForRole(title: string, description: string): string {
  const t = title.toLowerCase();
  const descSnippet =
    description.length > 220 ? `${description.slice(0, 217).trimEnd()}...` : description;

  type RoleEntry = { keywords: RegExp; copy: string };
  const roles: RoleEntry[] = [
    {
      keywords: /heart surgeon|cardiac surgeon|cardiothoracic|cardiovascular surgeon|surgeon/,
      copy: `Today, AI is already embedded around surgical practice — but rarely *in* the surgeon's hands at the moment of cutting. Imaging models (FDA-cleared cardiac MRI/CT triage tools, echocardiogram analyzers) flag findings before you see the scan, and large language models summarize charts, draft op notes, and pre-fill discharge summaries.\n\nRobotic-assist platforms (da Vinci, Hugo, robotic CABG / TAVR rigs) are *operator-controlled*, not autonomous; current AI in the OR is decision-support and visualization, not action. Hospitals are deploying ambient scribes that listen to pre-op consults and clinic visits and write the note for you.\n\nThe practical effect on a surgeon today is mostly *administrative time recovered*: less charting, faster pre-read of imaging, faster literature review. Operative judgment, manual skill, and accountability for the patient remain entirely human. Where AI is changing the role *right now* is at the edges — triage, documentation, and patient communication — not at the table.`,
    },
    {
      keywords: /registered nurse|\brn\b|licensed practical nurse|\blpn\b|nurse|nursing/,
      copy: `AI is already in the nursing workflow today — most visibly in the EHR. Ambient documentation tools (Epic + Microsoft DAX, Abridge, Suki) listen to bedside interactions and draft notes; predictive deterioration models (Epic Sepsis, eCART) surface early-warning scores in the chart; medication-reconciliation copilots flag interactions before you scan.\n\nStaffing tools use ML to forecast census and acuity, which has changed how units schedule and float. Patient-facing chatbots increasingly triage non-urgent questions before they reach the nurse line. None of this replaces bedside assessment, IV starts, advocacy, family education, or end-of-life conversations — all of which remain human-only.\n\nThe immediate impact for nurses today is *cognitive load reduction* on documentation and surveillance, plus more (sometimes noisier) algorithmic alerts to vet. The role's center of gravity — clinical judgment at the bedside — is unchanged.`,
    },
    {
      keywords: /paralegal|legal assistant|litigation assistant/,
      copy: `Paralegal work is one of the most visibly AI-affected white-collar roles right now. Document review platforms (Relativity aiR, Everlaw, DISCO) use LLMs to first-pass discovery; legal research tools (Lexis+ AI, Westlaw Precision AI, Harvey, Hebbia) draft memos and cite-check; contract analyzers (Ironclad, Spellbook) summarize and redline.\n\nLaw firms have publicly reported routine drafting (NDAs, demand letters, deposition summaries, privilege logs) taking a fraction of prior time. ABA and bar surveys show partners increasingly expecting AI-assisted output. Hallucinated citations have produced sanctions, so verification has become a core paralegal skill rather than disappearing.\n\nThe near-term reality is *task compression*, not headcount-to-zero: high-volume, structured tasks (intake, document indexing, citation formatting, first-draft memos) are now AI-first; matter management, court-rules compliance, client handling, and procedural accountability are still paralegal-led.`,
    },
    {
      keywords: /software engineer|software developer|developer|programmer/,
      copy: `Software engineering is the most AI-saturated knowledge role in 2024-2025. GitHub Copilot, Cursor, Claude Code, Codeium, and Amazon Q are now default tooling at most companies; surveys (Stack Overflow Developer Survey, GitHub) report 60-80% regular use among professional developers.\n\nLLMs reliably handle scaffolding, test generation, refactors, documentation, and routine bug-fixing. Agentic coding tools (Devin, Cursor's agent mode, Claude Code) now complete multi-file tasks end-to-end on small/medium scopes. The market signal is loud: junior hiring has softened at several large employers who cite AI productivity, while senior engineers who *direct* AI report 2-5× throughput.\n\nWhat remains human-led today: system design under ambiguity, debugging at the architecture or distributed-systems layer, security reasoning, code review, and the judgment to reject confident-but-wrong AI output. The shift right now is from \"writing code\" to \"specifying and verifying code.\"`,
    },
    {
      keywords: /data analyst|business analyst|business intelligence/,
      copy: `For analysts, the impact is *already here* and very visible. Natural-language-to-SQL is mainstream (Snowflake Cortex, ThoughtSpot Sage, Tableau Pulse/Agent, Hex Magic, Mode AI), and most major BI vendors ship a chat-with-your-data feature. Excel Copilot writes formulas and summarizes ranges. LLMs draft executive narratives over dashboards.\n\nThe practical effect today: ad-hoc \"can you pull X?\" requests increasingly self-serve, dashboards get authored faster, and first-draft insights are LLM-generated. Hallucination risk on numbers is real, so analysts now spend more time on data-quality checks, metric definitions, and reviewing AI-drafted narratives.\n\nThe role's surviving moat is *framing* — knowing which question to ask, what \"good\" looks like, where the data is wrong, and how to influence a decision. Pure SQL-monkey work is the part being compressed fastest.`,
    },
    {
      keywords: /accountant|bookkeeper|controller|auditor/,
      copy: `Accounting and bookkeeping are seeing very direct AI deployment today. Categorization, reconciliation, and AP/AR ingestion are increasingly automated (QuickBooks AI, Xero, Ramp, Bill.com, Brex). Audit firms (Big Four + mid-tier) are publicly piloting LLM-assisted workpaper review, sampling, and disclosure drafting. SAP Joule and Microsoft Copilot for Finance draft variance commentary and close narratives.\n\nThe directly observable effect: bookkeeping-only roles have softened in BLS and accounting-association data, while *advisory* and *controllership* work is growing — the gap is judgment, anomaly investigation, and client communication. Tax season workflows are increasingly AI-first on document intake.\n\nWhat is not yet AI-led today: GAAP/IFRS judgment, complex transactions, audit opinion sign-off, and regulator-facing accountability. The role is bifurcating into \"automated transactional\" and \"advisory + judgment\" tracks now, not in five years.`,
    },
    {
      keywords: /teacher|educator|instructor|professor/,
      copy: `For teachers, the largest immediate AI impact is on *students*, not directly on the teacher's job — but it's reshaping the work anyway. Students use ChatGPT, Claude, and Gemini for homework, essays, and study help at scale; districts and schools have rewritten assignment design, assessment formats, and academic-integrity policy in response.\n\nTeachers themselves are adopting AI for lesson planning (MagicSchool, Diffit, Khanmigo), differentiation, IEP drafting, feedback on student writing, and parent communication. Grading copilots are emerging but still trust-limited. None of this replaces classroom management, relationship-building, or pedagogical judgment about *this specific class* on *this specific day*.\n\nThe practical shift right now is workload (planning + feedback time falling) and *what is being taught* (more emphasis on process, sourcing, critical evaluation, and AI literacy). Headcount impact has been minimal so far; role redefinition has been substantial.`,
    },
    {
      keywords: /graphic designer|ux designer|ui designer|ui\/ux|designer/,
      copy: `Designers are operating in the most visibly disrupted creative field today. Generative image tools (Midjourney, DALL·E 3, Imagen, Adobe Firefly) handle moodboards, concepting, stock-style imagery, and quick comps. Figma AI, Galileo, Uizard, and v0 generate UI scaffolds from prompts. Adobe Photoshop's Generative Fill and Illustrator's vectorization have shipped to millions.\n\nFreelance marketplaces report price compression on commodity assets (icons, simple illustrations, basic ads). At the same time, brand systems, design-research-led work, motion design at a high bar, and AI-art-direction skill are gaining value. Inside companies, design teams are doing *more output with the same headcount* rather than shrinking outright.\n\nWhat AI cannot do well today: hold a coherent brand voice across many touchpoints, resolve real product trade-offs, run user research, or take accountability for shipped craft. The role is shifting from \"making the pixels\" toward \"directing the system that makes the pixels.\"`,
    },
    {
      keywords: /program manager|project manager|scrum master|technical program/,
      copy: `For program/project managers, AI is now part of the daily toolchain. Meeting copilots (Zoom AI Companion, Microsoft Copilot, Otter, Fireflies, Granola) transcribe, summarize, and extract action items. Jira/Linear AI drafts tickets, status updates, and risk summaries. ChatGPT and Claude draft stakeholder updates, exec briefs, and post-mortems.\n\nThe immediate effect is *meeting-and-status-update compression*: the documentation tax on a PM is dropping fast. Cross-functional facilitation, escalation handling, prioritization under conflicting incentives, and political navigation are unchanged — and arguably more valuable, because more orgs now expect senior PMs to *direct AI-augmented teams* rather than just track Jira.\n\nThe risk today is real but uneven: pure status-relay PM work is being squeezed, while ambiguity-resolving, judgment-heavy program leadership is gaining leverage.`,
    },
    {
      keywords: /sales representative|sales rep|account executive|business development|\bsales\b/,
      copy: `Sales orgs are deploying AI aggressively right now. Outbound is dominated by AI-assisted prospecting (Apollo, Clay, Outreach AI, Salesloft Rhythm), email drafting, and CRM auto-fill. Call recording tools (Gong, Chorus, Avoma) score calls, surface coaching, and draft follow-ups. AI SDR products attempt fully autonomous top-of-funnel.\n\nThe visible effect: outbound volume has exploded (and deliverability has suffered), so buyers are more skeptical; quota attainment data shows top reps using AI well are outpacing peers; pure SDR roles are under pressure at multiple public companies. CRM hygiene tasks are increasingly automated end-to-end.\n\nWhat AI hasn't taken: discovery in complex deals, executive trust-building, multi-threading enterprise accounts, negotiation, and judgment on which deals to walk away from. The shape of the role is shifting from \"activity volume\" toward \"orchestrating AI-augmented pipeline with high-trust seller moments.\"`,
    },
    {
      keywords: /restaurant manager|chef|cook|culinary/,
      copy: `In restaurant operations and culinary work, AI is mostly back-of-house and behind-the-scenes today. Scheduling and labor forecasting (7shifts, Homebase, Crunchtime), demand forecasting, dynamic menu pricing, and inventory automation are AI-driven at chains. Voice-AI is being piloted at drive-thrus (Wendy's, White Castle, Carl's Jr.) with mixed results. Chatbots handle a growing share of reservations and customer questions.\n\nThe actual *cooking* — hands, fire, palate, plating, and reading the room — is not being meaningfully automated; robotic kitchens exist but are rare. What is changing today for a restaurant manager or chef is the administrative wrapper: scheduling, ordering, comp-set pricing, marketing copy, social posts, and reviews-response are increasingly AI-drafted.\n\nHospitality, judgment under rush, food cost discipline, and team leadership in a physical kitchen remain firmly human.`,
    },
    {
      keywords: /electrician|plumber|mechanic|automotive|diesel|hvac|technician|first responder|firefighter|paramedic/,
      copy: `For licensed skilled-trades and field-service work, AI's near-term effect is genuinely modest at the job site and significant in the *back office*. Estimating, dispatching, route optimization, parts lookup, and customer communication (ServiceTitan, Housecall Pro, Jobber) are increasingly AI-assisted. Diagnostic copilots can read fault codes, cross-reference service bulletins, and suggest next checks.\n\nThe work itself — pulling wire, repairing a coil, snaking a line, working in a confined space, troubleshooting an actual physical system — is not being meaningfully automated by current AI. Robotics exists in specific industrial contexts but is not at the level of a residential or commercial service call. Licensure, code compliance, and physical accountability stay human.\n\nWhere a trades professional sees AI today is in invoicing, scheduling, marketing, and documentation — useful, but peripheral to the craft. This is one of the more durable knowledge-meets-hands categories in the current cycle.`,
    },
    {
      keywords: /sewer worker|wastewater|water treatment|utility worker|municipal utility|sewer/,
      copy: `In municipal utilities and field utility work, current AI deployment is concentrated in asset management, GIS, predictive maintenance, and SCADA analytics. Tools like Cityworks, Cartegraph, and various water-utility analytics platforms use ML to predict pipe failures, optimize cleaning schedules, and flag anomalies in flow / chemistry data.\n\nField inspection apps increasingly auto-classify CCTV pipe footage (NASSCO PACP coding assistance), and work-order systems pre-fill documentation. None of this performs the physical work — confined-space entry, equipment operation, repair, and emergency response remain human-led and safety-regulated.\n\nThe near-term effect for a sewer / wastewater / utility worker is mainly faster paperwork, better routing, and more proactive maintenance signals — the hands-on field role is largely unchanged. Public-safety accountability and regulatory compliance keep this role firmly in the durable category.`,
    },
    {
      keywords: /professional companion|companion|caregiver|home care|personal care|elder care/,
      copy: `In companion care and non-medical caregiving, AI is showing up at the edges — scheduling, family communication, care notes, medication reminders, and fall-detection sensors (Apple Watch, Lively, Wellue) — not in the relationship itself. Documentation copilots can summarize visit notes for family or agencies, and care-plan templates are increasingly AI-drafted.\n\nCompanion robots and chatbots (ElliQ, Replika, Pi) reach some seniors but are supplements to, not replacements for, human presence. Trust, observation of subtle changes, hands-on safety, and family communication remain entirely human responsibilities.\n\nThe immediate effect for a professional companion today is a lighter documentation and coordination load, more sensor-based safety signal, and unchanged core work: presence, dignity, and attention.`,
    },
    {
      keywords: /attorney|lawyer|counsel|associate(?!\s+(producer|director))/,
      copy: `Lawyers — especially associates — are operating in a market where AI is reshaping the work week by week. Harvey, Lexis+ AI, Westlaw Precision AI, Hebbia, Spellbook, and Microsoft Copilot for legal are deployed at most Am Law firms and many in-house teams; LLMs now draft memos, contract redlines, discovery summaries, and deposition prep at a level partners increasingly expect.\n\nClients have started pushing back on AFA / hourly billing for tasks they know AI can compress. Public sanctions for hallucinated citations have made verification a non-negotiable skill. Associate-class hiring at some firms has slowed, with productivity-per-associate cited as a reason.\n\nWhat remains lawyer-led today: judgment under regulatory ambiguity, client counseling, trial work, negotiation, and *signing the work product*. The fastest-growing skill in the profession right now is direction and verification of AI output — not avoidance of it.`,
    },
    {
      keywords: /marketer|marketing|content marketer|copywriter|content writer/,
      copy: `Marketing and content roles are deep into AI adoption already. Most B2B and B2C teams use ChatGPT, Claude, Jasper, or Copy.ai for first-draft copy, ad variants, social posts, briefs, and SEO outlines. Image and video generation (Firefly, Midjourney, Sora-class tools) shorten asset cycles. Marketing automation platforms (HubSpot, Marketo, Klaviyo) now ship AI-generated subject lines, send-time optimization, and segmentation.\n\nDirectly observable effects: junior copy and content-production hiring has softened at many companies, freelance-marketplace rates for commodity content have fallen, and the bar for distinctive work has risen. \"AI content\" SEO has triggered Google updates (HCU), making strategy and originality more valuable, not less.\n\nWhat remains human-led now: brand voice ownership, narrative strategy, customer research, channel judgment, and orchestration of integrated campaigns. The successful pattern today is *senior marketers directing AI-augmented output*, not solo AI-only content shops.`,
    },
    {
      keywords: /customer support|customer service|support agent|csr\b|call center|contact center/,
      copy: `Customer support is one of the most directly AI-impacted roles in 2024-2025. Tier-1 deflection by chatbots and voice agents (Intercom Fin, Zendesk AI, Decagon, Sierra, Ada, Salesforce Agentforce) is being rolled out across SaaS, e-commerce, telco, and fintech. Klarna, Shopify, and others have publicly reported large agent-equivalent volumes handled by AI.\n\nThe immediate effect: ticket volumes reaching humans are dropping in many orgs, while *complexity per ticket reaching a human goes up*. Quality monitoring, response drafting, and call summarization are AI-assisted by default. BPO contracts are being renegotiated around AI-assisted deflection.\n\nWhat AI hasn't replaced today: empathy on a tough escalation, judgment on policy edge cases, multi-channel account recovery, and the ability to bend rules for the right customer. The role is shifting from \"first responder\" toward \"escalation specialist + AI quality controller.\"`,
    },
    {
      keywords: /executive|president|owner|founder|ceo|cfo|coo|cio|cto|chief/,
      copy: `For executives, AI today is less about replacement and more about *new accountability*. Boards, investors, and employees increasingly expect leaders to set AI strategy, govern adoption, manage workforce impact, and report on safety / IP / privacy posture. AI shows up in your day as deep research (Perplexity, Claude, ChatGPT), exec briefs and board pre-reads drafted by copilots, ambient meeting notes, and decision support.\n\nDirect effects observable now: companies are publicly tying AI productivity to slower headcount growth; M&A and capital allocation increasingly hinge on AI moats; talent strategy is being rewritten around augmented teams.\n\nThe role itself is not being automated. The expectation is that the leader can *direct* AI-enabled execution at scale, hold the line on judgment, and own the harder calls AI cannot make: people, ethics, capital, and timing.`,
    },
  ];

  const match = roles.find((r) => r.keywords.test(t));
  if (match) return match.copy;

  return `For **${toTitleCase(title)}**, AI is currently showing up in three places at once. First, *adjacent productivity tools*: ChatGPT, Claude, and Microsoft / Google Copilots draft, summarize, and search inside the documents and workflows this role already touches. Second, *vertical SaaS*: the systems-of-record this role uses (CRM, project tracking, ticketing, EHR, etc.) are shipping AI features that pre-fill, suggest, or auto-complete the structured parts of the work. Third, *task automation* outside the role: upstream and downstream functions are using AI to compress hand-offs, which changes what reaches this role and how fast.\n\nBased on the description you provided — \"${descSnippet}\" — the immediate effects today are almost always *task compression* on the routine cognitive work (drafting, classifying, summarizing, searching) rather than full replacement. Judgment, accountability, physical presence, stakeholder trust, and knowing when AI output is wrong remain human responsibilities.\n\nThe practical reality right now: peers who actively integrate AI into the role are visibly faster on the routine parts, which is changing what \"a good week\" looks like in this profession.`;
}

export async function generateAnalysis(input: {
  job_title: string;
  job_description: string;
  technology_context?: string | null;
  resume_text?: string | null;
  signal?: AbortSignal;
}): Promise<AnalysisOutput> {
  // Simulate latency. Allow caller-side abort.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1600);
    if (input.signal) {
      input.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      });
    }
  });

  const { score, risk } = riskFromTitle(input.job_title);
  const title = toTitleCase(input.job_title);
  const tech = input.technology_context?.trim() || "general office software";
  const description = input.job_description.trim();
  const descriptionSnippet =
    description.length > 360 ? `${description.slice(0, 357).trimEnd()}...` : description;

  const result_text = `# AI Impact Assessment — ${title}

## Overall Automation Potential: **${risk}**
**Risk Score:** ${score}/100

This score reflects the likelihood that core tasks of the role could be meaningfully automated by current and near-term AI systems within a 3-5 year horizon. It is calibrated to be informative, not alarmist — most roles will *change* before they *disappear*.

## Current AI Impact on This Profession

${currentAiImpactForRole(title, description)}

## Current Impact of AI on Your Specific Role

Based on the job description you provided — "${descriptionSnippet}" — AI is already most relevant where the work creates, reviews, summarizes, classifies, or searches information. In the current market, that usually means AI can assist with documentation, first-draft analysis, work-order summaries, reporting, knowledge lookup, customer or stakeholder communication, and quality checks.

For **${title}**, the near-term impact is best understood as *task compression* rather than full role replacement: AI can reduce the time spent on repeatable cognitive tasks, but the role still depends on domain judgment, accountability, safety, physical context, stakeholder trust, and knowing when automated output is wrong. The more the job description depends on real-world observation, hands-on execution, high-stakes decisions, or ambiguous human context, the more AI functions as an assistant rather than a substitute.

## Task Decomposition

The role of **${title}** typically involves a blend of repeatable, rule-based work and judgment-heavy, contextual work. Based on the description provided:

- **Routine / structured tasks (higher automation exposure):** drafting standardized communications, data lookup and summarization, formatting reports, scheduling, basic analysis.
- **Judgment / relational tasks (lower automation exposure):** stakeholder negotiation, creative direction, ethical judgment, ambiguous problem framing, mentoring.
- **Hybrid tasks (augmented, not replaced):** review and quality control of AI-generated output, prompt design, oversight of automated workflows.

## Where AI Lands First

Given a technology context of *${tech}*, expect the first wave of disruption in:

1. **Drafting and summarization** — long-form writing, meeting notes, status updates.
2. **Information retrieval** — internal knowledge search, document Q&A.
3. **Pattern-matching analysis** — anomaly flagging, basic forecasting, classification.

## Where You Have Leverage

These capabilities consistently *increase* in value as AI handles the routine:

- **Judgment under ambiguity** — picking the right problem to solve.
- **Trust and relationship capital** — clients buy from people they trust.
- **Cross-domain synthesis** — connecting two fields AI sees as separate.
- **Taste** — knowing when an output is "good enough" vs. when it isn't.

## 90-Day Action Plan

1. **Audit your week.** Log every task for one week. Mark each as *routine*, *judgment*, or *relational*.
2. **Automate one routine task.** Pick the highest-volume routine task and build (or adopt) an AI-assisted workflow for it. Document the time saved.
3. **Invest the saved hours.** Redirect them to the judgment + relational column. Mentor a peer, take a strategic project, deepen a client relationship.
4. **Build an AI-fluent narrative.** Update your resume, LinkedIn, and internal positioning to lead with *how you use AI to amplify outcomes*, not just what you do.

## 12-Month Resilience Plan

- **Develop a "T-shape" skill.** Pair your current depth with one adjacent domain (e.g. PM + data, designer + research, ops + finance).
- **Ship visible work.** Internal demos, a blog post, a talk — make your AI-augmented output legible.
- **Build optionality.** Cultivate a second income stream or specialized side practice; the goal isn't to leave your role, it's to *not need to stay*.

## Bottom Line

${risk === "High"
      ? "This role faces meaningful disruption. The good news: people who *master* AI in this domain become 5-10× more productive — and those people are scarce. Move toward the work that compounds."
      : risk === "Medium"
        ? "This role will change shape rather than disappear. Use the next 12 months to bend the change in your favor — automate the routine, invest in judgment."
        : "This role is durable in its core. Use AI to remove drudgery so you can do more of the work only you can do."}

---
*This assessment is informational and not a guarantee of outcomes. The labor market is path-dependent and depends on many factors outside any single role.*`;

  return {
    result_text,
    automation_risk: risk,
    risk_score: score,
    provider_used: "AI Career Impact Model",
  };
}

/* Auto-fill stub: generates a plausible job description + tech context
 * from just a title. Replace with a real prompt call when wiring an LLM. */
export function generateAutofill(job_title: string): {
  job_description: string;
  technology_context: string;
} {
  const t = job_title.trim();
  const normalized = t.toLowerCase();
  if (/sewer|wastewater|utility worker|water treatment/.test(normalized)) {
    return {
      job_description:
        "Maintains and inspects sewer, wastewater, or municipal utility systems; performs field checks, preventative maintenance, confined-space or safety-sensitive work, basic equipment operation, documentation of service issues, and coordination with public works or maintenance teams.",
      technology_context:
        "Common tools include work-order systems, GIS or asset maps, mobile inspection apps, safety checklists, radios, sensors, and field equipment. AI may assist with maintenance logs, route planning, documentation, and anomaly detection, while physical field work remains human-led.",
    };
  }
  if (/professional companion|companion|caregiver|home care|personal care|elder care/.test(normalized)) {
    return {
      job_description:
        "Provides companionship and non-medical daily support to clients; assists with routines, appointments, light household coordination, safety observation, emotional support, family communication, and documentation of client needs or changes.",
      technology_context:
        "Common tools include scheduling apps, care notes, mobile communication, medication or appointment reminders, telehealth coordination, and family messaging. AI may assist with documentation, reminders, and care-plan summaries, while trust, presence, and hands-on support remain human-centered.",
    };
  }
  if (/registered nurse|\brn\b|licensed practical nurse|\blpn\b|nurse|nursing/.test(normalized)) {
    return {
      job_description:
        "Provides patient-centered nursing care; monitors vital signs and symptoms, documents clinical observations, coordinates with providers, educates patients and families, administers or tracks care-plan tasks, and responds to changing patient needs in a clinical or care setting.",
      technology_context:
        "Common tools include electronic health records, medication administration systems, scheduling tools, patient monitors, secure messaging, telehealth platforms, and clinical documentation workflows. AI may assist with chart summaries, handoff notes, triage support, and documentation, while bedside judgment and patient trust remain human-led.",
    };
  }
  if (/heart surgeon|cardiac surgeon|cardiothoracic surgeon|cardiovascular surgeon|surgeon/.test(normalized)) {
    return {
      job_description:
        "Performs and coordinates complex surgical care for cardiac patients; evaluates diagnostic results, plans procedures, operates in sterile surgical environments, collaborates with anesthesiology and critical-care teams, communicates with patients and families, and oversees post-operative care decisions.",
      technology_context:
        "Common tools include electronic health records, diagnostic imaging, surgical planning systems, operating room monitors, robotic or minimally invasive surgical equipment where available, and clinical decision-support references. AI may assist with imaging review, chart summarization, risk stratification, and documentation, while surgical judgment and hands-on operating-room skill remain physician-led.",
    };
  }
  if (/program manager|technology operations|cloud solutions|iot development|technical program/.test(normalized)) {
    return {
      job_description:
        "Leads technology operations and cross-functional delivery across cloud, IoT, product, and systems initiatives; coordinates stakeholders, manages roadmaps and execution plans, improves operational processes, tracks delivery risks, and aligns technical teams with business outcomes.",
      technology_context:
        "Common tools include cloud platforms, IoT management tools, Jira or Linear, dashboards, documentation systems, collaboration suites, CRM or customer operations tools, and AI assistants for planning, research, summarization, reporting, and technical documentation.",
    };
  }
  if (/paralegal|legal assistant|litigation assistant/.test(normalized)) {
    return {
      job_description:
        "Supports attorneys by organizing case files, drafting and formatting legal documents, managing discovery, preparing filings, coordinating deadlines, summarizing records, communicating with clients or courts, and maintaining matter documentation.",
      technology_context:
        "Common tools include case-management systems, e-filing portals, document management, Microsoft Office, PDF tools, legal research platforms, and emerging AI review or summarization tools. AI can accelerate drafting and document review, but legal judgment, accuracy checks, and procedural accountability remain critical.",
    };
  }
  return {
    job_description: `As a ${t}, primary responsibilities typically include planning and executing work in this domain, collaborating with cross-functional stakeholders, owning a set of measurable outcomes, and continuously improving processes and deliverables. The role requires combining domain expertise with strong communication and the ability to work independently in ambiguous environments.`,
    technology_context: `Common tools for a ${t} include collaboration platforms (Slack, Notion, Google Workspace), project tracking (Linear, Jira), and domain-specific tooling. Increasingly, AI assistants (ChatGPT, Claude, GitHub Copilot, Perplexity) are used for drafting, research, and analysis.`,
  };
}

/* =====================================================================
 * LinkedIn job text parser
 *
 * Operates on pasted text from a LinkedIn job page (or HTML fetched
 * server-side, after a coarse tag strip). LinkedIn does not provide a
 * stable public scrape surface and most server-side fetches return an
 * auth wall, so the primary supported path is the user pasting the
 * visible job text into the app. We extract:
 *
 *   - job_title:    the role line (usually the first prominent line, or
 *                   the line immediately preceding the company)
 *   - company:      the organization name (best-effort)
 *   - location:     city / region / "Remote" (best-effort, optional)
 *   - job_description: the body of the posting, with header noise
 *                      stripped (apply buttons, social actions, etc.)
 *
 * The parser is intentionally tolerant — partial input still yields a
 * useful object so the client can pre-fill what it found and let the
 * user edit. When nothing is recognisable we return the cleaned text as
 * the description and an empty title so the UI can offer manual entry.
 * ===================================================================== */
export interface LinkedInParsedJob {
  job_title: string;
  company: string;
  location: string;
  job_description: string;
}

/* Strip HTML tags from a string, decode the few entities LinkedIn job
 * pages actually contain, and normalise whitespace. Defensive: no DOM
 * parser dependency, just a coarse regex pipeline good enough for the
 * pasted-text + best-effort-fetch flow this feature uses. */
export function stripHtmlToText(input: string): string {
  if (!input) return "";
  let s = input;
  // Drop <script>, <style>, <noscript>, and SVG/HTML comments entirely
  // so embedded JSON-LD / inline styles do not pollute the visible text.
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Convert line-affecting tags to newlines so paragraphs survive the
  // tag strip.
  s = s.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n");
  s = s.replace(/<\s*(li|p|div|h[1-6])\b[^>]*>/gi, "\n");
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the entities we actually see in LinkedIn job HTML.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"');
  // Normalise whitespace.
  s = s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/* Try to lift structured fields from a JSON-LD JobPosting block when
 * one is present in fetched HTML. LinkedIn frequently includes a
 * <script type="application/ld+json"> with the public JobPosting
 * metadata even for logged-out scrapes — when we get it, this is the
 * most reliable parse path. Returns null when no usable block is
 * found. */
function tryExtractJsonLdJobPosting(rawHtml: string): LinkedInParsedJob | null {
  if (!rawHtml || !/JobPosting/i.test(rawHtml)) return null;
  const blocks = rawHtml.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  if (!blocks) return null;
  for (const block of blocks) {
    const jsonMatch = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (!jsonMatch) continue;
    try {
      const data = JSON.parse(jsonMatch[1].trim());
      const node = Array.isArray(data) ? data.find((n) => n?.["@type"] === "JobPosting") : data;
      if (!node || node["@type"] !== "JobPosting") continue;
      const title = typeof node.title === "string" ? node.title.trim() : "";
      const orgRaw =
        typeof node.hiringOrganization === "object" && node.hiringOrganization
          ? node.hiringOrganization.name
          : typeof node.hiringOrganization === "string"
            ? node.hiringOrganization
            : "";
      const company = typeof orgRaw === "string" ? orgRaw.trim() : "";
      let location = "";
      const locNode = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
      if (locNode && typeof locNode === "object") {
        const addr = locNode.address ?? locNode;
        if (typeof addr === "object" && addr) {
          location = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
            .filter((v) => typeof v === "string" && v.trim())
            .join(", ");
        }
      }
      const descriptionRaw = typeof node.description === "string" ? node.description : "";
      const description = stripHtmlToText(descriptionRaw);
      if (title || description) {
        return {
          job_title: toTitleCase(title),
          company,
          location,
          job_description: description,
        };
      }
    } catch {
      // Try the next block.
    }
  }
  return null;
}

/* Lines that appear on LinkedIn job pages but are pure chrome and
 * should not pollute the extracted body. The set is anchored: an exact
 * (case-insensitive) match drops the line. Substring rules below cover
 * the more variable noise. */
const LINKEDIN_NOISE_LINES = new Set(
  [
    "save",
    "apply",
    "easy apply",
    "share",
    "more",
    "see more",
    "see less",
    "show more",
    "show less",
    "report this job",
    "report",
    "follow",
    "promoted",
    "linkedin",
    "sign in",
    "join now",
    "join linkedin",
    "skip to main content",
    "about the job",
    "about this job",
    "job description",
    "people you can reach out to",
    "be an early applicant",
  ].map((s) => s.toLowerCase()),
);

function isLinkedInChrome(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (!lower) return true;
  if (LINKEDIN_NOISE_LINES.has(lower)) return true;
  // Stat lines like "300 applicants", "Posted 2 days ago", "10,000+ employees".
  if (/^\d[\d,]*\s+(applicants?|employees|connections?)\b/i.test(lower)) return true;
  if (/^posted\b.*\bago\b/i.test(lower)) return true;
  if (/^reposted\b.*\bago\b/i.test(lower)) return true;
  if (/^\d+\s+(hours?|days?|weeks?|months?)\s+ago\b/i.test(lower)) return true;
  if (/^view\s+(jobs?|company|profile)\b/i.test(lower)) return true;
  if (/^how (your|you).*matche/i.test(lower)) return true;
  // Cookie / nav / footer scraps that sometimes slip through.
  if (/^©\s?\d{4}\b/.test(lower)) return true;
  if (/^cookie\s+(policy|preferences)\b/i.test(lower)) return true;
  return false;
}

/* Heuristic: does this look like a LinkedIn profile paste (not a job
 * posting)? Profiles contain section headers like "Experience",
 * "Education", "About", "Skills", or a "Contact" block, and date ranges
 * containing "Present". A job-posting paste typically has "Apply",
 * "applicants", "Posted ... ago", or "About the job". When the profile
 * signal is stronger than the job-posting signal we route to the
 * profile parser, which extracts the user's *current/latest* role
 * rather than treating the whole thing as one job description. */
function looksLikeLinkedInProfile(lines: string[]): boolean {
  let profileSignal = 0;
  let postingSignal = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^experience$/i.test(line)) profileSignal += 3;
    if (/^education$/i.test(line)) profileSignal += 2;
    if (/^skills$/i.test(line)) profileSignal += 1;
    if (/^about$/i.test(line)) profileSignal += 1;
    if (/^contact$/i.test(line)) profileSignal += 1;
    if (/^licenses?\s*&?\s*certifications?$/i.test(line)) profileSignal += 1;
    if (/\bpresent\b/i.test(lower) && /\b(19|20)\d{2}\b/.test(lower)) profileSignal += 2;
    if (/·\s*(full[- ]time|part[- ]time|contract|self[- ]employed|freelance|internship)\b/i.test(lower))
      profileSignal += 2;
    if (/^easy apply$/i.test(line) || /\bapply\b/i.test(line) && line.length < 30) postingSignal += 2;
    if (/\b\d[\d,]*\s+applicants\b/i.test(lower)) postingSignal += 3;
    if (/^posted\b.*\bago\b/i.test(lower)) postingSignal += 2;
    if (/^about the job$/i.test(line)) postingSignal += 3;
    if (/^job description$/i.test(line)) postingSignal += 2;
    if (/^report this job$/i.test(line)) postingSignal += 2;
  }
  return profileSignal >= 3 && profileSignal > postingSignal;
}

/* A profile line that names a role+company on the same line. LinkedIn
 * commonly renders the experience row as one of:
 *
 *   "Senior Software Engineer at Acme Robotics"
 *   "Senior Software Engineer · Acme Robotics"
 *   "Senior Software Engineer – Acme Robotics"
 *   "Senior Software Engineer | Acme Robotics"
 *
 * Returns { title, company } when the pattern matches, else null. */
function splitRoleCompanyLine(line: string): { title: string; company: string } | null {
  const separators = [
    /^(.+?)\s+at\s+(.+)$/i,
    /^(.+?)\s+[·•]\s+(.+)$/,
    /^(.+?)\s+[–—-]\s+(.+)$/,
    /^(.+?)\s+\|\s+(.+)$/,
  ];
  for (const re of separators) {
    const m = line.match(re);
    if (!m) continue;
    const title = m[1].trim();
    const company = m[2].trim();
    // Reject when the right side looks like an employment-type tag
    // ("Full-time", "Part-time") rather than a company name.
    if (/^(full[- ]time|part[- ]time|contract|self[- ]employed|freelance|internship|permanent)\b/i.test(company))
      return null;
    // Reject when the right side looks like a date range.
    if (/\b(19|20)\d{2}\b/.test(company) && /(present|\d{4})/i.test(company)) return null;
    if (title.length < 2 || title.length > 140 || company.length < 2 || company.length > 140) return null;
    if (!/[A-Za-z]/.test(title) || !/[A-Za-z]/.test(company)) return null;
    return { title, company };
  }
  return null;
}

/* Look for the current / latest role in a LinkedIn profile paste.
 *
 * Strategy (in priority order):
 *   1. The profile headline — the line that sits 1-3 lines below the
 *      candidate name and *isn't* a section header. LinkedIn headlines
 *      usually combine the current role and company ("Senior Software
 *      Engineer at Acme Robotics") and are the most reliable signal for
 *      "what the user does right now."
 *   2. The first role under the "Experience" section whose date range
 *      contains "Present" (current role). If multiple, pick the first
 *      one encountered (LinkedIn lists most-recent first).
 *   3. The first role under "Experience" regardless of date — falls
 *      back to "latest" when "Present" isn't matched (e.g. someone
 *      between jobs or pasted text dropped the date row).
 *
 * Always returns a LinkedInParsedJob; fields are empty when nothing
 * matches so the caller can degrade gracefully. */
function parseLinkedInProfileText(lines: string[]): LinkedInParsedJob {
  const headerKeywords = new Set([
    "experience", "education", "about", "skills", "contact", "activity",
    "featured", "recommendations", "accomplishments", "interests",
    "licenses & certifications", "licenses and certifications",
    "certifications", "volunteer experience", "publications",
    "projects", "languages", "courses", "honors & awards", "honors and awards",
  ]);
  const isSectionHeader = (s: string) => headerKeywords.has(s.trim().toLowerCase());

  // 1. Headline: look at the first ~6 non-empty lines for a role-bearing
  //    line that isn't a section header and isn't a location. The
  //    candidate's name typically sits at position 0; the headline is
  //    one of the next few lines.
  const rolePattern =
    /\b(engineer|developer|manager|director|designer|analyst|consultant|specialist|lead|founder|owner|ceo|cfo|coo|cio|cto|chief|president|vp|head of|architect|nurse|surgeon|doctor|teacher|professor|attorney|lawyer|paralegal|accountant|bookkeeper|marketer|writer|editor|producer|administrator|coordinator|operator|technician|mechanic|electrician|plumber|chef|cook|sales|representative|associate|executive|partner|principal|scientist|researcher|advisor|strategist|officer|controller|auditor|recruiter|trainer|coach|therapist|counselor|paramedic|firefighter|programmer|copywriter|stylist|barista|cashier|clerk|assistant|intern|apprentice|technologist|pharmacist|dentist|veterinarian|psychologist)\b/i;

  const looksLikeLocation = (s: string) =>
    /\b(remote|hybrid|on[- ]site|onsite)\b/i.test(s) ||
    /,\s*[A-Z]{2}\b/.test(s) ||
    /,\s*(united states|usa|uk|canada|india|germany|france|spain|brazil|mexico|australia|singapore|netherlands|ireland|poland|portugal|italy)\b/i.test(s);

  let headlineTitle = "";
  let headlineCompany = "";
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i];
    if (!line || isSectionHeader(line)) continue;
    if (looksLikeLocation(line)) continue;
    if (/^\d+\s+followers?\b/i.test(line)) continue;
    if (/^\d+\s+connections?\b/i.test(line)) continue;
    if (!rolePattern.test(line)) continue;
    // Avoid grabbing the candidate name on line 0 unless it itself
    // contains a role token (rare, but possible: "Jane Doe, MD").
    if (i === 0 && !rolePattern.test(line)) continue;
    const split = splitRoleCompanyLine(line);
    if (split) {
      headlineTitle = split.title;
      headlineCompany = split.company;
    } else {
      headlineTitle = line;
    }
    break;
  }

  // 2. Experience section: find the "Experience" header and inspect the
  //    rows that follow. LinkedIn experience entries vary in shape;
  //    common patterns include:
  //
  //      Acme Robotics
  //      Senior Software Engineer
  //      Full-time
  //      Jan 2022 - Present · 3 yrs
  //      San Francisco, CA
  //
  //    or:
  //
  //      Senior Software Engineer
  //      Acme Robotics · Full-time
  //      Jan 2022 - Present
  //
  //    We look for a row whose date span contains "Present" and harvest
  //    the title / company from the 1-3 lines preceding it.
  let experienceTitle = "";
  let experienceCompany = "";
  const expIndex = lines.findIndex((l) => /^experience$/i.test(l.trim()));
  if (expIndex >= 0) {
    const expSlice = lines.slice(expIndex + 1, expIndex + 80);
    // Stop at the next section header.
    const stopAt = expSlice.findIndex((l) => isSectionHeader(l));
    const expLines = stopAt >= 0 ? expSlice.slice(0, stopAt) : expSlice;

    const datePresentRe = /\b(19|20)\d{2}\b.*\b(present|current|now)\b/i;
    const dateRangeRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/i;

    // Pass 1: try to find a "Present" row and lift the role from the
    // 1-3 lines above it.
    let currentRowIdx = expLines.findIndex((l) => datePresentRe.test(l));
    let currentFound = currentRowIdx >= 0;
    // Pass 2: fall back to the first row whose date range looks like a
    // job employment span (latest, since LinkedIn lists newest-first).
    if (!currentFound) currentRowIdx = expLines.findIndex((l) => dateRangeRe.test(l));

    if (currentRowIdx >= 0) {
      // Inspect the 3 lines immediately above the date row.
      const candidates: string[] = [];
      for (let i = Math.max(0, currentRowIdx - 3); i < currentRowIdx; i++) {
        const l = expLines[i].trim();
        if (!l) continue;
        if (/^(full[- ]time|part[- ]time|contract|self[- ]employed|freelance|internship|permanent)\b/i.test(l))
          continue;
        if (looksLikeLocation(l)) continue;
        candidates.push(l);
      }
      // Heuristic: when there's a single-line "Title at Company"
      // pattern, split it. Otherwise treat the last candidate as the
      // title and the one before as the company (LinkedIn's "title
      // then company" rendering). If only one candidate, that's the
      // title.
      const splitLast = candidates.length
        ? splitRoleCompanyLine(candidates[candidates.length - 1])
        : null;
      if (splitLast) {
        experienceTitle = splitLast.title;
        experienceCompany = splitLast.company;
      } else if (candidates.length >= 2) {
        // Detect "Company · Full-time" pattern on the second-to-last
        // candidate (company sits under the title in this layout).
        const last = candidates[candidates.length - 1];
        const prev = candidates[candidates.length - 2];
        const companyDotType = prev.match(/^(.+?)\s+[·•]\s+(full[- ]time|part[- ]time|contract|self[- ]employed|freelance|internship|permanent)\b/i);
        if (rolePattern.test(last) && !rolePattern.test(prev)) {
          experienceTitle = last;
          experienceCompany = companyDotType ? companyDotType[1].trim() : prev;
        } else if (rolePattern.test(prev) && !rolePattern.test(last)) {
          experienceTitle = prev;
          experienceCompany = last;
        } else {
          experienceTitle = last;
          experienceCompany = companyDotType ? companyDotType[1].trim() : prev;
        }
      } else if (candidates.length === 1) {
        const split = splitRoleCompanyLine(candidates[0]);
        if (split) {
          experienceTitle = split.title;
          experienceCompany = split.company;
        } else {
          experienceTitle = candidates[0];
        }
      }
    }
  }

  // Prefer headline when it carries a role; otherwise the experience-
  // section role; final fallback empty.
  const job_title = headlineTitle || experienceTitle || "";
  const company = headlineCompany || experienceCompany || "";

  // For the description, prefer the "About" section text when present
  // (it's the user's own summary), else stitch together the headline
  // and current-role line as a short context blurb so the analysis has
  // something to work with.
  let description = "";
  const aboutIdx = lines.findIndex((l) => /^about$/i.test(l.trim()));
  if (aboutIdx >= 0) {
    const after = lines.slice(aboutIdx + 1);
    const stopAt = after.findIndex((l) => isSectionHeader(l));
    const aboutLines = stopAt >= 0 ? after.slice(0, stopAt) : after.slice(0, 40);
    description = aboutLines.join("\n").trim();
  }
  if (!description) {
    const parts: string[] = [];
    if (headlineTitle) parts.push(headlineTitle + (headlineCompany ? ` at ${headlineCompany}` : ""));
    if (experienceTitle && experienceTitle !== headlineTitle)
      parts.push(`Current role: ${experienceTitle}${experienceCompany ? ` at ${experienceCompany}` : ""}`);
    description = parts.join("\n").trim();
  }

  // Location: a line near the top that matches the location pattern
  // and isn't already the company.
  let location = "";
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    if (!line || isSectionHeader(line)) continue;
    if (line === company) continue;
    if (looksLikeLocation(line) && !/at\s+/i.test(line)) {
      location = line;
      break;
    }
  }

  return {
    job_title: toTitleCase(job_title),
    company,
    location,
    job_description: description,
  };
}

/* Public: parse pasted LinkedIn job text (or HTML-stripped fetched
 * content) into structured fields. Best-effort and tolerant — see the
 * top-of-section doc comment for the contract. */
export function parseLinkedInJobText(rawInput: string): LinkedInParsedJob {
  if (!rawInput || !rawInput.trim()) {
    return { job_title: "", company: "", location: "", job_description: "" };
  }
  // If the user pasted raw HTML, try JSON-LD first.
  if (/<\s*(html|body|script|div|head)/i.test(rawInput)) {
    const ld = tryExtractJsonLdJobPosting(rawInput);
    if (ld && (ld.job_title || ld.job_description.length > 40)) {
      return ld;
    }
  }
  const cleanedText = /<[^>]+>/.test(rawInput) ? stripHtmlToText(rawInput) : rawInput;
  const lines = cleanedText
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Route LinkedIn-profile pastes to the profile parser; otherwise
  // continue with the existing job-posting parser below.
  if (looksLikeLinkedInProfile(lines)) {
    const profile = parseLinkedInProfileText(lines);
    if (profile.job_title || profile.job_description) {
      return profile;
    }
  }

  // Drop obvious chrome lines from the front of the body for header
  // detection, but keep them out of the description either way.
  const headerCandidates: string[] = [];
  for (const line of lines.slice(0, 30)) {
    if (isLinkedInChrome(line)) continue;
    headerCandidates.push(line);
    if (headerCandidates.length >= 12) break;
  }

  // Heuristic: the first non-chrome line that looks like a title is the
  // role. The line immediately after the title (positionally), if short
  // and not a location and not a sentence of prose, is the company. A
  // line containing typical location markers (city + state, country, or
  // "Remote") becomes the location.
  const looksLikeTitle = (s: string) =>
    s.length >= 3 &&
    s.length <= 140 &&
    !/[.!?]$/.test(s) &&
    !/^https?:\/\//i.test(s) &&
    /[A-Za-z]/.test(s);
  const looksLikeLocation = (s: string) =>
    /\b(remote|hybrid|on[- ]site|onsite)\b/i.test(s) ||
    /,\s*[A-Z]{2}\b/.test(s) ||
    /,\s*(united states|usa|uk|canada|india|germany|france|spain|brazil|mexico|australia|singapore|netherlands|ireland|poland|portugal|italy)\b/i.test(s);
  // A short, non-sentence line directly under the title is treated as
  // the company. Trailing "Inc.", "LLC.", "Ltd." are allowed; sentence
  // punctuation in the middle of the line is not (prose lines are
  // rejected).
  const looksLikeCompanyLine = (s: string) =>
    s.length >= 2 &&
    s.length <= 120 &&
    !/^https?:\/\//i.test(s) &&
    /[A-Za-z]/.test(s) &&
    !/[.!?]\s+[A-Z]/.test(s); // no "Sentence. Next" prose

  let job_title = "";
  let company = "";
  let location = "";
  let titleIndex = -1;
  for (let i = 0; i < headerCandidates.length; i += 1) {
    const line = headerCandidates[i];
    if (!job_title && looksLikeTitle(line) && !looksLikeLocation(line)) {
      job_title = line;
      titleIndex = i;
      continue;
    }
    if (
      job_title &&
      !company &&
      titleIndex >= 0 &&
      i === titleIndex + 1 &&
      looksLikeCompanyLine(line) &&
      !looksLikeLocation(line)
    ) {
      company = line;
      continue;
    }
    if (!location && looksLikeLocation(line)) {
      location = line;
    }
    if (job_title && company && location) break;
  }

  // Build the description from all the non-chrome lines that weren't
  // consumed as header fields. We preserve paragraph structure by
  // re-joining on single newlines and collapsing repeated blanks later.
  const descriptionLines: string[] = [];
  for (const line of lines) {
    if (isLinkedInChrome(line)) continue;
    if (line === job_title || line === company || line === location) continue;
    descriptionLines.push(line);
  }
  let job_description = descriptionLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Cap description so a pathological paste doesn't blow up the request
  // body when the user submits the form. 12k chars matches the resume
  // PDF extraction cap.
  if (job_description.length > 12_000) {
    job_description = `${job_description.slice(0, 12_000).trimEnd()}…`;
  }

  return {
    job_title: toTitleCase(job_title),
    company,
    location,
    job_description,
  };
}

/* Resume pre-fill stub: extracts a plausible job title and rewrites
 * description + tech context from the resume's extracted_text. */
export function prefillFromResumeText(extracted_text: string): {
  job_title: string;
  job_description: string;
  technology_context: string;
} {
  // Prefer the resume header (top of the document) for the role. The
  // filename is a secondary hint — only used when the header lacks a
  // recognisable title pattern. Responsibility bullets and section
  // labels must NEVER become the job title.
  const rawLines = extracted_text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Strip file extension from the filename hint before doing any matching.
  const stripExtension = (value: string) =>
    value.replace(/\.(pdf|docx?|txt|rtf|odt)$/i, "").trim();
  const fileNameHint = stripExtension(rawLines[0] || "");

  // Resume body starts after the filename line we prepended.
  const lines = rawLines.slice(1);

  const genericFallbackPattern =
    /senior professional with multi-year experience|selected experience|communication, project management|extracted text generated by the in-app fallback|extracted text generated by the in-app stub/i;
  const responsibilityLinePattern =
    /^[•\-\*]?\s*(led|collaborated|owned|managed|supported|assisted|coordinated|prepared|reviewed|maintained|performed|developed|created|delivered|provided|architected|implemented|designed|re-engineered|mentored|continuously|evaluated|drove|built|launched)\b/i;
  // Personal-name pattern: "FIRST LAST" or "First Last" with no role keyword.
  // Used to skip the candidate's name line.
  const personalNamePattern =
    /^(?:[A-Z][a-z]+\s+){1,2}[A-Z][a-z]+$|^(?:[A-Z]+\s+){1,2}[A-Z]+$/;
  const rolePattern =
    /sewer|wastewater|utility|worker|companion|caregiver|home care|personal care|engineer|manager|designer|analyst|director|lead|specialist|consultant|developer|architect|paralegal|attorney|lawyer|counsel|associate|coordinator|operator|marketer|sales|product|teacher|educator|nurse|nursing|medical|doctor|surgeon|technician|plumber|electrician|mechanic|chef|cook|bookkeeper|accountant|assistant|clerk|administrator|representative|executive|officer|president|owner|founder/i;

  const cleanTitle = (value: string) =>
    toTitleCase(value
      .replace(/resume|résumé|cv|sample|template|ats|classic|modern|color block/gi, " ")
      .replace(/\bnursing\b/gi, "Nurse")
      .replace(/\bmedical\b/gi, "Healthcare")
      .replace(/\bIoT\b/g, "IOT")
      .replace(/[•·\-—@_]/g, " ")
      .replace(/\s*\|\s*/g, " | ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "Professional")
      .replace(/\bIo\s*T\b/g, "IoT")
      .replace(/\bIot\b/g, "IoT")
      .replace(/\bSr\./g, "Sr.");

  const canonicalRole = (value: string): string => {
    // Normalise underscores / dots / multi-spaces so filenames like
    // "Heart_Surgeon_Resume.pdf" match the same patterns as headers.
    const text = value
      .toLowerCase()
      .replace(/[._\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const rules: Array<[RegExp, string]> = [
      [/professional companion|companion caregiver|senior companion|companion\b|caregiver|home care|personal care|elder care/, "Professional Companion"],
      [/sewer worker|wastewater|water treatment|municipal utility|utility worker|sewer/, "Sewer Worker"],
      [/first grade teacher|1st grade teacher/, "First Grade Teacher"],
      [/teacher|educator|instructor|professor/, "Teacher"],
      [/registered nurse|\brn\b/, "Registered Nurse"],
      [/licensed practical nurse|\blpn\b/, "Licensed Practical Nurse"],
      [/nursing|nurse/, "Nurse"],
      [/heart surgeon|cardiac surgeon|cardiothoracic surgeon|cardiovascular surgeon/, "Heart Surgeon"],
      [/surgeon/, "Surgeon"],
      [/paralegal|legal assistant|litigation assistant/, "Paralegal"],
      [/software engineer|software developer/, "Software Engineer"],
      [/developer|programmer/, "Software Developer"],
      [/accountant|bookkeeper|controller|auditor/, "Accountant"],
      [/program manager/, "Program Manager"],
      [/project manager|scrum master/, "Project Manager"],
      [/sales representative|sales rep|account executive|business development/, "Sales Representative"],
      [/electrician|electrical/, "Electrician"],
      [/mechanic|automotive|diesel/, "Mechanic"],
      [/chef|cook|culinary/, "Chef"],
      [/data analyst|business analyst|analyst|business intelligence/, "Data Analyst"],
      [/restaurant manager/, "Restaurant Manager"],
      [/graphic designer/, "Graphic Designer"],
      [/ux designer|ui designer|ui\/ux/, "UX Designer"],
    ];
    return rules.find(([pattern]) => pattern.test(text))?.[1] ?? "";
  };

  // Lines we never want as a job title: section headers, contact info,
  // bullet responsibilities, candidate names, prose paragraphs, etc.
  const isBadTitleCandidate = (line: string) => {
    if (genericFallbackPattern.test(line)) return true;
    if (responsibilityLinePattern.test(line)) return true;
    if (/@/.test(line)) return true;
    if (/^[A-Z]\s+\d{3}/.test(line)) return true; // "E 949 233-9090"
    if (/\b(phone|tel|email|linkedin|address|summary|experience|education|skills|profile|key achievements|contact|references|certifications|languages|interests|objective)\b/i.test(line)) return true;
    // Long prose with sentence punctuation is not a title.
    if (line.length > 90 && /\.\s/.test(line)) return true;
    if (line.length > 120) return true;
    // Pure personal name lines (no role keyword).
    if (personalNamePattern.test(line) && !rolePattern.test(line)) return true;
    return false;
  };

  // A line looks like a real job title when it has a seniority modifier,
  // a multi-part "|" separator, or a clear role keyword without prose.
  const preservesSpecificHeader = (line: string) =>
    /\b(sr\.?|senior|principal|lead|staff|director|vp|chief|head|program|operations|cloud|iot|technology)\b/i.test(line) ||
    /\|/.test(line);

  // Headers in resumes sometimes wrap across two lines (e.g. "... IoT\nDevelopment").
  // Glue continuation words back onto the previous line when they look like
  // tail-words of a title.
  const joinWrappedHeader = (line: string, next: string) => {
    if (!next) return line;
    if (/\|\s*$/.test(line)) return `${line} ${next}`;
    if (next.length < 30 && /^[A-Z][a-zA-Z]+$/.test(next) && /\b(iot|cloud|solutions|development|operations|technology|engineering|design|management)\b/i.test(next)) {
      return `${line} ${next}`;
    }
    return line;
  };

  const bestRoleFromLines = (candidateLines: string[]) => {
    for (let i = 0; i < candidateLines.length; i += 1) {
      const line = candidateLines[i];
      if (!rolePattern.test(line)) continue;
      // Skip lines that look like body prose (full sentences).
      if (line.length > 90 && /\b\w+\s+\w+\s+\w+\s+\w+\s+\w+\s+\w+\s+\w+\s+\w+\b/.test(line) && !/\|/.test(line)) continue;
      const reconstructed = joinWrappedHeader(line, candidateLines[i + 1] ?? "");
      if (preservesSpecificHeader(reconstructed)) return cleanTitle(reconstructed);
      const canonical = canonicalRole(reconstructed);
      if (canonical) return canonical;
      return cleanTitle(reconstructed);
    }
    return "";
  };

  const headerLines = lines.slice(0, 10).filter((l) => !isBadTitleCandidate(l));
  const headerRole = bestRoleFromLines(headerLines);
  const earlyResumeLines = lines.slice(0, 20).filter((l) => !isBadTitleCandidate(l));
  const earlyRole = bestRoleFromLines(earlyResumeLines);
  const filenameRole = canonicalRole(fileNameHint);

  // Priority order:
  //  1. A specific multi-part / senior header ("Sr. Program Manager | ...")
  //  2. Header role from the top of the resume
  //  3. Canonical role from filename ("Heart_Surgeon_Resume.pdf")
  //  4. Anything from the first ~20 lines
  //  5. Clean filename hint
  //  6. "Professional"
  let cleaned: string;
  if (headerRole && /\||\b(sr\.?|senior|principal|lead|staff|director|vp|chief|head)\b/i.test(headerRole)) {
    cleaned = headerRole;
  } else if (headerRole) {
    cleaned = headerRole;
  } else if (filenameRole) {
    cleaned = filenameRole;
  } else if (earlyRole) {
    cleaned = earlyRole;
  } else {
    cleaned = cleanTitle(fileNameHint || "Professional");
  }

  const af = generateAutofill(cleaned);
  return {
    job_title: cleaned,
    job_description: af.job_description,
    technology_context: af.technology_context,
  };
}
