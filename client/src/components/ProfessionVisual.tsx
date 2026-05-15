type ProfessionKind =
  | "field"
  | "construction"
  | "legal"
  | "healthcare"
  | "engineering"
  | "design"
  | "finance"
  | "analyst"
  | "education"
  | "sales"
  | "operations"
  | "marketing"
  | "product"
  | "culinary"
  | "customer"
  | "general";

type ProfessionMatch = {
  title: string;
  label: string;
  scene: string;
  prompt: string;
  image: string;
  confidence: "specific" | "category" | "fallback";
};

const NEGATIVE_IMAGE_DIRECTION =
  "Photorealistic documentary workplace portrait only. No icon, no illustration, no vector art, no flat design, no clipart, no symbol, no generic business avatar, no logo, no text overlay.";

function matches(text: string, pattern: RegExp) {
  return pattern.test(text);
}

function titleCase(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bIot\b/g, "IoT")
    .replace(/\bIo T\b/g, "IoT")
    .replace(/\bSr\./g, "Sr.");
}

function specificProfessionForContent(text: string): Omit<ProfessionMatch, "confidence"> | null {
  const exact: Array<{ pattern: RegExp; match: Omit<ProfessionMatch, "confidence"> }> = [
    {
      pattern: /paralegal|legal assistant|litigation assistant|case file|discovery|deposition|court filing|law firm/,
      match: {
        title: "Paralegal",
        label: "Paralegal workplace",
        scene: "reviewing case files, discovery binders, and court documents in a law office",
        prompt:
          "Photorealistic editorial portrait of a paralegal in a modern law office, reviewing case files, discovery binders, court filings, and legal documents at a desk with subtle courthouse and law library context, natural window light, documentary style.",
        image: "./profession/legal.jpg",
      },
    },
    {
      pattern: /heart surgeon|cardiac surgeon|cardiothoracic surgeon|cardiovascular surgeon|surgeon|operating room|surgical|cardiac/,
      match: {
        title: "Heart Surgeon",
        label: "Surgical healthcare workplace",
        scene: "working in a cardiac operating room with surgical monitors and sterile clinical equipment",
        prompt:
          "Photorealistic editorial portrait of a heart surgeon in a cardiac operating room, wearing surgical scrubs in a sterile clinical environment with operating room lights, surgical monitors, cardiac care equipment, and realistic hospital details, documentary style, natural clinical lighting.",
        image: "./profession/healthcare.jpg",
      },
    },
    {
      pattern: /registered nurse|\brn\b|licensed practical nurse|\blpn\b|nurse|nursing|patient care|clinical|hospital|triage|vital signs/,
      match: {
        title: "Nurse",
        label: "Nursing workplace",
        scene: "providing patient care in a clinical environment",
        prompt:
          "Photorealistic editorial portrait of a nurse in a hospital or clinic, checking patient charts and medical equipment in a realistic care setting, natural clinical lighting, documentary style.",
        image: "./profession/healthcare.jpg",
      },
    },
    {
      pattern: /professional companion|companion caregiver|caregiver|home care|personal care|elder care|senior companion|activities of daily living|companionship/,
      match: {
        title: "Professional Companion",
        label: "Companion care workplace",
        scene: "supporting a client with companionship, daily routines, and personal care coordination",
        prompt:
          "Photorealistic editorial portrait of a professional companion or caregiver in a warm home-care setting, helping an older adult with daily routines, companionship, appointment notes, and safe supportive care context, natural window light, documentary style.",
        image: "./profession/healthcare.jpg",
      },
    },
    {
      pattern: /teacher|educator|professor|instructor|classroom|lesson plan|curriculum|student|school/,
      match: {
        title: "Teacher",
        label: "Education workplace",
        scene: "teaching students in a classroom with lesson materials",
        prompt:
          "Photorealistic editorial portrait of a teacher in a real classroom, standing near a whiteboard with lesson materials, desks, books, and students' work visible, natural daylight, documentary style.",
        image: "./profession/education.jpg",
      },
    },
    {
      pattern: /software engineer|software developer|frontend|backend|full stack|programmer|coding|javascript|typescript|python|react|devops/,
      match: {
        title: "Software Engineer",
        label: "Software engineering workplace",
        scene: "building and reviewing software in a technical workspace",
        prompt:
          "Photorealistic editorial portrait of a software engineer in a focused technical workspace, reviewing code on large monitors with architecture notes and development tools nearby, natural desk lighting, documentary style.",
        image: "./profession/office.jpg",
      },
    },
    {
      pattern: /accountant|accounting|bookkeeper|controller|audit|tax|payroll|reconciliation|general ledger|financial statements/,
      match: {
        title: "Accountant",
        label: "Accounting workplace",
        scene: "reviewing ledgers, reconciliations, and financial statements",
        prompt:
          "Photorealistic editorial portrait of an accountant at a finance desk, reviewing ledgers, reconciliations, spreadsheets, and financial statements with calculator and organized files, natural office lighting, documentary style.",
        image: "./profession/finance.jpg",
      },
    },
    {
      pattern: /project manager|program manager|\bpm\b|scrum master|roadmap|stakeholder|timeline|milestone|requirements|backlog/,
      match: {
        title: "Technology Program Manager",
        label: "Technology program management workplace",
        scene: "coordinating technology operations, cloud delivery, IoT roadmaps, and stakeholder execution plans",
        prompt:
          "Photorealistic editorial portrait of a technology program manager in a modern technical operations workspace, coordinating cloud delivery, IoT platform roadmaps, stakeholder notes, architecture diagrams, kanban boards, and operational dashboards, natural collaborative office lighting, documentary style.",
        image: "./profession/team.jpg",
      },
    },
    {
      pattern: /sales representative|sales rep|account executive|business development|prospecting|pipeline|quota|crm|client meeting/,
      match: {
        title: "Sales Representative",
        label: "Sales workplace",
        scene: "preparing client conversations and pipeline notes",
        prompt:
          "Photorealistic editorial portrait of a sales representative preparing for a client meeting, with CRM pipeline notes, presentation materials, laptop, and realistic conference room context, natural office lighting, documentary style.",
        image: "./profession/business-meeting.jpg",
      },
    },
    {
      pattern: /electrician|electrical|wiring|breaker|circuit|conduit|panel|voltage|journeyman/,
      match: {
        title: "Electrician",
        label: "Electrical trades workplace",
        scene: "working near electrical panels, conduit, and wiring tools",
        prompt:
          "Photorealistic editorial portrait of an electrician in a real job-site environment, inspecting electrical panels, conduit, wiring tools, and safety equipment, natural industrial lighting, documentary style.",
        image: "./profession/construction.jpg",
      },
    },
    {
      pattern: /mechanic|automotive|diesel|vehicle repair|engine|diagnostic|service technician|maintenance technician/,
      match: {
        title: "Mechanic",
        label: "Mechanical trades workplace",
        scene: "diagnosing equipment and working with mechanical tools",
        prompt:
          "Photorealistic editorial portrait of a mechanic in a repair bay, diagnosing equipment with tools, engine components, workbench details, and realistic shop lighting, documentary style.",
        image: "./profession/construction.jpg",
      },
    },
    {
      pattern: /chef|cook|culinary|kitchen|restaurant|food service|catering|menu|prep cook|line cook/,
      match: {
        title: "Chef",
        label: "Culinary workplace",
        scene: "preparing food in a professional kitchen",
        prompt:
          "Photorealistic editorial portrait of a chef in a professional kitchen, preparing ingredients near stainless steel counters, cookware, and active restaurant kitchen details, warm practical lighting, documentary style.",
        image: "./profession/culinary.jpg",
      },
    },
    {
      pattern: /data analyst|business analyst|bi analyst|business intelligence|dashboard|metrics|tableau|power bi|sql|excel reporting/,
      match: {
        title: "Data Analyst",
        label: "Data analysis workplace",
        scene: "analyzing dashboards, reports, and business metrics",
        prompt:
          "Photorealistic editorial portrait of a data analyst reviewing dashboards, spreadsheets, SQL notes, and business metrics on multiple monitors in a focused analytics workspace, natural office lighting, documentary style.",
        image: "./profession/analyst.jpg",
      },
    },
  ];

  return exact.find(({ pattern }) => matches(text, pattern))?.match ?? null;
}

function kindForContent(text: string): ProfessionKind {
  if (matches(text, /sewer|wastewater|water treatment|utility worker|confined space|sanitation|maintenance worker|field technician|pipe|plumber|drain|municipal utility/)) return "field";
  if (matches(text, /construction|carpenter|welder|electrician|hvac|mechanic|technician|installer|foreman|site supervisor|heavy equipment|tradesperson|roofer/)) return "construction";
  if (matches(text, /paralegal|attorney|lawyer|legal|counsel|compliance|contract|litigation|case file|court|discovery|clerk|legal assistant|law firm/)) return "legal";
  if (matches(text, /nurse|nursing|doctor|therap|clinic|health|medical|care|caregiver|companion|home care|surgeon|patient|hospital|pharmacy|dental|veterinary|radiology|ems|paramedic/)) return "healthcare";
  if (matches(text, /engineer|developer|architect|software|data engineer|security|devops|technical|programmer|coding|systems|infrastructure/)) return "engineering";
  if (matches(text, /designer|creative|ux|ui|visual|brand|figma|prototype|art director|illustrator|creative director/)) return "design";
  if (matches(text, /finance|account|bookkeep|investment|financial analyst|controller|bank|audit|tax|payroll|reconciliation|forecast|budget/)) return "finance";
  if (matches(text, /analyst|reporting|dashboard|metrics|business intelligence|data analysis|research|insights|spreadsheet|excel|tableau|power bi/)) return "analyst";
  if (matches(text, /teacher|educat|professor|instructor|coach|training|classroom|curriculum|student|school|academic/)) return "education";
  if (matches(text, /chef|cook|restaurant|culinary|kitchen|server|bartender|hospitality|food service|catering/)) return "culinary";
  if (matches(text, /sales|account executive|customer success|business development|revenue|pipeline|prospecting|quota|crm/)) return "sales";
  if (matches(text, /support|customer service|call center|help desk|ticket|client service|customer care/)) return "customer";
  if (matches(text, /operation|program|project|coordinator|logistics|supply|warehouse|inventory|procurement|dispatch|scheduler|process improvement/)) return "operations";
  if (matches(text, /marketing|growth|content|social|campaign|seo|communications|copywriter|advertising|public relations|email marketing/)) return "marketing";
  if (matches(text, /product|pm|roadmap|strategy|user research|requirements|backlog|stakeholder/)) return "product";
  return "general";
}

const categoryMeta: Record<ProfessionKind, Omit<ProfessionMatch, "confidence">> = {
  field: {
    title: "Field Operations Worker",
    label: "Field operations workplace",
    scene: "performing utility, maintenance, and inspection work in the field",
    prompt: "Photorealistic editorial portrait of a field operations worker in a realistic utility or maintenance environment with safety gear, tools, and job-site details, natural light, documentary style.",
    image: "./profession/sewer-worker.jpg",
  },
  construction: {
    title: "Skilled Trades Professional",
    label: "Skilled trades workplace",
    scene: "working hands-on with job-site tools and materials",
    prompt: "Photorealistic editorial portrait of a skilled trades professional on a realistic job site, with tools, materials, safety gear, and active work context, natural industrial lighting, documentary style.",
    image: "./profession/construction.jpg",
  },
  legal: {
    title: "Legal Professional",
    label: "Legal workplace",
    scene: "reviewing legal documents and case materials in a law office",
    prompt: "Photorealistic editorial portrait of a legal professional in a law office, reviewing case files, legal documents, and research materials, natural window light, documentary style.",
    image: "./profession/legal.jpg",
  },
  healthcare: {
    title: "Healthcare Professional",
    label: "Healthcare workplace",
    scene: "working in a clinical care setting with patient-care tools",
    prompt: "Photorealistic editorial portrait of a healthcare professional in a clinic or hospital setting with patient charts, medical equipment, and realistic care context, natural clinical lighting, documentary style.",
    image: "./profession/healthcare.jpg",
  },
  engineering: {
    title: "Technical Professional",
    label: "Technical workplace",
    scene: "solving technical problems with systems, code, and documentation",
    prompt: "Photorealistic editorial portrait of a technical professional in a modern engineering workspace with monitors, diagrams, systems documentation, and focused problem-solving context, natural desk lighting, documentary style.",
    image: "./profession/office.jpg",
  },
  design: {
    title: "Design Professional",
    label: "Design workplace",
    scene: "developing visual concepts, prototypes, and creative work",
    prompt: "Photorealistic editorial portrait of a design professional in a creative studio with sketches, prototypes, mood boards, and digital design tools, soft natural lighting, documentary style.",
    image: "./profession/team.jpg",
  },
  finance: {
    title: "Finance Professional",
    label: "Finance workplace",
    scene: "reviewing financial models, reports, and business data",
    prompt: "Photorealistic editorial portrait of a finance professional reviewing financial models, spreadsheets, reports, and organized documents at a focused office desk, natural lighting, documentary style.",
    image: "./profession/finance.jpg",
  },
  analyst: {
    title: "Analyst",
    label: "Analysis workplace",
    scene: "working through data, research, dashboards, and reports",
    prompt: "Photorealistic editorial portrait of an analyst reviewing dashboards, research notes, spreadsheets, and business metrics in a realistic analytics workspace, natural office lighting, documentary style.",
    image: "./profession/analyst.jpg",
  },
  education: {
    title: "Education Professional",
    label: "Education workplace",
    scene: "teaching, coaching, or developing learning materials",
    prompt: "Photorealistic editorial portrait of an education professional in a classroom or training environment with lesson materials, whiteboard, books, and student work context, natural daylight, documentary style.",
    image: "./profession/education.jpg",
  },
  sales: {
    title: "Sales Professional",
    label: "Sales workplace",
    scene: "preparing client conversations, CRM notes, and pipeline plans",
    prompt: "Photorealistic editorial portrait of a sales professional preparing for a client conversation in a conference room with CRM notes, proposal materials, and laptop, natural office lighting, documentary style.",
    image: "./profession/business-meeting.jpg",
  },
  operations: {
    title: "Operations Professional",
    label: "Operations workplace",
    scene: "coordinating workflows, schedules, logistics, and delivery details",
    prompt: "Photorealistic editorial portrait of an operations professional coordinating schedules, logistics notes, workflow boards, and process documentation in a realistic workplace, natural office lighting, documentary style.",
    image: "./profession/team.jpg",
  },
  marketing: {
    title: "Marketing Professional",
    label: "Marketing workplace",
    scene: "planning campaigns, content, and audience strategy",
    prompt: "Photorealistic editorial portrait of a marketing professional reviewing campaign boards, content calendars, audience notes, and creative materials in a collaborative office, natural lighting, documentary style.",
    image: "./profession/business-meeting.jpg",
  },
  product: {
    title: "Product Professional",
    label: "Product workplace",
    scene: "reviewing roadmap, user research, and stakeholder decisions",
    prompt: "Photorealistic editorial portrait of a product professional reviewing roadmap notes, user research, wireframes, and stakeholder planning materials in a collaborative workspace, natural lighting, documentary style.",
    image: "./profession/team.jpg",
  },
  culinary: {
    title: "Culinary Professional",
    label: "Culinary workplace",
    scene: "preparing food in a professional kitchen",
    prompt: "Photorealistic editorial portrait of a culinary professional working in a professional kitchen with ingredients, stainless steel counters, cookware, and active restaurant details, warm practical lighting, documentary style.",
    image: "./profession/culinary.jpg",
  },
  customer: {
    title: "Customer Support Professional",
    label: "Customer support workplace",
    scene: "helping customers with tickets, calls, and client communication",
    prompt: "Photorealistic editorial portrait of a customer support professional helping customers with support tickets, headset or laptop, knowledge base notes, and realistic service-team workspace, natural office lighting, documentary style.",
    image: "./profession/business-meeting.jpg",
  },
  general: {
    title: "Profession-Matched Worker",
    label: "Profession-matched workplace",
    scene: "working in a realistic professional environment based on the resume context",
    prompt: "Photorealistic editorial portrait of a worker in a realistic professional environment matched to resume context, with relevant tools, documents, and work setting details, natural lighting, documentary style.",
    image: "./profession/office.jpg",
  },
};

function professionForContent(title: string, description?: string | null): ProfessionMatch {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  const specific = specificProfessionForContent(text);
  if (specific) return { ...specific, confidence: "specific" };

  const kind = kindForContent(text);
  const category = categoryMeta[kind];
  return { ...category, confidence: kind === "general" ? "fallback" : "category" };
}

export function ProfessionVisual({
  title,
  description,
  compact = false,
}: {
  title: string;
  description?: string | null;
  compact?: boolean;
}) {
  const match = professionForContent(title, description);
  const sizeClass = compact ? "h-28" : "h-44";
  const displayTitle = title ? titleCase(title) : match.title;
  const imagePrompt = `${match.prompt} ${NEGATIVE_IMAGE_DIRECTION}`;

  return (
    <figure
      className={`profession-visual relative overflow-hidden rounded-xl border border-border bg-card ${sizeClass}`}
      role="img"
      aria-label={`${match.label} photorealistic image for ${displayTitle}`}
      data-testid="image-profession-report"
      data-profession-confidence={match.confidence}
      data-profession-prompt={imagePrompt}
    >
      <img
        src={match.image}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        loading="eager"
        onError={(event) => {
          event.currentTarget.src = "./profession/office.jpg";
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/76 via-black/28 to-black/12" />
      <figcaption className="absolute inset-x-4 bottom-4">
        <div className="max-w-[420px] rounded-xl border border-white/20 bg-black/48 px-4 py-3 text-white shadow-lg backdrop-blur-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-cyan-100">
            {match.label}
          </div>
          <div className="mt-1 text-sm font-semibold leading-tight">
            {displayTitle}
          </div>
          <div className="mt-1 text-xs text-white/75">
            {match.scene}
          </div>
        </div>
      </figcaption>
    </figure>
  );
}
