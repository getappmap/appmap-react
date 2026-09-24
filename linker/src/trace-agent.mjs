// The tracing agent: turn AppMap recordings (this repo's sequence export)
// into two honest, dependency-free views —
//
//   (a) an ASCII call-graph for the terminal, and
//   (b) a GitHub-native mermaid sequence diagram,
//
// and, when given a baseline recording, a BEHAVIOR DIFF that bands
// changed/added steps in amber and removed steps in red, with a one-line
// plain-English "what changed" caption.
//
// Honesty rules this file keeps:
//   - never draw a call that is not in the recording,
//   - never drop a changed/added/removed call to fit a cap,
//   - collapse only *unchanged* subtrees (proven equal by subtreeDigest).
//
// Note on the contract: AppMap v1.2 has no native diff export — no
// diffMode enum, no subtreeDigest field. This repo produces plain v1.2
// maps plus the linker's appmap-links.json. So the agent COMPUTES the
// diff itself from two recordings; the status vocabulary it emits
// (unchanged / added / removed / changed) is defined here, not read from
// the data. See docs/design/05 and docs/design/10.

import { parseTraceparent } from './link.mjs';

// ---------------------------------------------------------------------------
// Model building — the honest sequence tree
// ---------------------------------------------------------------------------

/** Labels that light up the amber highlight band by default (case-insensitive
 * prefix match). security.* is the headline case; extend via options.highlight. */
const DEFAULT_HIGHLIGHT = /^(security|secret|auth|crypto)/i;

const SQL_PREVIEW = 72;

/** Reconstruct the call tree from a flat AppMap event list.
 *
 * Nesting is implied by call/return ordering, but this repo's recorder has no
 * async context (the "async gap", docs/design/01): concurrent `await`s make
 * returns arrive out of LIFO order and interleave calls from different
 * branches. Two rules keep the reconstruction honest under that:
 *
 *  - A return closes **only** the call it names (`parent_id`), wherever that
 *    call sits in the open set — never the calls opened above it. A naive
 *    "pop everything above" would silently drop a concurrent sibling.
 *  - When choosing a new call's parent, skip any open `http_client_request`
 *    frame. A fetch is an async leaf whose only completion is its response;
 *    a call that appears after it is concurrent work, not the fetch's child.
 *    Without this, a second concurrent fetch nests *inside* the first fetch's
 *    subtree and looks like the backend made it.
 *
 * The result never drops a call, but with no async context the parent of a
 * concurrent call is genuinely ambiguous — it may attach to a sibling branch
 * rather than its true caller. That residual imprecision is the async gap,
 * not a bug this layer can close. Returns root nodes { event, return?, children[] }. */
export function buildCallTree(events) {
  const roots = [];
  const byId = new Map();
  const open = []; // ids of calls seen but not yet returned, in call order
  const isFetch = (node) => Boolean(node?.event.http_client_request);
  for (const e of events ?? []) {
    if (e.event === 'call') {
      const node = { event: e, return: undefined, children: [] };
      byId.set(e.id, node);
      let parentId;
      for (let i = open.length - 1; i >= 0; i--) {
        if (isFetch(byId.get(open[i]))) continue; // fetches don't adopt children
        parentId = open[i];
        break;
      }
      if (parentId != null) byId.get(parentId).children.push(node);
      else roots.push(node);
      open.push(e.id);
    } else if (e.event === 'return') {
      const owner = byId.get(e.parent_id);
      if (owner) owner.return = e;
      const idx = open.lastIndexOf(e.parent_id);
      if (idx !== -1) open.splice(idx, 1); // close just this call; tolerate interleaving
    }
  }
  return roots;
}

/** Build a lookup of AppMap labels by "Class.method", read from the
 * classMap (labels live there, not on the call events). */
export function labelIndex(classMap) {
  const index = new Map();
  const walkClass = (cls, pkgLabelPath) => {
    for (const child of cls.children ?? []) {
      if (child.type === 'function') {
        index.set(`${cls.name}.${child.name}`, child.labels ?? []);
      }
    }
  };
  const walk = (node) => {
    if (node.type === 'class') walkClass(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of classMap ?? []) walk(root);
  return index;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function previewSql(sql) {
  const s = normalizeSql(sql);
  return s.length > SQL_PREVIEW ? s.slice(0, SQL_PREVIEW) + '…' : s;
}

/**
 * Build the honest sequence model for one interaction: the frontend call
 * tree, with each linked fetch stitched to its backend request map.
 *
 * @param {object} frontendAppmap the frontend interaction/test map
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.spanToBackend] span-id → backend appmap
 * @returns {object} the root model node
 */
export function buildInteractionModel(frontendAppmap, opts = {}) {
  const spanToBackend = opts.spanToBackend ?? new Map();
  const labels = labelIndex(frontendAppmap.classMap);

  const root = {
    kind: 'interaction',
    actor: 'User',
    target: 'frontend',
    label: frontendAppmap.metadata?.name ?? 'interaction',
    labels: [],
    detail: {},
    children: buildCallTree(frontendAppmap.events).map((n) =>
      frontendNodeToModel(n, labels, spanToBackend),
    ),
  };
  return root;
}

function frontendNodeToModel(node, labels, spanToBackend) {
  const e = node.event;

  if (e.http_client_request) {
    const method = e.http_client_request.request_method;
    const url = e.http_client_request.url;
    const ctx = parseTraceparent(e.http_client_request.headers?.traceparent);
    const status = node.return?.http_client_response?.status_code;
    const backend = ctx?.spanId ? spanToBackend.get(ctx.spanId) : undefined;
    const app = backend?.metadata?.app ?? 'network';
    // The backend subtree is the fetch's "children". buildCallTree treats a
    // fetch as an async leaf, so node.children is normally empty — but keep any
    // frontend calls it did attribute here rather than discarding them, so a
    // call is never silently dropped no matter how the events interleaved.
    const backendKids = backend ? backendChildren(backend, app) : [];
    const strayKids = node.children.map((c) => frontendNodeToModel(c, labels, spanToBackend));
    return {
      kind: 'fetch',
      actor: 'frontend',
      target: app,
      label: `${method} ${pathOf(url)}`,
      labels: ['http'],
      detail: { status: status ?? null, linked: Boolean(backend) },
      children: [...backendKids, ...strayKids],
    };
  }

  const cls = e.defined_class;
  const method = e.method_id;
  const fnLabels = labels.get(`${cls}.${method}`) ?? [];
  return {
    kind: 'call',
    actor: 'frontend',
    target: 'frontend',
    label: `${cls}.${method}`,
    labels: fnLabels,
    detail: {
      exception: node.return?.exceptions?.[0]?.class ?? null,
      returnClass: node.return?.return_value?.class ?? null,
    },
    children: node.children.map((c) => frontendNodeToModel(c, labels, spanToBackend)),
  };
}

/** Model children for a backend request map: its handler calls become
 * app self-messages, its SQL become app→DB messages. The http_server_request
 * root is unwrapped (the fetch arrow already represents the request). */
function backendChildren(backendAppmap, app) {
  const labels = labelIndex(backendAppmap.classMap);
  const roots = buildCallTree(backendAppmap.events);
  const out = [];
  for (const node of roots) {
    if (node.event.http_server_request) {
      for (const child of node.children) out.push(backendNodeToModel(child, app, labels));
    } else {
      out.push(backendNodeToModel(node, app, labels));
    }
  }
  return out;
}

function backendNodeToModel(node, app, labels) {
  const e = node.event;
  if (e.sql_query) {
    return {
      kind: 'sql',
      actor: app,
      target: 'DB',
      label: previewSql(e.sql_query.sql),
      labels: ['sql'],
      detail: { sql: normalizeSql(e.sql_query.sql) },
      children: [],
    };
  }
  const cls = e.defined_class ?? '?';
  const method = e.method_id ?? '?';
  return {
    kind: 'call',
    actor: app,
    target: app,
    label: `${cls}.${method}`,
    labels: labels.get(`${cls}.${method}`) ?? [],
    detail: { exception: node.return?.exceptions?.[0]?.class ?? null },
    children: node.children.map((c) => backendNodeToModel(c, app, labels)),
  };
}

// ---------------------------------------------------------------------------
// Digests — stable identity (for diffing) and subtree equality (for collapse)
// ---------------------------------------------------------------------------

/** Identity of a step, ignoring volatile detail (elapsed, ids, statuses).
 * Two steps with the same nodeDigest are "the same step". */
export function nodeDigest(node) {
  return `${node.kind}|${node.actor}>${node.target}|${node.label}`;
}

/** A step is "materially different" when its own observable outcome differs,
 * even though it is the same step (same nodeDigest). */
function detailDigest(node) {
  const d = node.detail ?? {};
  if (node.kind === 'fetch') return `status=${d.status}|linked=${d.linked}`;
  if (node.kind === 'sql') return `sql=${d.sql}`;
  return `exc=${d.exception ?? ''}|ret=${d.returnClass ?? ''}`;
}

/** FNV-1a 32-bit — a tiny deterministic string hash, no dependencies. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Digest of a whole subtree: own identity + own outcome + ordered child
 * subtreeDigests. Equal subtreeDigests ⇒ the subtree behaved identically,
 * which is exactly when it is safe to collapse in a diff. */
export function subtreeDigest(node) {
  const childPart = (node.children ?? []).map(subtreeDigest).join(',');
  return fnv1a(`${nodeDigest(node)}#${detailDigest(node)}[${childPart}]`);
}

// ---------------------------------------------------------------------------
// Behavior diff — annotate a current model against a baseline model
// ---------------------------------------------------------------------------

/**
 * Diff two interaction models. Returns a new tree whose nodes carry a
 * `status` of 'unchanged' | 'added' | 'removed' | 'changed', plus a
 * summary. Removed steps (present only in the baseline) are spliced back
 * in at their position so nothing is hidden.
 *
 * @returns {{ tree: object, summary: {added:number, removed:number, changed:number, unchanged:number} }}
 */
export function diffModels(baseline, current) {
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  const tree = diffNode(baseline, current, summary);
  return { tree, summary };
}

function diffNode(base, cur, summary) {
  // Fast path: identical subtree ⇒ everything below is unchanged.
  if (base && cur && subtreeDigest(base) === subtreeDigest(cur)) {
    return mark(cur, 'unchanged', summary, /*deep*/ true);
  }

  const node = { ...cur, children: [] };
  node.children = diffChildren(base?.children ?? [], cur.children ?? [], summary);

  const childChanged = node.children.some((c) => c.status !== 'unchanged');
  const outcomeChanged = base ? detailDigest(base) !== detailDigest(cur) : false;
  node.status = outcomeChanged || childChanged ? 'changed' : 'unchanged';
  if (node.status === 'changed') summary.changed++;
  else summary.unchanged++;
  node.outcomeChanged = outcomeChanged;
  return node;
}

/** Order-preserving match of two child lists by nodeDigest (greedy LCS).
 * Unmatched current children are 'added'; unmatched baseline children are
 * 'removed' and spliced in place. */
function diffChildren(baseChildren, curChildren, summary) {
  const result = [];
  const baseDigests = baseChildren.map(nodeDigest);
  const curDigests = curChildren.map(nodeDigest);
  const lcs = lcsMatch(baseDigests, curDigests);
  const matchedCur = new Map(lcs.map(([b, c]) => [c, b]));

  let bi = 0;
  for (let ci = 0; ci < curChildren.length; ci++) {
    if (matchedCur.has(ci)) {
      const bIndex = matchedCur.get(ci);
      // Emit any baseline children skipped before this match as 'removed'.
      while (bi < bIndex) result.push(mark(baseChildren[bi++], 'removed', summary, true));
      bi = bIndex + 1;
      result.push(diffNode(baseChildren[bIndex], curChildren[ci], summary));
    } else {
      result.push(mark(curChildren[ci], 'added', summary, true));
    }
  }
  while (bi < baseChildren.length) result.push(mark(baseChildren[bi++], 'removed', summary, true));
  return result;
}

/** Longest common subsequence of two digest arrays → list of [baseIndex,curIndex]. */
function lcsMatch(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function mark(node, status, summary, deep) {
  summary[status] = (summary[status] ?? 0) + 1;
  const out = { ...node, status };
  out.children = deep
    ? (node.children ?? []).map((c) => markSilently(c, status))
    : node.children ?? [];
  return out;
}

// Descendants of an added/removed/unchanged subtree inherit its status
// without inflating the top-level counts (the subtree is counted once).
function markSilently(node, status) {
  return {
    ...node,
    status,
    children: (node.children ?? []).map((c) => markSilently(c, status)),
  };
}

// ---------------------------------------------------------------------------
// Caption — one line of plain English
// ---------------------------------------------------------------------------

export function captionFor(summary, tree, options = {}) {
  const highlight = options.highlight ?? DEFAULT_HIGHLIGHT;
  const parts = [];
  if (summary.added) parts.push(`${summary.added} added`);
  if (summary.removed) parts.push(`${summary.removed} removed`);
  if (summary.changed) parts.push(`${summary.changed} changed`);
  if (parts.length === 0) return 'No behavior change: every step matched the baseline.';

  // Surface the single most notable step: a highlighted (e.g. security) add
  // wins, then any added cross-lane call, then the first changed outcome.
  const notable = firstNotable(tree, highlight);
  const lead = `Behavior changed — ${parts.join(', ')}.`;
  return notable ? `${lead} ${notable}` : lead;
}

function firstNotable(tree, highlight) {
  let securityAdd = null;
  let addedCrossLane = null;
  let changedOutcome = null;
  const visit = (node) => {
    const isHi = (node.labels ?? []).some((l) => highlight.test(l));
    if (node.status === 'added' && isHi && !securityAdd)
      securityAdd = `New sensitive step: ${node.label} [${node.labels.join(', ')}].`;
    if (node.status === 'added' && node.actor !== node.target && !addedCrossLane)
      addedCrossLane = `New call ${node.actor}→${node.target}: ${node.label}.`;
    if (node.status === 'changed' && node.outcomeChanged && !changedOutcome)
      changedOutcome = `${node.label} now returns a different outcome.`;
    for (const c of node.children ?? []) visit(c);
  };
  visit(tree);
  return securityAdd ?? addedCrossLane ?? changedOutcome;
}

// ---------------------------------------------------------------------------
// ASCII call-graph renderer
// ---------------------------------------------------------------------------

const STATUS_MARK = { added: '+', removed: '-', changed: '~', unchanged: ' ' };

/**
 * Render an ASCII call-graph. In plain mode every step is shown. In diff
 * mode, unchanged subtrees collapse to a "… (N unchanged)" line; changed,
 * added and removed steps are always shown, marked +/-/~.
 */
export function renderAscii(tree, options = {}) {
  const diff = options.diff ?? false;
  const highlight = options.highlight ?? DEFAULT_HIGHLIGHT;
  const lines = [];
  const title = tree.label;
  lines.push(title);
  if (diff && options.caption) lines.push(`  ${options.caption}`);
  lines.push('');

  const renderChildren = (children, prefix) => {
    const visible = collapseUnchanged(children, diff);
    visible.forEach((item, i) => {
      const last = i === visible.length - 1;
      const branch = last ? '└─ ' : '├─ ';
      const childPrefix = prefix + (last ? '   ' : '│  ');
      if (item.collapsed) {
        lines.push(`${prefix}${branch}… (${item.count} unchanged)`);
        return;
      }
      const node = item;
      const mark = diff ? STATUS_MARK[node.status ?? 'unchanged'] : ' ';
      const hi = (node.labels ?? []).some((l) => highlight.test(l)) ? ' ⚠' : '';
      const labelStr = node.labels?.length ? `  [${node.labels.join(', ')}]` : '';
      const outcome = outcomeSuffix(node);
      lines.push(`${prefix}${branch}${mark} ${arrow(node)}${node.label}${labelStr}${outcome}${hi}`);
      renderChildren(node.children ?? [], childPrefix);
    });
  };

  renderChildren(tree.children ?? [], '');
  return lines.join('\n') + '\n';
}

function arrow(node) {
  if (node.kind === 'fetch') return `→ ${node.target}: `;
  if (node.kind === 'sql') return `→ DB: `;
  return '';
}

function outcomeSuffix(node) {
  const d = node.detail ?? {};
  if (node.kind === 'fetch') {
    const s = d.status == null ? '?' : d.status;
    return d.linked ? `  (${s})` : `  (${s}, no backend map)`;
  }
  if (d.exception) return `  !${d.exception}`;
  return '';
}

/** Replace maximal runs of unchanged siblings with a single collapse marker
 * (diff mode only). Non-unchanged nodes are always kept. */
function collapseUnchanged(children, diff) {
  if (!diff) return children;
  const out = [];
  let run = 0;
  for (const child of children) {
    if (child.status === 'unchanged') {
      run++;
    } else {
      if (run) {
        out.push({ collapsed: true, count: run });
        run = 0;
      }
      out.push(child);
    }
  }
  if (run) out.push({ collapsed: true, count: run });
  return out;
}

// ---------------------------------------------------------------------------
// Mermaid sequence-diagram renderer (GitHub-native)
// ---------------------------------------------------------------------------

const AMBER = 'rgb(255, 236, 179)'; // changed / added
const RED = 'rgb(255, 205, 210)'; // removed
const HI_AMBER = 'rgb(255, 224, 130)'; // highlighted label (e.g. security.*)

/**
 * Render a GitHub-native mermaid sequence diagram. Participants are User,
 * frontend, each backend app (first-seen order) and DB. In diff mode,
 * changed/added steps sit in an amber band and removed steps in a red band;
 * a leading `%%` comment and a Note carry the plain-English caption.
 */
export function renderMermaid(tree, options = {}) {
  const diff = options.diff ?? false;
  const highlight = options.highlight ?? DEFAULT_HIGHLIGHT;
  const participants = orderedParticipants(tree);
  const alias = mkAlias(); // per-render, so BE aliases are stable within one diagram
  const lines = ['sequenceDiagram', '  autonumber'];
  for (const p of participants) lines.push(`  participant ${alias(p)} as ${p}`);

  if (options.caption) {
    lines.push(`  %% ${sanitizeComment(options.caption)}`);
    lines.push(`  Note over ${alias(participants[0])},${alias(participants[participants.length - 1])}: ${escapeNote(options.caption)}`);
  }

  // Opening interaction message.
  lines.push(`  ${alias('User')}->>${alias('frontend')}: ${escapeMsg(tree.label)}`);

  const emit = (node, depth) => {
    const band = diff ? bandFor(node.status) : null;
    const hi = !band && (node.labels ?? []).some((l) => highlight.test(l));
    if (band) lines.push(`  rect ${band}`);
    else if (hi) lines.push(`  rect ${HI_AMBER}`);

    const from = alias(node.actor);
    const to = alias(node.target);
    const labelStr = node.labels?.length ? ` [${node.labels.join(', ')}]` : '';
    const msg = escapeMsg(node.label + labelStr + outcomeSuffix(node));
    if (node.kind === 'fetch' || node.kind === 'sql' || node.actor !== node.target) {
      lines.push(`  ${from}->>${to}: ${msg}`);
      const kids = collapseUnchanged(node.children ?? [], diff);
      for (const k of kids) emitItem(k, depth + 1);
      // Return arrow for a real cross-lane round trip.
      if (node.kind === 'fetch') lines.push(`  ${to}-->>${from}: ${node.detail?.status ?? '?'}`);
      else if (node.kind === 'sql') lines.push(`  ${to}-->>${from}: rows`);
    } else {
      // Self-call: show as an activation bar so nesting stays visible.
      lines.push(`  ${from}->>${from}: ${msg}`);
      lines.push(`  activate ${from}`);
      const kids = collapseUnchanged(node.children ?? [], diff);
      for (const k of kids) emitItem(k, depth + 1);
      lines.push(`  deactivate ${from}`);
    }

    if (band || hi) lines.push('  end');
  };

  const emitItem = (item, depth) => {
    if (item.collapsed) {
      lines.push(`  Note over ${alias('frontend')}: … ${item.count} unchanged step(s)`);
      return;
    }
    emit(item, depth);
  };

  for (const item of collapseUnchanged(tree.children ?? [], diff)) emitItem(item, 0);
  return lines.join('\n') + '\n';
}

function bandFor(status) {
  if (status === 'added' || status === 'changed') return AMBER;
  if (status === 'removed') return RED;
  return null;
}

function orderedParticipants(tree) {
  const seen = [];
  const add = (p) => {
    if (!seen.includes(p)) seen.push(p);
  };
  add('User');
  add('frontend');
  let hasDb = false;
  const visit = (node) => {
    if (node.kind === 'fetch') add(node.target);
    if (node.kind === 'sql') hasDb = true;
    for (const c of node.children ?? []) visit(c);
  };
  visit(tree);
  if (hasDb) add('DB');
  return seen;
}

/** A fresh alias resolver per diagram: User/frontend/DB are fixed, each
 * backend app gets a stable BE<n> in first-seen order. */
function mkAlias() {
  const cache = new Map();
  return (name) => {
    if (name === 'User') return 'User';
    if (name === 'frontend') return 'FE';
    if (name === 'DB') return 'DB';
    if (!cache.has(name)) cache.set(name, 'BE' + cache.size);
    return cache.get(name);
  };
}

function escapeMsg(text) {
  return String(text).replace(/[\n\r]+/g, ' ').replace(/;/g, ',').replace(/[<>]/g, '');
}
function escapeNote(text) {
  return String(text).replace(/[\n\r]+/g, ' ').replace(/[:<>]/g, '');
}
function sanitizeComment(text) {
  return String(text).replace(/[\n\r]+/g, ' ');
}

// ---------------------------------------------------------------------------
// One-call convenience: build + (optionally diff) + render both views
// ---------------------------------------------------------------------------

/**
 * @param {object} frontendAppmap current interaction map
 * @param {object} [opts]
 * @param {Map<string,object>} [opts.spanToBackend] current span→backend index
 * @param {object} [opts.baselineAppmap] baseline interaction map (enables diff)
 * @param {Map<string,object>} [opts.baselineSpanToBackend] baseline index
 * @param {RegExp} [opts.highlight] label highlight matcher
 * @returns {{ model, diff?, caption?, ascii, mermaid }}
 */
export function renderInteraction(frontendAppmap, opts = {}) {
  const highlight = opts.highlight ?? DEFAULT_HIGHLIGHT;
  const model = buildInteractionModel(frontendAppmap, { spanToBackend: opts.spanToBackend });

  if (opts.baselineAppmap) {
    const baseModel = buildInteractionModel(opts.baselineAppmap, {
      spanToBackend: opts.baselineSpanToBackend ?? new Map(),
    });
    const { tree, summary } = diffModels(baseModel, model);
    const caption = captionFor(summary, tree, { highlight });
    return {
      model,
      diff: { tree, summary },
      caption,
      ascii: renderAscii(tree, { diff: true, caption, highlight }),
      mermaid: renderMermaid(tree, { diff: true, caption, highlight }),
    };
  }

  return {
    model,
    ascii: renderAscii(model, { diff: false, highlight }),
    mermaid: renderMermaid(model, { diff: false, highlight }),
  };
}

/** Build the span-id → backend appmap index the model builder needs, from a
 * set of scanned maps (the same {path, appmap} shape scan.mjs returns). */
export function backendIndex(maps) {
  const index = new Map();
  for (const m of maps) {
    const span = m.appmap?.metadata?.parent_span_id;
    if (span) index.set(span, m.appmap);
  }
  return index;
}
