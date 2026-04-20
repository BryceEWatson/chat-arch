import type { CloudConversation, CloudMessage, CloudProject } from '@chat-arch/schema';
import { buildCloudEntries } from '@chat-arch/analysis';
import type { UploadedCloudData } from '../types.js';

/**
 * In-browser fixture generator used by the "Load Demo Data" button on
 * the empty state. Produces an `UploadedCloudData` shaped identically
 * to a real Settings→Privacy ZIP upload so the rest of the viewer
 * (filters, KPIs, sparkline, duplicates, zombie projects, semantic
 * analyzer, drill-in) just works without any special-case branches.
 *
 * Fixture composition is intentional:
 *
 *   - A wide 240-day date range so the sparkline has shape AND the
 *     zombie project's historical burst sits ≥180 days ago (the
 *     SILENT_ZOMBIE_DAYS threshold in zombiesHeuristic.ts).
 *   - One explicit zombie project (`Codex Archive`) whose conversations
 *     *all* cluster in a single 14-day window ~200 days ago and then
 *     go silent. No `Codex Archive`-titled conversations exist outside
 *     that burst — otherwise the title-match pass in buildCloudEntries
 *     would spray the zombie tag across recent conversations and the
 *     heuristic would never flag it.
 *   - Two explicit duplicate clusters with *byte-identical* first-
 *     human-messages (not just similar titles) so the
 *     buildDuplicateClusters exact-hash pass fires.
 *   - A long singleton pool so the grid / sparkline looks full without
 *     contaminating duplicate-detection with accidental collisions.
 *   - Deterministic — seeded PRNG so the demo looks identical across
 *     reloads (nothing worse than a demo that wobbles between loads
 *     and erodes the user's confidence the UI is actually stable).
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

// ---------- projects -------------------------------------------------------

interface ProjectSeed {
  name: string;
  description: string;
  /**
   * How many conversations should land in this project. Exact — we
   * pre-allocate per-project instead of picking probabilistically so
   * the zombie project gets its whole burst without random drift.
   */
  sessionCount: number;
  zombie?: boolean;
}

// Project names are deliberately fabricated (not derived from any real
// user's claude.ai projects) so the fixture can't be confused with
// actual personal data. Names >5 chars, none on the buildCloudEntries
// denylist, so title-match tagging still fires.
const PROJECT_SEEDS: readonly ProjectSeed[] = [
  { name: 'Bluefin Mobile', description: 'Demo fixture · pretend iOS app for fishing-log tracking.', sessionCount: 12 },
  { name: 'Prism Highlight', description: 'Demo fixture · pretend browser extension for explanatory tooltips.', sessionCount: 10 },
  { name: 'Ledger Dashboard', description: 'Demo fixture · pretend ops dashboard for a multi-tenant SaaS.', sessionCount: 8 },
  { name: 'Relay Rebuild', description: 'Demo fixture · pretend product-rebuild project.', sessionCount: 7 },
  { name: 'SingleHop Pipeline', description: 'Demo fixture · pretend ML notebook + eval harness.', sessionCount: 6 },
  { name: 'Codex Archive', description: 'Demo fixture · abandoned Python refactor (zombie).', sessionCount: 9, zombie: true },
];

// Per-project title + preview templates. Titles contain the project
// name so buildCloudEntries regex-matches them. Preview strings are
// unique per entry — we control duplicate clusters elsewhere.
interface ProjectPrompt {
  title: string;
  preview: string;
}
const PROJECT_PROMPTS: Record<string, readonly ProjectPrompt[]> = {
  'Bluefin Mobile': [
    { title: 'Bluefin Mobile iOS sync-conflict design', preview: 'Designing the CloudKit schema so fishing-log notes sync between paired devices without conflicts.' },
    { title: 'Bluefin Mobile onboarding copy review', preview: 'Can you help tighten the first-run onboarding copy for Bluefin Mobile? Aim for warm + informative.' },
    { title: 'Bluefin Mobile push notification throttling', preview: 'Users complain the daily-tide push fires three times. How do I coalesce across devices?' },
    { title: 'Bluefin Mobile offline mode conflict resolution', preview: 'Offline edits conflict on sync. What\u2019s a reasonable CRDT-ish policy for text fields?' },
    { title: 'Bluefin Mobile widget timer budget', preview: 'WidgetKit reloads are hitting the 15-minute minimum. Any way to push them tighter?' },
    { title: 'Bluefin Mobile TestFlight crash on iOS 18', preview: 'TestFlight build crashes on launch under iOS 18 only. Symbolicated stack shows WidgetKit.' },
    { title: 'Bluefin Mobile App Store description rewrite', preview: 'App Store description feels generic. Help me rewrite it to highlight the offline-first story.' },
    { title: 'Bluefin Mobile CoreData vs SwiftData choice', preview: 'Still on CoreData. SwiftData migration worth it for a 2-person team in 2026?' },
    { title: 'Bluefin Mobile multi-log profile UX', preview: 'Anglers with 4 rigs find the picker cramped. Pattern for a scrollable header swatch?' },
    { title: 'Bluefin Mobile PDF export formatting', preview: 'PDF export for trip reports looks rough. Recommended Swift PDF libs in 2026?' },
    { title: 'Bluefin Mobile paid-tier feature scoping', preview: 'What\u2019s a healthy scope for a first paid tier without killing the free experience?' },
    { title: 'Bluefin Mobile background fetch eligibility', preview: 'Background fetch runs at unpredictable intervals. What actually influences iOS\u2019s eligibility rating?' },
  ],
  'Prism Highlight': [
    { title: 'Prism Highlight tooltip positioning bug', preview: 'The tooltip in Prism Highlight flickers when the highlight spans two lines. Fix ideas?' },
    { title: 'Prism Highlight content-script isolation in Chrome MV3', preview: 'MV3 separates content and background worlds. How do I pass highlighted text selection events through?' },
    { title: 'Prism Highlight streaming response UX', preview: 'Streaming LLM responses into the tooltip — avoid jumpiness as the text grows.' },
    { title: 'Prism Highlight rate-limit fallback copy', preview: 'User hits their quota. What\u2019s a non-annoying way to communicate the limit + next reset?' },
    { title: 'Prism Highlight dark-site contrast audit', preview: 'Tooltip on dark sites looks washed out. Need a contrast strategy that works everywhere.' },
    { title: 'Prism Highlight pricing page rewrite', preview: 'Pricing page converts poorly. Help me restructure around "why" not "what".' },
    { title: 'Prism Highlight Firefox MV3 compatibility', preview: 'Porting Prism Highlight to Firefox. What\u2019s still different about MV3 on FF?' },
    { title: 'Prism Highlight keyboard shortcut conflicts', preview: 'Our shortcut collides with Gmail\u2019s. Detect-and-fallback pattern?' },
    { title: 'Prism Highlight review recovery plan', preview: 'One bad mention sent the 1-star reviews flying. Recovery plan?' },
    { title: 'Prism Highlight i18n plan for non-English highlights', preview: 'Non-English text detection is flaky. Any practical lib for fast language-ID in-browser?' },
  ],
  'Ledger Dashboard': [
    { title: 'Ledger Dashboard p95 latency chart', preview: 'Plotting p95 per tenant over 7d — Grafana query that survives missing data points?' },
    { title: 'Ledger Dashboard alerting thresholds', preview: 'Setting error-rate alert thresholds for the Ledger Dashboard without drowning oncall.' },
    { title: 'Ledger Dashboard cost-per-tenant view', preview: 'Breaking cost down per tenant with usage joined from a separate system.' },
    { title: 'Ledger Dashboard RBAC design', preview: 'Separating view-only vs edit permissions across teams on the Ledger Dashboard.' },
    { title: 'Ledger Dashboard embed widget for Notion', preview: 'Users want to embed the Ledger Dashboard charts into Notion. OEmbed or iframe?' },
    { title: 'Ledger Dashboard incident drill runbook', preview: 'Drafting the runbook when the Ledger Dashboard itself goes down.' },
    { title: 'Ledger Dashboard export to CSV flow', preview: 'Adding CSV export to the Ledger Dashboard — server-side or client-side?' },
    { title: 'Ledger Dashboard SLO definitions', preview: 'Pinning down what "up" means for the Ledger Dashboard. Availability vs freshness?' },
  ],
  'Relay Rebuild': [
    { title: 'Relay Rebuild retention cohorts', preview: 'Need a SQL query for Relay Rebuild weekly retention cohorts grouped by install week.' },
    { title: 'Relay Rebuild pricing experiment design', preview: 'Designing the $4.99 vs $6.99 pricing A/B for Relay Rebuild — how do I avoid variance from seasonality?' },
    { title: 'Relay Rebuild onboarding first-value moment', preview: 'What\u2019s the 60-second first-value path we should optimize for in Relay Rebuild?' },
    { title: 'Relay Rebuild notification cadence tuning', preview: 'Dialing back Relay Rebuild push cadence — what metrics should drive the change?' },
    { title: 'Relay Rebuild android parity tracker', preview: 'Tracking Relay Rebuild feature parity across iOS and Android without a Notion database.' },
    { title: 'Relay Rebuild referral program mechanics', preview: 'Referral incentives for Relay Rebuild that don\u2019t become a fraud magnet.' },
    { title: 'Relay Rebuild support inbox triage', preview: 'Relay Rebuild support email volume doubled. Need a triage pattern for a 1-person team.' },
  ],
  'SingleHop Pipeline': [
    { title: 'SingleHop Pipeline eval harness design', preview: 'Building an eval harness that can run a rubric-judge loop over ~500 prompts. Storage + idempotence questions.' },
    { title: 'SingleHop Pipeline dataset sampling notes', preview: 'Sampling strategy for SingleHop Pipeline — stratified vs weighted vs importance. Trade-offs?' },
    { title: 'SingleHop Pipeline reproducibility concerns', preview: 'Re-running SingleHop Pipeline experiments yields drift despite seeded runs. Culprits?' },
    { title: 'SingleHop Pipeline model-comparison dashboard', preview: 'Side-by-side output diff UI for SingleHop Pipeline results. MDX? Streamlit?' },
    { title: 'SingleHop Pipeline prompt-template versioning', preview: 'Versioning prompt templates used by SingleHop Pipeline without tangling code.' },
    { title: 'SingleHop Pipeline cost burndown', preview: 'Keeping SingleHop Pipeline\u2019s token spend inside a weekly budget without killing throughput.' },
  ],
  // Zombie project — 9 deeply-titled conversations all in a 14-day
  // historical burst. No Codex Archive conversations exist outside
  // that burst, so the title-matcher can't accidentally tag a recent
  // conversation to the zombie project.
  'Codex Archive': [
    { title: 'Codex Archive AST transform for dataclass fields', preview: 'Need Codex Archive to rewrite plain classes with __init__ to @dataclass. AST transform approach?' },
    { title: 'Codex Archive typed-dict migration plan', preview: 'Migrating Codex Archive\u2019s dict-heavy APIs to TypedDict. Where does mypy complain?' },
    { title: 'Codex Archive why is the CI red on 3.12 only', preview: 'Codex Archive passes locally on 3.11/3.10 but the 3.12 CI leg fails — asyncio deprecation?' },
    { title: 'Codex Archive decorator chaining pitfalls', preview: 'Chaining @cached_property with a custom decorator in Codex Archive breaks descriptor lookup. Why?' },
    { title: 'Codex Archive benchmark harness', preview: 'Adding a tiny bench harness to Codex Archive for the ast-walk hot paths. pytest-benchmark or bare timeit?' },
    { title: 'Codex Archive release script rewrite', preview: 'Codex Archive release script still uses twine. Anything better in the 2026 packaging story?' },
    { title: 'Codex Archive docs site stack choice', preview: 'Docs for Codex Archive: MkDocs Material or Sphinx? Small-team preference question.' },
    { title: 'Codex Archive issue triage backlog', preview: 'Codex Archive issue tracker has drifted. Need a one-pass triage protocol.' },
    { title: 'Codex Archive README rewrite for the first release', preview: 'First-release README pass for Codex Archive — highlight the "what this isn\u2019t" section.' },
  ],
};

// ---------- duplicate clusters ---------------------------------------------

/**
 * Byte-identical first-human-messages (the string buildDuplicateClusters
 * hashes) so the exact-duplicate pass fires. Each entry becomes N
 * separate sessions sharing one preview.
 */
interface DuplicateCluster {
  title: string;
  preview: string;
  count: number;
}
const DUPLICATE_CLUSTERS: readonly DuplicateCluster[] = [
  {
    title: 'How do I configure SSH proxy jump for a bastion host?',
    preview:
      'I need to SSH through a bastion host to reach an internal server and keep losing the agent forwarding. What\u2019s the cleanest ~/.ssh/config entry for a ProxyJump setup?',
    count: 3,
  },
  {
    title: 'Setting up webpack 5 in a pnpm workspace monorepo',
    preview:
      'Setting up webpack 5 in a pnpm workspace with shared tsconfig path aliases. Bundle fails with "Cannot find module" — where does the alias config live so both apps and packages pick it up?',
    count: 2,
  },
];

// ---------- singleton topics (fill the remaining grid) ---------------------

// Deliberately vanilla, third-person technical questions. None should
// resemble something a real user might plausibly have asked — no
// personal finance, no specific product niches, no references to the
// chat-archaeologist project itself. If a question could be mistaken
// for the user's own conversation, it doesn't belong here.
//
// These are intentionally structured as THEMATIC CLUSTERS so the
// semantic classifier can emerge ~5–8 topic clusters at its default
// threshold (matching the ~5% topic rate seen on real-world corpora).
// Each cluster below is 4–5 prompts about a shared technical theme
// (Postgres / auth / browser / Docker / k8s / etc.) — similar enough
// to cluster via cosine similarity, distinct enough from the project-
// scoped prompts above so they don't pull into any known project.
const SINGLETON_PROMPTS: readonly ProjectPrompt[] = [
  // — Postgres cluster —
  { title: 'Postgres partition pruning stops after UPDATE', preview: 'Partition pruning stops working after an UPDATE on the partition key in Postgres. What\u2019s the mechanism?' },
  { title: 'Postgres statement-level triggers vs row-level', preview: 'When is a statement-level trigger the right call vs per-row in Postgres for a high-volume audit log?' },
  { title: 'Postgres deadlock diagnosis between batch jobs', preview: 'Tracing a recurrent Postgres deadlock between two batch jobs that don\u2019t obviously share keys.' },
  { title: 'Postgres JSONB indexing selective queries', preview: 'When do GIN, BRIN, or expression indexes actually win on Postgres JSONB columns?' },
  { title: 'Postgres UUID v7 vs serial primary keys', preview: 'UUID v7 as a Postgres PK — what do I lose vs a plain serial bigint column?' },
  // — Auth / identity cluster —
  { title: 'OAuth PKCE for single-page apps', preview: 'Walking through OAuth PKCE for an SPA with no backend — is the auth-code flow still the right default?' },
  { title: 'TOTP secret storage server-side', preview: 'Best practices for storing TOTP shared secrets server-side — KMS envelope, HSM, or plain encrypted-at-rest?' },
  { title: 'JWT vs opaque session tokens', preview: 'JWT bearer tokens vs opaque session ids — when does each actually make sense for a web session?' },
  { title: 'Refresh token rotation security model', preview: 'Refresh-token rotation with reuse detection — what threat model is it protecting against exactly?' },
  { title: 'WebAuthn fallback UX when no authenticator', preview: 'What\u2019s the graceful fallback UX for WebAuthn when a user has no registered authenticator?' },
  // — React + front-end cluster —
  { title: 'React server components best practices', preview: 'When do RSCs vs client components actually reduce bundle size in real apps?' },
  { title: 'React 19 transitions vs deferred values', preview: 'When do startTransition and useDeferredValue meaningfully differ in practice for a React 19 app?' },
  { title: 'React Query offline mutation queue', preview: 'React Query pattern for queueing mutations while offline and replaying on reconnect.' },
  { title: 'React memo, useMemo, useCallback — when to care', preview: 'Concrete checklist for when React memoization actually wins vs adds complexity.' },
  { title: 'React state machine library comparison', preview: 'React state machines in 2026: XState, Zustand FSM, Robot — which has the lowest learning tax?' },
  // — Docker / container cluster —
  { title: 'Why is my Docker image 2 GB', preview: 'Pulled node:alpine and ended up with a 2 GB Docker image. What\u2019s ballooning it?' },
  { title: 'Docker multi-stage build cache busting', preview: 'Docker multi-stage build keeps busting the final-layer cache. Likely culprit?' },
  { title: 'Container image slimming checklist', preview: 'Checklist for slimming a Docker container image past what a node:alpine base buys you.' },
  { title: 'BuildKit remote cache setup', preview: 'Wiring Docker BuildKit remote cache to S3 so CI builds share layers across branches.' },
  // — Kubernetes cluster —
  { title: 'Kubernetes readiness vs liveness probes', preview: 'Team keeps confusing Kubernetes readiness and liveness probes. What\u2019s the canonical explanation?' },
  { title: 'Kubernetes pod priority eviction order', preview: 'Kubernetes pod priority + eviction — what\u2019s the ordering when the node is under memory pressure?' },
  { title: 'Kubernetes NetworkPolicy egress rules', preview: 'Writing Kubernetes NetworkPolicy egress rules without accidentally blocking CoreDNS.' },
  { title: 'Kubernetes HPA custom metrics', preview: 'Scaling Kubernetes deployments on a custom metric via the external-metrics adapter.' },
  // — Testing / reliability cluster —
  { title: 'pytest fixture scoping pitfalls', preview: 'Module-scope pytest fixture got torn down per-test after a dependency-graph refactor. Why?' },
  { title: 'Playwright component tests at scale', preview: 'Keeping Playwright component tests below 10 minutes in CI with 200+ components.' },
  { title: 'Test data factory patterns', preview: 'Factory patterns for integration test data that won\u2019t wedge parallel runs against a shared DB.' },
  { title: 'Debugging a flaky retry loop with exponential backoff', preview: 'Retry loop gives up at 3 attempts when latency spikes. Should I bound max backoff?' },
  // — Observability cluster —
  { title: 'OpenTelemetry traces for a Node worker', preview: 'Instrumenting a background Node worker with OpenTelemetry traces that correlate to HTTP requests.' },
  { title: 'Sentry sampling for high-volume apps', preview: 'Sentry sampling rates for a high-volume app — tail-based vs rate-based, and the cost math.' },
  { title: 'p95 latency chart from Prometheus', preview: 'Plotting p95 latency per service over 7d from Prometheus — a query that survives missing data points.' },
  { title: 'Log sampling before shipping to Loki', preview: 'Sampling application logs before shipping to Loki without losing tail-latency signal.' },
  // — Data streaming cluster —
  { title: 'Streaming NDJSON parser in Node', preview: 'Parsing a multi-GB NDJSON stream in Node without buffering — generator vs transform stream?' },
  { title: 'Async iterators over a large CSV', preview: 'For-await-of usage when streaming a large CSV from fetch in browser JavaScript.' },
  { title: 'Kafka consumer group lag monitoring', preview: 'Alerting on Kafka consumer-group lag without false-positives from rebalances.' },
  // — Language / runtime cluster —
  { title: 'Rust async runtime differences', preview: 'What\u2019s the meaningful difference between tokio and async-std in 2026?' },
  { title: 'Rust generic bounds vs traits as arguments', preview: 'Rust trade-offs between `fn x<T: Trait>` vs `fn x(impl Trait)` vs `dyn Trait`.' },
  { title: 'Rust error handling with anyhow vs thiserror', preview: 'Rust: when to reach for anyhow, when to formalize with thiserror — library vs app line.' },
  { title: 'Kotlin coroutines structured concurrency', preview: 'Coming from Go goroutines — how does structured concurrency in Kotlin change the mental model?' },
  { title: 'Postgres partition-pruning gotchas', preview: 'Partition pruning stops working after an UPDATE on the partition key — why?' },
  { title: 'Better commit-message style for squash merges', preview: 'Team does squash merges. What should the squashed commit title capture vs the body?' },
  { title: 'Figma to Storybook handoff workflow', preview: 'Designers push Figma, engineers build Storybook. How do you keep the two in sync without a ticket graveyard?' },
  { title: 'Debouncing vs throttling the right way', preview: 'UX team wants "smooth" scroll tracking. Debouncing too laggy, throttling drops updates. Hybrid?' },
  { title: 'Explaining monads to a senior backend engineer', preview: 'Senior Python engineer, very skeptical of FP. Path through State/Reader/IO without losing them?' },
  { title: 'Why is my Docker image 2 GB', preview: 'Pulled a node:alpine and somehow ended at 2 GB. What\u2019s ballooning it?' },
  { title: 'Rust generic bounds vs traits as arguments', preview: 'Trade-offs between `fn x<T: Trait>` vs `fn x(impl Trait)` vs `dyn Trait`. Real-world guidance?' },
  { title: 'Bash script portable shebang', preview: 'What\u2019s the most portable #! line for a bash script that needs to run on macOS + Ubuntu + Alpine?' },
  { title: 'React 19 transitions vs deferred values', preview: 'When do startTransition and useDeferredValue meaningfully differ in practice?' },
  { title: 'Designing idempotent webhook handlers', preview: 'What pattern keeps webhook handlers safely idempotent under retry storms?' },
  { title: 'Feature-flag rollout strategies', preview: 'Gradual rollout with a kill switch — what does the modern SRE playbook look like?' },
  { title: 'Cost attribution for multi-tenant SaaS', preview: 'How do I attribute infra cost to individual tenants without polluting app code?' },
  { title: 'OpenTelemetry traces for a Node worker', preview: 'Instrumenting a background worker with OTel traces that correlate to HTTP requests.' },
  { title: 'pytest fixture scoping pitfalls', preview: 'Module-scope fixture got torn down per-test after a dependency graph refactor. Why?' },
  { title: 'Best schema for event sourcing in Postgres', preview: 'Store events as JSONB rows, separate tables per aggregate, or hybrid? Trade-offs?' },
  { title: 'Kubernetes readiness vs liveness probes', preview: 'Team keeps confusing readiness and liveness. Give me the canonical explanation.' },
  { title: 'CSS subgrid for card layouts', preview: 'Using subgrid to align nested cards\u2019 meta rows with the parent grid.' },
  { title: 'Bayesian A/B test vs frequentist', preview: 'When does Bayesian AB actually change the decision vs frequentist with fixed α?' },
  { title: 'SQLite WAL mode on EFS', preview: 'Running SQLite on EFS with WAL enabled — known footguns?' },
  { title: 'TypeScript branded types practical uses', preview: 'Concrete places in app code where branded types pay for their complexity.' },
  { title: 'Zero-downtime deploy with a Postgres migration', preview: 'What does a safe zero-downtime deploy look like when a column rename is needed?' },
  { title: 'Async iterators in browser JavaScript', preview: 'For-await-of usage when streaming a large CSV from fetch.' },
  { title: 'Cloudflare Workers vs Fly.io for a new project', preview: 'CDN-edge runtime or full VM — decision criteria for a small API + static app.' },
  { title: 'Git worktree for parallel PR review', preview: 'Keeping two active worktrees for simultaneous PR review without thrashing the index.' },
  { title: 'Robust markdown rendering for LLM output', preview: 'Sanitizing + rendering LLM markdown with embedded code blocks and tables.' },
];

const MODELS: readonly (string | null)[] = [
  'claude-sonnet-4-5-20251015',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  null,
];

const SUMMARY_TEMPLATES: readonly string[] = [
  'Continued the design discussion on {topic}, settling on a pragmatic default with room to specialize.',
  'Worked through a hands-on example covering {topic}; ended with a working snippet and two open follow-ups.',
  'Multi-session research thread on {topic}. This run consolidated prior notes and proposed next steps.',
  'Debugging session — traced a subtle issue in {topic} to a missing guard in a retry path.',
  '',
];

// ---------- synthesis ------------------------------------------------------

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function makeConversation(
  seed: string,
  title: string,
  preview: string,
  createdAt: number,
  updatedAt: number,
  turns: number,
  summary: string,
): CloudConversation {
  const messages: CloudMessage[] = [];
  let prev = '';
  const baseCreated = isoFromMs(createdAt);
  messages.push({
    uuid: `${seed}-m0`,
    parent_message_uuid: prev,
    sender: 'human',
    text: preview,
    content: [{ type: 'text', text: preview } as never],
    created_at: baseCreated,
    updated_at: baseCreated,
    attachments: [],
    files: [],
  });
  prev = `${seed}-m0`;
  for (let i = 1; i < turns * 2; i += 1) {
    const isHuman = i % 2 === 0;
    const text = isHuman
      ? 'Follow-up: can you expand on the trade-offs?'
      : 'Here\u2019s a summary of the key considerations, with an example.';
    const ts = isoFromMs(createdAt + i * 45_000);
    const uuid = `${seed}-m${i}`;
    messages.push({
      uuid,
      parent_message_uuid: prev,
      sender: isHuman ? 'human' : 'assistant',
      text,
      content: [{ type: 'text', text } as never],
      created_at: ts,
      updated_at: ts,
      attachments: [],
      files: [],
    });
    prev = uuid;
  }
  return {
    uuid: seed,
    name: title,
    summary,
    created_at: baseCreated,
    updated_at: isoFromMs(updatedAt),
    account: { uuid: 'demo-account' },
    chat_messages: messages,
  };
}

export function generateDemoUpload(): UploadedCloudData {
  const rnd = mulberry32(42);
  const now = Date.now();

  // 240d window so the zombie burst (at -200d) is ≥180d and sits
  // inside the bottom of the bucketed sparkline.
  const RECENT_WINDOW_DAYS = 160; // non-zombie conversations spread here
  const ZOMBIE_BURST_CENTER = now - 200 * DAY;
  const ZOMBIE_BURST_SPREAD = 14 * DAY;

  // ----- projects -----
  const projects: CloudProject[] = PROJECT_SEEDS.map((p, i) => ({
    uuid: `demo-proj-${i}`,
    name: p.name,
    description: p.description,
    is_private: false,
    is_starter_project: false,
    prompt_template: '',
    created_at: isoFromMs(now - 260 * DAY),
    updated_at: isoFromMs(now - (p.zombie ? 195 : 14) * DAY),
    creator: { uuid: 'demo-account', full_name: 'Demo User' },
    docs: [],
  }));

  // ----- conversations -----
  //
  // We hand-compose the conversation set rather than sampling so we
  // can guarantee the signal we want: duplicate clusters exist, the
  // zombie project is fully historical, and nothing in the recent
  // window accidentally title-matches a zombie name.
  const conversations: CloudConversation[] = [];
  let nextId = 0;
  const nextSeed = () => `demo-conv-${(nextId++).toString().padStart(3, '0')}`;

  // Pick a random timestamp in the recent window, right-skewed so
  // "recent activity" looks fresher than the edge of the window.
  const recentTimestamp = (): number => {
    const bias = rnd() * rnd();
    return now - bias * RECENT_WINDOW_DAYS * DAY;
  };
  const zombieTimestamp = (): number =>
    ZOMBIE_BURST_CENTER + (rnd() - 0.5) * ZOMBIE_BURST_SPREAD;

  const makeSummary = (topic: string): string => {
    if (rnd() >= 0.6) return '';
    const tpl = SUMMARY_TEMPLATES[Math.floor(rnd() * SUMMARY_TEMPLATES.length)]!;
    return tpl.replace('{topic}', topic);
  };

  // 1) Duplicate clusters — byte-identical preview across N entries.
  //    Spread updatedAt so they don't bunch visually, but keep them
  //    in the recent window so they're not mistaken for zombie
  //    project history.
  for (const cluster of DUPLICATE_CLUSTERS) {
    for (let k = 0; k < cluster.count; k += 1) {
      const updated = recentTimestamp();
      const created = updated - Math.floor(rnd() * 4 * 3600_000);
      conversations.push(
        makeConversation(
          nextSeed(),
          cluster.title,
          cluster.preview,
          created,
          updated,
          1 + Math.floor(rnd() * 8),
          makeSummary(cluster.title.split(' ').slice(0, 3).join(' ')),
        ),
      );
    }
  }

  // 2) Per-project conversations. Zombie projects (Codex Archive) get
  //    zombieTimestamp; everyone else gets recentTimestamp.
  for (const seed of PROJECT_SEEDS) {
    const pool = PROJECT_PROMPTS[seed.name] ?? [];
    for (let k = 0; k < seed.sessionCount && k < pool.length; k += 1) {
      const prompt = pool[k]!;
      const updated = seed.zombie ? zombieTimestamp() : recentTimestamp();
      const created = updated - Math.floor(rnd() * 4 * 3600_000);
      conversations.push(
        makeConversation(
          nextSeed(),
          prompt.title,
          prompt.preview,
          created,
          updated,
          1 + Math.floor(rnd() * 12),
          makeSummary(seed.name),
        ),
      );
    }
  }

  // 3) Singleton fillers — unassigned, unique prompts spread across
  //    the recent window. Fills the grid and gives the sparkline
  //    texture without affecting duplicate/zombie detection.
  for (const prompt of SINGLETON_PROMPTS) {
    const updated = recentTimestamp();
    const created = updated - Math.floor(rnd() * 4 * 3600_000);
    conversations.push(
      makeConversation(
        nextSeed(),
        prompt.title,
        prompt.preview,
        created,
        updated,
        1 + Math.floor(rnd() * 10),
        makeSummary(prompt.title.split(' ').slice(0, 3).join(' ')),
      ),
    );
  }

  const built = buildCloudEntries({ conversations, projects });

  // Synthesize plausible model + cost so MODEL and COST cells aren't
  // all em-dash. Deterministic per-entry seed so refreshes keep the
  // same face.
  const enriched = built.entries.map((e) => {
    const entrySeed = (e.id.length * 17 + (e.updatedAt & 0xffff)) >>> 0;
    const r2 = mulberry32(entrySeed);
    const model = MODELS[Math.floor(r2() * MODELS.length)] ?? null;
    const costUsd = model ? +(r2() * 1.8).toFixed(2) : null;
    const entry = { ...e };
    if (model) entry.model = model;
    if (costUsd !== null) {
      entry.costEstimatedUsd = costUsd;
      entry.costIsEstimate = true;
    }
    return entry;
  });

  return {
    manifest: {
      schemaVersion: 2,
      generatedAt: now,
      counts: {
        cloud: enriched.length,
        cowork: 0,
        'cli-direct': 0,
        'cli-desktop': 0,
      },
      sessions: enriched,
    },
    conversationsById: built.conversationsById,
    projects,
    // Label reads as a data-provenance marker in the upper-panel chip.
    // Avoid "generated" — the content isn't synthesized at runtime, it's
    // a hand-written fixture shipped with the viewer bundle. Timestamps
    // shift per load so the sparkline tracks "today"; everything else
    // is literal strings from source.
    sourceLabel: `DEMO DATA · ${enriched.length} fake conversations (bundled fixture)`,
  };
}
