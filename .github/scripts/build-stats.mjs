// Builds assets/stats/activity.svg and assets/stats/achievements.svg from real GitHub data.
// Runs daily in GitHub Actions (see .github/workflows/stats.yml). No dependencies.
//
//   GITHUB_TOKEN=... node .github/scripts/build-stats.mjs            # live data
//   node .github/scripts/build-stats.mjs --mock path/to/data.json    # local preview

import { readFile, writeFile, mkdir } from "node:fs/promises";

const USER = process.env.PROFILE_USER || "temmy762";
const OUT = new URL("../../assets/stats/", import.meta.url);

// Theme (matches the rest of the profile)
const C = {
  bg: "#071013", border: "#1f3a36", line: "#30363d", fg: "#e6edf3", muted: "#8b949e", soft: "#c3cbd3",
  cyan: "#3ee6c4", cyanDim: "#1c6b5d", amber: "#f2b84b", panel: "#161b22",
};
const SANS = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace";
// Each language keeps its own colour (a colour-blind-safe set checked against the dark card).
const LANG_COLORS = {
  TypeScript: "#3987e5", HTML: "#d95926", JavaScript: "#199e70", CSS: "#c98500", Python: "#d55181", Java: "#9085e9",
};
const OTHER = "#6e7681";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => n.toLocaleString("en-US");

async function fetchData() {
  const mockIdx = process.argv.indexOf("--mock");
  if (mockIdx > -1) return JSON.parse(await readFile(process.argv[mockIdx + 1], "utf8"));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const to = new Date();
  const from = new Date(to); from.setUTCFullYear(from.getUTCFullYear() - 1); from.setUTCDate(1);
  const query = `query($login:String!, $from:DateTime!, $to:DateTime!){
    user(login:$login){
      createdAt
      followers{ totalCount }
      pullRequests{ totalCount }
      repositories(ownerAffiliations:OWNER, privacy:PUBLIC, isFork:false, first:100){ totalCount nodes{ name primaryLanguage{ name } } }
      contributionsCollection(from:$from, to:$to){
        restrictedContributionsCount
        commitContributionsByRepository(maxRepositories:100){ repository{ isPrivate } contributions{ totalCount } }
        issueContributionsByRepository(maxRepositories:100){ repository{ isPrivate } contributions{ totalCount } }
        pullRequestContributionsByRepository(maxRepositories:100){ repository{ isPrivate } contributions{ totalCount } }
        pullRequestReviewContributionsByRepository(maxRepositories:100){ repository{ isPrivate } contributions{ totalCount } }
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
      }
    }}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-stats" },
    body: JSON.stringify({ query, variables: { login: USER, from: from.toISOString(), to: to.toISOString() } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors || body).slice(0, 500));
  const u = body.data.user;
  const cc = u.contributionsCollection;
  // Private work: counts only. Repository names are never read into the output.
  const privateVisible = ["commitContributionsByRepository", "issueContributionsByRepository", "pullRequestContributionsByRepository", "pullRequestReviewContributionsByRepository"]
    .flatMap((k) => cc[k] || [])
    .filter((x) => x.repository?.isPrivate)
    .reduce((sum, x) => sum + (x.contributions?.totalCount || 0), 0);
  return {
    createdAt: u.createdAt,
    followers: u.followers.totalCount,
    pullRequests: u.pullRequests.totalCount,
    repoCount: u.repositories.totalCount,
    repoLanguages: u.repositories.nodes.map((r) => r.primaryLanguage?.name || null),
    days: u.contributionsCollection.contributionCalendar.weeks.flatMap((w) => w.contributionDays),
    total: u.contributionsCollection.contributionCalendar.totalContributions,
    // Contributions made in private repos: counted in the totals, but never named or linked.
    privateCount: (cc.restrictedContributionsCount || 0) + privateVisible,
    generatedAt: to.toISOString(),
  };
}

function svg(w, h, title, inner, style = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>.sans{font-family:${SANS}}.mono{font-family:${MONO}}${style}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>
${inner}
</svg>
`;
}

function card(x, y, w, h) {
  return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="8" fill="${C.bg}" stroke="${C.border}"/>`;
}

function languages(d) {
  const counts = {};
  for (const l of d.repoLanguages) if (l) counts[l] = (counts[l] || 0) + 1;
  let list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const known = list.filter(([n]) => LANG_COLORS[n]);
  const other = list.filter(([n]) => !LANG_COLORS[n]).reduce((s, [, v]) => s + v, 0);
  list = known.slice(0, 6).map(([n, v]) => ({ name: n, value: v, color: LANG_COLORS[n] }));
  const dropped = known.slice(6).reduce((s, [, v]) => s + v, 0);
  if (other + dropped > 0) list.push({ name: "Other", value: other + dropped, color: OTHER });
  return list;
}

// The last 12 complete months (the current, unfinished month is left out).
function monthly(d) {
  const current = (d.generatedAt || new Date().toISOString()).slice(0, 7);
  const map = new Map();
  for (const day of d.days) {
    const k = day.date.slice(0, 7);
    map.set(k, (map.get(k) || 0) + day.contributionCount);
  }
  const keys = [...map.keys()].filter((k) => k < current).sort().slice(-12);
  return keys.map((k) => ({ key: k, label: new Date(k + "-01T00:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }), value: map.get(k) }));
}

// Axis top that splits into 4 whole-number steps (e.g. 0, 70, 140, 210, 280).
function niceMax(v) {
  if (v <= 4) return 4;
  const raw = v / 4, mag = 10 ** Math.floor(Math.log10(raw));
  return Math.ceil(raw / mag) * mag * 4;
}

function activitySvg(d) {
  const W = 840, gap = 12;
  const leftW = 372, rightW = W - leftW - gap, topH = 214;
  const out = [];
  const year = new Date(d.createdAt).getUTCFullYear();
  const langs = languages(d);
  const langTotal = langs.reduce((s, l) => s + l.value, 0);

  // --- At a glance
  out.push(card(0, 0, leftW, topH));
  out.push(`<text x="18" y="32" class="sans" font-size="15" font-weight="700" fill="${C.fg}">At a glance</text>`);
  const kpis = [
    [fmt(d.repoCount), "Public projects"],
    [String(langs.filter((l) => l.name !== "Other").length + (langs.some((l) => l.name === "Other") ? 1 : 0)), "Languages used"],
    [String(year), "On GitHub since"],
    [fmt(d.total), "Contributions, last 12 months"],
  ];
  kpis.forEach(([v, l], i) => {
    const x = 18 + (i % 2) * ((leftW - 36) / 2), y = 64 + Math.floor(i / 2) * 72;
    out.push(`<line x1="${x}" x2="${x + (leftW - 36) / 2 - 14}" y1="${y}" y2="${y}" stroke="${C.line}"/>`,
      `<text x="${x}" y="${y + 32}" class="mono" font-size="26" font-weight="700" fill="${C.fg}">${esc(v)}</text>`,
      `<text x="${x}" y="${y + 52}" class="sans" font-size="12" fill="${C.muted}">${esc(l)}</text>`);
  });

  if (d.privateCount > 0) {
    out.push(`<text x="18" y="${topH - 12}" class="sans" font-size="11" fill="${C.muted}">Includes ${fmt(d.privateCount)} contributions to private projects</text>`);
  }

  // --- Languages donut
  const lx = leftW + gap;
  out.push(card(lx, 0, rightW, topH));
  out.push(`<text x="${lx + 18}" y="32" class="sans" font-size="15" font-weight="700" fill="${C.fg}">Languages across my projects</text>`);
  const cx = lx + 92, cy = 122, R = 66, r = 43, gapRad = langs.length > 1 ? 0.03 : 0;
  let a0 = -Math.PI / 2;
  const pt = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  langs.forEach((l, i) => {
    const a1 = a0 + (l.value / langTotal) * Math.PI * 2;
    const s = a0 + gapRad, e = Math.max(s + 0.001, a1 - gapRad), large = e - s > Math.PI ? 1 : 0;
    if (langs.length === 1) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${l.color}" stroke-width="${R - r}"/>`);
    } else {
      out.push(`<path class="seg" style="animation-delay:${(i * 0.08).toFixed(2)}s" d="M${pt(R, s)}A${R} ${R} 0 ${large} 1 ${pt(R, e)}L${pt(r, e)}A${r} ${r} 0 ${large} 0 ${pt(r, s)}Z" fill="${l.color}"><title>${esc(l.name)}: ${l.value}</title></path>`);
    }
    a0 = a1;
  });
  out.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="mono" font-size="22" font-weight="700" fill="${C.fg}">${langTotal}</text>`,
    `<text x="${cx}" y="${cy + 21}" text-anchor="middle" class="sans" font-size="10.5" fill="${C.muted}">projects</text>`);
  langs.forEach((l, i) => {
    const y = 66 + i * 21, x = lx + 186;
    const pct = Math.round((l.value / langTotal) * 100);
    out.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${l.color}"/>`,
      `<text x="${x + 18}" y="${y}" class="sans" font-size="12.5" fill="${C.fg}">${esc(l.name)}</text>`,
      `<text x="${lx + rightW - 18}" y="${y}" text-anchor="end" class="mono" font-size="12" fill="${C.soft}">${l.value} · ${pct}%</text>`);
  });
  out.push(`<text x="${lx + 18}" y="${topH - 14}" class="sans" font-size="11" fill="${C.muted}">Number of public projects per main language</text>`);

  // --- Contributions per month
  const months = monthly(d);
  const by = topH + gap, bh = 236;
  out.push(card(0, by, W, bh));
  out.push(`<text x="18" y="${by + 32}" class="sans" font-size="15" font-weight="700" fill="${C.fg}">Contributions per month</text>`);
  const L = 54, Rr = W - 30, T = by + 58, B = by + bh - 42;
  const max = niceMax(Math.max(1, ...months.map((m) => m.value)));
  const X = (i) => L + (i * (Rr - L)) / Math.max(1, months.length - 1);
  const Y = (v) => B - (v / max) * (B - T);
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g, y = Y(v);
    out.push(`<line x1="${L}" x2="${Rr}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.line}" ${g ? 'stroke-dasharray="2 4"' : ""}/>`,
      `<text x="${L - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="mono" font-size="11" fill="${C.muted}">${fmt(Math.round(v))}</text>`);
  }
  months.forEach((m, i) => out.push(`<text x="${X(i).toFixed(1)}" y="${B + 22}" text-anchor="middle" class="sans" font-size="11" fill="${C.muted}">${m.label}</text>`));
  const path = months.map((m, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(m.value).toFixed(1)}`).join("");
  const last = months.length - 1;
  out.push(`<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".28"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></linearGradient></defs>`,
    `<path d="${path}L${X(last).toFixed(1)} ${B}L${L} ${B}Z" fill="url(#area)"/>`,
    `<path class="draw" d="${path}" fill="none" stroke="${C.cyan}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>`);
  months.forEach((m, i) => out.push(`<circle cx="${X(i).toFixed(1)}" cy="${Y(m.value).toFixed(1)}" r="${i === last ? 5 : 2.5}" fill="${i === last ? C.cyan : C.bg}" stroke="${C.cyan}" stroke-width="${i === last ? 2 : 1.5}"><title>${m.label}: ${m.value}</title></circle>`));
  const lastLabel = `${fmt(months[last]?.value || 0)} in ${months[last]?.label || ""}`;
  out.push(`<text x="${(X(last) - 10).toFixed(1)}" y="${(Y(months[last]?.value || 0) - 12).toFixed(1)}" text-anchor="end" class="mono" font-size="12" fill="${C.fg}">${esc(lastLabel)}</text>`);
  const updated = new Date(d.generatedAt || Date.now()).toISOString().slice(0, 10);
  out.push(`<text x="${W - 18}" y="${by + 32}" text-anchor="end" class="mono" font-size="11" fill="${C.muted}">updated ${updated}</text>`);

  const H = by + bh;
  const style = `.seg{animation:fade .6s ease-out both}@keyframes fade{from{opacity:0}}.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s ease-out .2s forwards}@keyframes draw{to{stroke-dashoffset:0}}`;
  return svg(W, H, `GitHub activity: ${d.repoCount} public projects, ${d.total} contributions in the last 12 months`, out.join("\n"), style);
}

function rank(value, steps) {
  const names = ["C", "B", "A", "S", "SS"];
  let i = -1;
  steps.forEach((s, k) => { if (value >= s) i = k; });
  return i < 0 ? null : names[i];
}

function achievementsSvg(d) {
  const years = Math.max(0, Math.floor((Date.now() - new Date(d.createdAt)) / 3.156e10));
  const langs = new Set(d.repoLanguages.filter(Boolean)).size;
  const items = [
    ["Projects", d.repoCount, [1, 10, 20, 50, 100]],
    ["Contributions", d.total, [1, 100, 500, 1000, 3000]],
    ["Pull requests", d.pullRequests, [1, 10, 50, 100, 500]],
    ["Languages", langs, [1, 3, 5, 8, 12]],
    ["Experience", years, [1, 2, 4, 6, 10]],
    ["Followers", d.followers, [1, 10, 50, 100, 500]],
  ];
  const W = 840, cw = 130, gap = (W - cw * 6) / 5, H = 132;
  const out = [];
  items.forEach(([label, value, steps], i) => {
    const x = i * (cw + gap), r = rank(value, steps);
    const col = r ? (r.startsWith("S") ? C.amber : r === "A" ? C.cyan : C.soft) : C.line;
    const shown = label === "Experience" ? `${value} yr${value === 1 ? "" : "s"}` : fmt(value);
    out.push(`<g class="t" style="animation-delay:${(i * 0.08).toFixed(2)}s">`,
      `<rect x="${x + 0.5}" y="0.5" width="${cw - 1}" height="${H - 1}" rx="8" fill="${C.bg}" stroke="${C.border}"/>`,
      // trophy cup
      `<path d="M${x + cw / 2 - 16} 20h32v10a16 16 0 0 1-32 0z" fill="${col}"/>`,
      `<path d="M${x + cw / 2 - 16} 24h-6a6 6 0 0 0 6 10M${x + cw / 2 + 16} 24h6a6 6 0 0 1-6 10" fill="none" stroke="${col}" stroke-width="2.5"/>`,
      `<rect x="${x + cw / 2 - 3}" y="45" width="6" height="8" fill="${col}"/><rect x="${x + cw / 2 - 12}" y="53" width="24" height="5" rx="2" fill="${col}"/>`,
      `<text x="${x + cw / 2}" y="37" text-anchor="middle" class="mono" font-size="11" font-weight="800" fill="${C.bg}">${r || ""}</text>`,
      `<text x="${x + cw / 2}" y="84" text-anchor="middle" class="sans" font-size="13" font-weight="700" fill="${C.fg}">${esc(label)}</text>`,
      `<text x="${x + cw / 2}" y="106" text-anchor="middle" class="mono" font-size="13" fill="${C.soft}">${esc(shown)}</text>`,
      `</g>`);
  });
  const style = `.t{animation:up .6s ease-out both}@keyframes up{from{opacity:0;transform:translateY(6px)}}`;
  return svg(W, H, "GitHub achievements", out.join("\n"), style);
}

const data = await fetchData();
await mkdir(OUT, { recursive: true });
await writeFile(new URL("activity.svg", OUT), activitySvg(data));
await writeFile(new URL("achievements.svg", OUT), achievementsSvg(data));
console.log(`Wrote stats for ${USER}: ${data.repoCount} repos, ${data.total} contributions`);
