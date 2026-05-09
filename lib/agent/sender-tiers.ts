// Pre-classification of email senders by relationship tier.
//
// Built from real analysis of Naomi's inbox (see EMAIL_NEEDS_ANALYSIS.md).
// The triage agent uses these to: (a) hard-filter noise before it ever sees
// the email, (b) prioritize the right things, (c) pick the right tone when
// drafting.

export type Tier =
  | "sabi_business" // Education for Equality / telephony / nonprofit infra
  | "family"
  | "wesleyan"
  | "vox_church"
  | "vendor_outreach" // new vendors / sales / cold introductions
  | "friend"
  | "opportunity" // job alerts, fellowships, scholarships, internships
  | "noise" // promotions, shopping, recurring updates with no engagement
  | "unknown";

// Domains that are pure noise — auto-filtered from the agent's view entirely.
// You replied to ZERO of these in the analyzed window.
const NOISE_DOMAINS = new Set([
  // Job alerts - high volume, never engaged
  "linkedin.com",
  "messages-noreply@linkedin.com",
  "newsletters-noreply@linkedin.com",
  "jobalerts-noreply@linkedin.com",
  "notifications-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
  "glassdoor.com",
  "noreply@glassdoor.com",
  "adzuna.com",
  "no-reply@adzuna.com",
  "candidates.workablemail.com",
  // Shopping
  "members.wayfair.com",
  "us-news.comms.adidas.com",
  "mg.owner.com",
  "doordash.com",
  "no-reply@doordash.com",
  "email.alibaba.com",
  "service.alibaba.com",
  "notice.alibaba.com",
  "sales.alibaba.com",
  "noreply@email.alibaba.com",
  "noreply@service.alibaba.com",
  // Recurring marketing/newsletters with no engagement
  "updates.biblehub.com",
  "newsletter@updates.biblehub.com",
  "jordanraynor.com",
  "hello@jordanraynor.com",
  "insiders.thechosen.tv",
  "travel.wanderu.com",
  "chiku@travel.wanderu.com",
  "getbrick.app",
  "contact@getbrick.app",
  "otter.ai",
  "no-reply@otter.ai",
  "submagic.co",
  "shop-support.samsontech.com",
  "laballey.com",
  "website@laballey.com",
  "bemoacademicconsulting.com",
  "hi@bemoacademicconsulting.com",
  "itr.mail.codecademy.com",
  "learn@itr.mail.codecademy.com",
  // Notification services
  "accounts.bitly.com",
  "no-reply@accounts.bitly.com",
  "update.one.app",
  "mail@update.one.app",
  "notifications.ct.gov",
  "estuarytransit.org",
  "info@estuarytransit.org",
  "f6s.com",
  "commpeak.com",
]);

// Domains that are unambiguously Sabi/Education-for-Equality work.
const SABI_DOMAINS = new Set([
  "africastalking.com",
  "didww.com",
  "connectsip.com",
  "alphatechnologieslimited.com",
  "infotekps.com",
  "linphone.org",
  "sendchamp.com",
  "f6s.com",
]);

// Hetzner is mixed — billing is noise, support tickets are work. Keep visible.
const SABI_LIKELY_DOMAINS = new Set([
  "hetzner.com",
  "info@hetzner.com",
  "support@hetzner.com",
]);

// Specific known people in her life
const FAMILY_EMAILS = new Set([
  "simplysonia30@gmail.com", // Mom (Sonia Ivie)
  "ceo@corruptionobservatory.com", // Dad
]);

const WESLEYAN_INDICATORS = ["wesleyan.edu"];
const VOX_INDICATORS = ["voxchurch.org"];

// Opportunity / fellowship / scholarship signals — usually domain + subject
const OPPORTUNITY_DOMAIN_HINTS = [
  "linkedin.com",
  "glassdoor.com",
  "adzuna.com",
  "fellowship",
  "scholarship",
  "internship",
  "f5hiring",
  "amplitudeinc",
  "workablemail",
];

const OPPORTUNITY_SUBJECT_HINTS = [
  "fellowship",
  "scholarship",
  "internship",
  "fully funded",
  "intern",
  "leadership",
  "programme",
  "apply",
  "summer 2026",
  "summer 2027",
  "hiring",
  "remote ",
];

interface ClassifyInput {
  from: string; // raw "Name <email@domain>"
  subject?: string;
  labels?: string[];
}

interface ClassifyResult {
  tier: Tier;
  domain: string;
  reasoning: string;
}

const SKIP_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
  "SPAM",
  "TRASH",
  "DRAFT",
]);

export function isNoise(input: ClassifyInput): boolean {
  return classifySender(input).tier === "noise";
}

export function classifySender(input: ClassifyInput): ClassifyResult {
  const fromLower = (input.from || "").toLowerCase();
  const email = (fromLower.match(/<([^>]+)>/)?.[1] || fromLower).trim();
  const domain = email.split("@")[1] || "unknown";
  const subject = (input.subject || "").toLowerCase();
  const labels = input.labels || [];

  // Gmail-classified noise wins immediately
  if (labels.some((l) => SKIP_LABELS.has(l))) {
    return {
      tier: "noise",
      domain,
      reasoning: `Gmail labeled as ${labels.find((l) => SKIP_LABELS.has(l))}`,
    };
  }

  if (NOISE_DOMAINS.has(domain) || NOISE_DOMAINS.has(email)) {
    return { tier: "noise", domain, reasoning: "Known recurring noise sender" };
  }

  if (FAMILY_EMAILS.has(email)) {
    return { tier: "family", domain, reasoning: "Family member" };
  }

  if (WESLEYAN_INDICATORS.some((w) => domain.includes(w))) {
    return { tier: "wesleyan", domain, reasoning: "Wesleyan University" };
  }

  if (VOX_INDICATORS.some((w) => domain.includes(w))) {
    return { tier: "vox_church", domain, reasoning: "Vox Church community" };
  }

  if (SABI_DOMAINS.has(domain) || SABI_LIKELY_DOMAINS.has(domain)) {
    return {
      tier: "sabi_business",
      domain,
      reasoning: "Known Sabi/Education-for-Equality vendor or partner",
    };
  }

  // Subject heuristics for opportunity spam
  if (
    OPPORTUNITY_SUBJECT_HINTS.some((h) => subject.includes(h)) ||
    OPPORTUNITY_DOMAIN_HINTS.some((h) => domain.includes(h))
  ) {
    return {
      tier: "opportunity",
      domain,
      reasoning: "Looks like an opportunity/fellowship/internship pitch",
    };
  }

  // Plain gmail.com — could be friend, classmate, or vendor outreach
  if (domain === "gmail.com" || domain === "yahoo.com" || domain === "outlook.com") {
    return {
      tier: "friend",
      domain,
      reasoning: "Personal email account — friend or classmate",
    };
  }

  // Anything else from a corporate-looking domain is probably vendor outreach
  return {
    tier: "vendor_outreach",
    domain,
    reasoning: "Unrecognized sender — likely vendor/sales outreach",
  };
}

// Default priority order — high tiers come first when sorting flagged items
export const TIER_PRIORITY: Record<Tier, number> = {
  sabi_business: 0,
  family: 1,
  wesleyan: 2,
  vox_church: 3,
  friend: 4,
  vendor_outreach: 5,
  opportunity: 6,
  unknown: 7,
  noise: 8,
};

// Tone guidance the drafter uses when it knows the tier
export const TIER_TONE_GUIDANCE: Record<Tier, string> = {
  sabi_business:
    'Use Naomi\'s founder voice. Open with "Dear [Name]," or "Hi [Name]!" depending on familiarity. Be structured — bullets/numbered lists for requirements. Sign off "Best regards, Naomi Ivie / Founder, Education for Equality". Mention nonprofit/education context where relevant — she negotiates pricing this way.',
  family:
    'Warm and natural. She says "Amennn!" / "Congrats in advance mummy!!" to her mom. No formal greetings — direct. May still sign "Yours sincerely, Naomi Ivie." or just first name.',
  wesleyan:
    'Casual-warm. "Hi [first name]!" with the exclamation. Short — she keeps these to 1–3 sentences. Sign off "Yours sincerely, Naomi Ivie."',
  vox_church:
    'Warm community tone. First names. Brief. May reference faith naturally.',
  vendor_outreach:
    'Polite founder tone. Acknowledge their reach-out, share Education for Equality context briefly, ask the focused question (rates / setup / nonprofit pricing). Sign off "Best regards, Naomi Ivie / Founder, Education for Equality".',
  friend:
    'Casual. "Hi [name]!" Brief. May skip sign-off entirely or use just first name.',
  opportunity:
    'These usually do not need replies. If drafting, keep it minimal — likely a "thanks, will review" or a decline.',
  noise: "Should not be drafted to.",
  unknown:
    'Default to her casual register: "Hi [name]!" + brief + "Yours sincerely, Naomi Ivie."',
};
