// Instagram Analytics – two paths into the same dashboard:
//   1) "Live" via Facebook Login + Instagram Graph API (requires Meta app)
//   2) "Export" via Instagram's JSON data export .zip (no API)

const GRAPH = "https://graph.facebook.com/v19.0";
const LS_APPID = "ig_analytics_appid_v1";
const LS_CONFIGID = "ig_analytics_configid_v1";
const FB_SCOPE_VARIANTS = [
  ["instagram_business_basic", "instagram_business_manage_insights", "pages_show_list", "pages_read_engagement", "business_management"],
  ["instagram_basic", "instagram_manage_insights", "pages_show_list", "pages_read_engagement", "business_management"],
  ["pages_show_list", "pages_read_engagement"],
];
let fbSdkReady = false;
let currentMode = "lookup";

const $ = (id) => document.getElementById(id);
const fmt = (n) => {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
};
const fmtDate = (ts) =>
  ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

let charts = { growth: null, activity: null, engagement: null, reach: null };

// ---------- UI ----------
function setConnected(connected, label) {
  const pill = $("connection-pill");
  pill.classList.remove("hidden");
  pill.innerHTML = connected
    ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>${label || "Loaded"}</span>`
    : '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span><span>No data loaded</span>';
  $("reset-btn").classList.toggle("hidden", !connected);
}
function showError(msg) {
  $("error-box").classList.remove("hidden");
  $("error-msg").textContent = msg;
}
function hideError() {
  $("error-box").classList.add("hidden");
}
function showLoading(text, sub) {
  $("loading-state").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
  $("upload-panel").classList.add("hidden");
  $("loading-text").textContent = text || "Reading your export…";
  $("loading-sub").textContent = sub || "";
}
function hideLoading() {
  $("loading-state").classList.add("hidden");
}
function resetUI() {
  $("upload-panel").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
  hideError();
  setConnected(false);
  $("file-input").value = "";
}

// ---------- zip + json helpers ----------
async function readJsonEntry(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  try {
    return JSON.parse(await file.async("string"));
  } catch (e) {
    console.warn("bad json:", path, e);
    return null;
  }
}

function findEntries(zip, predicate) {
  const matches = [];
  zip.forEach((relPath, file) => {
    if (!file.dir && predicate(relPath)) matches.push(relPath);
  });
  return matches;
}

async function readAllJson(zip, predicate) {
  const paths = findEntries(zip, predicate);
  const out = [];
  for (const p of paths) {
    const j = await readJsonEntry(zip, p);
    if (j) out.push({ path: p, data: j });
  }
  return out;
}

// Instagram export format: most lists are arrays of items shaped like
//   { title: "", string_list_data: [{ href, value, timestamp }] }
// where `value` is the username and `timestamp` is when the action happened.
function extractEntries(node) {
  // node can be: array of items, or { key: array } wrapper
  let items = [];
  if (Array.isArray(node)) items = node;
  else if (node && typeof node === "object") {
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        items = v;
        break;
      }
    }
  }
  const out = [];
  for (const item of items) {
    const sld = item?.string_list_data;
    if (Array.isArray(sld) && sld.length) {
      const first = sld[0];
      out.push({
        username: first.value || item.title || "",
        href: first.href || "",
        timestamp: first.timestamp || 0,
      });
    } else if (item?.title) {
      out.push({ username: item.title, href: "", timestamp: 0 });
    }
  }
  return out.filter((x) => x.username);
}

// ---------- HTML parsing helpers (for non-JSON exports) ----------
async function readTextEntry(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  try {
    return await file.async("string");
  } catch (e) {
    console.warn("read fail:", path, e);
    return null;
  }
}

// Matches IG's HTML date formats:
//   "May 18, 2026 1:58 am"
//   "Oct 28, 2024 at 5:23:11 PM"
//   "2024-10-28T17:23:11"
const HTML_DATE_RX =
  /(\w{3,9}\s+\d{1,2},?\s*\d{4}(?:\s+at)?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?)|(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/;

// Skip Instagram path segments that aren't usernames
const IG_PATH_SKIP = new Set([
  "i", "p", "reel", "reels", "stories", "tv", "accounts",
  "explore", "direct", "_u", "_n", "web", "legal", "about", "developer",
]);

function extractUsernameFromHref(href) {
  if (!href) return null;
  // strip any leading "https://www.instagram.com/" and trailing slash
  const m = href.match(/instagram\.com\/(?:_u\/|_n\/)?([\w.]+)/);
  if (!m) return null;
  const u = m[1];
  if (IG_PATH_SKIP.has(u.toLowerCase())) return null;
  if (u.length < 1 || u.length > 30) return null;
  return u;
}

function parseHtmlPeopleList(html) {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const entries = [];
  const seen = new Set();

  // Each row is a <div class="pam _3-95 ..."> containing the user link + date.
  // We iterate row-by-row so we get the username paired with its date.
  const rows = doc.querySelectorAll("div.pam, div._a6-g");
  let rowList = rows.length ? Array.from(rows) : Array.from(doc.querySelectorAll('a[href*="instagram.com/"]')).map((a) => a.closest("div") || a);

  for (const row of rowList) {
    // Find the row's user link (or the row IS a link)
    let link = row.tagName === "A" ? row : row.querySelector('a[href*="instagram.com/"]');
    if (!link) continue;
    const username = extractUsernameFromHref(link.getAttribute("href") || "");
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Date is usually a sibling div text node within the same row
    let timestamp = 0;
    const text = (row.textContent || "").trim();
    const dm = HTML_DATE_RX.exec(text);
    if (dm) {
      const t = Date.parse(dm[1] || dm[2]);
      if (!isNaN(t)) timestamp = Math.floor(t / 1000);
    }
    entries.push({ username, href: link.getAttribute("href") || "", timestamp });
  }
  return entries;
}

function parseHtmlPosts(html, fileKind) {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const posts = [];
  const seenKeys = new Set();

  // IG HTML posts are nested as <div class="pam ..."> rows, each containing:
  //   <h2 class="...">CAPTION</h2>
  //   <video src="..."> or <img src="...">
  //   <div class="_3-94 _a6-o">DATE STRING</div>
  const rows = doc.querySelectorAll("div.pam, div._a6-g");
  for (const row of rows) {
    const h2 = row.querySelector("h2");
    const dateDiv = row.querySelector("div._a6-o") || row;
    const videos = row.querySelectorAll("video, a[href$='.mp4'], a[href$='.mov']");
    const imgs = row.querySelectorAll("img");

    const caption = (h2?.textContent || "").trim();
    const dateText = (dateDiv?.textContent || "").trim();
    const dm = HTML_DATE_RX.exec(dateText) || HTML_DATE_RX.exec(row.textContent || "");
    if (!dm) continue;
    const tsRaw = Date.parse(dm[1] || dm[2]);
    if (isNaN(tsRaw)) continue;
    const timestamp = Math.floor(tsRaw / 1000);

    // skip files that are clearly Instagram chrome (logo, header img)
    const mediaImgs = Array.from(imgs).filter(
      (i) => !/Instagram-Logo|files\/Instagram-Logo/.test(i.getAttribute("src") || "")
    );

    const isVideo = videos.length > 0 || (fileKind === "reel");
    const mediaType =
      fileKind === "story"
        ? "Story"
        : isVideo
        ? fileKind === "reel"
          ? "Reel"
          : "Video"
        : mediaImgs.length > 1
        ? "Carousel"
        : "Image";

    const key = timestamp + "_" + caption.slice(0, 30);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    posts.push({
      caption,
      timestamp,
      mediaType,
      media: mediaImgs.map((i) => ({ uri: i.getAttribute("src") || "" })),
    });
  }
  return posts;
}

// Extracts usernames from table-cell rows of the form
//    <td>LABEL</td><td>VALUE</td>
// Used for liked_posts (looks for "Username" inside an Owner block) and post_comments
// (looks for "Media Owner").
function parseHtmlTableLabelList(html, label) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  const tds = doc.querySelectorAll("td");
  const ll = label.toLowerCase();
  for (let i = 0; i < tds.length - 1; i++) {
    const cellText = (tds[i].textContent || "").trim().toLowerCase();
    if (cellText !== ll) continue;
    // value can be in the next sibling td OR nested inside this td after the label
    let valueText = (tds[i + 1]?.textContent || "").trim();
    if (!valueText) {
      // some IG HTML puts <td>Label<div>VALUE</div></td> — fall back to inner div
      const inner = tds[i].querySelector("div");
      if (inner) valueText = (inner.textContent || "").trim();
    }
    const username = valueText.split(/\s+/)[0];
    if (!/^[\w.]{1,30}$/.test(username)) continue;
    // find a nearby date by walking up the DOM
    let timestamp = 0;
    let node = tds[i].closest("div.pam") || tds[i].parentElement;
    let hops = 0;
    while (node && hops < 6 && !timestamp) {
      const dm = HTML_DATE_RX.exec(node.textContent || "");
      if (dm) {
        const t = Date.parse(dm[1] || dm[2]);
        if (!isNaN(t)) timestamp = Math.floor(t / 1000);
      }
      node = node.parentElement;
      hops++;
    }
    out.push({ username, timestamp });
  }
  return out;
}

function parseHtmlCommentsReceived(html) {
  // post_comments_X.html → rows with "Media Owner" label
  return parseHtmlTableLabelList(html, "Media Owner");
}

function parseHtmlLikedPostsOwners(html) {
  // liked_posts.html → rows with "Username" labels (inside nested Owner blocks)
  return parseHtmlTableLabelList(html, "Username");
}

// ---------- parsing ----------
async function parseExport(file) {
  showLoading("Reading your export…", file.name);
  const zip = await JSZip.loadAsync(file);

  // detect what format(s) the export uses
  const jsonCount = findEntries(zip, (p) => /\.json$/i.test(p)).length;
  const htmlCount = findEntries(zip, (p) => /\.html$/i.test(p) && !/^\s*_/.test(p)).length;
  const hasJson = jsonCount > 0;
  const hasHtml = htmlCount > 0;

  // ---- followers ----
  showLoading(`Parsing followers… (${hasJson ? "JSON" : ""}${hasJson && hasHtml ? " + " : ""}${hasHtml ? "HTML" : ""})`);
  let followers = [];
  if (hasJson) {
    const followerFiles = findEntries(zip, (p) => /followers(_\d+)?\.json$/i.test(p) && !/pending/i.test(p));
    for (const p of followerFiles) {
      const data = await readJsonEntry(zip, p);
      if (data) followers = followers.concat(extractEntries(data));
    }
  }
  if (!followers.length && hasHtml) {
    const followerHtmls = findEntries(zip, (p) => /followers(_\d+)?\.html$/i.test(p) && !/pending/i.test(p));
    for (const p of followerHtmls) {
      const html = await readTextEntry(zip, p);
      followers = followers.concat(parseHtmlPeopleList(html));
    }
  }
  followers = dedupe(followers);

  // ---- following ----
  showLoading("Parsing following…");
  let following = [];
  if (hasJson) {
    const followingPaths = findEntries(zip, (p) => /following\.json$/i.test(p) && !/hashtag/i.test(p));
    for (const p of followingPaths) {
      const data = await readJsonEntry(zip, p);
      if (data) following = following.concat(extractEntries(data));
    }
  }
  if (!following.length && hasHtml) {
    const followingHtmls = findEntries(zip, (p) => /following\.html$/i.test(p) && !/hashtag/i.test(p));
    for (const p of followingHtmls) {
      const html = await readTextEntry(zip, p);
      following = following.concat(parseHtmlPeopleList(html));
    }
  }
  following = dedupe(following);

  // ---- posts ----
  showLoading("Parsing posts…");
  let posts = [];
  if (hasJson) {
    const postFiles = findEntries(zip, (p) => /content\/posts(_\d+)?\.json$/i.test(p) || /\/posts_\d+\.json$/i.test(p));
    for (const p of postFiles) {
      const data = await readJsonEntry(zip, p);
      if (Array.isArray(data)) posts = posts.concat(data.map(normalizePost));
    }
    const reelFiles = findEntries(zip, (p) => /content\/reels\.json$/i.test(p));
    for (const p of reelFiles) {
      const data = await readJsonEntry(zip, p);
      const arr = Array.isArray(data) ? data : data?.ig_reels_media || [];
      posts = posts.concat(arr.map((r) => normalizePost(r, "reel")));
    }
  }
  if (!posts.length && hasHtml) {
    // IG's HTML export puts media here:
    //   your_instagram_activity/media/{reels,stories,other_content,archived_posts,reposts}.html
    //   content/posts_X.html (older exports)
    const postSources = [
      { rx: /your_instagram_activity\/media\/reels\.html$/i, kind: "reel" },
      { rx: /your_instagram_activity\/media\/other_content\.html$/i, kind: "post" },
      { rx: /your_instagram_activity\/media\/archived_posts\.html$/i, kind: "post" },
      { rx: /your_instagram_activity\/media\/reposts\.html$/i, kind: "post" },
      { rx: /your_instagram_activity\/media\/stories\.html$/i, kind: "story" },
      { rx: /content\/(posts_\d+|reels|stories|igtv|archived_posts)\.html$/i, kind: "post" },
    ];
    for (const src of postSources) {
      const paths = findEntries(zip, (p) => src.rx.test(p));
      for (const p of paths) {
        const html = await readTextEntry(zip, p);
        posts = posts.concat(parseHtmlPosts(html, src.kind));
      }
    }
  }
  posts.sort((a, b) => b.timestamp - a.timestamp);

  // ---- likes you gave ----
  showLoading("Parsing your likes…");
  let likedAccounts = [];
  if (hasJson) {
    const likedPosts = await readJsonEntry(
      zip,
      findEntries(zip, (p) => /liked_posts\.json$/i.test(p))[0]
    );
    likedAccounts = extractEntries(likedPosts?.likes_media_likes || likedPosts || []);
  }
  if (!likedAccounts.length && hasHtml) {
    const likedHtmls = findEntries(zip, (p) => /liked_posts\.html$/i.test(p));
    for (const p of likedHtmls) {
      const html = await readTextEntry(zip, p);
      likedAccounts = likedAccounts.concat(parseHtmlLikedPostsOwners(html));
    }
  }

  // ---- comments you wrote ----
  showLoading("Parsing your comments…");
  let commented = [];
  if (hasJson) {
    const commentFiles = findEntries(zip, (p) =>
      /comments\/(post_comments|reels_comments|story_comments)(_\d+)?\.json$/i.test(p)
    );
    for (const p of commentFiles) {
      const data = await readJsonEntry(zip, p);
      const arr = Array.isArray(data) ? data : Object.values(data || {})[0] || [];
      for (const item of arr) {
        const sm = item?.string_map_data || {};
        const owner =
          sm["Media Owner"]?.value ||
          sm["Propriétaire du média"]?.value ||
          sm["Owner"]?.value || "";
        const ts = sm["Time"]?.timestamp || sm["Heure"]?.timestamp || 0;
        if (owner) commented.push({ username: owner, timestamp: ts });
      }
    }
  }
  if (!commented.length && hasHtml) {
    const commentHtmls = findEntries(zip, (p) =>
      /comments\/(post_comments|reels_comments|story_comments)(_\d+)?\.html$/i.test(p)
    );
    for (const p of commentHtmls) {
      const html = await readTextEntry(zip, p);
      commented = commented.concat(parseHtmlCommentsReceived(html));
    }
  }

  // ---- profile (username, bio if present) ----
  showLoading("Parsing profile…");
  let username = "";
  let bio = "";
  if (hasJson) {
    const personalPaths = findEntries(zip, (p) => /personal_information\.json$/i.test(p));
    for (const p of personalPaths) {
      const data = await readJsonEntry(zip, p);
      const items =
        data?.profile_user || data?.profile_account_insights || (Array.isArray(data) ? data : []);
      for (const it of items || []) {
        const sm = it?.string_map_data || {};
        username =
          username ||
          sm["Username"]?.value ||
          sm["Nom d'utilisateur"]?.value ||
          sm["Name"]?.value ||
          it?.title ||
          "";
        bio = bio || sm["Bio"]?.value || sm["Biographie"]?.value || "";
      }
    }
  }
  if (!username && hasHtml) {
    const personalHtmls = findEntries(zip, (p) => /personal_information\.html$/i.test(p));
    for (const p of personalHtmls) {
      const html = await readTextEntry(zip, p);
      if (!html) continue;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = doc.body?.textContent || "";
      const um = text.match(/Username[:\s]+([\w.]+)/i) || text.match(/Nom d'utilisateur[:\s]+([\w.]+)/i);
      if (um && !username) username = um[1];
      const bm = text.match(/(?:Bio|Biographie)[:\s]+([^\n]{2,200})/i);
      if (bm && !bio) bio = bm[1].trim();
    }
  }
  // fallback: guess from zip name "instagram-USERNAME-DATE.zip"
  if (!username && file.name) {
    const m = file.name.match(/instagram-([a-z0-9_.]+)/i);
    if (m) username = m[1];
  }

  return {
    followers,
    following,
    posts,
    likedAccounts,
    commented,
    username,
    bio,
    _format: hasJson ? (hasHtml ? "JSON + HTML" : "JSON") : (hasHtml ? "HTML" : "unknown"),
  };
}

function normalizePost(p, kind = "post") {
  const media = Array.isArray(p.media) ? p.media : [];
  const caption = (p.title || media[0]?.title || "").trim();
  const ts = p.creation_timestamp || media[0]?.creation_timestamp || 0;
  const mediaType = kind === "reel" ? "Reel" : media.length > 1 ? "Carousel" : guessMediaType(media[0]?.uri);
  return { caption, timestamp: ts, mediaType, media };
}
function guessMediaType(uri) {
  if (!uri) return "Post";
  if (/\.(mp4|mov)$/i.test(uri)) return "Video";
  if (/\.(jpg|jpeg|png|webp|heic)$/i.test(uri)) return "Image";
  return "Post";
}
function dedupe(arr) {
  const seen = new Map();
  for (const x of arr) {
    const k = x.username.toLowerCase();
    if (!seen.has(k) || (x.timestamp && !seen.get(k).timestamp)) seen.set(k, x);
  }
  return Array.from(seen.values());
}

// ---------- analytics ----------
function computeAnalytics(d) {
  const followersSet = new Set(d.followers.map((x) => x.username.toLowerCase()));
  const followingSet = new Set(d.following.map((x) => x.username.toLowerCase()));

  const dontFollowBack = d.following.filter((x) => !followersSet.has(x.username.toLowerCase()));
  const fans = d.followers.filter((x) => !followingSet.has(x.username.toLowerCase()));
  const mutuals = d.followers.filter((x) => followingSet.has(x.username.toLowerCase()));

  // engagement: combine likes + comments you gave, count per target account
  const engagement = new Map();
  for (const x of d.likedAccounts) {
    if (!x.username) continue;
    const k = x.username.toLowerCase();
    engagement.set(k, (engagement.get(k) || 0) + 1);
  }
  for (const x of d.commented) {
    if (!x.username) continue;
    const k = x.username.toLowerCase();
    engagement.set(k, (engagement.get(k) || 0) + 2); // weight comments x2
  }
  const topEngagers = Array.from(engagement.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([username, score]) => ({ username, score }));

  // hashtags
  const tagCount = new Map();
  for (const p of d.posts) {
    const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
    for (const t of tags) {
      const k = t.toLowerCase();
      tagCount.set(k, (tagCount.get(k) || 0) + 1);
    }
  }
  const topTags = Array.from(tagCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  return { dontFollowBack, fans, mutuals, topEngagers, topTags };
}

// ---------- render ----------
function renderProfile(d) {
  $("profile-name").textContent = d.username ? "@" + d.username : "Your account";
  $("profile-username").textContent = d.username ? "@" + d.username : "";
  $("profile-bio").textContent = d.bio || "";
  $("stat-media").textContent = fmt(d.posts.length);
  $("stat-followers-small").textContent = fmt(d.followers.length);
  $("stat-follows").textContent = fmt(d.following.length);
}

function renderHeadlineStats(d, a) {
  $("stat-nofollowback").textContent = fmt(a.dontFollowBack.length);
  $("stat-fans").textContent = fmt(a.fans.length);
  $("stat-mutuals").textContent = fmt(a.mutuals.length);
  const ratio = d.following.length ? (d.followers.length / d.following.length).toFixed(2) : "—";
  $("stat-ratio").textContent = ratio;
}

function renderUserList(elId, items, opts = {}) {
  const el = $(elId);
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = '<p class="text-xs text-slate-500 py-2">No data.</p>';
    return;
  }
  items.forEach((x) => {
    const row = document.createElement("a");
    row.href = x.username ? `https://www.instagram.com/${x.username}` : "#";
    row.target = "_blank";
    row.rel = "noreferrer";
    row.className =
      "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition group";
    const right = opts.right ? opts.right(x) : x.timestamp ? fmtDate(x.timestamp) : "";
    row.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-fuchsia-500/30 to-amber-400/30 flex items-center justify-center shrink-0">
          <i data-lucide="user" class="w-3.5 h-3.5 text-fuchsia-200"></i>
        </div>
        <span class="text-sm truncate">@${x.username}</span>
      </div>
      <span class="text-xs text-slate-500 group-hover:text-fuchsia-300 transition whitespace-nowrap">${right}</span>
    `;
    el.appendChild(row);
  });
  lucide.createIcons();
}

function renderFollowerGrowthChart(followers) {
  const ctx = $("follower-growth-chart").getContext("2d");
  // bucket by month
  const buckets = new Map();
  for (const f of followers) {
    if (!f.timestamp) continue;
    const d = new Date(f.timestamp * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const sorted = Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let cumulative = 0;
  const labels = [];
  const data = [];
  for (const [k, v] of sorted) {
    cumulative += v;
    labels.push(
      new Date(k + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" })
    );
    data.push(cumulative);
  }
  if (charts.growth) charts.growth.destroy();
  charts.growth = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Cumulative followers",
          data,
          borderColor: "#ec4899",
          backgroundColor: "rgba(236,72,153,0.18)",
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
      ],
    },
    options: chartOpts(),
  });
}

function renderPostingActivityChart(posts) {
  const ctx = $("posting-activity-chart").getContext("2d");
  const buckets = new Map();
  for (const p of posts) {
    if (!p.timestamp) continue;
    const d = new Date(p.timestamp * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const sorted = Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sorted.map(([k]) =>
    new Date(k + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" })
  );
  const data = sorted.map(([, v]) => v);
  if (charts.activity) charts.activity.destroy();
  charts.activity = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Posts", data, backgroundColor: "rgba(251,191,36,0.6)", borderRadius: 4 },
      ],
    },
    options: chartOpts(),
  });
}

function chartOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#cbd5e1", font: { size: 11 }, boxWidth: 10 } },
      tooltip: {
        backgroundColor: "rgba(0,0,0,0.85)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        titleColor: "#fff",
        bodyColor: "#cbd5e1",
        padding: 10,
      },
    },
    scales: {
      x: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
      y: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
    },
  };
}

function renderPostsTable(posts) {
  $("posts-table-head").innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-white/5">
      <th class="py-2 pr-3">#</th>
      <th class="py-2 px-3">Caption</th>
      <th class="py-2 px-3">Type</th>
      <th class="py-2 pl-3 text-right">Date</th>
    </tr>`;
  const tbody = $("posts-table");
  tbody.innerHTML = "";
  posts.slice(0, 25).forEach((p, i) => {
    const tr = document.createElement("tr");
    const caption = (p.caption || "").replace(/\s+/g, " ").slice(0, 120);
    tr.innerHTML = `
      <td class="pr-3 text-slate-500 text-xs">${i + 1}</td>
      <td class="px-3 text-slate-300 max-w-md">${caption || '<span class="text-slate-500">— no caption —</span>'}</td>
      <td class="px-3"><span class="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/5">${p.mediaType}</span></td>
      <td class="pl-3 text-right text-slate-400 whitespace-nowrap">${fmtDate(p.timestamp)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderHashtags(tags) {
  const el = $("hashtag-cloud");
  el.innerHTML = "";
  if (!tags.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No hashtags found in your captions.</p>';
    return;
  }
  const max = tags[0].count;
  tags.forEach(({ tag, count }) => {
    const size = 0.75 + (count / max) * 0.75; // 0.75rem → 1.5rem
    const chip = document.createElement("span");
    chip.className =
      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:border-fuchsia-400/40 transition";
    chip.style.fontSize = size + "rem";
    chip.innerHTML = `<span class="text-fuchsia-300">${tag}</span><span class="text-xs text-slate-500">·${count}</span>`;
    el.appendChild(chip);
  });
}

// ---------- main ----------
async function parseExportFromPath() {
  const path = $("export-path-input").value.trim();
  if (!path) {
    showError("Paste the full path to your Instagram export .zip.");
    return;
  }
  hideError();
  showLoading("Streaming your export server-side…", path.split("/").pop());
  try {
    const res = await fetch(`/api/parse-export?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.followers?.length && !data.following?.length && !data.posts?.length) {
      throw new Error("Server parsed the zip but found no Instagram data — file may be corrupted or not a real IG export.");
    }
    // adapt server format to the renderer's expected shape
    const adapted = {
      username: data.username || "",
      bio: data.bio || "",
      followers: data.followers || [],
      following: data.following || [],
      posts: (data.posts || []).map((p) => ({
        caption: p.caption || "",
        timestamp: p.timestamp || 0,
        mediaType: p.mediaType || (p.is_video ? "Video" : "Image"),
      })),
      likedAccounts: data.likedAccounts || [],
      commented: data.commented || [],
      _format: data.format,
    };
    console.log(`Server parsed — format: ${data.format}, followers: ${adapted.followers.length}, following: ${adapted.following.length}, posts: ${adapted.posts.length}`);
    renderExportDashboard(adapted);
  } catch (e) {
    hideLoading();
    $("upload-panel").classList.remove("hidden");
    showError(e.message);
  }
}

function renderExportDashboard(data) {
  window.__lastExport = data;
  const analytics = computeAnalytics(data);
  renderProfile(data);
  renderHeadlineStats(data, analytics);
  renderFollowerGrowthChart(data.followers);
  renderPostingActivityChart(data.posts);

  const nfb = [...analytics.dontFollowBack].sort((a, b) => a.username.localeCompare(b.username));
  const fans = [...analytics.fans].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const recent = [...data.followers].filter((x) => x.timestamp).sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  $("nofollowback-count").textContent = `${nfb.length} total`;
  $("fans-count").textContent = `${fans.length} total`;
  renderUserList("nofollowback-list", nfb.slice(0, 200));
  renderUserList("fans-list", fans.slice(0, 200));
  renderUserList("recent-followers-list", recent);
  renderUserList("top-engagers-list", analytics.topEngagers, {
    right: (x) => `${x.score} interactions`,
  });
  renderPostsTable(data.posts);
  renderHashtags(analytics.topTags);

  // show merge banner if we have a username to lookup
  if (data.username) {
    $("merge-banner").classList.remove("hidden");
    $("merge-username").textContent = "@" + data.username;
    $("merge-btn").onclick = () => mergeWithLiveData(data.username);
  } else {
    $("merge-banner").classList.add("hidden");
  }

  hideLoading();
  $("dashboard").classList.remove("hidden");
  setConnected(true, data.username ? "@" + data.username : "Loaded");
  lucide.createIcons();
}

// ====================================================
// MERGE — combines export historical data with live engagement data
// ====================================================

async function mergeWithLiveData(username) {
  const btn = $("merge-btn");
  const errEl = $("merge-error");
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>Fetching live data…';
  lucide.createIcons();
  try {
    const res = await fetch(`/api/lookup?username=${encodeURIComponent(username)}`);
    const live = await res.json();
    if (!res.ok || live.error) throw new Error(live.error || `HTTP ${res.status}`);
    if (!live.available) throw new Error("No public data available for @" + username);

    const exportData = window.__lastExport;
    if (!exportData) throw new Error("Export data missing — re-parse first.");

    renderMergedDashboard(exportData, live);

    // banner → merged success state
    $("merge-banner").className = "glass-card p-4 bg-gradient-to-r from-emerald-500/10 to-fuchsia-500/10 border-emerald-400/30";
    $("merge-banner").innerHTML = `
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-start gap-3">
          <i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-300 mt-0.5 shrink-0"></i>
          <div>
            <div class="font-display font-semibold text-sm">Merged ✓ · @${username}</div>
            <p class="text-xs text-slate-400 mt-0.5">
              Showing <strong>${exportData.followers.length.toLocaleString()}</strong> follower entries,
              <strong>${exportData.posts.length}</strong> posts from export +
              live engagement on <strong>${live.posts.length}</strong> recent posts,
              brand detection, reel ideas & similar accounts.
            </p>
          </div>
        </div>
        <button id="merge-refresh-btn" class="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs transition inline-flex items-center gap-1.5">
          <i data-lucide="refresh-cw" class="w-3 h-3"></i>Refresh
        </button>
      </div>`;
    $("merge-refresh-btn").addEventListener("click", () => mergeWithLiveData(username));
    lucide.createIcons();
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i>Try again';
    errEl.classList.remove("hidden");
    errEl.textContent = e.message;
    lucide.createIcons();
  }
}

function mergePostsByTimestamp(exportPosts, livePosts) {
  // Live posts have likes, comments, thumbnails, permalinks
  // Export posts have caption, timestamp, mediaType
  // Match by timestamp within ±2 minutes
  const liveByTs = new Map();
  for (const p of livePosts) {
    const ts = p.timestamp;
    if (typeof ts === "number") liveByTs.set(ts, p);
  }
  return exportPosts.map((p) => {
    const ts = p.timestamp;
    for (let delta = 0; delta <= 120; delta++) {
      const live = liveByTs.get(ts + delta) || liveByTs.get(ts - delta);
      if (live) {
        return {
          ...p,
          likes: live.likes,
          comments: live.comments,
          permalink: live.permalink,
          thumbnail: live.thumbnail || live.display_url,
          display_url: live.display_url,
          is_video: live.is_video,
          shortcode: live.shortcode,
        };
      }
    }
    return p;
  });
}

function renderMergedDashboard(exportData, live) {
  window.__merged = { exportData, live };

  // 1) Run lookup rendering first — populates profile + lookup-only sections with live data
  // (engagement chart, top posts, brand detection, reel ideas, etc.)
  renderLookupDashboard(live);

  // 2) Now re-overlay export-only sections with full historical data
  //    (followers list, growth chart, posting activity, etc.)
  const analytics = computeAnalytics(exportData);
  renderHeadlineStats(exportData, analytics);
  // Keep live profile pic, but expose export's total post count via the small stat tiles
  $("stat-media").textContent = fmt(exportData.posts.length);
  $("stat-followers-small").textContent = fmt(exportData.followers.length);
  $("stat-follows").textContent = fmt(exportData.following.length);
  renderFollowerGrowthChart(exportData.followers);
  renderPostingActivityChart(exportData.posts);

  const nfb = [...analytics.dontFollowBack].sort((a, b) => a.username.localeCompare(b.username));
  const fans = [...analytics.fans].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const recent = [...exportData.followers].filter((x) => x.timestamp).sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  $("nofollowback-count").textContent = `${nfb.length} total`;
  $("fans-count").textContent = `${fans.length} total`;
  renderUserList("nofollowback-list", nfb.slice(0, 200));
  renderUserList("fans-list", fans.slice(0, 200));
  renderUserList("recent-followers-list", recent);
  renderUserList("top-engagers-list", analytics.topEngagers, { right: (x) => `${x.score} interactions` });

  // 3) Posts table: merge export's full history with live engagement counts
  const mergedPosts = mergePostsByTimestamp(exportData.posts, live.posts || []);
  renderMergedPostsTable(mergedPosts);

  // 4) Hashtag cloud: combine both sources
  const merged = { posts: [...exportData.posts, ...(live.posts || []).map((p) => ({ caption: p.caption, timestamp: p.timestamp }))] };
  const ana2 = computeAnalytics({ ...exportData, posts: merged.posts });
  renderHashtags(ana2.topTags);

  // 5) Unhide ALL sections (both lookup-only and export-only)
  document.querySelectorAll(".lookup-only").forEach((el) => el.classList.remove("hidden"));
  document.querySelectorAll(".export-only").forEach((el) => el.classList.remove("hidden"));
  document.querySelectorAll(".live-lookup").forEach((el) => el.classList.remove("hidden"));

  setConnected(true, "Merged · @" + live.username);
  lucide.createIcons();
}

function renderMergedPostsTable(posts) {
  $("posts-table-head").innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-white/5">
      <th class="py-2 pr-3">Post</th>
      <th class="py-2 px-3">Caption</th>
      <th class="py-2 px-3">Type</th>
      <th class="py-2 px-3 text-right">Likes</th>
      <th class="py-2 px-3 text-right">Comments</th>
      <th class="py-2 pl-3 text-right">Date</th>
    </tr>`;
  const tbody = $("posts-table");
  tbody.innerHTML = "";
  posts.slice(0, 50).forEach((p) => {
    const tr = document.createElement("tr");
    const caption = (p.caption || "").replace(/\s+/g, " ").slice(0, 100);
    const thumb = p.thumbnail || p.display_url;
    const src = thumb ? `/api/image?url=${encodeURIComponent(thumb)}` : "";
    const hasLive = p.likes != null;
    tr.innerHTML = `
      <td class="pr-3"><a href="${p.permalink || "#"}" target="_blank" rel="noreferrer"><div class="w-10 h-10 rounded-md overflow-hidden bg-black/40 border border-white/5">${src ? `<img src="${src}" class="w-full h-full object-cover" onerror="this.style.display='none'"/>` : ""}</div></a></td>
      <td class="px-3 text-slate-300 max-w-md">${caption || '<span class="text-slate-500">—</span>'}</td>
      <td class="px-3"><span class="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/5">${p.mediaType || "Post"}</span></td>
      <td class="px-3 text-right">${hasLive ? fmt(p.likes) : '<span class="text-slate-600">—</span>'}</td>
      <td class="px-3 text-right">${hasLive ? fmt(p.comments) : '<span class="text-slate-600">—</span>'}</td>
      <td class="pl-3 text-right text-slate-400 whitespace-nowrap">${fmtDate(p.timestamp)}</td>`;
    tbody.appendChild(tr);
  });
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) {
    showError("Please drop a .zip file (the export Instagram emailed you).");
    return;
  }
  try {
    hideError();
    const data = await parseExport(file);

    if (!data.followers.length && !data.following.length && !data.posts.length) {
      throw new Error(
        "Couldn't find any Instagram data in this zip. Tried both JSON and HTML — neither matched expected file paths. Make sure this is the official IG export (not a partial download)."
      );
    }
    console.log(`Parsed export — format: ${data._format}, followers: ${data.followers.length}, following: ${data.following.length}, posts: ${data.posts.length}`);

    showLoading("Crunching numbers…");
    const analytics = computeAnalytics(data);

    renderProfile(data);
    renderHeadlineStats(data, analytics);

    renderFollowerGrowthChart(data.followers);
    renderPostingActivityChart(data.posts);

    // sort lists for display
    const nfb = [...analytics.dontFollowBack].sort((a, b) =>
      a.username.localeCompare(b.username)
    );
    const fans = [...analytics.fans].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = [...data.followers]
      .filter((x) => x.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);

    $("nofollowback-count").textContent = `${nfb.length} total`;
    $("fans-count").textContent = `${fans.length} total`;

    renderUserList("nofollowback-list", nfb.slice(0, 200));
    renderUserList("fans-list", fans.slice(0, 200));
    renderUserList("recent-followers-list", recent);
    renderUserList("top-engagers-list", analytics.topEngagers, {
      right: (x) => `${x.score} interactions`,
    });

    renderPostsTable(data.posts);
    renderHashtags(analytics.topTags);

    hideLoading();
    $("dashboard").classList.remove("hidden");
    setConnected(true, data.username ? "@" + data.username : "Loaded");
    lucide.createIcons();
  } catch (e) {
    console.error(e);
    hideLoading();
    $("upload-panel").classList.remove("hidden");
    showError(e.message);
  }
}

// ====================================================
// LIVE MODE — Facebook Login + Instagram Graph API
// ====================================================

function getAppId() {
  return localStorage.getItem(LS_APPID) || "";
}
function setAppId(id) {
  localStorage.setItem(LS_APPID, id);
}
function getConfigId() {
  return localStorage.getItem(LS_CONFIGID) || "";
}
function setConfigId(id) {
  if (id) localStorage.setItem(LS_CONFIGID, id);
  else localStorage.removeItem(LS_CONFIGID);
}
function showLiveError(msg) {
  $("live-error-box").classList.remove("hidden");
  $("live-error-msg").textContent = msg;
}
function hideLiveError() {
  $("live-error-box").classList.add("hidden");
}

function loadFbSdk(appId) {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, cookie: true, xfbml: false, version: "v19.0" });
      fbSdkReady = true;
      resolve();
      return;
    }
    window.fbAsyncInit = function () {
      window.FB.init({ appId, cookie: true, xfbml: false, version: "v19.0" });
      fbSdkReady = true;
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("Failed to load Facebook SDK"));
    document.head.appendChild(s);
  });
}

function fbLoginWithScope(scope) {
  return new Promise((resolve, reject) => {
    if (!window.FB) {
      reject(new Error("Facebook SDK not ready — save an App ID first."));
      return;
    }
    window.FB.login(
      (response) => {
        if (response.status === "connected" && response.authResponse?.accessToken) {
          resolve({
            token: response.authResponse.accessToken,
            granted: (response.authResponse.grantedScopes || "").split(","),
          });
        } else if (response.status === "not_authorized") {
          reject(new Error("You declined some required permissions."));
        } else {
          reject(new Error("Login window closed or blocked."));
        }
      },
      { scope, return_scopes: true, auth_type: "rerequest" }
    );
  });
}

function fbLoginWithConfigId(configId) {
  return new Promise((resolve, reject) => {
    if (!window.FB) {
      reject(new Error("Facebook SDK not ready — save credentials first."));
      return;
    }
    window.FB.login(
      (response) => {
        if (response.status === "connected" && response.authResponse?.accessToken) {
          resolve({
            token: response.authResponse.accessToken,
            granted: (response.authResponse.grantedScopes || "").split(","),
          });
        } else if (response.status === "not_authorized") {
          reject(new Error("You declined some required permissions."));
        } else {
          reject(new Error("Login window closed or blocked."));
        }
      },
      { config_id: configId, response_type: "token", override_default_response_type: true }
    );
  });
}

async function fbLogin() {
  // If a Config ID is set, use the Facebook Login for Business flow.
  const configId = getConfigId();
  if (configId) {
    const r = await fbLoginWithConfigId(configId);
    return r.token;
  }
  // Otherwise fall back to scope-based (classic Facebook Login).
  let lastErr;
  for (let i = 0; i < FB_SCOPE_VARIANTS.length; i++) {
    const scope = FB_SCOPE_VARIANTS[i].join(",");
    try {
      const r = await fbLoginWithScope(scope);
      const hasIg = r.granted.some((s) => s.startsWith("instagram_"));
      const hasPages = r.granted.includes("pages_show_list");
      if (hasIg || hasPages || i === FB_SCOPE_VARIANTS.length - 1) return r.token;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Facebook login failed after trying all scope variants.");
}

function fbLogout() {
  return new Promise((resolve) => {
    if (window.FB) {
      window.FB.getLoginStatus((resp) => {
        if (resp.status === "connected") window.FB.logout(() => resolve());
        else resolve();
      });
    } else resolve();
  });
}

async function graph(path, params, token) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  Object.entries(params || {}).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function resolveIgId(token) {
  try {
    await graph("me", { fields: "id,name" }, token);
  } catch (e) {
    throw new Error(`Token invalid: ${e.message}.`);
  }
  let pages;
  try {
    pages = await graph("me/accounts", { fields: "id,name,instagram_business_account" }, token);
  } catch (e) {
    throw new Error(`Can't read your Pages: ${e.message}. Missing pages_show_list permission.`);
  }
  if (!pages.data?.length) {
    throw new Error("You don't manage any Facebook Page. Instagram Graph API requires your IG to be linked to a Page.");
  }
  const withIg = pages.data.find((p) => p.instagram_business_account?.id);
  if (!withIg) {
    const names = pages.data.map((p) => p.name).join(", ");
    throw new Error(`Found Page(s) (${names}) but none has Instagram linked. Link your IG (Business/Creator) to one of them.`);
  }
  return withIg.instagram_business_account.id;
}

async function loadLiveDashboard(token) {
  try {
    hideLiveError();
    showLoading("Resolving your Instagram account…");
    const igId = await resolveIgId(token);

    showLoading("Fetching profile…");
    const profile = await graph(igId, {
      fields: "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count",
    }, token);

    showLoading("Fetching recent posts…");
    const mediaRes = await graph(`${igId}/media`, {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
      limit: 25,
    }, token);
    const media = mediaRes.data || [];

    showLoading("Fetching insights…");
    let insights = [];
    try {
      const until = Math.floor(Date.now() / 1000);
      const since = until - 60 * 60 * 24 * 30;
      const r = await graph(`${igId}/insights`, { metric: "reach,profile_views", period: "day", since, until }, token);
      insights = r.data || [];
    } catch (e) {
      console.warn("insights unavailable:", e.message);
    }

    renderLiveDashboard(profile, media, insights);
    hideLoading();
    $("dashboard").classList.remove("hidden");
    setConnected(true, profile.username ? "@" + profile.username : "Live");
    $("fb-logout-btn").classList.remove("hidden");
    lucide.createIcons();
  } catch (e) {
    hideLoading();
    $("live-panel").classList.remove("hidden");
    showLiveError(e.message);
  }
}

function renderLiveDashboard(p, media, insights) {
  $("profile-name").textContent = p.name || p.username || "—";
  $("profile-username").textContent = p.username ? "@" + p.username : "";
  $("profile-bio").textContent = p.biography || "";
  $("stat-media").textContent = fmt(p.media_count);
  $("stat-followers-small").textContent = fmt(p.followers_count);
  $("stat-follows").textContent = fmt(p.follows_count);
  $("stat-followers-live").textContent = fmt(p.followers_count);

  // engagement %
  const sample = media.slice(0, 12);
  const er = sample.length && p.followers_count
    ? (sample.reduce((s, m) => s + (m.like_count || 0) + (m.comments_count || 0), 0) / sample.length / p.followers_count) * 100
    : 0;
  $("stat-engagement").textContent = er.toFixed(2) + "%";

  const sumI = (name) => {
    const m = insights.find((x) => x.name === name);
    return m?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;
  };
  $("stat-reach").textContent = fmt(sumI("reach"));
  $("stat-views").textContent = fmt(sumI("profile_views"));

  // engagement chart
  const ctxE = $("engagement-chart").getContext("2d");
  const ordered = [...media].reverse();
  if (charts.engagement) charts.engagement.destroy();
  charts.engagement = new Chart(ctxE, {
    type: "line",
    data: {
      labels: ordered.map((_, i) => `#${i + 1}`),
      datasets: [
        { label: "Likes", data: ordered.map((m) => m.like_count || 0), borderColor: "#ec4899", backgroundColor: "rgba(236,72,153,0.15)", fill: true, tension: 0.35, borderWidth: 2 },
        { label: "Comments", data: ordered.map((m) => m.comments_count || 0), borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,0.1)", fill: true, tension: 0.35, borderWidth: 2 },
      ],
    },
    options: chartOpts(),
  });

  // reach chart
  const ctxR = $("reach-chart").getContext("2d");
  const reach = insights.find((x) => x.name === "reach");
  if (charts.reach) charts.reach.destroy();
  charts.reach = new Chart(ctxR, {
    type: "bar",
    data: {
      labels: (reach?.values || []).map((v) => new Date(v.end_time).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
      datasets: [{ label: "Reach", data: (reach?.values || []).map((v) => v.value || 0), backgroundColor: "rgba(56,189,248,0.55)", borderRadius: 4 }],
    },
    options: chartOpts(),
  });

  // top posts
  const sorted = [...media].sort((a, b) => (b.like_count || 0) + (b.comments_count || 0) - ((a.like_count || 0) + (a.comments_count || 0)));
  const top = $("top-posts");
  top.innerHTML = "";
  sorted.slice(0, 6).forEach((m) => {
    const a = document.createElement("a");
    a.className = "top-tile";
    a.href = m.permalink;
    a.target = "_blank";
    a.rel = "noreferrer";
    const img = m.thumbnail_url || m.media_url || "";
    a.innerHTML = `<img src="${img}" alt="" onerror="this.style.display='none'"/><div class="overlay"><span>♥ ${fmt(m.like_count)}</span><span>💬 ${fmt(m.comments_count)}</span></div>`;
    top.appendChild(a);
  });

  // posts table
  $("posts-table-head").innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-white/5">
      <th class="py-2 pr-3">Post</th>
      <th class="py-2 px-3">Caption</th>
      <th class="py-2 px-3 text-right">Likes</th>
      <th class="py-2 px-3 text-right">Comments</th>
      <th class="py-2 pl-3 text-right">Date</th>
    </tr>`;
  const tbody = $("posts-table");
  tbody.innerHTML = "";
  media.forEach((m) => {
    const tr = document.createElement("tr");
    const caption = (m.caption || "").replace(/\s+/g, " ").slice(0, 80);
    const img = m.thumbnail_url || m.media_url || "";
    tr.innerHTML = `
      <td class="pr-3"><a href="${m.permalink}" target="_blank" rel="noreferrer"><div class="w-10 h-10 rounded-md overflow-hidden bg-black/40 border border-white/5"><img src="${img}" class="w-full h-full object-cover" onerror="this.style.display='none'"/></div></a></td>
      <td class="px-3 text-slate-300 max-w-md">${caption || '<span class="text-slate-500">—</span>'}</td>
      <td class="px-3 text-right">${fmt(m.like_count)}</td>
      <td class="px-3 text-right">${fmt(m.comments_count)}</td>
      <td class="pl-3 text-right text-slate-400 whitespace-nowrap">${fmtDate(Math.floor(new Date(m.timestamp).getTime() / 1000))}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ====================================================
// MODE SWITCHING
// ====================================================
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".mode-tab").forEach((b) => {
    const active = b.dataset.mode === mode;
    b.className = active
      ? "mode-tab px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-tr from-fuchsia-500 to-pink-500 text-white shadow-lg shadow-pink-500/20"
      : "mode-tab px-4 py-2 rounded-lg text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 transition";
    // re-add relative class for watchlist tab (since we replace className)
    if (b.dataset.mode === "watchlist") b.classList.add("relative");
  });
  $("lookup-panel").classList.toggle("hidden", mode !== "lookup");
  $("live-panel").classList.toggle("hidden", mode !== "live");
  $("upload-panel").classList.toggle("hidden", mode !== "export");
  $("watchlist-panel").classList.toggle("hidden", mode !== "watchlist");
  $("compare-panel").classList.toggle("hidden", mode !== "compare");
  $("dashboard").classList.add("hidden");
  document.querySelectorAll(".live-only").forEach((el) => el.classList.toggle("hidden", mode !== "live"));
  document.querySelectorAll(".lookup-only").forEach((el) => el.classList.toggle("hidden", mode !== "lookup"));
  document.querySelectorAll(".export-only").forEach((el) => el.classList.toggle("hidden", mode !== "export"));
  document.querySelectorAll(".live-lookup").forEach((el) => el.classList.toggle("hidden", mode !== "live" && mode !== "lookup"));
  hideError();
  hideLiveError();
  hideLookupError();
  if (mode === "watchlist") renderWatchlist();
  if (mode === "compare") renderCompare();
}

// ====================================================
// LOOKUP MODE — public profile via local /proxy endpoint
// ====================================================

function showLookupError(msg) {
  $("lookup-error").classList.remove("hidden");
  $("lookup-error-msg").textContent = msg;
}
function hideLookupError() {
  $("lookup-error").classList.add("hidden");
}

async function doLookup() {
  const raw = $("lookup-input").value.trim();
  if (!raw) return;
  const username = raw.replace(/^@+/, "").replace(/\/.*/g, "").trim();
  if (!/^[\w.]{1,30}$/.test(username)) {
    showLookupError("Username should be 1–30 chars (letters, numbers, dots, underscores).");
    return;
  }
  hideLookupError();
  $("dashboard").classList.add("hidden");
  $("lookup-btn").disabled = true;
  $("lookup-btn").textContent = "Looking up…";
  showLoading("Fetching @" + username + "…", "Public profile via local proxy");
  try {
    const res = await fetch(`/api/lookup?username=${encodeURIComponent(username)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.available) {
      throw new Error("No public data found. Account may be private, deleted, or the username is misspelled.");
    }
    renderLookupDashboard(data);

    // surface cache/rate-limit notice
    if (data.partial || data.from_cache) {
      const ageSec = data.served_from_cache_age || 0;
      const ageTxt = ageSec
        ? (ageSec < 3600 ? `${Math.round(ageSec / 60)} min ago` :
           ageSec < 86400 ? `${Math.round(ageSec / 3600)} h ago` :
           `${Math.round(ageSec / 86400)} d ago`)
        : "just now";
      const cacheBadge = data.from_cache
        ? `<span class="inline-block px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-200 text-[10px] font-semibold uppercase tracking-wider">Cached · ${ageTxt}</span>`
        : (data.merged_posts_from_cache
          ? `<span class="inline-block px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-200 text-[10px] font-semibold uppercase tracking-wider">Mixed · posts from cache (${ageTxt})</span>`
          : "");
      const banner = document.createElement("div");
      banner.className = "glass-card p-3 bg-amber-500/10 border-amber-400/30 mb-2";
      banner.innerHTML = `
        <div class="flex items-start gap-2 text-xs text-amber-200">
          <i data-lucide="${data.from_cache ? "database" : "clock"}" class="w-4 h-4 mt-0.5 shrink-0"></i>
          <div class="flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <strong>${data.from_cache ? "Showing cached data." : "Instagram rate-limited fresh data."}</strong>
              ${cacheBadge}
            </div>
            <div class="mt-1">${escapeHtml(data.note || "Counts came through; some live fields may be missing. Click Refresh to retry.")}</div>
            <div class="mt-1.5 text-amber-300/80">Nothing's lost — every successful fetch is saved to disk, so you keep working offline / through rate-limits.</div>
          </div>
        </div>`;
      const dash = $("dashboard");
      const existing = dash.querySelector(".rate-limit-banner");
      if (existing) existing.remove();
      banner.classList.add("rate-limit-banner");
      dash.insertBefore(banner, dash.firstChild);
    }

    hideLoading();
    $("dashboard").classList.remove("hidden");
    const statusLabel = data.from_cache ? " · cached" : (data.partial ? " · partial" : "");
    setConnected(true, "@" + (data.username || username) + statusLabel);
    lucide.createIcons();
  } catch (e) {
    hideLoading();
    showLookupError(
      e.message.includes("Failed to fetch")
        ? "Couldn't reach the local proxy. Make sure you ran `sh run.sh` (the local server must be running)."
        : e.message
    );
  } finally {
    $("lookup-btn").disabled = false;
    $("lookup-btn").textContent = "Look up";
  }
}

function renderLookupDashboard(d) {
  // --- profile card ---
  const uname = d.username;
  $("profile-name").textContent = d.full_name || uname;
  $("profile-username").textContent = "@" + uname;

  // category
  if (d.category) {
    $("profile-category").textContent = d.category;
    $("profile-category").classList.remove("hidden");
  } else $("profile-category").classList.add("hidden");

  // bio
  $("profile-bio").textContent = d.biography || "";

  // external URL
  const ext = $("profile-external");
  if (d.external_url) {
    ext.href = d.external_url;
    $("profile-external-label").textContent = d.external_url.replace(/^https?:\/\//, "").slice(0, 50);
    ext.classList.remove("hidden");
  } else ext.classList.add("hidden");

  // profile pic (via image proxy to avoid hotlink/referrer block)
  const img = $("profile-pic");
  if (d.profile_pic_url) {
    img.src = `/api/image?url=${encodeURIComponent(d.profile_pic_url)}`;
    img.classList.remove("hidden");
    $("profile-pic-fallback").classList.add("hidden");
    img.onerror = () => {
      img.classList.add("hidden");
      $("profile-pic-fallback").classList.remove("hidden");
    };
  } else {
    img.classList.add("hidden");
    $("profile-pic-fallback").classList.remove("hidden");
  }

  // verified badge
  $("profile-verified").classList.toggle("hidden", !d.is_verified);

  // badges row (private/business/professional/verified-style)
  const badges = $("profile-badges");
  badges.innerHTML = "";
  const tag = (text, color) => {
    const span = document.createElement("span");
    span.className = `text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${color}`;
    span.textContent = text;
    badges.appendChild(span);
  };
  if (d.is_verified) tag("Verified", "border-sky-400/30 text-sky-300 bg-sky-500/10");
  if (d.is_private) tag("Private", "border-rose-400/30 text-rose-300 bg-rose-500/10");
  if (d.is_business) tag("Business", "border-amber-400/30 text-amber-300 bg-amber-500/10");
  else if (d.is_professional) tag("Creator", "border-fuchsia-400/30 text-fuchsia-300 bg-fuchsia-500/10");
  if (d.has_clips) tag("Reels", "border-pink-400/30 text-pink-300 bg-pink-500/10");
  if (d.business_email) tag("📧 " + d.business_email, "border-white/10 text-slate-300 bg-white/5");

  // small stats grid inside profile card
  $("stat-media").textContent = fmt(d.posts_count);
  $("stat-followers-small").textContent = fmt(d.followers);
  $("stat-follows").textContent = fmt(d.following);

  // --- big stat cards ---
  $("lookup-stat-followers").textContent = fmt(d.followers);
  $("lookup-stat-following").textContent = fmt(d.following);
  $("lookup-stat-posts").textContent = fmt(d.posts_count);
  $("lookup-stat-posts-sub").textContent = `${d.posts.length} fetched, ${fmt(d.posts_count)} total`;
  const posts = d.posts || [];
  const avgEng = posts.length
    ? posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length
    : 0;
  const er = d.followers ? (avgEng / d.followers) * 100 : 0;
  $("lookup-stat-engagement").textContent = er.toFixed(2) + "%";

  // --- engagement chart ---
  if (posts.length) {
    const ctxE = $("engagement-chart").getContext("2d");
    const ordered = [...posts].reverse();
    if (charts.engagement) charts.engagement.destroy();
    charts.engagement = new Chart(ctxE, {
      type: "line",
      data: {
        labels: ordered.map((_, i) => `#${i + 1}`),
        datasets: [
          { label: "Likes", data: ordered.map((p) => p.likes || 0), borderColor: "#ec4899", backgroundColor: "rgba(236,72,153,0.15)", fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3 },
          { label: "Comments", data: ordered.map((p) => p.comments || 0), borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,0.1)", fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3 },
        ],
      },
      options: chartOpts(),
    });

    // posting frequency (days between consecutive posts)
    const ts = posts.map((p) => p.timestamp).filter(Boolean).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(Math.round((ts[i] - ts[i - 1]) / 86400 * 10) / 10);
    const ctxF = $("frequency-chart").getContext("2d");
    if (charts.frequency) charts.frequency.destroy();
    charts.frequency = new Chart(ctxF, {
      type: "bar",
      data: {
        labels: gaps.map((_, i) => `gap ${i + 1}`),
        datasets: [{ label: "Days between posts", data: gaps, backgroundColor: "rgba(168,85,247,0.55)", borderRadius: 4 }],
      },
      options: chartOpts(),
    });
  }

  // --- top posts ---
  const top = [...posts].sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments)).slice(0, 6);
  const topEl = $("top-posts");
  topEl.innerHTML = "";
  top.forEach((p) => {
    const a = document.createElement("a");
    a.className = "top-tile";
    a.href = p.permalink || "#";
    a.target = "_blank";
    a.rel = "noreferrer";
    const thumb = p.thumbnail || p.display_url;
    const src = thumb ? `/api/image?url=${encodeURIComponent(thumb)}` : "";
    a.innerHTML = `
      <img src="${src}" alt="" onerror="this.style.display='none'"/>
      <div class="overlay">
        <span class="inline-flex items-center gap-1">♥ ${fmt(p.likes)}</span>
        <span class="inline-flex items-center gap-1">💬 ${fmt(p.comments)}</span>
      </div>`;
    topEl.appendChild(a);
  });

  // --- posts table (uses state-aware renderer for sort/search/filter) ---
  renderPostsTable(posts.map((p) => ({
    ...p,
    mediaType: p.is_video ? (p.video_view_count != null ? "Reel" : "Video") : p.is_carousel ? "Carousel" : "Image",
  })));

  // --- hashtags ---
  const tagCount = new Map();
  for (const p of posts) {
    const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
    for (const t of tags) {
      const k = t.toLowerCase();
      tagCount.set(k, (tagCount.get(k) || 0) + 1);
    }
  }
  const tags = Array.from(tagCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const hEl = $("lookup-hashtags");
  hEl.innerHTML = "";
  if (!tags.length) {
    hEl.innerHTML = '<p class="text-xs text-slate-500">No hashtags in recent captions.</p>';
  } else {
    const max = tags[0][1];
    tags.forEach(([tag, count]) => {
      const size = 0.75 + (count / max) * 0.6;
      const chip = document.createElement("span");
      chip.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10";
      chip.style.fontSize = size + "rem";
      chip.innerHTML = `<span class="text-fuchsia-300">${tag}</span><span class="text-xs text-slate-500">·${count}</span>`;
      hEl.appendChild(chip);
    });
  }

  // --- related profiles ---
  const rel = $("related-profiles");
  rel.innerHTML = "";
  const related = d.related_profiles || [];
  if (!related.length) {
    rel.innerHTML = '<p class="text-xs text-slate-500 py-2">Instagram didn\'t return related profiles for this account.</p>';
  } else {
    related.forEach((r) => {
      const row = document.createElement("a");
      row.className = "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition group";
      row.href = `https://www.instagram.com/${r.username}/`;
      row.target = "_blank";
      row.rel = "noreferrer";
      const pic = r.profile_pic
        ? `<img src="/api/image?url=${encodeURIComponent(r.profile_pic)}" class="w-8 h-8 rounded-full object-cover shrink-0" onerror="this.style.display='none'"/>`
        : '<div class="w-8 h-8 rounded-full bg-white/10 shrink-0"></div>';
      row.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          ${pic}
          <div class="min-w-0">
            <div class="text-sm truncate">${r.full_name || r.username}</div>
            <div class="text-[11px] text-fuchsia-300 truncate">@${r.username}${r.is_verified ? ' ✓' : ''}</div>
          </div>
        </div>
        <button class="text-xs text-slate-500 group-hover:text-fuchsia-300" data-lookup-username="${r.username}">Look up</button>`;
      row.querySelector("button").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        $("lookup-input").value = r.username;
        doLookup();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      rel.appendChild(row);
    });
  }

  // caveat text for lookup mode
  $("caveat-text").innerHTML =
    "Public data only — fetched from Instagram's anonymous endpoints. Follower / following <em>lists</em>, " +
    "story viewers, and reach/impressions aren't exposed publicly (Instagram doesn't share those). " +
    "Engagement rate is computed from the 12 most recent posts ÷ followers.";

  // --- posting heatmap (day × hour) ---
  renderHeatmap(posts);

  // --- content type performance ---
  renderContentTypeBreakdown(posts);

  // --- caption length scatter ---
  renderCaptionScatter(posts);

  // --- hashtag effectiveness ---
  renderHashtagEffectiveness(posts);

  // --- best vs typical post ---
  renderBestVsTypical(posts, d);

  // --- reels stats ---
  renderReelsStats(posts);

  // --- content patterns ---
  renderContentPatterns(posts, d);

  // --- niche & brand fit ---
  renderBrandFit(posts, d);

  // --- reel ideas, caption templates, collab targets ---
  renderReelIdeas(posts, d);
  renderCaptionTemplates(posts);
  renderCollabTargets(posts, d);

  // --- brand partnerships ---
  renderBrandPartnerships(posts, d);

  // --- account health score ---
  renderHealthScore(posts, d);

  // --- what your audience loves ---
  renderAudienceLoves(posts, d);

  // --- caption doctor (just init, runs on click) ---
  initCaptionDoctor(posts, d);

  // --- shadowban sniffer ---
  renderShadowbanSniffer(posts, d);

  // --- calendar ---
  initContentCalendar(d.username);

  // --- new power features ---
  renderSponsorshipRate(posts, d);
  initWhatIfSimulator(posts, d);
  renderBrandKit(posts, d);
  renderYearHeatmap(posts);

  // --- record snapshot for watchlist tracking ---
  recordSnapshot(d);

  // --- update action bar (watch/compare buttons) ---
  updateActionBar(uname);

  // stash for "copy summary"
  window.__lastLookup = d;
}

// ====================================================
// HEATMAP & CONTENT TYPE
// ====================================================

function renderHeatmap(posts) {
  const el = $("posting-heatmap");
  el.innerHTML = "";
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (const p of posts) {
    if (!p.timestamp) continue;
    const d = new Date(p.timestamp * 1000);
    const dow = (d.getDay() + 6) % 7; // Monday-start
    grid[dow][d.getHours()] += (p.likes || 0) + (p.comments || 0);
  }
  const max = Math.max(1, ...grid.flat());
  const wrap = document.createElement("div");
  wrap.className = "inline-grid gap-0.5";
  wrap.style.gridTemplateColumns = "auto repeat(24, 1fr)";
  // header
  wrap.innerHTML += '<div></div>' + Array.from({ length: 24 }, (_, h) =>
    `<div class="text-[8px] text-slate-500 text-center w-3.5">${h % 6 === 0 ? h : ""}</div>`).join("");
  for (let i = 0; i < 7; i++) {
    wrap.innerHTML += `<div class="text-[10px] text-slate-400 pr-1">${days[i]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[i][h];
      const intensity = v / max;
      const bg = v === 0 ? "rgba(255,255,255,0.04)" : `rgba(236,72,153,${0.15 + intensity * 0.85})`;
      wrap.innerHTML += `<div title="${days[i]} ${h}:00 — ${fmt(v)} engagement" style="width:14px;height:14px;background:${bg};border-radius:2px"></div>`;
    }
  }
  el.appendChild(wrap);
}

function renderContentTypeBreakdown(posts) {
  const el = $("content-type-breakdown");
  el.innerHTML = "";
  const buckets = { Photo: [], Video: [], Carousel: [] };
  for (const p of posts) {
    const eng = (p.likes || 0) + (p.comments || 0);
    if (p.is_video) buckets.Video.push(eng);
    else if (p.is_carousel) buckets.Carousel.push(eng);
    else buckets.Photo.push(eng);
  }
  const rows = Object.entries(buckets).map(([k, arr]) => ({
    type: k,
    count: arr.length,
    avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0,
  }));
  rows.sort((a, b) => b.avg - a.avg);
  const max = Math.max(1, ...rows.map((r) => r.avg));
  rows.forEach((r) => {
    const pct = (r.avg / max) * 100;
    const row = document.createElement("div");
    row.className = "space-y-1";
    row.innerHTML = `
      <div class="flex items-center justify-between text-xs">
        <span class="text-slate-300">${r.type} <span class="text-slate-500">·${r.count}</span></span>
        <span class="text-fuchsia-300 font-medium">${fmt(r.avg)} avg engagement</span>
      </div>
      <div class="h-2 rounded-full bg-white/5 overflow-hidden">
        <div class="h-full bg-gradient-to-r from-fuchsia-500 to-amber-400 rounded-full" style="width:${pct}%"></div>
      </div>`;
    el.appendChild(row);
  });
}

// ====================================================
// DEEP POST ANALYTICS
// ====================================================

let captionScatterChart = null;

function renderCaptionScatter(posts) {
  const ctx = $("caption-scatter-chart").getContext("2d");
  const data = posts
    .filter((p) => p.timestamp)
    .map((p) => ({
      x: (p.caption || "").length,
      y: (p.likes || 0) + (p.comments || 0),
      label: (p.caption || "").slice(0, 40) || "(no caption)",
    }));
  if (captionScatterChart) captionScatterChart.destroy();
  captionScatterChart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [{
        label: "Posts",
        data,
        backgroundColor: "rgba(236,72,153,0.6)",
        borderColor: "#ec4899",
        pointRadius: 6,
        pointHoverRadius: 9,
      }],
    },
    options: {
      ...chartOpts(),
      plugins: {
        ...chartOpts().plugins,
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.raw.label} — ${ctx.raw.x} chars, ${fmt(ctx.raw.y)} eng`,
          },
        },
      },
      scales: {
        x: { ...chartOpts().scales.x, title: { display: true, text: "Caption length (chars)", color: "#64748b", font: { size: 10 } } },
        y: { ...chartOpts().scales.y, title: { display: true, text: "Likes + comments", color: "#64748b", font: { size: 10 } } },
      },
    },
  });
  // crude correlation
  const corr = pearson(data.map((d) => d.x), data.map((d) => d.y));
  const insight = isNaN(corr)
    ? "Not enough data to correlate."
    : corr > 0.3
    ? `📈 Positive correlation (r=${corr.toFixed(2)}) — longer captions tend to get more engagement.`
    : corr < -0.3
    ? `📉 Negative correlation (r=${corr.toFixed(2)}) — shorter captions perform better here.`
    : `≈ No meaningful correlation (r=${corr.toFixed(2)}). Caption length doesn't predict engagement for this account.`;
  $("caption-insight").textContent = insight;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const syy = ys.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return den === 0 ? NaN : num / den;
}

function renderHashtagEffectiveness(posts) {
  const el = $("hashtag-effectiveness");
  el.innerHTML = "";
  const tagPosts = new Map();
  for (const p of posts) {
    const eng = (p.likes || 0) + (p.comments || 0);
    const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
    for (const t of new Set(tags.map((x) => x.toLowerCase()))) {
      if (!tagPosts.has(t)) tagPosts.set(t, []);
      tagPosts.get(t).push(eng);
    }
  }
  const arr = Array.from(tagPosts.entries())
    .map(([tag, arr]) => ({ tag, count: arr.length, avg: arr.reduce((a, b) => a + b, 0) / arr.length }))
    .filter((x) => x.count >= 1)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 15);

  if (!arr.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No hashtags in recent captions.</p>';
    return;
  }
  const max = arr[0].avg;
  arr.forEach((r) => {
    const pct = (r.avg / max) * 100;
    const row = document.createElement("div");
    row.className = "space-y-0.5";
    row.innerHTML = `
      <div class="flex items-center justify-between text-xs">
        <span class="text-fuchsia-300 truncate max-w-[60%]">${r.tag}</span>
        <span class="text-slate-400">${fmt(Math.round(r.avg))} <span class="text-slate-600 text-[10px]">·${r.count}x</span></span>
      </div>
      <div class="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div class="h-full bg-gradient-to-r from-fuchsia-500 to-amber-400 rounded-full" style="width:${pct}%"></div>
      </div>`;
    el.appendChild(row);
  });
}

function renderBestVsTypical(posts, d) {
  const el = $("best-vs-typical");
  el.innerHTML = "";
  if (posts.length < 3) {
    el.innerHTML = '<p class="text-xs text-slate-500">Not enough posts to compare.</p>';
    return;
  }
  const engs = posts.map((p) => (p.likes || 0) + (p.comments || 0)).sort((a, b) => a - b);
  const median = engs[Math.floor(engs.length / 2)];
  const best = engs[engs.length - 1];
  const worst = engs[0];
  const bestPost = [...posts].sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))[0];
  const multiplier = median > 0 ? (best / median).toFixed(1) : "—";

  const tile = (label, value, sub, color) => {
    const t = document.createElement("div");
    t.className = "rounded-xl p-4 " + color;
    t.innerHTML = `
      <div class="text-[10px] uppercase tracking-wider text-slate-300 mb-1">${label}</div>
      <div class="font-display text-xl font-bold">${value}</div>
      <div class="text-[11px] text-slate-300 mt-1">${sub}</div>`;
    return t;
  };
  el.appendChild(tile("Best post", fmt(best), `${multiplier}× the median`, "bg-emerald-500/10 border border-emerald-400/20"));
  el.appendChild(tile("Median post", fmt(median), "Typical engagement", "bg-white/5 border border-white/10"));
  el.appendChild(tile("Worst post", fmt(worst), `${(worst / Math.max(median, 1) * 100).toFixed(0)}% of median`, "bg-rose-500/10 border border-rose-400/20"));

  // top caption preview
  const cap = (bestPost.caption || "").slice(0, 120);
  if (cap) {
    const p = document.createElement("p");
    p.className = "text-[11px] text-slate-400 mt-1 italic";
    p.innerHTML = `<i data-lucide="quote" class="w-3 h-3 inline -mt-0.5"></i> Top post caption: "${cap}${bestPost.caption.length > 120 ? "…" : ""}"`;
    el.appendChild(p);
  }
}

function renderReelsStats(posts) {
  const el = $("reels-stats");
  el.innerHTML = "";
  const videos = posts.filter((p) => p.is_video);
  if (!videos.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No videos / reels in the last 12 posts.</p>';
    return;
  }
  const withViews = videos.filter((v) => v.video_view_count != null);
  const totalViews = withViews.reduce((s, v) => s + (v.video_view_count || 0), 0);
  const avgViews = withViews.length ? totalViews / withViews.length : 0;

  const stats = [
    { label: "Videos in last 12", value: videos.length },
    { label: "With view count", value: withViews.length },
    { label: "Total views", value: fmt(totalViews) },
    { label: "Avg views per video", value: fmt(Math.round(avgViews)) },
  ];
  stats.forEach((s) => {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center p-2.5 rounded-lg bg-white/5";
    row.innerHTML = `<span class="text-xs text-slate-400">${s.label}</span><span class="font-display text-sm font-bold">${s.value}</span>`;
    el.appendChild(row);
  });
}

// ====================================================
// CONTENT PATTERNS  &  BRAND FIT
// ====================================================

const NICHE_BRANDS = {
  fitness: {
    label: "Fitness & training",
    keywords: ["gym", "workout", "fitness", "muscle", "training", "crossfit", "bodybuild", "trainer", "cardio", "lifting", "squat", "bench", "athlete", "fit", "sweat", "reps"],
    brands: ["Gymshark", "Whoop", "MyProtein", "Optimum Nutrition", "Nike Training", "Under Armour", "Bulk", "Alo Yoga", "Lululemon", "Therabody"],
    products: ["Workout apparel", "Protein powder / supplements", "Fitness tracker / smartwatch", "Athletic footwear", "Resistance bands & home equipment", "Recovery devices (massage gun, ice bath)"],
  },
  fashion: {
    label: "Fashion & style",
    keywords: ["fashion", "outfit", "ootd", "style", "stylist", "designer", "lookbook", "wardrobe", "vintage", "streetwear", "trend", "luxury", "couture", "denim"],
    brands: ["ASOS", "Shein", "Zara", "PrettyLittleThing", "Revolve", "Fashion Nova", "Princess Polly", "Boohoo", "Aritzia", "& Other Stories"],
    products: ["Seasonal clothing drops", "Statement accessories", "Footwear", "Jewelry", "Sunglasses", "Handbags / luggage"],
  },
  beauty: {
    label: "Beauty & cosmetics",
    keywords: ["beauty", "makeup", "skincare", "mua", "lipstick", "foundation", "cosmetic", "skin", "haircare", "fragrance", "perfume", "lash", "brow", "glow"],
    brands: ["Sephora", "Fenty Beauty", "MAC", "NYX", "Maybelline", "L'Oréal", "Charlotte Tilbury", "Glossier", "The Ordinary", "Drunk Elephant", "Rare Beauty"],
    products: ["Makeup palette / lip product", "Skincare routine set", "Hair care kit", "Fragrance / perfume", "Beauty tools (curler, brush set)"],
  },
  food: {
    label: "Food & cooking",
    keywords: ["food", "recipe", "cooking", "chef", "eat", "delicious", "restaurant", "foodie", "kitchen", "tasty", "meal", "bake", "dessert", "vegan", "keto"],
    brands: ["HelloFresh", "Blue Apron", "Whole Foods", "Le Creuset", "KitchenAid", "Ninja", "Vitamix", "All-Clad", "Material Kitchen", "Misen"],
    products: ["Meal kit subscriptions", "Kitchen gadgets / cookware", "Specialty ingredients", "Coffee / tea brands", "Cookbooks / online courses"],
  },
  travel: {
    label: "Travel & adventure",
    keywords: ["travel", "wanderlust", "vacation", "explore", "adventure", "trip", "destination", "passport", "backpack", "nomad", "hotel", "flight", "roadtrip"],
    brands: ["Airbnb", "Booking.com", "GoPro", "Away", "Samsonite", "Tumi", "Patagonia", "The North Face", "Lonely Planet", "Expedia"],
    products: ["Luggage / travel bags", "GoPro / action camera", "Booking platforms", "Outdoor gear", "Travel insurance"],
  },
  tech: {
    label: "Tech & gadgets",
    keywords: ["tech", "gadget", "review", "smartphone", "laptop", "ai", "coding", "developer", "startup", "saas", "iphone", "android", "review"],
    brands: ["Apple", "Samsung", "Logitech", "Anker", "Sony", "Bose", "Dell", "Razer", "OnePlus", "Nothing", "DJI"],
    products: ["Headphones / earbuds", "Phone accessories", "Smart home devices", "Laptops / monitors", "Productivity SaaS (1-yr license)"],
  },
  gaming: {
    label: "Gaming & esports",
    keywords: ["gaming", "gamer", "esports", "twitch", "stream", "streamer", "fortnite", "minecraft", "fps", "rpg", "console", "pc", "valorant", "league"],
    brands: ["Razer", "HyperX", "Logitech G", "SteelSeries", "ASUS ROG", "Corsair", "Elgato", "Secretlab", "MSI", "NVIDIA"],
    products: ["Gaming peripherals (mouse/keyboard/headset)", "Gaming chair", "Streaming gear (capture card, mic)", "Energy drinks", "Game keys / Steam subscriptions"],
  },
  music: {
    label: "Music & artist",
    keywords: ["music", "song", "album", "artist", "singer", "rapper", "producer", "studio", "concert", "tour", "spotify", "guitar", "piano", "dj"],
    brands: ["Spotify", "Apple Music", "Beats", "Audio-Technica", "Native Instruments", "Shure", "Fender", "Gibson", "Ableton"],
    products: ["Headphones / studio monitors", "Music production software", "Streaming subscriptions", "Instruments / accessories", "Live event tickets"],
  },
  business: {
    label: "Business & entrepreneurship",
    keywords: ["business", "entrepreneur", "founder", "ceo", "startup", "investor", "marketing", "sales", "growth", "leadership", "mindset", "hustle", "scale"],
    brands: ["HubSpot", "Notion", "Linear", "Stripe", "Shopify", "Squarespace", "Webflow", "Calendly", "Slack", "MasterClass"],
    products: ["SaaS annual subscriptions", "Online business courses", "Productivity tools", "Business books", "Mentorship platforms"],
  },
  athlete: {
    label: "Pro athlete",
    keywords: ["soccer", "football", "basketball", "tennis", "champion", "olympic", "league", "season", "match", "goal", "team", "nba", "ufc", "boxing"],
    brands: ["Nike", "Adidas", "Puma", "Under Armour", "Whoop", "Therabody", "BioSteel", "Red Bull", "Gatorade", "Rolex"],
    products: ["Performance apparel / signature line", "Recovery devices", "Sports drinks", "Athletic footwear", "Premium watches / accessories"],
  },
  artist: {
    label: "Visual artist / designer",
    keywords: ["art", "artist", "painting", "drawing", "illustration", "design", "creative", "sketch", "portrait", "gallery", "color", "palette"],
    brands: ["Wacom", "Procreate", "Adobe", "Blick Art Materials", "Faber-Castell", "Winsor & Newton", "Society6", "Skillshare"],
    products: ["Art supplies / paints / pencils", "Digital tablets", "Design software licenses", "Print marketplaces", "Skill-building course platforms"],
  },
  parenting: {
    label: "Parenting & family",
    keywords: ["mom", "dad", "parent", "kids", "family", "baby", "toddler", "mama", "papa", "pregnancy", "newborn", "maternity"],
    brands: ["Pampers", "Huggies", "Mustela", "Aveeno Baby", "Carter's", "LEGO", "Melissa & Doug", "Owlet", "Lovevery"],
    products: ["Baby care products", "Educational toys", "Family subscription boxes", "Strollers / safety gear", "Kids' apparel"],
  },
  finance: {
    label: "Finance & investing",
    keywords: ["finance", "money", "invest", "crypto", "stocks", "trading", "wealth", "savings", "budget", "fintech", "bitcoin", "etf", "portfolio"],
    brands: ["Robinhood", "Coinbase", "Kraken", "eToro", "Wealthfront", "Public", "Tiller", "Rocket Money", "M1 Finance"],
    products: ["Trading platforms (sponsored signup)", "Crypto wallets", "Budgeting apps", "Investment courses", "Personal finance books"],
  },
  health: {
    label: "Health & wellness",
    keywords: ["health", "wellness", "nutrition", "doctor", "medical", "therapy", "meditation", "yoga", "mental", "holistic", "mindful", "sleep"],
    brands: ["Headspace", "Calm", "Athletic Greens", "Liquid IV", "Hims", "Hers", "Ritual", "Olipop", "Manduka", "Eight Sleep"],
    products: ["Supplements / multivitamins", "Wellness app subscriptions", "Yoga / meditation gear", "Healthy snacks & drinks", "Telehealth memberships"],
  },
  pets: {
    label: "Pets & animals",
    keywords: ["dog", "cat", "puppy", "kitten", "pet", "doggo", "rescue", "vet", "groomer", "treat", "paws", "leash"],
    brands: ["Chewy", "BarkBox", "Furbo", "Kong", "Wild One", "Petsies", "The Honest Kitchen", "Petco"],
    products: ["Pet food subscriptions", "Toys & treats", "Pet tech (camera, GPS)", "Grooming products", "Pet apparel & accessories"],
  },
  photography: {
    label: "Photography & film",
    keywords: ["photographer", "photography", "camera", "lens", "shoot", "portrait", "landscape", "filmmaker", "cinematography", "edit", "lightroom"],
    brands: ["Sony", "Canon", "Nikon", "Fujifilm", "DJI", "Adobe Lightroom", "Peak Design", "B&H Photo", "Capture One", "SmallRig"],
    products: ["Camera bodies / lenses", "Photography presets / LUT packs", "Editing software licenses", "Camera bags & accessories", "Drones"],
  },
  lifestyle: {
    label: "Lifestyle & general",
    keywords: ["lifestyle", "daily", "vlog", "dayinmylife", "grwm", "morning", "routine", "aesthetic", "blogger", "influencer"],
    brands: ["Casetify", "Daniel Wellington", "MVMT", "Vuori", "Quay Australia", "Glossier", "Aspesi"],
    products: ["Lifestyle accessories", "Watches / minimalist jewelry", "Loungewear", "Home decor", "Subscription boxes"],
  },
};

function renderContentPatterns(posts, profile) {
  const tilesEl = $("pattern-tiles");
  const themesEl = $("pattern-themes");
  const mentionsEl = $("pattern-mentions");
  const clustersEl = $("pattern-clusters");
  const sugEl = $("pattern-suggestions");
  tilesEl.innerHTML = mentionsEl.innerHTML = themesEl.innerHTML = clustersEl.innerHTML = sugEl.innerHTML = "";

  // format mix
  const counts = { Reel: 0, Photo: 0, Carousel: 0 };
  for (const p of posts) {
    if (p.is_video) counts.Reel++;
    else if (p.is_carousel) counts.Carousel++;
    else counts.Photo++;
  }
  const total = posts.length || 1;
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  // caption stats
  const lens = posts.map((p) => (p.caption || "").length);
  const avgLen = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;

  // emoji density
  const emojiRx = /\p{Extended_Pictographic}/gu;
  const emojiCount = posts.reduce((s, p) => s + ((p.caption || "").match(emojiRx) || []).length, 0);
  const avgEmojis = posts.length ? (emojiCount / posts.length).toFixed(1) : "0";

  // question / cta detection
  const questions = posts.filter((p) => (p.caption || "").includes("?")).length;
  const exclam = posts.filter((p) => (p.caption || "").includes("!")).length;

  // posting cadence
  const ts = posts.map((p) => p.timestamp).filter(Boolean).sort((a, b) => a - b);
  let cadence = "—";
  if (ts.length >= 2) {
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 86400);
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    cadence = median < 1 ? "Multiple/day" : median < 2 ? "~daily" : median < 4 ? "Every 2–3 days" : median < 8 ? "Weekly" : "Sporadic";
  }

  // language guess
  const lang = guessLanguage(posts);

  const tile = (label, value, sub) => `
    <div class="rounded-xl bg-white/5 border border-white/10 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-400">${label}</div>
      <div class="font-display text-base font-bold mt-1">${value}</div>
      ${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ""}
    </div>`;
  tilesEl.innerHTML = [
    tile("Format mix", `${counts.Reel}R · ${counts.Photo}P · ${counts.Carousel}C`, `Mostly ${dominant[0]}s`),
    tile("Avg caption", `${avgLen} chars`, avgLen < 80 ? "Short-form" : avgLen < 250 ? "Mid-form" : "Long-form"),
    tile("Emojis / post", avgEmojis, parseFloat(avgEmojis) > 3 ? "Expressive" : parseFloat(avgEmojis) > 0.5 ? "Moderate" : "Minimal"),
    tile("Cadence", cadence, `${questions} of ${total} ask questions`),
  ].join("");

  // themes — top keywords from captions (filter stop-words)
  const themes = topKeywords(posts.map((p) => p.caption || "").join(" "), 12);
  if (themes.length) {
    themes.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "px-2 py-0.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-400/20 text-fuchsia-200 text-xs";
      chip.textContent = t.word;
      themesEl.appendChild(chip);
    });
  } else themesEl.innerHTML = '<span class="text-xs text-slate-500">No themes detected.</span>';

  // mentions (@accounts in captions — potential collaborators / brands worked with)
  const mentionCount = new Map();
  for (const p of posts) {
    const matches = (p.caption || "").match(/@([\w.]{2,30})/g) || [];
    for (const raw of matches) {
      const u = raw.replace(/^@/, "").toLowerCase();
      if (u === profile.username) continue;
      mentionCount.set(u, (mentionCount.get(u) || 0) + 1);
    }
  }
  const mentions = Array.from(mentionCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (mentions.length) {
    mentions.forEach(([u, c]) => {
      const chip = document.createElement("a");
      chip.href = `https://www.instagram.com/${u}/`;
      chip.target = "_blank";
      chip.rel = "noreferrer";
      chip.className = "px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-400/20 text-sky-200 text-xs hover:bg-sky-500/20 transition";
      chip.innerHTML = `@${u} <span class="text-slate-500">·${c}</span>`;
      mentionsEl.appendChild(chip);
    });
  } else mentionsEl.innerHTML = '<span class="text-xs text-slate-500">No @mentions in recent captions.</span>';

  // hashtag clusters (pairs that appear together)
  const cluster = new Map();
  for (const p of posts) {
    const tags = Array.from(new Set(((p.caption || "").match(/#[\p{L}0-9_]+/gu) || []).map((x) => x.toLowerCase())));
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = [tags[i], tags[j]].sort().join(" · ");
        cluster.set(key, (cluster.get(key) || 0) + 1);
      }
    }
  }
  const clusters = Array.from(cluster.entries()).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (clusters.length) {
    clusters.forEach(([pair, count]) => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5";
      row.innerHTML = `<span class="text-fuchsia-200 truncate">${pair}</span><span class="text-slate-400">${count}×</span>`;
      clustersEl.appendChild(row);
    });
  } else clustersEl.innerHTML = '<p class="text-xs text-slate-500">No recurring hashtag pairs.</p>';

  // content suggestions based on detected patterns
  const suggestions = [];
  if (counts.Reel < counts.Photo) suggestions.push("Try more Reels — Instagram pushes video heavily in 2025.");
  if (counts.Carousel === 0 && posts.length > 5) suggestions.push("Add a carousel — they typically out-engage single photos.");
  if (questions / total < 0.2) suggestions.push("Add a question to captions — drives comments (currently only " + Math.round((questions / total) * 100) + "% do).");
  if (avgLen < 50) suggestions.push("Try a longer storytelling caption once a week — saves & shares jump.");
  if (avgEmojis === "0.0") suggestions.push("Sprinkle 1–2 relevant emojis — improves click & retention.");
  const er = posts.length && profile.followers ? (posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length / profile.followers) * 100 : 0;
  if (er < 1 && profile.followers < 100_000) suggestions.push("Engagement <1% — collab with a peer account (similar size, different niche) to grow reach.");
  if (themes[0]) suggestions.push(`Double down on "${themes[0].word}" content — it dominates the captions.`);
  if (lang.code !== "en" && lang.code !== "?") suggestions.push(`Caption mostly in ${lang.name} — mirror that in collabs / brand briefs.`);
  if (!suggestions.length) suggestions.push("Strong format mix — keep current rhythm; experiment with one new format/month.");
  suggestions.slice(0, 6).forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s;
    sugEl.appendChild(li);
  });

  // stash for brand step
  window.__contentPatterns = { counts, avgLen, themes, mentions, lang, er, suggestions };
}

function guessLanguage(posts) {
  const text = posts.map((p) => p.caption || "").join(" ").toLowerCase();
  if (text.length < 30) return { code: "?", name: "Unknown" };
  const dicts = {
    en: ["the", "and", "you", "with", "this", "for", "from", "what", "have"],
    fr: ["le", "la", "les", "des", "une", "avec", "pour", "dans", "qui", "tout"],
    es: ["el", "la", "los", "las", "que", "con", "para", "una", "del", "más"],
    pt: ["um", "uma", "para", "que", "com", "não", "mais", "como", "muito"],
    it: ["il", "lo", "che", "una", "per", "con", "mio", "sono"],
    de: ["der", "die", "das", "und", "mit", "ist", "ich", "auf"],
    ar: ["في", "من", "على", "هذا", "إلى", "كل", "أن"],
  };
  const names = { en: "English", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", de: "German", ar: "Arabic" };
  let best = ["?", 0];
  for (const [code, words] of Object.entries(dicts)) {
    let score = 0;
    for (const w of words) {
      const rx = new RegExp("\\b" + w + "\\b", "g");
      score += (text.match(rx) || []).length;
    }
    if (score > best[1]) best = [code, score];
  }
  return { code: best[0], name: names[best[0]] || "Unknown" };
}

const STOPWORDS = new Set("the and you with this for from what have just but our not has are was that one out get can will all my me i we us your they their about more over into when has http https www com".split(" "));
function topKeywords(text, n) {
  const words = (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#\w+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const c = new Map();
  for (const w of words) c.set(w, (c.get(w) || 0) + 1);
  return Array.from(c.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

function detectNiches(profile, posts) {
  const blob = [
    profile.biography || "",
    profile.category || "",
    profile.full_name || "",
    posts.map((p) => p.caption || "").join(" "),
    posts.map((p) => ((p.caption || "").match(/#[\p{L}0-9_]+/gu) || []).join(" ")).join(" "),
  ].join(" ").toLowerCase();

  const scores = [];
  for (const [key, def] of Object.entries(NICHE_BRANDS)) {
    let score = 0;
    for (const kw of def.keywords) {
      const rx = new RegExp(`\\b${kw}`, "g");
      score += (blob.match(rx) || []).length;
    }
    if (score > 0) scores.push({ key, score, def });
  }
  // bonus from explicit category match
  const cat = (profile.category || "").toLowerCase();
  if (cat.includes("athlete") || cat.includes("sport")) scores.push({ key: "athlete", score: 5, def: NICHE_BRANDS.athlete });
  if (cat.includes("beauty") || cat.includes("cosmetic")) scores.push({ key: "beauty", score: 5, def: NICHE_BRANDS.beauty });
  if (cat.includes("art") || cat.includes("design")) scores.push({ key: "artist", score: 5, def: NICHE_BRANDS.artist });
  if (cat.includes("music") || cat.includes("dj")) scores.push({ key: "music", score: 5, def: NICHE_BRANDS.music });
  if (cat.includes("food") || cat.includes("chef")) scores.push({ key: "food", score: 5, def: NICHE_BRANDS.food });

  // consolidate duplicates
  const merged = new Map();
  for (const s of scores) {
    const e = merged.get(s.key) || { ...s, score: 0 };
    e.score += s.score;
    merged.set(s.key, e);
  }
  let result = Array.from(merged.values()).sort((a, b) => b.score - a.score);
  if (!result.length) result.push({ key: "lifestyle", score: 1, def: NICHE_BRANDS.lifestyle });
  return result.slice(0, 3);
}

// ====================================================
// REEL IDEAS · CAPTION TEMPLATES · COLLAB TARGETS
// ====================================================

const REEL_FORMATS = [
  { id: "grwm", emoji: "💄", name: "GRWM (60s)", hook: 'Get ready with me for [moment]', structure: "Intro hook → quick prep cuts → reveal", best_time: "morning", niches: ["fashion","beauty","fitness","lifestyle","business"] },
  { id: "ditl", emoji: "🌅", name: "Day in the life", hook: 'A day as a [role]', structure: "Time-stamped cuts: 7am, 10am, 1pm, 5pm, 9pm", best_time: "evening", niches: ["lifestyle","business","fitness","artist","photography","parenting","food"] },
  { id: "listicle", emoji: "📝", name: "Listicle (numbered)", hook: '[N] [things] that changed my [outcome]', structure: "Hook → 5 quick text cards with B-roll → CTA", best_time: "lunch", niches: ["fitness","business","beauty","food","tech","health","finance","parenting"] },
  { id: "tutorial", emoji: "🎓", name: "Tutorial / how-to", hook: 'How I [achieve outcome] in 30 seconds', structure: "Pain point → fast steps → result", best_time: "morning", niches: ["beauty","artist","tech","food","photography","fitness","music","business"] },
  { id: "before_after", emoji: "✨", name: "Before / after", hook: 'I tried [routine/product] for [duration]', structure: "Before footage → process montage → after reveal", best_time: "evening", niches: ["fitness","beauty","artist","fashion","food","health","photography"] },
  { id: "reaction", emoji: "😱", name: "Reaction to a trend", hook: 'I tried the [trending thing] so you don\'t have to', structure: "Setup → live reaction → verdict", best_time: "afternoon", niches: ["beauty","food","tech","gaming","lifestyle","fashion"] },
  { id: "story_time", emoji: "📖", name: "Story time", hook: 'The time I [unexpected event] (story time)', structure: "Bait hook → reveal → twist → lesson", best_time: "evening", niches: ["lifestyle","business","travel","parenting","artist","music"] },
  { id: "pov", emoji: "👀", name: "POV / relatable", hook: 'POV: you\'re the [archetype]', structure: "Quick relatable scenario, often silent w/ captions", best_time: "lunch", niches: ["lifestyle","fashion","gaming","parenting","fitness","food"] },
  { id: "transition", emoji: "🌀", name: "Transition (outfit/skill)", hook: 'Wait for it…', structure: "Trigger frame → cut → big visual change", best_time: "evening", niches: ["fashion","beauty","fitness","artist","photography","music"] },
  { id: "qa", emoji: "💬", name: "Q&A response", hook: 'Answering the question I get the most', structure: "Read DM/comment → quick answer → CTA for more", best_time: "morning", niches: ["business","fitness","beauty","health","finance","tech","artist","parenting"] },
  { id: "bts", emoji: "🎬", name: "Behind the scenes", hook: 'BTS of how this [thing] gets made', structure: "Setup → process steps → finished result", best_time: "afternoon", niches: ["artist","food","music","fashion","photography","business","beauty"] },
  { id: "case_study", emoji: "📈", name: "Mini case study", hook: 'How [client/project] went from [A] to [B]', structure: "Problem → action → numbers/result", best_time: "lunch", niches: ["business","finance","fitness","health","artist","photography"] },
  { id: "trend_remix", emoji: "🎵", name: "Trending audio remix", hook: 'Using [trending audio] for [your niche]', structure: "Match beat → niche-specific visual swap", best_time: "evening", niches: ["fashion","beauty","music","fitness","gaming","lifestyle","food"] },
  { id: "comparison", emoji: "⚖️", name: "A vs B comparison", hook: '[Option A] vs [Option B] — which wins?', structure: "Setup criteria → quick test of each → verdict", best_time: "afternoon", niches: ["tech","food","beauty","fashion","fitness","gaming","photography","finance"] },
  { id: "hot_take", emoji: "🔥", name: "Hot take / unpopular opinion", hook: 'Unpopular opinion: [bold statement]', structure: "Stake claim → 3 reasons → invite debate", best_time: "morning", niches: ["business","fitness","tech","finance","health","music","gaming"] },
];

function generateReelIdeas(posts, profile) {
  const niches = detectNiches(profile, posts);
  const top = niches[0]?.key || "lifestyle";
  const themes = topKeywords(posts.map((p) => p.caption || "").join(" "), 8).map((t) => t.word);
  const topHashtags = (() => {
    const c = new Map();
    for (const p of posts) {
      const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
      for (const t of new Set(tags.map((x) => x.toLowerCase()))) c.set(t, (c.get(t) || 0) + 1);
    }
    return Array.from(c.keys()).slice(0, 6);
  })();
  const cat = (profile.category || niches[0]?.def?.label || "creator").toLowerCase();
  const niceCat = profile.category || niches[0]?.def?.label || "creator";
  const role = niceCat;
  const moment = themes[0] ? themes[0] : niceCat.toLowerCase();
  const outcome = themes[1] || "best results";

  // pick formats that match the top niche, plus 2 wildcards
  const matching = REEL_FORMATS.filter((f) => f.niches.includes(top));
  const wildcards = REEL_FORMATS.filter((f) => !f.niches.includes(top));
  const shuffle = (arr) => arr.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const selected = [...shuffle(matching).slice(0, 9), ...shuffle(wildcards).slice(0, 3)];

  // tag bundle suggestion: top 4 of theirs + 2 niche-generic
  const nicheKeywords = niches[0]?.def?.keywords || [];
  const nicheTags = nicheKeywords.slice(0, 3).map((k) => "#" + k);
  const tagBundle = [...new Set([...topHashtags.slice(0, 4), ...nicheTags])].slice(0, 6);

  return selected.map((f) => ({
    ...f,
    hook_filled: f.hook
      .replace("[moment]", `'${moment}'`)
      .replace("[role]", role)
      .replace("[things]", themes[0] || "secrets")
      .replace("[outcome]", outcome)
      .replace("[N]", "5")
      .replace("[achieve outcome]", `get ${outcome}`)
      .replace("[duration]", "30 days")
      .replace("[routine/product]", themes[2] || "this routine")
      .replace("[trending thing]", `the ${themes[0] || "viral"} trend`)
      .replace("[unexpected event]", `tried ${themes[0] || "this"}`)
      .replace("[archetype]", role)
      .replace("[thing]", themes[0] || cat + " content")
      .replace("[client/project]", "a recent project")
      .replace("[A]", "0")
      .replace("[B]", themes[1] || "10K"),
    tags: tagBundle,
  }));
}

function renderReelIdeas(posts, profile) {
  $("reel-ideas-username").textContent = "@" + profile.username;
  const grid = $("reel-ideas-grid");
  grid.innerHTML = "";
  const ideas = generateReelIdeas(posts, profile);
  window.__lastReelIdeas = { posts, profile };

  ideas.forEach((idea, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "flex flex-col";
    wrap.innerHTML = `
      <div class="reel-card" data-idea-idx="${idx}">
        <div class="reel-bg reel-grad-${idea.id || "default"}"></div>
        <div class="reel-vignette"></div>
        <div class="reel-statusbar">
          <span>${idea.best_time === "morning" ? "🌅" : idea.best_time === "lunch" ? "☀️" : idea.best_time === "afternoon" ? "🌤" : "🌙"} ${idea.best_time}</span>
          <span>${(idea.name || "").split("(")[0].trim().toUpperCase()}</span>
        </div>
        <div class="reel-format-emoji">${idea.emoji || "🎬"}</div>
        <div class="reel-hook">${escapeHtml(idea.hook_filled)}</div>
        <div class="reel-side-icons">
          <div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.3-9.2C1.1 8 3.4 4 7.3 4c2 0 3.4 1 4.7 2.5C13.3 5 14.7 4 16.7 4c3.9 0 6.2 4 4.6 7.8C19 16.5 12 21 12 21z"/></svg><span>${randEngagement(50, 800)}</span></div>
          <div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span>${randEngagement(5, 80)}</span></div>
          <div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m3 11 18-8-8 18-2-7-8-3z"/></svg><span>${randEngagement(2, 40)}</span></div>
        </div>
        <div class="reel-tags">
          ${idea.tags.slice(0, 4).map((t) => `<span class="reel-tag">${t}</span>`).join("")}
        </div>
      </div>
      <div class="reel-card-meta">
        <strong>${idea.name}</strong>
        <p class="mt-0.5 text-[10px] text-slate-500 leading-snug">${idea.structure}</p>
      </div>
      <div class="reel-card-actions">
        <button data-act="cover" title="Generate AI cover image (free)"><i data-lucide="image" class="w-3 h-3"></i>Cover</button>
        <button data-act="copy" title="Copy script"><i data-lucide="clipboard-copy" class="w-3 h-3"></i>Copy</button>
        <button data-act="watch" title="Save to watchlist of ideas"><i data-lucide="bookmark" class="w-3 h-3"></i>Save</button>
      </div>`;

    wrap.querySelector('[data-act="copy"]').addEventListener("click", () => {
      const txt = `${idea.name}\n\nHook: ${idea.hook_filled}\nStructure: ${idea.structure}\nBest time: ${idea.best_time}\nTags: ${idea.tags.join(" ")}`;
      navigator.clipboard.writeText(txt);
      flashBtn(wrap.querySelector('[data-act="copy"]'), "Copied ✓");
    });
    wrap.querySelector('[data-act="cover"]').addEventListener("click", (e) => {
      const btn = e.currentTarget;
      generateReelCover(wrap.querySelector(".reel-card"), idea, btn);
    });
    wrap.querySelector('[data-act="watch"]').addEventListener("click", () => {
      saveReelIdea(idea, profile.username);
      flashBtn(wrap.querySelector('[data-act="watch"]'), "Saved ✓");
    });

    grid.appendChild(wrap);
  });
  lucide.createIcons();
}

function randEngagement(min, max) {
  const n = Math.floor(Math.random() * (max - min) + min);
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : n;
}
function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function flashBtn(btn, text) {
  const orig = btn.innerHTML;
  btn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i>${text}`;
  lucide.createIcons();
  setTimeout(() => {
    btn.innerHTML = orig;
    lucide.createIcons();
  }, 1500);
}

async function generateReelCover(card, idea, btn) {
  // Build a prompt for Pollinations.ai (free, no key needed)
  const niche = idea.niches?.[0] || "lifestyle";
  const visualStyle = "vertical 9:16 Instagram reel cover, vibrant, modern aesthetic, social media";
  const subject = idea.hook_filled.replace(/['"`]/g, "").slice(0, 100);
  const prompt = `${subject} — ${niche} content creator, ${visualStyle}, no text, cinematic lighting`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=540&height=960&model=flux&nologo=true&enhance=true&seed=${Math.floor(Math.random() * 99999)}`;

  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="animate-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="40 100"/></svg>Generating';

  // preload the image, then swap the background
  const img = new Image();
  img.onload = () => {
    const bg = card.querySelector(".reel-bg");
    bg.style.backgroundImage = `url(${url})`;
    bg.classList.remove(...Array.from(bg.classList).filter((c) => c.startsWith("reel-grad-")));
    // hide the giant emoji once we have a real cover
    const e = card.querySelector(".reel-format-emoji");
    if (e) e.style.opacity = "0";
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3"></i>Regen';
    lucide.createIcons();
  };
  img.onerror = () => {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="alert-triangle" class="w-3 h-3"></i>Retry';
    lucide.createIcons();
  };
  img.src = url;
}

function saveReelIdea(idea, username) {
  const key = "ig_saved_reel_ideas_v1";
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
  arr.unshift({ ts: Date.now(), username, idea });
  localStorage.setItem(key, JSON.stringify(arr.slice(0, 100)));
}

// ---------- caption templates ----------
function renderCaptionTemplates(posts) {
  const el = $("caption-templates");
  el.innerHTML = "";
  // pick top 5 posts by engagement, abstract them into templates
  const ranked = [...posts]
    .filter((p) => (p.caption || "").trim())
    .sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))
    .slice(0, 5);

  if (!ranked.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No captions to learn from.</p>';
    return;
  }

  ranked.forEach((p, i) => {
    const tmpl = abstractCaption(p.caption);
    const eng = (p.likes || 0) + (p.comments || 0);
    const card = document.createElement("div");
    card.className = "rounded-lg p-3 bg-black/30 border border-white/5 hover:border-fuchsia-400/30 transition";
    card.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <span class="text-[10px] uppercase tracking-wider text-slate-400">Template #${i + 1} · from top post (${fmt(eng)} eng)</span>
        <button class="text-[11px] text-slate-400 hover:text-fuchsia-300 inline-flex items-center gap-1"><i data-lucide="clipboard-copy" class="w-3 h-3"></i>Copy</button>
      </div>
      <p class="text-xs text-slate-300 leading-relaxed whitespace-pre-line">${tmpl}</p>`;
    const btn = card.querySelector("button");
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(tmpl);
      btn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>Copied';
      lucide.createIcons();
      setTimeout(() => {
        btn.innerHTML = '<i data-lucide="clipboard-copy" class="w-3 h-3"></i>Copy';
        lucide.createIcons();
      }, 1500);
    });
    el.appendChild(card);
  });
  lucide.createIcons();
}

function abstractCaption(caption) {
  if (!caption) return "";
  let t = caption.trim();
  // collapse repeated whitespace
  t = t.replace(/\s+/g, " ");
  // replace named @mentions with placeholder
  t = t.replace(/@[\w.]+/g, "@[partner]");
  // replace URLs
  t = t.replace(/https?:\/\/\S+/g, "[link]");
  // replace specific numbers/dates
  t = t.replace(/\b\d{1,3}([,.\s]?\d{3})+\b/g, "[N]");
  t = t.replace(/\b\d{4,}\b/g, "[N]");
  // replace "year" mentions
  t = t.replace(/\b(20\d{2}|19\d{2})\b/g, "[year]");
  // truncate
  if (t.length > 280) t = t.slice(0, 280) + "…";
  return t;
}

// ---------- collab targets ----------
function renderCollabTargets(posts, profile) {
  const el = $("collab-targets");
  el.innerHTML = "";
  const seen = new Map();

  // seed from API-supplied related profiles (high signal)
  (profile.related_profiles || []).forEach((r) => {
    const k = (r.username || "").toLowerCase();
    if (!k || k === profile.username.toLowerCase()) return;
    seen.set(k, {
      username: r.username,
      full_name: r.full_name,
      profile_pic: r.profile_pic,
      is_verified: r.is_verified,
      reasons: ["Instagram lists as similar"],
      score: 3,
    });
  });

  // augment from frequently-mentioned accounts in their captions
  const mentions = new Map();
  for (const p of posts) {
    const matches = (p.caption || "").match(/@([\w.]{2,30})/g) || [];
    for (const raw of matches) {
      const u = raw.replace(/^@/, "").toLowerCase();
      if (u === profile.username.toLowerCase()) continue;
      mentions.set(u, (mentions.get(u) || 0) + 1);
    }
  }
  for (const [u, count] of mentions.entries()) {
    const existing = seen.get(u) || { username: u, reasons: [], score: 0 };
    existing.reasons.push(`Mentioned ${count}× in recent captions`);
    existing.score += Math.min(3, count);
    seen.set(u, existing);
  }

  let list = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 10);

  if (!list.length) {
    el.innerHTML = '<p class="text-xs text-slate-500 col-span-2 py-2">No collab candidates from public data. Try a more active account.</p>';
    return;
  }

  list.forEach((c) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-3 p-3 rounded-lg bg-black/30 border border-white/5 hover:border-fuchsia-400/30 transition";
    const pic = c.profile_pic
      ? `<img src="/api/image?url=${encodeURIComponent(c.profile_pic)}" class="w-9 h-9 rounded-full object-cover shrink-0" onerror="this.style.display='none'"/>`
      : '<div class="w-9 h-9 rounded-full bg-white/10 shrink-0"></div>';
    row.innerHTML = `
      ${pic}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="font-semibold text-sm truncate">${c.full_name || c.username}</span>
          ${c.is_verified ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="#38bdf8"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>' : ""}
        </div>
        <div class="text-[11px] text-fuchsia-300 truncate">@${c.username}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">${c.reasons.join(" · ")}</div>
      </div>
      <div class="flex flex-col gap-1 shrink-0">
        <button data-action="lookup" class="px-2 py-1 rounded-md bg-white/5 hover:bg-fuchsia-500/20 text-[10px] transition">Lookup</button>
        <a href="https://www.instagram.com/${c.username}/" target="_blank" rel="noreferrer" class="px-2 py-1 rounded-md bg-white/5 hover:bg-white/15 text-[10px] text-center transition">Open IG</a>
      </div>`;
    row.querySelector('[data-action="lookup"]').addEventListener("click", () => {
      $("lookup-input").value = c.username;
      doLookup();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    el.appendChild(row);
  });
}

async function refreshSimilarAccounts() {
  if (!window.__lastLookup) return;
  const btn = $("related-refresh");
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>';
  lucide.createIcons();
  try {
    const res = await fetch(`/api/lookup?username=${encodeURIComponent(window.__lastLookup.username)}`);
    const data = await res.json();
    if (data.related_profiles) {
      window.__lastLookup.related_profiles = data.related_profiles;
      // re-render the related profiles section
      const rel = $("related-profiles");
      rel.innerHTML = "";
      if (!data.related_profiles.length) {
        rel.innerHTML = '<p class="text-xs text-slate-500 py-2">Instagram didn\'t return any related profiles this time.</p>';
      } else {
        data.related_profiles.forEach((r) => {
          const row = document.createElement("a");
          row.className = "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition group";
          row.href = `https://www.instagram.com/${r.username}/`;
          row.target = "_blank";
          row.rel = "noreferrer";
          const pic = r.profile_pic
            ? `<img src="/api/image?url=${encodeURIComponent(r.profile_pic)}" class="w-8 h-8 rounded-full object-cover shrink-0" onerror="this.style.display='none'"/>`
            : '<div class="w-8 h-8 rounded-full bg-white/10 shrink-0"></div>';
          row.innerHTML = `
            <div class="flex items-center gap-2.5 min-w-0">
              ${pic}
              <div class="min-w-0">
                <div class="text-sm truncate">${r.full_name || r.username}</div>
                <div class="text-[11px] text-fuchsia-300 truncate">@${r.username}${r.is_verified ? ' ✓' : ''}</div>
              </div>
            </div>
            <button class="text-xs text-slate-500 group-hover:text-fuchsia-300">Look up</button>`;
          row.querySelector("button").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            $("lookup-input").value = r.username;
            doLookup();
            window.scrollTo({ top: 0, behavior: "smooth" });
          });
          rel.appendChild(row);
        });
      }
      renderCollabTargets(window.__lastLookup.posts, window.__lastLookup);
    }
  } catch (e) {
    console.warn(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3"></i>';
    lucide.createIcons();
  }
}

// ====================================================
// BRAND PARTNERSHIP DETECTION
// ====================================================

// Curated database of known brands. `handles` = lowercase IG handles to match
// in @mentions. `category` groups them. Includes global + MENA / Morocco focus
// (matching the user's region). Add more freely — order doesn't matter.
const KNOWN_BRANDS = [
  // ---- Food delivery ----
  { name: "Glovo", category: "Food delivery", color: "#FFC244", handles: ["glovo", "glovoapp", "glovomaroc", "glovo_maroc", "glovo_es", "glovo_pt"] },
  { name: "Uber Eats", category: "Food delivery", color: "#06C167", handles: ["ubereats"] },
  { name: "Deliveroo", category: "Food delivery", color: "#00CCBC", handles: ["deliveroo"] },
  { name: "DoorDash", category: "Food delivery", color: "#FF3008", handles: ["doordash"] },
  { name: "Wolt", category: "Food delivery", color: "#00C2E8", handles: ["wolt"] },
  { name: "Talabat", category: "Food delivery", color: "#FF5A00", handles: ["talabat"] },
  { name: "JahezApp", category: "Food delivery", color: "#FF6633", handles: ["jahezapp"] },

  // ---- Fast food & chains ----
  { name: "McDonald's", category: "Fast food", color: "#FFC72C", handles: ["mcdonalds", "mcdonaldsmaroc", "mcdonalds_ma"] },
  { name: "Pizza Hut", category: "Fast food", color: "#EE3124", handles: ["pizzahut", "pizzahutmaroc", "pizzahut_ma"] },
  { name: "Domino's", category: "Fast food", color: "#0078AE", handles: ["dominos", "dominosmaroc"] },
  { name: "KFC", category: "Fast food", color: "#F40027", handles: ["kfc", "kfcmaroc", "kfc_ma"] },
  { name: "Burger King", category: "Fast food", color: "#D62300", handles: ["burgerking", "burgerkingmaroc", "burgerking_ma"] },
  { name: "Subway", category: "Fast food", color: "#008C15", handles: ["subway"] },
  { name: "Starbucks", category: "Coffee", color: "#006241", handles: ["starbucks", "starbucksmaroc"] },
  { name: "Dunkin'", category: "Coffee", color: "#FF671F", handles: ["dunkin"] },

  // ---- Fashion ----
  { name: "Nike", category: "Sportswear", color: "#000000", handles: ["nike", "nikefootball", "nikewomen"] },
  { name: "Adidas", category: "Sportswear", color: "#000000", handles: ["adidas", "adidasfootball", "adidasoriginals"] },
  { name: "Puma", category: "Sportswear", color: "#000000", handles: ["puma"] },
  { name: "Under Armour", category: "Sportswear", color: "#1428A0", handles: ["underarmour"] },
  { name: "New Balance", category: "Sportswear", color: "#000000", handles: ["newbalance"] },
  { name: "Reebok", category: "Sportswear", color: "#E51E2D", handles: ["reebok"] },
  { name: "Lululemon", category: "Sportswear", color: "#A41E1E", handles: ["lululemon"] },
  { name: "Gymshark", category: "Sportswear", color: "#000000", handles: ["gymshark"] },
  { name: "Zara", category: "Fashion", color: "#000000", handles: ["zara"] },
  { name: "H&M", category: "Fashion", color: "#E50010", handles: ["hm"] },
  { name: "Uniqlo", category: "Fashion", color: "#FF0000", handles: ["uniqlo"] },
  { name: "Shein", category: "Fashion", color: "#000000", handles: ["sheinofficial", "shein_official"] },
  { name: "ASOS", category: "Fashion", color: "#000000", handles: ["asos"] },
  { name: "Levi's", category: "Fashion", color: "#E60012", handles: ["levis"] },
  { name: "Tommy Hilfiger", category: "Fashion", color: "#003366", handles: ["tommyhilfiger"] },
  { name: "Lacoste", category: "Fashion", color: "#04AC34", handles: ["lacoste"] },

  // ---- Luxury ----
  { name: "Louis Vuitton", category: "Luxury", color: "#8B6F3B", handles: ["louisvuitton"] },
  { name: "Gucci", category: "Luxury", color: "#000000", handles: ["gucci"] },
  { name: "Chanel", category: "Luxury", color: "#000000", handles: ["chanelofficial"] },
  { name: "Dior", category: "Luxury", color: "#000000", handles: ["dior"] },
  { name: "Hermès", category: "Luxury", color: "#FF6900", handles: ["hermes"] },
  { name: "Prada", category: "Luxury", color: "#000000", handles: ["prada"] },
  { name: "Versace", category: "Luxury", color: "#000000", handles: ["versace"] },
  { name: "Rolex", category: "Luxury watches", color: "#006039", handles: ["rolex"] },
  { name: "Cartier", category: "Luxury watches", color: "#A41723", handles: ["cartier"] },

  // ---- Beauty ----
  { name: "Sephora", category: "Beauty", color: "#000000", handles: ["sephora"] },
  { name: "Fenty Beauty", category: "Beauty", color: "#000000", handles: ["fentybeauty"] },
  { name: "MAC Cosmetics", category: "Beauty", color: "#000000", handles: ["maccosmetics"] },
  { name: "L'Oréal", category: "Beauty", color: "#000000", handles: ["lorealparis", "loreal"] },
  { name: "Maybelline", category: "Beauty", color: "#E5048C", handles: ["maybelline"] },
  { name: "NYX Cosmetics", category: "Beauty", color: "#000000", handles: ["nyxcosmetics"] },
  { name: "Charlotte Tilbury", category: "Beauty", color: "#000000", handles: ["charlottetilbury"] },
  { name: "Huda Beauty", category: "Beauty", color: "#FF69B4", handles: ["hudabeauty"] },
  { name: "Glossier", category: "Beauty", color: "#FF7B96", handles: ["glossier"] },
  { name: "The Ordinary", category: "Skincare", color: "#000000", handles: ["theordinary"] },
  { name: "Drunk Elephant", category: "Skincare", color: "#FF69B4", handles: ["drunkelephantskincare", "drunkelephant"] },

  // ---- Tech ----
  { name: "Apple", category: "Tech", color: "#000000", handles: ["apple"] },
  { name: "Samsung", category: "Tech", color: "#1428A0", handles: ["samsung", "samsungmobile"] },
  { name: "Sony", category: "Tech", color: "#000000", handles: ["sony"] },
  { name: "DJI", category: "Tech / Drones", color: "#000000", handles: ["djiglobal"] },
  { name: "GoPro", category: "Cameras", color: "#000000", handles: ["gopro"] },
  { name: "Canon", category: "Cameras", color: "#CC0000", handles: ["canonusa", "canon_uk", "canon"] },
  { name: "Nikon", category: "Cameras", color: "#FFC107", handles: ["nikonusa", "nikon"] },
  { name: "Fujifilm", category: "Cameras", color: "#FF0000", handles: ["fujifilm", "fujifilm_xseries"] },
  { name: "Bose", category: "Audio", color: "#000000", handles: ["bose"] },
  { name: "Beats by Dre", category: "Audio", color: "#FF0000", handles: ["beatsbydre"] },
  { name: "Logitech", category: "Tech", color: "#0094D6", handles: ["logitech", "logitechg"] },
  { name: "Razer", category: "Gaming gear", color: "#44D62C", handles: ["razer"] },
  { name: "HyperX", category: "Gaming gear", color: "#FF0000", handles: ["hyperx"] },

  // ---- Auto ----
  { name: "BMW", category: "Automotive", color: "#0066B1", handles: ["bmw"] },
  { name: "Mercedes-Benz", category: "Automotive", color: "#000000", handles: ["mercedesbenz"] },
  { name: "Audi", category: "Automotive", color: "#BB0A30", handles: ["audi"] },
  { name: "Tesla", category: "Automotive", color: "#CC0000", handles: ["teslamotors", "tesla"] },
  { name: "Porsche", category: "Automotive", color: "#000000", handles: ["porsche"] },
  { name: "Ferrari", category: "Automotive", color: "#FF2800", handles: ["ferrari"] },
  { name: "Lamborghini", category: "Automotive", color: "#000000", handles: ["lamborghini"] },
  { name: "Toyota", category: "Automotive", color: "#EB0A1E", handles: ["toyotausa", "toyota"] },
  { name: "Renault", category: "Automotive", color: "#FFC700", handles: ["renault"] },
  { name: "Peugeot", category: "Automotive", color: "#001E5C", handles: ["peugeot"] },
  { name: "Hyundai", category: "Automotive", color: "#002C5F", handles: ["hyundai"] },

  // ---- Beverages ----
  { name: "Coca-Cola", category: "Beverages", color: "#F40009", handles: ["cocacola"] },
  { name: "Pepsi", category: "Beverages", color: "#004B93", handles: ["pepsi"] },
  { name: "Red Bull", category: "Energy drink", color: "#001489", handles: ["redbull"] },
  { name: "Monster Energy", category: "Energy drink", color: "#00FF00", handles: ["monsterenergy"] },
  { name: "Heineken", category: "Beer", color: "#00913F", handles: ["heineken"] },
  { name: "Corona", category: "Beer", color: "#FFC72C", handles: ["coronaextra"] },

  // ---- Telecom / Mobile ----
  { name: "Orange", category: "Telecom", color: "#FF7900", handles: ["orange", "orangemaroc", "orange_maroc"] },
  { name: "Inwi", category: "Telecom (MA)", color: "#9B005C", handles: ["inwi", "inwi_maroc"] },
  { name: "Maroc Telecom", category: "Telecom (MA)", color: "#0066B3", handles: ["maroctelecom"] },
  { name: "Vodafone", category: "Telecom", color: "#E60000", handles: ["vodafone"] },
  { name: "T-Mobile", category: "Telecom", color: "#E20074", handles: ["tmobile"] },

  // ---- Travel / Hotels ----
  { name: "Airbnb", category: "Travel", color: "#FF5A5F", handles: ["airbnb"] },
  { name: "Booking.com", category: "Travel", color: "#003580", handles: ["bookingcom"] },
  { name: "Marriott", category: "Hotels", color: "#A52439", handles: ["marriottinternational", "marriott"] },
  { name: "Hilton", category: "Hotels", color: "#000080", handles: ["hilton"] },
  { name: "Hyatt", category: "Hotels", color: "#000000", handles: ["hyatt"] },
  { name: "Four Seasons", category: "Hotels", color: "#A38247", handles: ["fourseasons"] },
  { name: "Emirates", category: "Airline", color: "#D71921", handles: ["emirates"] },
  { name: "Qatar Airways", category: "Airline", color: "#5C0F32", handles: ["qatarairways"] },
  { name: "Air France", category: "Airline", color: "#002157", handles: ["airfrance"] },

  // ---- Retail / Marketplace ----
  { name: "Amazon", category: "Marketplace", color: "#FF9900", handles: ["amazon"] },
  { name: "Carrefour", category: "Retail", color: "#0046BE", handles: ["carrefour", "carrefourmaroc"] },
  { name: "Marjane", category: "Retail (MA)", color: "#005CA9", handles: ["marjane", "marjanemarket"] },
  { name: "Decathlon", category: "Sports retail", color: "#0082C3", handles: ["decathlon", "decathlonmaroc"] },
  { name: "IKEA", category: "Furniture", color: "#0058A3", handles: ["ikea", "ikeamaroc"] },

  // ---- Finance / Crypto ----
  { name: "PayPal", category: "Fintech", color: "#003087", handles: ["paypal"] },
  { name: "Wise", category: "Fintech", color: "#9FE870", handles: ["wise"] },
  { name: "Revolut", category: "Fintech", color: "#000000", handles: ["revolutapp"] },
  { name: "Binance", category: "Crypto", color: "#F3BA2F", handles: ["binance"] },
  { name: "Coinbase", category: "Crypto", color: "#0052FF", handles: ["coinbase"] },
  { name: "Kraken", category: "Crypto", color: "#5840D2", handles: ["krakenfx"] },

  // ---- Apps / Software ----
  { name: "Spotify", category: "Music streaming", color: "#1DB954", handles: ["spotify"] },
  { name: "Apple Music", category: "Music streaming", color: "#FA243C", handles: ["applemusic"] },
  { name: "Netflix", category: "Streaming", color: "#E50914", handles: ["netflix"] },
  { name: "Disney+", category: "Streaming", color: "#113CCF", handles: ["disneyplus"] },
  { name: "Notion", category: "SaaS", color: "#000000", handles: ["notionhq"] },
  { name: "Canva", category: "SaaS", color: "#00C4CC", handles: ["canva"] },
  { name: "Adobe", category: "SaaS", color: "#FF0000", handles: ["adobe", "lightroom", "photoshop"] },

  // ---- Health & supplements ----
  { name: "Whoop", category: "Wearables", color: "#000000", handles: ["whoop"] },
  { name: "Garmin", category: "Wearables", color: "#000000", handles: ["garmin"] },
  { name: "Optimum Nutrition", category: "Supplements", color: "#000000", handles: ["optimumnutrition"] },
  { name: "MyProtein", category: "Supplements", color: "#000000", handles: ["myprotein"] },
  { name: "Athletic Greens", category: "Supplements", color: "#000000", handles: ["athleticgreens"] },
  { name: "Liquid IV", category: "Supplements", color: "#FF6B35", handles: ["liquidiv"] },

  // ---- Misc popular ----
  { name: "Red Bull Racing", category: "Sports / F1", color: "#0600EF", handles: ["redbullracing"] },
  { name: "FC Barcelona", category: "Football club", color: "#A50044", handles: ["fcbarcelona"] },
  { name: "Real Madrid", category: "Football club", color: "#FFFFFF", handles: ["realmadrid"] },
  { name: "Manchester United", category: "Football club", color: "#DA020E", handles: ["manchesterunited"] },
];

const PARTNERSHIP_HASHTAGS = [
  "ad", "sponsored", "paidpartnership", "paidpartner", "partner", "partnership",
  "collab", "collaboration", "gifted", "pr", "prgift", "ambassador",
  "publicité", "publicite", "partenariat", "publi", "anuncio", "publicidad",
];

function detectBrandPartnerships(posts, profile) {
  // Build a lookup map: handle (lowercase) → brand definition
  const handleMap = new Map();
  for (const brand of KNOWN_BRANDS) {
    for (const h of brand.handles) handleMap.set(h.toLowerCase(), brand);
  }

  // Per-brand aggregation
  const stats = new Map(); // key: brand.name → { brand, posts: [], totalEng: 0, latestTs: 0, disclosedCount: 0 }
  const unmatchedMentions = new Map(); // username → count

  for (const p of posts) {
    const caption = (p.caption || "");
    const lc = caption.toLowerCase();
    const eng = (p.likes || 0) + (p.comments || 0);

    // collect every @mention from caption
    const mentions = new Set();
    const matchIter = caption.matchAll(/@([\w.]{2,30})/g);
    for (const m of matchIter) mentions.add(m[1].toLowerCase());

    // detect disclosure hashtags in same post
    const hasDisclosure = PARTNERSHIP_HASHTAGS.some((tag) => new RegExp(`#${tag}\\b`, "i").test(lc));

    let matchedAny = false;
    for (const u of mentions) {
      const brand = handleMap.get(u);
      if (brand) {
        matchedAny = true;
        const e = stats.get(brand.name) || {
          brand,
          posts: [],
          totalEng: 0,
          latestTs: 0,
          disclosedCount: 0,
        };
        e.posts.push(p);
        e.totalEng += eng;
        if ((p.timestamp || 0) > e.latestTs) e.latestTs = p.timestamp || 0;
        if (hasDisclosure) e.disclosedCount++;
        stats.set(brand.name, e);
      } else {
        // potential collab not in our DB
        if (u !== (profile.username || "").toLowerCase()) {
          unmatchedMentions.set(u, (unmatchedMentions.get(u) || 0) + 1);
        }
      }
    }
  }

  // also scan bio for brand handles (signals an ambassador/long-term partnership)
  const bioMentions = new Set(
    ((profile.biography || "").match(/@([\w.]{2,30})/g) || []).map((m) => m.slice(1).toLowerCase())
  );
  // also count "Partner of @X", "Ambassador of @X", etc. in bio
  for (const u of bioMentions) {
    const brand = handleMap.get(u);
    if (brand) {
      const e = stats.get(brand.name) || { brand, posts: [], totalEng: 0, latestTs: 0, disclosedCount: 0 };
      e.bioMention = true;
      stats.set(brand.name, e);
    }
  }

  // sort by post count desc, then total engagement desc, then recency
  const arr = Array.from(stats.values()).sort(
    (a, b) =>
      b.posts.length - a.posts.length ||
      b.totalEng - a.totalEng ||
      b.latestTs - a.latestTs
  );
  const other = Array.from(unmatchedMentions.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([username, count]) => ({ username, count }));
  return { brands: arr, otherMentions: other };
}

function renderBrandPartnerships(posts, profile) {
  const data = detectBrandPartnerships(posts, profile);
  const summaryEl = $("brand-partnerships-summary");
  const gridEl = $("brand-partnerships-grid");
  const otherEl = $("brand-other-mentions");
  summaryEl.innerHTML = "";
  gridEl.innerHTML = "";
  otherEl.innerHTML = "";

  // summary tiles
  const totalPosts = data.brands.reduce((s, b) => s + b.posts.length, 0);
  const categories = new Set(data.brands.map((b) => b.brand.category)).size;
  const disclosed = data.brands.filter((b) => b.disclosedCount > 0).length;
  const inBio = data.brands.filter((b) => b.bioMention).length;
  const tile = (label, value, sub, color = "fuchsia") => `
    <div class="rounded-xl bg-white/5 border border-white/10 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-400">${label}</div>
      <div class="font-display text-base font-bold mt-1 text-${color}-200">${value}</div>
      ${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ""}
    </div>`;
  summaryEl.innerHTML = [
    tile("Brands detected", data.brands.length, `${categories} categor${categories === 1 ? "y" : "ies"}`),
    tile("Posts featuring brands", totalPosts, totalPosts === 1 ? "post" : "posts"),
    tile("With #ad / #sponsored", disclosed, "disclosed partnership"),
    tile("Brand in bio", inBio, "ambassador-style"),
  ].join("");

  if (!data.brands.length) {
    gridEl.innerHTML = '<p class="col-span-full text-center text-xs text-slate-500 py-6">No brand collaborations detected in the last 12 captions.<br/>The account may not have @tagged any brand we know about.</p>';
  } else {
    for (const b of data.brands) {
      const card = document.createElement("a");
      card.href = `https://www.instagram.com/${b.brand.handles[0]}/`;
      card.target = "_blank";
      card.rel = "noreferrer";
      card.className = "rounded-xl p-4 bg-black/30 border border-white/5 hover:border-fuchsia-400/40 transition flex flex-col gap-2";
      const last = b.latestTs ? new Date(b.latestTs * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
      card.innerHTML = `
        <div class="flex items-center gap-2">
          <div class="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold shrink-0" style="background:${b.brand.color}20; color:${b.brand.color}; border:1px solid ${b.brand.color}40">
            ${b.brand.name.slice(0, 2).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-sm truncate">${b.brand.name}</div>
            <div class="text-[11px] text-slate-400 truncate">${b.brand.category}</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-1 text-center">
          <div class="rounded-md bg-white/5 px-1.5 py-1.5">
            <div class="font-display text-sm font-bold">${b.posts.length}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500">posts</div>
          </div>
          <div class="rounded-md bg-white/5 px-1.5 py-1.5">
            <div class="font-display text-sm font-bold">${fmt(b.totalEng)}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500">eng</div>
          </div>
          <div class="rounded-md bg-white/5 px-1.5 py-1.5">
            <div class="font-display text-sm font-bold">${last.split(",")[0]}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500">last</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-1">
          ${b.disclosedCount > 0 ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300">✓ Disclosed (#ad)</span>` : ""}
          ${b.bioMention ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-300">In bio</span>` : ""}
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-400/20 text-fuchsia-300">@${b.brand.handles[0]}</span>
        </div>`;
      gridEl.appendChild(card);
    }
  }

  // other unmatched @mentions (could be smaller brands, peers, friends)
  if (data.otherMentions.length) {
    data.otherMentions.forEach((m) => {
      const chip = document.createElement("a");
      chip.href = `https://www.instagram.com/${m.username}/`;
      chip.target = "_blank";
      chip.rel = "noreferrer";
      chip.className = "px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] hover:border-fuchsia-400/30 transition";
      chip.innerHTML = `@${m.username} <span class="text-slate-500">·${m.count}</span>`;
      otherEl.appendChild(chip);
    });
  } else {
    otherEl.innerHTML = '<span class="text-[11px] text-slate-500">No other @mentions found.</span>';
  }
}

// ====================================================
// AI STRATEGIST
// ====================================================

const AI_PROMPTS = {
  strategy: `Give me a complete Instagram growth strategy for this account. Include:
1. Diagnosis (what's working, what isn't, in numbers)
2. The next 90 days: weekly content cadence, format mix (% reels/photos/carousels), and 3 specific content pillars to focus on
3. 5 specific posts I should make in the next 14 days (with hook + format + tags)
4. The single biggest opportunity I'm leaving on the table`,
  content: `Generate 10 ready-to-shoot Instagram reel scripts tailored to THIS account's audience and existing tone. Each script: title, hook (first 3 seconds, exact words), 30-second beat sheet (5 beats), suggested on-screen text, suggested caption (with hashtags), and best day/time to post.`,
  brands: `Build a brand outreach plan:
1. Top 10 brands this creator should pitch (use the detected niche; be specific by brand name)
2. For each: why this creator fits, what to send/offer, and one concrete creative angle
3. A 5-step outreach sequence (DM → email → follow-up) with copy I can paste
4. Rate-card suggestions based on the follower count and engagement rate`,
  audit: `Audit this account like a brand sponsorship agency would. Score 1–10 with reasoning on: (a) content quality consistency, (b) niche clarity, (c) engagement health, (d) audience activity signals, (e) brand-readiness. Then list the 5 things to fix THIS WEEK in priority order, each with a concrete first action.`,
  bio: `Write 5 alternative Instagram bios for this account, each ≤150 characters, each with a clear positioning and a single CTA. Show the rationale for each. Then mark which one I should A/B test against the current one and why.`,
  roast: `🔥 ROAST THIS ACCOUNT. Be a savage but caring Instagram coach — the kind of friend who tells you the truth nobody else will. Cite specific numbers from the data to make it sting AND stick. Cover:
- The brutal truth about their content (formats, captions, posting cadence)
- The cringe they're putting on display
- What's lazy, repetitive, or trying-too-hard
- The painful gap between their potential and reality
- End with ONE ruthless command — the single thing they MUST stop doing today, and ONE thing they MUST start.
Be funny and specific, but useful. Roast like Gordon Ramsay roasts a kitchen — harsh because they deserve better. Use vivid metaphors. ≤500 words.`,
  competitor: `Look at this account's top-performing post (highest likes + comments in the recent feed). Then:
1. Reverse-engineer WHY it worked — hook structure, format, tone, caption length, hashtags, posting time
2. Distill it into a reusable "winning template" with placeholder slots
3. Generate 5 DIFFERENT post ideas this account could make using that exact template, each in a different angle/topic
4. For each, write the exact caption + hashtags`,
};

const AI_MODELS = {
  gemini: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — fast & smart · free tier" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite — fastest · free tier" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash — stable · free tier" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — best quality · free tier" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B — best free open-source" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B — instant" },
    { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B — good for long context" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B — Google open model" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini — fast & cheap (~$0.001/run)" },
    { id: "gpt-4o", label: "GPT-4o — smarter (~$0.01/run)" },
    { id: "gpt-4.1", label: "GPT-4.1 — best (~$0.02/run)" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini — fast & smart (~$0.002/run)" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fast & cheap" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
    { id: "claude-opus-4-7", label: "Opus 4.7 — best" },
  ],
};

const AI_KEY_HINTS = {
  gemini: '✨ Free key (no credit card): <a href="https://aistudio.google.com/apikey" target="_blank" class="text-fuchsia-300 hover:underline">aistudio.google.com/apikey</a>',
  groq: '⚡ Free key (no credit card): <a href="https://console.groq.com/keys" target="_blank" class="text-fuchsia-300 hover:underline">console.groq.com/keys</a>',
  openai: 'Paid (~$0.001–0.02/run): <a href="https://platform.openai.com/api-keys" target="_blank" class="text-fuchsia-300 hover:underline">platform.openai.com/api-keys</a>',
  anthropic: 'Paid (~$0.003–0.06/run): <a href="https://console.anthropic.com/settings/keys" target="_blank" class="text-fuchsia-300 hover:underline">console.anthropic.com/settings/keys</a>',
};

function refillAiModels(provider) {
  const sel = $("ai-model");
  sel.innerHTML = "";
  const saved = localStorage.getItem(`ig_ai_model_${provider}_v1`) || AI_MODELS[provider][0].id;
  AI_MODELS[provider].forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === saved) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateAiKeyHint(provider) {
  const hintEl = $("ai-get-key-hint");
  if (hintEl) hintEl.innerHTML = AI_KEY_HINTS[provider] || "";
}

function initAiPanel() {
  // restore saved key
  const savedProvider = localStorage.getItem("ig_ai_provider_v1") || "gemini";
  const savedKey = localStorage.getItem(`ig_ai_key_${savedProvider}_v1`) || localStorage.getItem("ig_ai_key_v1") || "";
  $("ai-key").value = savedKey;
  $("ai-provider").value = savedProvider;
  refillAiModels(savedProvider);
  updateAiKeyHint(savedProvider);

  $("ai-provider").addEventListener("change", (e) => {
    refillAiModels(e.target.value);
    updateAiKeyHint(e.target.value);
    // restore per-provider key
    $("ai-key").value = localStorage.getItem(`ig_ai_key_${e.target.value}_v1`) || "";
    $("ai-discover-models").classList.toggle("hidden", e.target.value !== "gemini");
  });
  $("ai-discover-models").classList.toggle("hidden", savedProvider !== "gemini");

  $("ai-discover-models").addEventListener("click", async () => {
    const key = ($("ai-key").value || "").trim();
    if (!key) { showAiError("Paste your Gemini key first."); return; }
    const btn = $("ai-discover-models");
    btn.disabled = true;
    btn.textContent = "Detecting…";
    try {
      const res = await fetch("/api/list-gemini-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const sel = $("ai-model");
      sel.innerHTML = "";
      const detected = (data.models || []).filter((m) => m.id.startsWith("gemini-"));
      if (!detected.length) throw new Error("No Gemini models found for this key.");
      // sort so newest are first
      detected.sort((a, b) => b.id.localeCompare(a.id));
      detected.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.display_name + " — " + m.id;
        sel.appendChild(opt);
      });
      hideAiError();
      btn.textContent = `${detected.length} found ✓`;
      setTimeout(() => (btn.textContent = "🔍 Detect"), 2500);
    } catch (e) {
      showAiError("Couldn't list models: " + e.message);
      btn.textContent = "🔍 Detect";
    } finally {
      btn.disabled = false;
    }
  });

  $("ai-model").addEventListener("change", (e) => {
    const provider = $("ai-provider").value;
    localStorage.setItem(`ig_ai_model_${provider}_v1`, e.target.value);
  });

  $("ai-key-save").addEventListener("click", () => {
    const k = $("ai-key").value.trim();
    const p = $("ai-provider").value;
    const m = $("ai-model").value;
    // store per-provider so user can switch without re-entering keys
    localStorage.setItem(`ig_ai_key_${p}_v1`, k);
    localStorage.setItem("ig_ai_key_v1", k); // legacy fallback
    localStorage.setItem("ig_ai_provider_v1", p);
    localStorage.setItem(`ig_ai_model_${p}_v1`, m);
    $("ai-key-save").textContent = "Saved ✓";
    setTimeout(() => ($("ai-key-save").textContent = "Save"), 1500);
  });

  document.querySelectorAll(".ai-prompt-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const kind = b.dataset.prompt;
      if (kind === "custom") {
        $("ai-custom-prompt").classList.remove("hidden");
        $("ai-custom-prompt").focus();
        const handler = (e) => {
          if (e.key === "Enter" && e.metaKey) {
            runAi("custom", $("ai-custom-prompt").value.trim());
            $("ai-custom-prompt").removeEventListener("keydown", handler);
          }
        };
        $("ai-custom-prompt").addEventListener("keydown", handler);
        // also allow click of the same button again to send
        b.textContent = "Send →";
        b.onclick = () => {
          const txt = $("ai-custom-prompt").value.trim();
          if (txt) runAi("custom", txt);
        };
      } else {
        $("ai-custom-prompt").classList.add("hidden");
        runAi(kind, AI_PROMPTS[kind]);
      }
    })
  );
}

function buildAiContext() {
  // Collect everything we know — works whether merged, export-only, or lookup-only
  const live = window.__lastLookup || null;
  const exp = window.__lastExport || null;
  if (!live && !exp) return null;

  // Pick profile from whichever is richer
  const profile = live
    ? {
        username: live.username,
        full_name: live.full_name,
        bio: live.biography,
        category: live.category,
        is_verified: live.is_verified,
        is_business: live.is_business,
        followers: live.followers,
        following: live.following,
        posts_count: live.posts_count,
        external_url: live.external_url,
      }
    : {
        username: exp.username,
        bio: exp.bio,
        followers: exp.followers.length,
        following: exp.following.length,
        posts_count: exp.posts.length,
      };

  // Recent posts (live's are richer with engagement)
  const recentPosts = live
    ? live.posts.slice(0, 12).map((p) => ({
        caption: (p.caption || "").slice(0, 200),
        likes: p.likes,
        comments: p.comments,
        type: p.is_video ? "reel" : p.is_carousel ? "carousel" : "image",
        timestamp: p.timestamp,
      }))
    : exp
    ? exp.posts.slice(0, 12).map((p) => ({
        caption: (p.caption || "").slice(0, 200),
        type: p.mediaType,
        timestamp: p.timestamp,
      }))
    : [];

  // Derived signals
  const ctx = {
    profile,
    recent_posts: recentPosts,
  };

  if (live && live.posts?.length) {
    const er = live.followers
      ? (live.posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / live.posts.length / live.followers) * 100
      : 0;
    ctx.engagement_rate_percent = +er.toFixed(2);
    ctx.avg_likes_per_post = Math.round(live.posts.reduce((s, p) => s + (p.likes || 0), 0) / live.posts.length);
    ctx.avg_comments_per_post = Math.round(live.posts.reduce((s, p) => s + (p.comments || 0), 0) / live.posts.length);
    // niches + brands
    const niches = detectNiches(live, live.posts);
    ctx.detected_niches = niches.map((n) => ({ niche: n.def.label, score: n.score }));
    const brands = detectBrandPartnerships(live.posts, live).brands;
    ctx.detected_brand_partnerships = brands.map((b) => ({
      brand: b.brand.name,
      category: b.brand.category,
      posts: b.posts.length,
      disclosed: b.disclosedCount > 0,
      in_bio: !!b.bioMention,
    }));
    // hashtags
    const tagC = new Map();
    for (const p of live.posts) {
      const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
      for (const t of tags) tagC.set(t.toLowerCase(), (tagC.get(t.toLowerCase()) || 0) + 1);
    }
    ctx.top_hashtags = Array.from(tagC.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, c]) => ({ tag: t, count: c }));
  }

  if (exp) {
    const ana = computeAnalytics(exp);
    ctx.export_summary = {
      total_followers: exp.followers.length,
      total_following: exp.following.length,
      mutuals: ana.mutuals.length,
      dont_follow_back: ana.dontFollowBack.length,
      silent_fans: ana.fans.length,
      followers_with_timestamps: exp.followers.filter((x) => x.timestamp).length,
      total_posts_in_export: exp.posts.length,
    };
    // posting cadence from export
    const ts = exp.posts.map((p) => p.timestamp).filter(Boolean).sort();
    if (ts.length > 1) {
      const days = (ts[ts.length - 1] - ts[0]) / 86400;
      ctx.export_summary.posts_per_month = +(exp.posts.length / Math.max(1, days / 30)).toFixed(2);
    }
  }

  return ctx;
}

async function runAi(kind, customPrompt) {
  const key = ($("ai-key").value || "").trim();
  const provider = $("ai-provider").value;
  const model = $("ai-model").value;
  if (!key) {
    showAiError("Paste an API key first. " + (provider === "anthropic" ? "Get one at console.anthropic.com" : "Get one at platform.openai.com/api-keys") + " — then click Save.");
    return;
  }
  const prompt = customPrompt || AI_PROMPTS[kind];
  if (!prompt) {
    showAiError("Pick a prompt or type a custom question.");
    return;
  }
  const ctx = buildAiContext();
  if (!ctx) {
    showAiError("Load an account first (look it up or parse your export).");
    return;
  }

  hideAiError();
  $("ai-output").classList.remove("hidden");
  $("ai-output").innerHTML = '<div class="flex items-center gap-2 text-slate-400"><div class="w-4 h-4 border-2 border-fuchsia-400 border-t-transparent rounded-full animate-spin"></div>Thinking…</div>';
  // disable buttons during call
  document.querySelectorAll(".ai-prompt-btn").forEach((b) => (b.disabled = true));
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, api_key: key, prompt, context: ctx }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    renderAiOutput(data.text);
    // save to history
    const usernameForHistory = (window.__lastLookup?.username) || (window.__lastExport?.username) || "unknown";
    saveAiHistoryEntry({
      ts: Date.now(),
      username: usernameForHistory,
      kind,
      provider,
      model,
      text: data.text,
    });
  } catch (e) {
    $("ai-output").classList.add("hidden");
    showAiError(e.message);
  } finally {
    document.querySelectorAll(".ai-prompt-btn").forEach((b) => (b.disabled = false));
  }
}

function renderAiOutput(text) {
  // light markdown-ish rendering: bold + headings + lists
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/^###\s+(.+)$/gm, '<h4 class="font-display font-semibold text-fuchsia-200 mt-3 mb-1">$1</h4>');
  html = html.replace(/^##\s+(.+)$/gm, '<h3 class="font-display font-bold text-fuchsia-300 mt-4 mb-2 text-base">$1</h3>');
  html = html.replace(/^#\s+(.+)$/gm, '<h2 class="font-display font-bold text-fuchsia-300 mt-4 mb-2 text-lg">$1</h2>');
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>');
  html = html.replace(/(<li.*?<\/li>\n?)+/g, '<ul class="list-disc space-y-0.5 my-1">$&</ul>');
  $("ai-output").innerHTML = html;
}

function showAiError(msg) {
  $("ai-error").classList.remove("hidden");
  $("ai-error").textContent = msg;
}
function hideAiError() {
  $("ai-error").classList.add("hidden");
}

function renderBrandFit(posts, profile) {
  const niches = detectNiches(profile, posts);
  const tagsEl = $("niche-tags");
  const brandsEl = $("brand-list");
  const prodEl = $("product-list");
  const outEl = $("outreach-template");
  tagsEl.innerHTML = brandsEl.innerHTML = prodEl.innerHTML = "";

  // niche tags
  niches.forEach((n) => {
    const pct = Math.min(100, Math.round((n.score / Math.max(1, niches[0].score)) * 100));
    const chip = document.createElement("span");
    chip.className = "px-2.5 py-1 rounded-full bg-gradient-to-r from-fuchsia-500/20 to-amber-400/20 border border-fuchsia-400/30 text-xs font-medium text-fuchsia-100";
    chip.innerHTML = `${n.def.label} <span class="text-fuchsia-300/70 ml-1 text-[10px]">${pct}%</span>`;
    tagsEl.appendChild(chip);
  });

  // brand list — merge top niches, dedupe
  const brandSet = new Set();
  niches.forEach((n) => n.def.brands.forEach((b) => brandSet.add(b)));
  Array.from(brandSet).slice(0, 16).forEach((b) => {
    const chip = document.createElement("span");
    chip.className = "px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-sm hover:border-fuchsia-400/40 transition cursor-default";
    chip.textContent = b;
    brandsEl.appendChild(chip);
  });

  // product list — merge top niches
  const prodSet = new Set();
  niches.forEach((n) => n.def.products.forEach((p) => prodSet.add(p)));
  Array.from(prodSet).slice(0, 10).forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p;
    prodEl.appendChild(li);
  });

  // outreach DM template
  const renderTemplate = () => {
    const tone = $("outreach-tone").value;
    const greeting = tone === "professional" ? `Hello @${profile.username},` : tone === "casual" ? `yo @${profile.username} 👋` : `Hi @${profile.username}!`;
    const opener = tone === "professional"
      ? `I came across your profile and your work in the ${niches[0].def.label.toLowerCase()} space genuinely stands out — especially your recent ${posts[0]?.is_video ? "reels" : "posts"}.`
      : tone === "casual"
      ? `been following your stuff — your ${niches[0].def.label.toLowerCase()} content is 🔥`
      : `Love what you're doing in the ${niches[0].def.label.toLowerCase()} space! Your engagement on recent posts caught my eye.`;
    const pitch = tone === "professional"
      ? `We're a brand operating in [your category — e.g. ${(niches[0].def.products[0] || "").toLowerCase()}] and we'd like to explore a paid collaboration that aligns with your audience.`
      : `We make [your product — think ${niches[0].def.products.slice(0, 2).map((p) => p.toLowerCase()).join(" or ")}] and would love to send you some to try, no strings attached. If it resonates, we can talk about a longer-term partnership.`;
    const ask = tone === "casual" ? `dm me back if you're down 🙏` : `Would you be open to a quick chat? Happy to share more details and rate cards.`;
    const sign = tone === "professional" ? `Best,\n[Your name] · [Brand]` : tone === "casual" ? `– [name]` : `Thanks,\n[Your name]`;
    outEl.textContent = [greeting, "", opener, "", pitch, "", ask, "", sign].join("\n");
  };
  renderTemplate();
  $("outreach-tone").onchange = renderTemplate;
  $("copy-outreach-btn").onclick = () => {
    navigator.clipboard.writeText(outEl.textContent);
    $("copy-outreach-btn").textContent = "Copied ✓";
    setTimeout(() => {
      $("copy-outreach-btn").innerHTML = '<i data-lucide="clipboard-copy" class="w-3 h-3"></i>Copy DM';
      lucide.createIcons();
    }, 1500);
  };
}

// ====================================================
// WATCHLIST
// ====================================================
const LS_WATCH = "ig_watchlist_v1";

function loadWatchlist() {
  try {
    return JSON.parse(localStorage.getItem(LS_WATCH) || "{}");
  } catch {
    return {};
  }
}
function saveWatchlist(w) {
  localStorage.setItem(LS_WATCH, JSON.stringify(w));
  updateWatchlistCount();
}
function updateWatchlistCount() {
  const w = loadWatchlist();
  const n = Object.keys(w).length;
  const pill = $("watchlist-count");
  if (n > 0) {
    pill.textContent = n;
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
}

function recordSnapshot(d) {
  const w = loadWatchlist();
  const key = (d.username || "").toLowerCase();
  if (!key || !w[key]) return; // only record for tracked accounts
  const snapshot = {
    ts: Math.floor(Date.now() / 1000),
    followers: d.followers,
    following: d.following,
    posts_count: d.posts_count,
    engagement_rate: d.posts.length
      ? ((d.posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / d.posts.length / d.followers) * 100)
      : 0,
  };
  w[key].snapshots = w[key].snapshots || [];
  // avoid duplicates within 1 hour
  const last = w[key].snapshots[w[key].snapshots.length - 1];
  if (!last || snapshot.ts - last.ts > 3600) {
    w[key].snapshots.push(snapshot);
  } else {
    w[key].snapshots[w[key].snapshots.length - 1] = snapshot;
  }
  w[key].full_name = d.full_name;
  w[key].profile_pic = d.profile_pic_url;
  w[key].is_verified = d.is_verified;
  w[key].last_fetched = snapshot.ts;
  saveWatchlist(w);
}

function addToWatchlist(username) {
  const w = loadWatchlist();
  const key = username.toLowerCase();
  if (w[key]) return false;
  w[key] = { username, added_at: Math.floor(Date.now() / 1000), snapshots: [] };
  saveWatchlist(w);
  return true;
}

function removeFromWatchlist(username) {
  const w = loadWatchlist();
  delete w[username.toLowerCase()];
  saveWatchlist(w);
  renderWatchlist();
}

function updateActionBar(username) {
  const w = loadWatchlist();
  const tracked = !!w[username.toLowerCase()];
  $("dashboard-watch-label").textContent = tracked ? "Tracked ✓" : "Add to watchlist";
  $("dashboard-watch-btn").onclick = () => {
    if (w[username.toLowerCase()]) {
      removeFromWatchlist(username);
      $("dashboard-watch-label").textContent = "Add to watchlist";
    } else {
      addToWatchlist(username);
      // also record current snapshot
      if (window.__lastLookup) recordSnapshot(window.__lastLookup);
      $("dashboard-watch-label").textContent = "Tracked ✓";
    }
  };
  $("dashboard-compare-btn").onclick = () => {
    addToCompare(username);
    flash("dashboard-compare-btn", "Added ✓");
  };
  $("dashboard-copy-btn").onclick = () => {
    if (!window.__lastLookup) return;
    const d = window.__lastLookup;
    const txt = `@${d.username} – ${d.full_name || ""}
Followers: ${d.followers.toLocaleString()}
Following: ${d.following.toLocaleString()}
Posts: ${d.posts_count.toLocaleString()}
Engagement: ${($("lookup-stat-engagement").textContent)}
${d.biography ? "Bio: " + d.biography.replace(/\s+/g, " ").slice(0, 200) : ""}`;
    navigator.clipboard.writeText(txt);
    flash("dashboard-copy-btn", "Copied ✓");
  };
}

function flash(btnId, text) {
  const btn = $(btnId);
  const original = btn.querySelector("span:last-child")?.textContent || btn.textContent;
  const target = btn.querySelector("span:last-child") || btn;
  target.textContent = text;
  setTimeout(() => (target.textContent = original), 1500);
}

let watchlistCharts = { followers: null, engagement: null, reach: null, views: null };
let currentDetailKey = null;

function renderWatchlist() {
  const w = loadWatchlist();
  const entries = Object.entries(w).sort((a, b) => (b[1].last_fetched || 0) - (a[1].last_fetched || 0));
  const list = $("watchlist-list");
  list.innerHTML = "";
  $("watchlist-empty").classList.toggle("hidden", entries.length > 0);
  if (!entries.length) return;

  for (const [key, acc] of entries) {
    const snaps = acc.snapshots || [];
    const latest = snaps[snaps.length - 1];
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
    const delta = latest && prev ? latest.followers - prev.followers : 0;
    const deltaPct = prev && prev.followers ? (delta / prev.followers) * 100 : 0;
    const since = prev ? new Date(prev.ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
    const lastFetched = acc.last_fetched
      ? new Date(acc.last_fetched * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "never";

    const sparkline = sparklineSvg(snaps.map((s) => s.followers));

    const row = document.createElement("div");
    row.className = "flex items-center gap-3 p-3 rounded-xl bg-black/30 border border-white/5 hover:border-fuchsia-400/30 transition";
    const pic = acc.profile_pic
      ? `<img src="/api/image?url=${encodeURIComponent(acc.profile_pic)}" class="w-10 h-10 rounded-full object-cover shrink-0" onerror="this.style.display='none'"/>`
      : '<div class="w-10 h-10 rounded-full bg-white/10 shrink-0 flex items-center justify-center"><svg width="16" height="16" fill="rgba(255,255,255,0.3)" viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4 0-12 2-12 6v2h24v-2c0-4-8-6-12-6z"/></svg></div>';
    const deltaBadge = !latest
      ? '<span class="text-[10px] text-slate-500">no snapshot yet</span>'
      : !prev
      ? '<span class="text-[10px] text-slate-500">first snapshot</span>'
      : delta === 0
      ? '<span class="text-[10px] text-slate-500">no change</span>'
      : delta > 0
      ? `<span class="text-[11px] text-emerald-300 font-medium">+${delta.toLocaleString()} (${deltaPct.toFixed(2)}%)</span>`
      : `<span class="text-[11px] text-rose-300 font-medium">${delta.toLocaleString()} (${deltaPct.toFixed(2)}%)</span>`;

    row.innerHTML = `
      ${pic}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="font-semibold truncate">${acc.full_name || acc.username}</span>
          ${acc.is_verified ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="#38bdf8"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>' : ""}
        </div>
        <div class="text-xs text-fuchsia-300 truncate">@${acc.username}</div>
        <div class="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
          <span>${latest ? fmt(latest.followers) + " followers" : "—"}</span>
          ${deltaBadge}
          ${prev ? `<span class="text-slate-500">since ${since}</span>` : ""}
        </div>
      </div>
      <div class="hidden sm:block w-24 h-10 shrink-0">${sparkline}</div>
      <div class="flex flex-col gap-1 shrink-0">
        <button data-action="lookup" class="px-2.5 py-1 rounded-md bg-white/5 hover:bg-fuchsia-500/20 text-[11px] transition">Lookup</button>
        <button data-action="detail" class="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/15 text-[11px] transition">Chart</button>
        <button data-action="remove" class="px-2.5 py-1 rounded-md bg-white/5 hover:bg-rose-500/20 text-[11px] text-rose-300 transition">Remove</button>
      </div>`;
    row.addEventListener("click", (e) => {
      const a = e.target.closest("[data-action]");
      if (!a) return;
      const action = a.dataset.action;
      if (action === "lookup") {
        setMode("lookup");
        $("lookup-input").value = acc.username;
        doLookup();
      } else if (action === "detail") {
        showWatchlistDetail(key);
      } else if (action === "remove") {
        if (confirm(`Stop tracking @${acc.username}?`)) removeFromWatchlist(acc.username);
      }
    });
    list.appendChild(row);
  }
  lucide.createIcons();
}

function sparklineSvg(values) {
  if (!values || values.length < 2) return '<svg viewBox="0 0 100 40" class="w-full h-full"></svg>';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 40 - ((v - min) / range) * 36 - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="w-full h-full">
    <polyline fill="none" stroke="#ec4899" stroke-width="1.5" points="${pts.join(" ")}"/>
    <polyline fill="rgba(236,72,153,0.15)" stroke="none" points="0,40 ${pts.join(" ")} 100,40"/>
  </svg>`;
}

function showWatchlistDetail(key) {
  const w = loadWatchlist();
  const acc = w[key];
  if (!acc) return;
  currentDetailKey = key;
  $("watchlist-detail").classList.remove("hidden");
  $("detail-username").textContent = "@" + acc.username;
  $("detail-log-form").classList.add("hidden");
  $("log-date").value = new Date().toISOString().slice(0, 10);

  const snaps = (acc.snapshots || []).slice().sort((a, b) => a.ts - b.ts);
  if (!snaps.length) {
    document.getElementById("watchlist-detail").scrollIntoView({ behavior: "smooth" });
    $("detail-entries").innerHTML = '<p class="text-xs text-slate-500">No snapshots yet — click "Log Insights manually" above or use Refresh All on the watchlist.</p>';
    // empty out charts
    ["followers","engagement","reach","views"].forEach((k) => {
      if (watchlistCharts[k]) { watchlistCharts[k].destroy(); watchlistCharts[k] = null; }
    });
    return;
  }
  const labels = snaps.map((s) => new Date(s.ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const pointStyles = snaps.map((s) => s.manual ? "rectRot" : "circle");
  const pointSizes = snaps.map((s) => s.manual ? 6 : 3);

  drawDetailLine("followers", labels, snaps.map((s) => s.followers), "Followers", "#ec4899", pointStyles, pointSizes);
  drawDetailLine("engagement", labels, snaps.map((s) => s.engagement_rate || 0), "Engagement %", "#fbbf24", pointStyles, pointSizes);
  drawDetailLine("reach", labels, snaps.map((s) => s.reach ?? null), "Reach (7d, manual)", "#38bdf8", pointStyles, pointSizes);
  drawDetailLine("views", labels, snaps.map((s) => s.profile_views ?? null), "Profile views (7d, manual)", "#10b981", pointStyles, pointSizes);

  renderEntriesList(key, snaps);
  document.getElementById("watchlist-detail").scrollIntoView({ behavior: "smooth" });
}

function drawDetailLine(key, labels, data, label, color, pointStyles, pointSizes) {
  const canvas = $(`detail-${key}-chart`);
  if (!canvas) return;
  if (watchlistCharts[key]) watchlistCharts[key].destroy();
  // skip if all null
  if (!data.some((v) => v != null && v !== 0)) {
    watchlistCharts[key] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: ["—"], datasets: [{ label: label + " (no data)", data: [0], borderColor: "rgba(255,255,255,0.1)" }] },
      options: chartOpts(),
    });
    return;
  }
  watchlistCharts[key] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label,
        data,
        borderColor: color,
        backgroundColor: color.replace(")", ",0.15)").replace("#", "rgba(").replace(/^rgba\(([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i, (_, r, g, b) =>
          `rgba(${parseInt(r,16)},${parseInt(g,16)},${parseInt(b,16)}`),
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointStyle: pointStyles,
        pointRadius: pointSizes,
        pointHoverRadius: 7,
        spanGaps: true,
      }],
    },
    options: chartOpts(),
  });
}

function renderEntriesList(key, snaps) {
  const el = $("detail-entries");
  el.innerHTML = "";
  snaps.slice().reverse().forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-2 p-2 rounded-md bg-white/5 text-xs";
    const dt = new Date(s.ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const badges = [
      `<span class="text-slate-400">${dt}</span>`,
      s.manual ? `<span class="px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-200 text-[10px]">manual</span>` : `<span class="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200 text-[10px]">auto</span>`,
      s.followers != null ? `<span><b>${fmt(s.followers)}</b> followers</span>` : "",
      s.reach ? `<span class="text-sky-300">reach ${fmt(s.reach)}</span>` : "",
      s.impressions ? `<span class="text-violet-300">impr ${fmt(s.impressions)}</span>` : "",
      s.profile_views ? `<span class="text-emerald-300">views ${fmt(s.profile_views)}</span>` : "",
      s.website_clicks ? `<span class="text-amber-300">clicks ${fmt(s.website_clicks)}</span>` : "",
      s.notes ? `<span class="text-slate-300 italic truncate">"${s.notes}"</span>` : "",
    ].filter(Boolean).join("");
    row.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 min-w-0 flex-1">${badges}</div>
      <button data-snap-idx="${snaps.length - 1 - idx}" class="text-[11px] text-rose-300 hover:text-rose-200 shrink-0">remove</button>`;
    row.querySelector("button").addEventListener("click", () => {
      const w = loadWatchlist();
      if (!w[key]?.snapshots) return;
      w[key].snapshots.splice(snaps.length - 1 - idx, 1);
      saveWatchlist(w);
      showWatchlistDetail(key);
    });
    el.appendChild(row);
  });
}

function saveManualEntry() {
  if (!currentDetailKey) return;
  const dateStr = $("log-date").value;
  if (!dateStr) {
    alert("Pick a date.");
    return;
  }
  const ts = Math.floor(new Date(dateStr + "T12:00:00").getTime() / 1000);
  const reach = parseInt($("log-reach").value) || null;
  const impressions = parseInt($("log-impressions").value) || null;
  const profile_views = parseInt($("log-views").value) || null;
  const followers = parseInt($("log-followers").value) || null;
  const website_clicks = parseInt($("log-clicks").value) || null;
  const notes = $("log-notes").value.trim();

  if (reach == null && impressions == null && profile_views == null && followers == null && website_clicks == null && !notes) {
    alert("Fill at least one field.");
    return;
  }

  const w = loadWatchlist();
  const acc = w[currentDetailKey];
  if (!acc) return;
  acc.snapshots = acc.snapshots || [];
  // pull followers from most recent auto snapshot if not provided
  const lastAuto = [...acc.snapshots].reverse().find((s) => !s.manual);
  const snapshot = {
    ts,
    manual: true,
    followers: followers ?? lastAuto?.followers ?? null,
    reach,
    impressions,
    profile_views,
    website_clicks,
    notes,
    engagement_rate: lastAuto?.engagement_rate ?? 0,
  };
  acc.snapshots.push(snapshot);
  acc.snapshots.sort((a, b) => a.ts - b.ts);
  acc.last_fetched = Math.floor(Date.now() / 1000);
  saveWatchlist(w);

  // reset form
  ["log-reach","log-impressions","log-views","log-followers","log-clicks","log-notes"].forEach((id) => ($(id).value = ""));
  $("detail-log-form").classList.add("hidden");
  showWatchlistDetail(currentDetailKey);
}

async function refreshWatchlistAll() {
  const w = loadWatchlist();
  const usernames = Object.values(w).map((a) => a.username);
  if (!usernames.length) return;
  const status = $("watchlist-status");
  status.classList.remove("hidden");
  for (let i = 0; i < usernames.length; i++) {
    status.textContent = `Refreshing ${i + 1}/${usernames.length}: @${usernames[i]}…`;
    try {
      const r = await fetch(`/api/lookup?username=${encodeURIComponent(usernames[i])}`);
      const data = await r.json();
      if (r.ok && data.available) recordSnapshot(data);
    } catch (e) {
      console.warn("refresh failed", usernames[i], e);
    }
    await new Promise((res) => setTimeout(res, 1500)); // throttle to avoid rate-limit
  }
  status.textContent = "Done — all snapshots updated.";
  setTimeout(() => status.classList.add("hidden"), 2500);
  renderWatchlist();
}

function exportWatchlistCsv() {
  const w = loadWatchlist();
  const rows = [["username", "full_name", "verified", "followers", "following", "posts", "engagement_rate", "last_fetched"]];
  for (const acc of Object.values(w)) {
    const s = (acc.snapshots || []).slice(-1)[0];
    rows.push([
      acc.username,
      (acc.full_name || "").replace(/,/g, " "),
      acc.is_verified ? "yes" : "",
      s?.followers ?? "",
      s?.following ?? "",
      s?.posts_count ?? "",
      s?.engagement_rate?.toFixed(3) ?? "",
      acc.last_fetched ? new Date(acc.last_fetched * 1000).toISOString() : "",
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `instagram-watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ====================================================
// COMPARE
// ====================================================
let compareAccounts = []; // array of full lookup payloads

function addToCompare(username) {
  const u = username.toLowerCase();
  if (compareAccounts.length >= 5) {
    return showCompareError("Max 5 accounts at a time.");
  }
  if (compareAccounts.some((a) => a.username.toLowerCase() === u)) return;
  hideCompareError();
  fetch(`/api/lookup?username=${encodeURIComponent(username)}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) return showCompareError(data.error);
      compareAccounts.push(data);
      if (currentMode === "compare") renderCompare();
    })
    .catch((e) => showCompareError(e.message));
}

function showCompareError(msg) {
  const el = $("compare-error");
  el.classList.remove("hidden");
  el.textContent = msg;
}
function hideCompareError() {
  $("compare-error").classList.add("hidden");
}

let compareCharts = { bar: null, radar: null };

function renderCompare() {
  // chips
  const chips = $("compare-chips");
  chips.innerHTML = "";
  compareAccounts.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-fuchsia-500/15 border border-fuchsia-400/30 text-xs";
    chip.innerHTML = `<span class="text-fuchsia-200">@${a.username}</span><button class="text-fuchsia-300 hover:text-white">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      compareAccounts.splice(i, 1);
      renderCompare();
    });
    chips.appendChild(chip);
  });

  $("compare-empty").classList.toggle("hidden", compareAccounts.length >= 2);
  $("compare-results").classList.toggle("hidden", compareAccounts.length < 2);
  if (compareAccounts.length < 2) return;

  // table
  const head = $("compare-thead");
  const body = $("compare-tbody");
  head.innerHTML = "<tr class='text-left text-xs uppercase tracking-wider text-slate-400 border-b border-white/5'><th class='py-2 pr-3'>Metric</th>" +
    compareAccounts.map((a) => `<th class='py-2 px-3'>@${a.username}</th>`).join("") + "</tr>";
  const rows = [
    ["Followers", (a) => fmt(a.followers)],
    ["Following", (a) => fmt(a.following)],
    ["Posts (total)", (a) => fmt(a.posts_count)],
    ["Verified", (a) => a.is_verified ? "✓" : "—"],
    ["Category", (a) => a.category || "—"],
    ["Engagement rate", (a) => {
      const er = a.posts.length && a.followers ? (a.posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / a.posts.length / a.followers) * 100 : 0;
      return er.toFixed(2) + "%";
    }],
    ["Avg likes / post", (a) => {
      const v = a.posts.length ? Math.round(a.posts.reduce((s, p) => s + (p.likes || 0), 0) / a.posts.length) : 0;
      return fmt(v);
    }],
    ["Avg comments / post", (a) => {
      const v = a.posts.length ? Math.round(a.posts.reduce((s, p) => s + (p.comments || 0), 0) / a.posts.length) : 0;
      return fmt(v);
    }],
    ["Influencer tier", (a) => tier(a.followers)],
  ];
  body.innerHTML = rows.map(([label, fn]) =>
    `<tr class='border-b border-white/5'><td class='py-2 pr-3 text-slate-400 text-xs'>${label}</td>` +
    compareAccounts.map((a) => `<td class='py-2 px-3 font-medium'>${fn(a)}</td>`).join("") + "</tr>"
  ).join("");

  // bar chart of followers
  if (compareCharts.bar) compareCharts.bar.destroy();
  compareCharts.bar = new Chart($("compare-bar-chart").getContext("2d"), {
    type: "bar",
    data: {
      labels: compareAccounts.map((a) => "@" + a.username),
      datasets: [{
        label: "Followers",
        data: compareAccounts.map((a) => a.followers),
        backgroundColor: ["#ec4899", "#fbbf24", "#38bdf8", "#a855f7", "#10b981"].slice(0, compareAccounts.length),
        borderRadius: 6,
      }],
    },
    options: { ...chartOpts(), plugins: { ...chartOpts().plugins, legend: { display: false } } },
  });

  // radar chart: normalized metrics
  const maxFollowers = Math.max(...compareAccounts.map((a) => a.followers || 1));
  const maxPosts = Math.max(...compareAccounts.map((a) => a.posts_count || 1));
  const maxAvgLike = Math.max(...compareAccounts.map((a) => avgLikes(a) || 1));
  const maxAvgCom = Math.max(...compareAccounts.map((a) => avgComments(a) || 1));
  const maxER = Math.max(...compareAccounts.map((a) => engagementRate(a) || 0.01));

  if (compareCharts.radar) compareCharts.radar.destroy();
  compareCharts.radar = new Chart($("compare-radar-chart").getContext("2d"), {
    type: "radar",
    data: {
      labels: ["Followers", "Posts", "Avg likes", "Avg comments", "ER %"],
      datasets: compareAccounts.map((a, i) => ({
        label: "@" + a.username,
        data: [
          (a.followers / maxFollowers) * 100,
          (a.posts_count / maxPosts) * 100,
          (avgLikes(a) / maxAvgLike) * 100,
          (avgComments(a) / maxAvgCom) * 100,
          (engagementRate(a) / maxER) * 100,
        ],
        backgroundColor: ["rgba(236,72,153,0.2)", "rgba(251,191,36,0.2)", "rgba(56,189,248,0.2)", "rgba(168,85,247,0.2)", "rgba(16,185,129,0.2)"][i],
        borderColor: ["#ec4899", "#fbbf24", "#38bdf8", "#a855f7", "#10b981"][i],
        borderWidth: 2,
        pointBackgroundColor: ["#ec4899", "#fbbf24", "#38bdf8", "#a855f7", "#10b981"][i],
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1", font: { size: 11 } } } },
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          ticks: { display: false, color: "#64748b" },
          grid: { color: "rgba(255,255,255,0.08)" },
          angleLines: { color: "rgba(255,255,255,0.08)" },
          pointLabels: { color: "#cbd5e1", font: { size: 11 } },
        },
      },
    },
  });
}

function avgLikes(a) { return a.posts?.length ? a.posts.reduce((s, p) => s + (p.likes || 0), 0) / a.posts.length : 0; }
function avgComments(a) { return a.posts?.length ? a.posts.reduce((s, p) => s + (p.comments || 0), 0) / a.posts.length : 0; }
function engagementRate(a) {
  if (!a.posts?.length || !a.followers) return 0;
  return ((avgLikes(a) + avgComments(a)) / a.followers) * 100;
}
function tier(followers) {
  if (followers < 1000) return "Nano (<1K)";
  if (followers < 10_000) return "Micro";
  if (followers < 100_000) return "Mid";
  if (followers < 1_000_000) return "Macro";
  return "Mega (>1M)";
}

// ====================================================
// SPONSORSHIP RATE · WHAT-IF · BRAND KIT · YEAR HEATMAP
// ====================================================

function renderSponsorshipRate(posts, profile) {
  const followers = profile.followers || 0;
  const er = (() => {
    if (!posts.length || !followers) return 0;
    const avg = posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length;
    return (avg / followers) * 100;
  })();
  // Industry formulas (Influencer Marketing Hub & Later average heuristics)
  // base = followers / 100 (a $1 per 100 followers baseline)
  // adjust by ER multiplier: < 1% → 0.7x, 1-3% → 1x, 3-6% → 1.5x, > 6% → 2x
  // adjust by tier: nano sub-1k → 0.6x, micro → 1x, mid → 1.1x, macro → 1.2x, mega → 1.4x
  const erMult = er < 1 ? 0.7 : er < 3 ? 1 : er < 6 ? 1.5 : 2.2;
  const tierMult = followers < 1000 ? 0.6 : followers < 10000 ? 1 : followers < 100000 ? 1.1 : followers < 1_000_000 ? 1.25 : 1.5;
  const base = (followers / 100) * erMult * tierMult;
  // verified or business bumps
  const profileMult = profile.is_verified ? 1.3 : profile.is_business ? 1.1 : 1;
  const adjusted = base * profileMult;

  const minRate = Math.max(50, Math.round(adjusted * 0.7));
  const maxRate = Math.max(100, Math.round(adjusted * 1.4));

  $("rate-range").textContent = `$${fmt(minRate)} — $${fmt(maxRate)} / post`;

  const breakdown = [
    `Base: ${followers.toLocaleString()} followers ÷ 100 = $${(followers / 100).toFixed(0)}`,
    `× ${erMult.toFixed(1)} engagement multiplier (${er.toFixed(2)}% ER)`,
    `× ${tierMult.toFixed(2)} tier multiplier (${tier(followers)})`,
    profile.is_verified ? `× 1.3 verified bonus` : profile.is_business ? `× 1.1 business bonus` : ``,
  ].filter(Boolean);
  $("rate-breakdown").innerHTML = breakdown.map((b) => `<div>${b}</div>`).join("");

  // by deliverable
  const tiers = [
    { label: "Photo", min: minRate, max: maxRate, mult: 1 },
    { label: "Reel / Video", min: Math.round(minRate * 1.4), max: Math.round(maxRate * 1.6), mult: 1.5 },
    { label: "Story", min: Math.round(minRate * 0.4), max: Math.round(maxRate * 0.5), mult: 0.45 },
  ];
  $("rate-tiers").innerHTML = tiers.map((t) => `
    <div class="rounded-md bg-white/5 border border-white/10 p-2 text-center">
      <div class="text-[9px] uppercase tracking-wider text-slate-400">${t.label}</div>
      <div class="font-display text-sm font-bold mt-0.5">$${fmt(t.min)}–${fmt(t.max)}</div>
    </div>`).join("");
}

let whatIfChart = null;
function initWhatIfSimulator(posts, profile) {
  const recompute = () => renderWhatIfProjection(posts, profile);
  ["whatif-cadence", "whatif-reels", "whatif-quality"].forEach((id) => {
    $(id).oninput = (e) => {
      if (id === "whatif-cadence") $("whatif-cadence-label").textContent = e.target.value + "/wk";
      if (id === "whatif-reels") $("whatif-reels-label").textContent = e.target.value + "%";
      if (id === "whatif-quality") $("whatif-quality-label").textContent = "+" + e.target.value + "%";
      recompute();
    };
  });
  // initial render based on current ER
  recompute();
}

function renderWhatIfProjection(posts, profile) {
  const currentFollowers = profile.followers || 1000;
  const cadence = parseInt($("whatif-cadence").value) || 3;
  const reelsPct = parseInt($("whatif-reels").value) || 60;
  const quality = parseInt($("whatif-quality").value) || 0;

  // current organic ER (proxy for content quality)
  const er = (() => {
    if (!posts.length) return 1;
    const avg = posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length;
    return (avg / currentFollowers) * 100;
  })();
  // base weekly growth rate: nano/micro accounts grow ~1.5% / week with 3 posts at 1% ER
  // we scale it
  const reelsBoost = 1 + (reelsPct / 100) * 0.4; // up to 40% lift if all reels
  const cadenceBoost = Math.log(cadence + 1) / Math.log(4); // diminishing returns
  const qualityBoost = 1 + (quality / 100);
  const erBoost = Math.max(0.5, Math.min(2, er / 1));

  const weeklyRate = 0.015 * cadenceBoost * reelsBoost * qualityBoost * erBoost;

  // project 12 weeks
  const labels = [];
  const data = [];
  let f = currentFollowers;
  for (let w = 0; w <= 12; w++) {
    labels.push(`W${w}`);
    data.push(Math.round(f));
    f *= 1 + weeklyRate;
  }
  const projected = Math.round(f / (1 + weeklyRate)); // final week value already pushed
  const gain = projected - currentFollowers;
  const pct = ((gain / currentFollowers) * 100).toFixed(1);

  if (whatIfChart) whatIfChart.destroy();
  whatIfChart = new Chart($("whatif-chart").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Projected followers", data, borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,0.15)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
        { label: "Current baseline", data: data.map(() => currentFollowers), borderColor: "rgba(255,255,255,0.2)", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: { ...chartOpts(), plugins: { ...chartOpts().plugins, legend: { display: false } } },
  });

  $("whatif-projection").innerHTML = `
    In 90 days: <strong class="text-fuchsia-300">${fmt(projected)}</strong> followers
    <span class="${gain >= 0 ? 'text-emerald-300' : 'text-rose-300'}">(${gain >= 0 ? '+' : ''}${fmt(gain)} · ${pct}%)</span>
    at ${(weeklyRate * 100).toFixed(1)}% weekly growth`;
}

function renderBrandKit(posts, profile) {
  // Colors: extract from profile pic + first 6 post thumbnails
  const imgs = [];
  if (profile.profile_pic_url) imgs.push(profile.profile_pic_url);
  for (const p of (posts || []).slice(0, 6)) {
    const t = p.thumbnail || p.display_url;
    if (t) imgs.push(t);
  }
  if (!imgs.length) {
    $("brandkit-colors").innerHTML = '<span class="text-xs text-slate-500 col-span-5">No images.</span>';
    $("brandkit-emojis").innerHTML = '<span class="text-xs text-slate-500">No data.</span>';
    $("brandkit-voice").innerHTML = '<span class="text-xs text-slate-500">No data.</span>';
    $("brandkit-phrases").innerHTML = '<span class="text-xs text-slate-500">No data.</span>';
    return;
  }
  // Use canvas pixel sampling — load each img through our /api/image proxy so we don't hit CORS
  extractColorPalette(imgs.map((u) => "/api/image?url=" + encodeURIComponent(u))).then((palette) => {
    const el = $("brandkit-colors");
    el.innerHTML = "";
    palette.forEach((hex) => {
      const sw = document.createElement("button");
      sw.className = "aspect-square rounded-md border border-white/10 group relative";
      sw.style.background = hex;
      sw.title = hex + " — click to copy";
      sw.onclick = () => {
        navigator.clipboard.writeText(hex);
        sw.style.outline = "2px solid white";
        setTimeout(() => (sw.style.outline = ""), 800);
      };
      sw.innerHTML = `<span class="absolute bottom-0 left-0 right-0 text-[8px] text-white/90 font-mono bg-black/50 rounded-b-md py-0.5">${hex.toUpperCase()}</span>`;
      el.appendChild(sw);
    });
  });

  // Emojis: top by frequency in captions
  const emojiRx = /\p{Extended_Pictographic}/gu;
  const emojiCount = new Map();
  for (const p of posts) {
    const ems = (p.caption || "").match(emojiRx) || [];
    for (const e of ems) emojiCount.set(e, (emojiCount.get(e) || 0) + 1);
  }
  const topEmojis = Array.from(emojiCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const emEl = $("brandkit-emojis");
  emEl.innerHTML = "";
  if (!topEmojis.length) {
    emEl.innerHTML = '<span class="text-xs text-slate-500">No emojis detected.</span>';
  } else {
    topEmojis.forEach(([e, c]) => {
      const chip = document.createElement("span");
      chip.className = "px-2 py-1 rounded-md bg-white/5 border border-white/10 text-sm inline-flex items-center gap-1";
      chip.innerHTML = `${e}<span class="text-[10px] text-slate-500">${c}</span>`;
      emEl.appendChild(chip);
    });
  }

  // Voice/tone analysis (heuristic)
  const allText = posts.map((p) => p.caption || "").join(" ").toLowerCase();
  const allTextRaw = posts.map((p) => p.caption || "").join(" ");
  const wordCount = (allText.match(/\b\w+\b/g) || []).length;
  const exclamPer = wordCount ? (allTextRaw.match(/!/g) || []).length / posts.length : 0;
  const questPer = wordCount ? (allTextRaw.match(/\?/g) || []).length / posts.length : 0;
  const avgCapLen = posts.length ? posts.reduce((s, p) => s + (p.caption || "").length, 0) / posts.length : 0;
  const allCapsPer = wordCount ? (allTextRaw.match(/\b[A-Z]{3,}\b/g) || []).length / posts.length : 0;

  const traits = [];
  if (exclamPer > 1.5) traits.push("🔥 Energetic — high exclamation density");
  else if (exclamPer < 0.3) traits.push("🧘 Calm — minimal exclamation");
  if (questPer > 0.5) traits.push("❓ Inquisitive — uses questions to engage");
  if (avgCapLen < 60) traits.push("⚡ Concise — short punchy captions");
  else if (avgCapLen > 250) traits.push("📖 Long-form storyteller");
  else traits.push("✍️ Mid-form — balanced caption length");
  if (allCapsPer > 0.5) traits.push("📣 Bold — uses ALL-CAPS for emphasis");
  if (topEmojis.length > 5) traits.push("😊 Expressive — emoji-rich");
  if (topEmojis.length === 0) traits.push("🤐 Minimalist — no emoji usage");
  // detect tone keywords
  if (/\b(love|amazing|grateful|blessed|appreciate)\b/i.test(allTextRaw)) traits.push("💝 Gratitude-driven");
  if (/\b(grind|hustle|win|push|crush)\b/i.test(allTextRaw)) traits.push("💪 Motivational / hustle");

  $("brandkit-voice").innerHTML = traits.length
    ? traits.map((t) => `<div class="mb-1">${t}</div>`).join("")
    : '<span class="text-slate-500">Not enough caption data.</span>';

  // Recurring phrases (3-grams that appear ≥2 times)
  const phraseEl = $("brandkit-phrases");
  phraseEl.innerHTML = "";
  const words = allTextRaw.toLowerCase().replace(/[^\w\s']/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const ngrams = new Map();
  for (let i = 0; i < words.length - 2; i++) {
    const g = words.slice(i, i + 3).join(" ");
    ngrams.set(g, (ngrams.get(g) || 0) + 1);
  }
  const recurring = Array.from(ngrams.entries())
    .filter(([g, c]) => c >= 2 && !/\b(and|the|for|with|that|this|you|are|was|but)\b/.test(g))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (recurring.length) {
    recurring.forEach(([g, c]) => {
      const chip = document.createElement("span");
      chip.className = "px-2 py-1 rounded-full bg-fuchsia-500/10 border border-fuchsia-400/20 text-xs text-fuchsia-200";
      chip.innerHTML = `"${g}" <span class="text-fuchsia-400/60 ml-1">${c}×</span>`;
      phraseEl.appendChild(chip);
    });
  } else {
    phraseEl.innerHTML = '<span class="text-xs text-slate-500">No recurring phrases yet.</span>';
  }

  $("brandkit-export").onclick = () => exportBrandKitPng(profile);
}

async function extractColorPalette(imageUrls) {
  // Pull pixels from each image, quantize, return top dominant hex colors.
  const palette = new Map();
  for (const url of imageUrls.slice(0, 6)) {
    try {
      const img = await loadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = 60;
      canvas.height = 60;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 60, 60);
      const data = ctx.getImageData(0, 0, 60, 60).data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] & 0xf0;
        const g = data[i + 1] & 0xf0;
        const b = data[i + 2] & 0xf0;
        const a = data[i + 3];
        if (a < 200) continue;
        // skip near-white and near-black
        if (r > 240 && g > 240 && b > 240) continue;
        if (r < 15 && g < 15 && b < 15) continue;
        const key = `${r},${g},${b}`;
        palette.set(key, (palette.get(key) || 0) + 1);
      }
    } catch (e) {
      console.warn("color sample fail:", url, e);
    }
  }
  const sorted = Array.from(palette.entries()).sort((a, b) => b[1] - a[1]);
  // pick top 5 distinct (filter close colors)
  const out = [];
  for (const [k] of sorted) {
    const [r, g, b] = k.split(",").map(Number);
    const close = out.some((h) => {
      const [hr, hg, hb] = hexToRgb(h);
      return Math.abs(hr - r) < 40 && Math.abs(hg - g) < 40 && Math.abs(hb - b) < 40;
    });
    if (!close) out.push(rgbToHex(r, g, b));
    if (out.length >= 5) break;
  }
  // fill with fallback if too few
  while (out.length < 5) out.push("#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"));
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

async function exportBrandKitPng(profile) {
  // Render the brandkit section into a canvas (simplified: screenshot via html-to-canvas isn't available)
  // Instead, generate a static brand-kit card via canvas
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#070712";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // gradient header
  const grad = ctx.createLinearGradient(0, 0, 1080, 200);
  grad.addColorStop(0, "#ec4899");
  grad.addColorStop(1, "#fbbf24");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 200);
  ctx.fillStyle = "white";
  ctx.font = "bold 60px 'Space Grotesk', sans-serif";
  ctx.fillText(`@${profile.username || "creator"}`, 60, 100);
  ctx.font = "32px Inter, sans-serif";
  ctx.fillText("Brand kit · auto-generated by Pulse", 60, 150);
  // colors
  ctx.fillStyle = "white";
  ctx.font = "bold 28px Inter, sans-serif";
  ctx.fillText("COLOR PALETTE", 60, 280);
  const swatches = document.querySelectorAll("#brandkit-colors button");
  swatches.forEach((sw, i) => {
    ctx.fillStyle = sw.style.background;
    ctx.fillRect(60 + i * 200, 310, 180, 180);
    ctx.fillStyle = "white";
    ctx.font = "20px monospace";
    ctx.fillText(sw.title.split(" — ")[0] || "", 60 + i * 200 + 10, 510);
  });
  // download
  const link = document.createElement("a");
  link.download = `brandkit-${profile.username || "creator"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function renderYearHeatmap(posts) {
  const el = $("year-heatmap");
  el.innerHTML = "";
  if (!posts || !posts.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No posts with timestamps available.</p>';
    $("year-heatmap-stats").innerHTML = "";
    return;
  }
  // count posts per day for last 365 days
  const counts = new Map();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const oneYearAgo = new Date(now);
  oneYearAgo.setDate(now.getDate() - 364);
  for (const p of posts) {
    if (!p.timestamp) continue;
    const d = new Date(p.timestamp * 1000);
    d.setHours(0, 0, 0, 0);
    if (d < oneYearAgo || d > now) continue;
    const key = d.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const max = Math.max(1, ...counts.values());

  // align to week start (Sunday)
  const startDay = (oneYearAgo.getDay()); // 0=Sunday
  // 53 weeks max in a year
  const wrap = document.createElement("div");
  wrap.className = "inline-flex gap-0.5";

  for (let w = 0; w < 53; w++) {
    const col = document.createElement("div");
    col.className = "flex flex-col gap-0.5";
    for (let d = 0; d < 7; d++) {
      const dayIdx = w * 7 + d - startDay;
      const date = new Date(oneYearAgo);
      date.setDate(oneYearAgo.getDate() + dayIdx);
      if (date < oneYearAgo || date > now) {
        const cell = document.createElement("div");
        cell.className = "w-2.5 h-2.5";
        col.appendChild(cell);
        continue;
      }
      const key = date.toISOString().slice(0, 10);
      const c = counts.get(key) || 0;
      const intensity = c === 0 ? "bg-white/5" : c === 1 ? "bg-fuchsia-500/30" : c === 2 ? "bg-fuchsia-500/55" : c === 3 ? "bg-fuchsia-500/80" : "bg-fuchsia-500";
      const cell = document.createElement("div");
      cell.className = `w-2.5 h-2.5 rounded-sm ${intensity}`;
      cell.title = `${date.toDateString()} — ${c} post${c !== 1 ? "s" : ""}`;
      col.appendChild(cell);
    }
    wrap.appendChild(col);
  }
  el.appendChild(wrap);

  // stats summary
  const totalDays = counts.size;
  const totalPosts = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const longestStreak = computeLongestStreak(counts, oneYearAgo, now);
  $("year-heatmap-stats").innerHTML = `
    <span>📅 <strong>${totalDays}</strong> active days</span>
    <span>📤 <strong>${totalPosts}</strong> posts in the past year</span>
    <span>🔥 Longest streak: <strong>${longestStreak}</strong> day${longestStreak !== 1 ? "s" : ""}</span>
  `;
}

function computeLongestStreak(counts, start, end) {
  let longest = 0;
  let current = 0;
  const d = new Date(start);
  while (d <= end) {
    const key = d.toISOString().slice(0, 10);
    if (counts.get(key)) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
    d.setDate(d.getDate() + 1);
  }
  return longest;
}

// ====================================================
// CAPTION DOCTOR · SHADOWBAN SNIFFER · CONTENT CALENDAR
// ====================================================

function initCaptionDoctor(posts, profile) {
  // store reference data for the analyzer
  const followers = profile.followers || 1;
  const engPerPost = (p) => (p.likes || 0) + (p.comments || 0);
  const top3 = [...posts].sort((a, b) => engPerPost(b) - engPerPost(a)).slice(0, 3);
  const topCapLens = top3.map((p) => (p.caption || "").length);
  const idealLen = topCapLens.length ? Math.round(topCapLens.reduce((a, b) => a + b, 0) / topCapLens.length) : 150;
  // emoji & hashtag baselines from top posts
  const emojiRx = /\p{Extended_Pictographic}/gu;
  const idealEmojis = top3.length ? Math.round(top3.reduce((s, p) => s + ((p.caption || "").match(emojiRx) || []).length, 0) / top3.length) : 2;
  const idealHashtags = top3.length ? Math.round(top3.reduce((s, p) => s + ((p.caption || "").match(/#\S+/g) || []).length, 0) / top3.length) : 5;
  const winningTags = (() => {
    const c = new Map();
    for (const p of top3) {
      const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
      for (const t of tags) c.set(t.toLowerCase(), (c.get(t.toLowerCase()) || 0) + 1);
    }
    return Array.from(c.keys());
  })();

  window.__captionDoctorCtx = { idealLen, idealEmojis, idealHashtags, winningTags, top3, followers, profile };

  $("caption-doctor-analyze").onclick = () => analyzeCaptionDraft();
  $("caption-doctor-rewrite").onclick = () => rewriteCaptionWithAi();
}

// Curated list of hashtags reported as "banned" or restricted by Instagram (community-sourced)
const BANNED_HASHTAGS = new Set([
  "adulting","alone","always","american","anonymous","asia","ass","babe","bikinibody","brain","costumes",
  "curvygirls","dating","date","desk","direct","dm","dogsofinstagram","easter","edm","elevator","fetish",
  "fitnessgirls","gloves","graffitiigers","hardworkpaysoff","hawks","hotweather","humpday","ice","instababe",
  "instasport","italiano","killingit","kissing","killingstalking","kik","kissing","lean","lingerie","loseweight",
  "master","mensfollow","milf","mirrorphoto","models","mustfollow","nasty","newyears","nude","parties","petite",
  "pornfood","pushups","rate","ravens","saltwater","selfharm","single","singlelife","skype","snap","snapchat",
  "snowstorm","stranger","streetphoto","sunbathing","swole","tag4like","tagsforlikes","teens","thought",
  "todayimwearing","valentinesday","wet","workflow","workout","yummy","date","dating","followback","followforfollow",
  "girlsonly","hardworkpaysoff","hotweather","instahot",
]);

function analyzeCaptionDraft() {
  const draft = $("caption-doctor-input").value.trim();
  const resEl = $("caption-doctor-result");
  if (!draft) {
    resEl.classList.remove("hidden");
    resEl.innerHTML = '<p class="text-xs text-rose-300">Paste a caption first.</p>';
    return;
  }
  const ctx = window.__captionDoctorCtx;
  if (!ctx) return;

  // banned hashtag scan
  const draftTags = (draft.match(/#([\w]+)/g) || []).map((t) => t.slice(1).toLowerCase());
  const flaggedTags = draftTags.filter((t) => BANNED_HASHTAGS.has(t));
  const len = draft.length;
  const emojis = (draft.match(/\p{Extended_Pictographic}/gu) || []).length;
  const hashtags = (draft.match(/#\S+/g) || []).length;
  const hasQ = draft.includes("?");
  const hasCta = /\b(comment|share|tag|tap|click|link|save|follow|dm)\b/i.test(draft);
  const hookFirst80 = draft.slice(0, 80);
  const hookLong = hookFirst80.length;
  const hasMention = /@\w+/.test(draft);

  // score each dimension
  const lenDiff = Math.abs(len - ctx.idealLen);
  const lenScore = Math.max(0, 100 - Math.round((lenDiff / Math.max(ctx.idealLen, 50)) * 100));
  const emojiDiff = Math.abs(emojis - ctx.idealEmojis);
  const emojiScore = Math.max(0, 100 - emojiDiff * 20);
  const hashtagDiff = Math.abs(hashtags - ctx.idealHashtags);
  const hashtagScore = Math.max(0, 100 - hashtagDiff * 15);
  const ctaScore = hasCta ? 100 : 50;
  const questionScore = hasQ ? 100 : 60;
  const hookScore = hookLong >= 40 && hookLong <= 80 ? 100 : hookLong < 40 ? 60 : 70;

  // overall (weighted)
  const overall = Math.round(
    lenScore * 0.2 + emojiScore * 0.1 + hashtagScore * 0.15 + ctaScore * 0.15 + questionScore * 0.15 + hookScore * 0.25
  );

  const grade = overall >= 85 ? "🟢 Excellent" : overall >= 70 ? "🟢 Good" : overall >= 55 ? "🟡 OK" : overall >= 40 ? "🟠 Weak" : "🔴 Rewrite";

  const bullets = [];
  if (lenScore < 70) bullets.push(`Caption length ${len} chars — your top posts average <strong>${ctx.idealLen}</strong>. ${len < ctx.idealLen ? "Write more." : "Trim it."}`);
  else bullets.push(`✓ Length (${len}) matches your top-post average (${ctx.idealLen}).`);
  if (emojiScore < 70) bullets.push(`Emojis: ${emojis}. Sweet-spot for this account: ~<strong>${ctx.idealEmojis}</strong>.`);
  if (hashtagScore < 70) bullets.push(`Hashtags: ${hashtags}. Best-performing posts use ~<strong>${ctx.idealHashtags}</strong>.`);
  if (!hasQ) bullets.push(`No question mark — add one to drive comments.`);
  if (!hasCta) bullets.push(`No clear CTA — try "save this", "tag a friend", "comment below".`);
  if (hookLong < 40) bullets.push(`First-line hook is too short (${hookLong} chars). Use 40–80 to win the scroll.`);
  if (hookLong > 80 && len > 80) bullets.push(`First line is cluttered. Tight opener = higher hold rate.`);

  const suggestedTags = ctx.winningTags.slice(0, 5);
  const tagSuggestion = suggestedTags.length && hashtagScore < 70
    ? `<div class="mt-2 text-[11px] text-slate-400">Try adding: ${suggestedTags.map((t) => `<span class="text-fuchsia-300">${t}</span>`).join(" ")}</div>`
    : "";

  const bannedWarning = flaggedTags.length
    ? `<div class="mt-2 p-2 rounded-md bg-rose-500/10 border border-rose-400/30 text-xs text-rose-200">⚠️ <strong>Potentially banned/restricted hashtags detected:</strong> ${flaggedTags.map((t) => `<code>#${t}</code>`).join(" ")} — these can hurt reach. Remove or replace.</div>`
    : "";

  resEl.classList.remove("hidden");
  resEl.innerHTML = `
    <div class="rounded-xl bg-black/40 border border-white/10 p-4">
      <div class="flex items-center gap-3 mb-3">
        <div class="relative w-16 h-16 shrink-0">
          <svg viewBox="0 0 64 64" class="w-16 h-16 -rotate-90">
            <circle cx="32" cy="32" r="26" stroke="rgba(255,255,255,0.07)" stroke-width="6" fill="none"/>
            <circle cx="32" cy="32" r="26" stroke="url(#cd-grad)" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="${163}" stroke-dashoffset="${163 - (163 * overall) / 100}"/>
            <defs><linearGradient id="cd-grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient></defs>
          </svg>
          <div class="absolute inset-0 flex items-center justify-center font-display font-bold text-lg">${overall}</div>
        </div>
        <div>
          <div class="font-display font-semibold text-sm">${grade}</div>
          <div class="text-[11px] text-slate-400">Caption health · vs your top 3 posts</div>
        </div>
      </div>
      <ul class="space-y-1 text-xs text-slate-300">${bullets.map((b) => `<li class="flex gap-1.5"><span class="text-fuchsia-300">›</span><span>${b}</span></li>`).join("")}</ul>
      ${tagSuggestion}
      ${bannedWarning}
      <div class="grid grid-cols-3 gap-1.5 mt-3">
        ${[["Length", lenScore], ["Hook", hookScore], ["Engagement triggers", Math.round((ctaScore + questionScore) / 2)]].map(([l, v]) => `
          <div class="rounded-md bg-white/5 p-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">${l}</div>
            <div class="font-bold text-sm">${v}</div>
          </div>`).join("")}
      </div>
    </div>`;
}

async function rewriteCaptionWithAi() {
  const draft = $("caption-doctor-input").value.trim();
  const resEl = $("caption-doctor-result");
  if (!draft) {
    resEl.classList.remove("hidden");
    resEl.innerHTML = '<p class="text-xs text-rose-300">Paste a caption first.</p>';
    return;
  }
  const key = ($("ai-key").value || "").trim();
  if (!key) {
    resEl.classList.remove("hidden");
    resEl.innerHTML = '<p class="text-xs text-rose-300">Save an AI key first (scroll down to AI strategist).</p>';
    return;
  }
  const ctx = window.__captionDoctorCtx;
  if (!ctx) return;
  const provider = $("ai-provider").value;
  const model = $("ai-model").value;
  resEl.classList.remove("hidden");
  resEl.innerHTML = '<div class="flex items-center gap-2 text-xs text-slate-400 p-3"><div class="w-3 h-3 border-2 border-fuchsia-400 border-t-transparent rounded-full animate-spin"></div>AI rewriting in 3 styles…</div>';

  const promptCtx = {
    original_draft: draft,
    account_username: ctx.profile.username,
    account_niche: ctx.profile.category || "",
    top_3_captions_for_reference: ctx.top3.map((p) => ({ caption: (p.caption || "").slice(0, 200), likes: p.likes, comments: p.comments })),
    ideal_caption_length_chars: ctx.idealLen,
    ideal_emoji_count: ctx.idealEmojis,
    ideal_hashtag_count: ctx.idealHashtags,
    winning_hashtags: ctx.winningTags.slice(0, 8),
  };
  const prompt = `Rewrite the user's draft caption in 3 distinct styles, optimized for this specific account's audience based on its top-performing captions:

1. **Punchy version** — short, hook-led, no fluff
2. **Storytelling version** — longer, narrative, with personal voice
3. **Engagement-bait version** — packed with question + CTA + multiple comment hooks

For each: write the caption (with hashtags ready to paste), then a single line explaining why it should outperform the draft for this account.`;

  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, api_key: key, prompt, context: promptCtx }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    // render output
    resEl.innerHTML = `
      <div class="rounded-xl bg-black/40 border border-white/10 p-4">
        <div class="text-xs uppercase tracking-wider text-fuchsia-300 mb-2 inline-flex items-center gap-1"><i data-lucide="sparkles" class="w-3 h-3"></i>3 AI rewrites</div>
        <div id="caption-doctor-ai-output" class="text-sm leading-relaxed whitespace-pre-wrap"></div>
      </div>`;
    document.getElementById("caption-doctor-ai-output").innerHTML = data.text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/(<li>.*?<\/li>\n?)+/gs, "<ul class='list-disc ml-4 my-1'>$&</ul>");
    lucide.createIcons();
  } catch (e) {
    resEl.innerHTML = `<p class="text-xs text-rose-300">${e.message}</p>`;
  }
}

// ----- Shadowban Sniffer -----
let shadowbanChart = null;
function renderShadowbanSniffer(posts, profile) {
  const statusEl = $("shadowban-status");
  const recEl = $("shadowban-recommendations");
  recEl.innerHTML = "";

  if (!posts.length || !profile.followers) {
    statusEl.innerHTML = '<p class="text-sm text-slate-400">Not enough data.</p>';
    return;
  }

  const eng = (p) => (p.likes || 0) + (p.comments || 0);
  const sorted = [...posts].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (sorted.length < 4) {
    statusEl.innerHTML = '<p class="text-sm text-slate-400">Need at least 4 posts to check trend.</p>';
    return;
  }
  // baseline = median of first half; recent = avg of last 3 posts
  const half = Math.floor(sorted.length / 2);
  const baselineSet = sorted.slice(0, half).map(eng).sort((a, b) => a - b);
  const baseline = baselineSet[Math.floor(baselineSet.length / 2)] || 1;
  const recent3 = sorted.slice(-3).map(eng);
  const recentAvg = recent3.reduce((a, b) => a + b, 0) / recent3.length;
  const ratio = recentAvg / Math.max(baseline, 1);

  let verdict, color, bgClass;
  if (ratio < 0.4) {
    verdict = "🚨 STRONG SHADOWBAN SIGNAL";
    color = "rose";
    bgClass = "bg-rose-500/15 border-rose-400/40";
  } else if (ratio < 0.65) {
    verdict = "⚠️ Engagement dip — investigate";
    color = "amber";
    bgClass = "bg-amber-500/10 border-amber-400/30";
  } else if (ratio > 1.5) {
    verdict = "🚀 Surge! Recent posts are outperforming.";
    color = "emerald";
    bgClass = "bg-emerald-500/10 border-emerald-400/30";
  } else {
    verdict = "✅ Normal — recent posts in line with baseline";
    color = "emerald";
    bgClass = "bg-emerald-500/10 border-emerald-400/30";
  }

  statusEl.className = "rounded-xl p-4 border " + bgClass;
  statusEl.innerHTML = `
    <div class="text-sm font-display font-semibold text-${color}-200">${verdict}</div>
    <p class="text-xs text-slate-300 mt-1">Recent 3 posts average <strong>${fmt(Math.round(recentAvg))}</strong> engagement vs baseline median <strong>${fmt(Math.round(baseline))}</strong> — that's <strong>${(ratio * 100).toFixed(0)}%</strong> of normal.</p>`;

  // recommendations
  const recs = [];
  if (ratio < 0.65) {
    recs.push("Check if any recent caption used a banned/sensitive hashtag — that's the #1 cause.");
    recs.push("Take a 24h break from posting. Restart with a high-quality original post.");
    recs.push("Audit recent comments — bot-spam or removed comments can drop reach.");
    recs.push("In IG app: Settings → Account → Account Status — read what Meta says about your reach.");
    recs.push("Reply to every comment in the first hour of your next post (signals real engagement).");
  } else if (ratio > 1.5) {
    recs.push("Whatever you just did is working. Make 2 more posts in the same style THIS WEEK.");
    recs.push("Analyze the top recent post: format, time, hook structure — make it your template.");
  } else {
    recs.push("Engagement is stable. Now push for a breakout: try a new format or trending audio.");
  }
  recs.forEach((r) => {
    const row = document.createElement("div");
    row.className = `text-xs text-${color}-100 px-3 py-1.5 rounded-md bg-${color}-500/5 border border-${color}-400/15 flex gap-1.5`;
    row.innerHTML = `<span>›</span><span>${r}</span>`;
    recEl.appendChild(row);
  });

  // mini chart of engagement over time
  const labels = sorted.map((_, i) => "#" + (i + 1));
  const data = sorted.map(eng);
  if (shadowbanChart) shadowbanChart.destroy();
  shadowbanChart = new Chart($("shadowban-chart").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Engagement", data, borderColor: "#ec4899", backgroundColor: "rgba(236,72,153,0.15)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 },
        { label: "Baseline median", data: data.map(() => baseline), borderColor: "rgba(255,255,255,0.3)", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: { ...chartOpts(), plugins: { ...chartOpts().plugins, legend: { display: false } } },
  });
}

// ----- Content Calendar -----
const LS_CALENDAR = "ig_calendar_v1";
let calendarWeekOffset = 0;

function loadCalendar() {
  try { return JSON.parse(localStorage.getItem(LS_CALENDAR) || "{}"); }
  catch { return {}; }
}
function saveCalendar(data) {
  localStorage.setItem(LS_CALENDAR, JSON.stringify(data));
}
function startOfWeek(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday-start
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function initContentCalendar(username) {
  if (!username) return;
  window.__calendarUsername = username;
  calendarWeekOffset = 0;
  renderCalendar();
  $("calendar-prev-week").onclick = () => { calendarWeekOffset--; renderCalendar(); };
  $("calendar-next-week").onclick = () => { calendarWeekOffset++; renderCalendar(); };
  $("calendar-notify-perm").onclick = async () => {
    if (!("Notification" in window)) { alert("Browser doesn't support notifications."); return; }
    const r = await Notification.requestPermission();
    $("calendar-notify-perm").textContent = r === "granted" ? "🔔 Enabled ✓" : "Denied";
  };
  // schedule any pending notifications
  scheduleCalendarReminders();
}

function renderCalendar() {
  const username = window.__calendarUsername;
  const data = loadCalendar();
  const userCal = data[username] || {};

  const start = startOfWeek(new Date());
  start.setDate(start.getDate() + calendarWeekOffset * 7);
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  $("calendar-week-label").textContent = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${new Date(start.getTime() + 6 * 86400000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const grid = $("calendar-grid");
  grid.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(start);
    dayDate.setDate(start.getDate() + i);
    const dateKey = dayDate.toISOString().slice(0, 10);
    const items = userCal[dateKey] || [];

    const cell = document.createElement("div");
    cell.className = "rounded-lg bg-black/30 border border-white/5 p-2 min-h-[120px] flex flex-col";
    const isToday = dateKey === new Date().toISOString().slice(0, 10);
    if (isToday) cell.classList.add("ring-1", "ring-fuchsia-400/40");
    cell.innerHTML = `
      <div class="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex justify-between">
        <span>${days[i]} ${dayDate.getDate()}</span>
        ${isToday ? '<span class="text-fuchsia-300">today</span>' : ''}
      </div>
      <div class="flex-1 space-y-1" data-day="${dateKey}"></div>`;
    const slot = cell.querySelector("[data-day]");

    if (items.length === 0) {
      slot.innerHTML = '<p class="text-[10px] text-slate-600 italic">empty</p>';
    } else {
      items.forEach((it, idx) => {
        const card = document.createElement("div");
        card.className = "text-[10px] rounded-md p-1.5 bg-gradient-to-br from-fuchsia-500/20 to-amber-400/20 border border-fuchsia-400/30 group relative";
        card.innerHTML = `
          <div class="font-semibold text-fuchsia-100 truncate">${it.emoji || "🎬"} ${escapeHtml(it.name || "Idea")}</div>
          <div class="text-slate-300 truncate">${escapeHtml((it.hook_filled || "").slice(0, 40))}</div>
          ${it.time ? `<div class="text-fuchsia-300/70 text-[9px] mt-0.5">⏰ ${it.time}</div>` : ""}
          <button data-rm class="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 text-[10px] text-rose-300 hover:text-white">×</button>`;
        card.querySelector("[data-rm]").addEventListener("click", (e) => {
          e.stopPropagation();
          const cal = loadCalendar();
          cal[username] = cal[username] || {};
          cal[username][dateKey] = cal[username][dateKey].filter((_, i) => i !== idx);
          saveCalendar(cal);
          renderCalendar();
        });
        slot.appendChild(card);
      });
    }

    // click empty space → opens scheduling modal
    cell.addEventListener("click", (e) => {
      if (e.target.closest("[data-rm]")) return;
      openCalendarPicker(dateKey);
    });
    grid.appendChild(cell);
  }
}

function openCalendarPicker(dateKey) {
  // get saved reel ideas
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("ig_saved_reel_ideas_v1") || "[]"); }
  catch {}
  const username = window.__calendarUsername;
  const userSaved = saved.filter((s) => s.username === username);

  // simple inline modal
  const existing = document.getElementById("cal-picker");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "cal-picker";
  modal.className = "fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md";
  modal.innerHTML = `
    <div class="glass-card p-5 max-w-md w-full">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-display font-semibold">Schedule for ${new Date(dateKey).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</h3>
        <button id="cal-picker-close" class="text-slate-400 hover:text-white">×</button>
      </div>
      <p class="text-xs text-slate-400 mb-2">Pick a saved reel idea, or type a custom one.</p>
      <div class="space-y-2 max-h-60 overflow-y-auto mb-3" id="cal-picker-list">
        ${userSaved.length ? userSaved.slice(0, 10).map((s, i) => `
          <button data-saved="${i}" class="w-full text-left rounded-md p-2 bg-white/5 hover:bg-fuchsia-500/15 border border-white/10 hover:border-fuchsia-400/40 transition text-xs">
            <div class="font-semibold">${s.idea.emoji || "🎬"} ${escapeHtml(s.idea.name)}</div>
            <div class="text-slate-400 truncate">${escapeHtml(s.idea.hook_filled)}</div>
          </button>
        `).join("") : '<p class="text-xs text-slate-500 text-center py-3">No saved ideas. Save some from the Reel ideas section first, or type custom below.</p>'}
      </div>
      <div class="space-y-2 pt-3 border-t border-white/5">
        <input id="cal-custom-name" placeholder="Custom post idea name…" class="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm" />
        <input id="cal-custom-hook" placeholder="Hook / first words…" class="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm" />
        <input id="cal-custom-time" type="time" class="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm" />
        <button id="cal-add-custom" class="w-full px-3 py-1.5 rounded bg-gradient-to-tr from-fuchsia-500 to-pink-500 text-white text-sm font-semibold">Add custom slot</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById("cal-picker-close").onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.querySelectorAll("[data-saved]").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.saved);
      const idea = userSaved[idx].idea;
      addToCalendar(dateKey, idea, null);
      modal.remove();
    };
  });
  document.getElementById("cal-add-custom").onclick = () => {
    const name = document.getElementById("cal-custom-name").value.trim();
    const hook = document.getElementById("cal-custom-hook").value.trim();
    const time = document.getElementById("cal-custom-time").value;
    if (!name && !hook) { return; }
    addToCalendar(dateKey, { name: name || "Post", hook_filled: hook || "", emoji: "📝" }, time);
    modal.remove();
  };
}

function addToCalendar(dateKey, idea, time) {
  const username = window.__calendarUsername;
  const cal = loadCalendar();
  cal[username] = cal[username] || {};
  cal[username][dateKey] = cal[username][dateKey] || [];
  cal[username][dateKey].push({ ...idea, time: time || null });
  saveCalendar(cal);
  renderCalendar();
  scheduleCalendarReminders();
}

function scheduleCalendarReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const username = window.__calendarUsername;
  const cal = loadCalendar();
  const userCal = cal[username] || {};
  const now = Date.now();
  for (const [dateKey, items] of Object.entries(userCal)) {
    items.forEach((it) => {
      if (!it.time) return;
      const dt = new Date(`${dateKey}T${it.time}:00`).getTime();
      const delay = dt - now;
      if (delay > 0 && delay < 7 * 86400 * 1000 && !it._scheduled) {
        setTimeout(() => {
          new Notification(`📸 Time to post: ${it.name}`, {
            body: it.hook_filled || "Your scheduled IG post",
            icon: "/favicon.svg",
          });
        }, delay);
        it._scheduled = true;
      }
    });
  }
}

// ====================================================
// WHAT YOUR AUDIENCE LOVES
// ====================================================
function renderAudienceLoves(posts, profile) {
  const tilesEl = $("audience-tiles");
  const topEl = $("audience-top-posts");
  const insEl = $("audience-insights");
  tilesEl.innerHTML = topEl.innerHTML = insEl.innerHTML = "";

  if (!posts.length) {
    tilesEl.innerHTML = '<p class="col-span-full text-xs text-slate-500">No posts to analyze.</p>';
    return;
  }

  const engOf = (p) => (p.likes || 0) + (p.comments || 0);
  const followers = profile.followers || 1;
  const sorted = [...posts].sort((a, b) => engOf(b) - engOf(a));
  const top3 = sorted.slice(0, 3);
  const avgEng = posts.reduce((s, p) => s + engOf(p), 0) / posts.length;
  const bestEng = engOf(top3[0]);
  const lift = (bestEng / Math.max(avgEng, 1)).toFixed(1);

  // dominant format among top posts
  const fmt = (p) => p.is_video ? "Reel" : p.is_carousel ? "Carousel" : "Photo";
  const fmtCount = { Reel: 0, Photo: 0, Carousel: 0 };
  top3.forEach((p) => fmtCount[fmt(p)]++);
  const dominantFmt = Object.entries(fmtCount).sort((a, b) => b[1] - a[1])[0][0];

  // best hour from top 5
  const hours = sorted.slice(0, 5).map((p) => p.timestamp ? new Date(p.timestamp * 1000).getHours() : null).filter((h) => h != null);
  const avgHour = hours.length ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null;
  const hourLabel = avgHour == null ? "—" : `${avgHour}:00`;
  const partOfDay = avgHour == null ? "—" : avgHour < 12 ? "morning" : avgHour < 17 ? "afternoon" : "evening";

  // top hashtags within best posts
  const tagCount = new Map();
  for (const p of sorted.slice(0, 5)) {
    const tags = (p.caption || "").match(/#[\p{L}0-9_]+/gu) || [];
    for (const t of tags) tagCount.set(t.toLowerCase(), (tagCount.get(t.toLowerCase()) || 0) + 1);
  }
  const winningTags = Array.from(tagCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);

  // tiles
  const tile = (label, value, sub, color = "fuchsia") => `
    <div class="rounded-xl bg-white/5 border border-white/10 p-3">
      <div class="text-[10px] uppercase tracking-wider text-slate-400">${label}</div>
      <div class="font-display text-base font-bold mt-1 text-${color}-200">${value}</div>
      ${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ""}
    </div>`;
  tilesEl.innerHTML = [
    tile("Best post engagement", fmt2(bestEng), `${lift}× the average post`, "fuchsia"),
    tile("Top format they ❤️", dominantFmt, `${fmtCount[dominantFmt]}/3 top posts`, "amber"),
    tile("Sweet-spot hour", hourLabel, partOfDay, "sky"),
    tile("Winning hashtags", winningTags.length, winningTags.length ? winningTags[0][0] : "—", "emerald"),
  ].join("");

  // top posts list
  top3.forEach((p, i) => {
    const row = document.createElement("a");
    row.className = "flex items-center gap-3 p-3 rounded-lg bg-black/30 border border-white/5 hover:border-fuchsia-400/40 transition";
    row.href = p.permalink || "#";
    row.target = "_blank";
    row.rel = "noreferrer";
    const thumb = p.thumbnail || p.display_url;
    const src = thumb ? `/api/image?url=${encodeURIComponent(thumb)}` : "";
    const eng = engOf(p);
    const erPct = followers ? ((eng / followers) * 100).toFixed(2) : "—";
    const caption = (p.caption || "").replace(/\s+/g, " ").slice(0, 70);
    row.innerHTML = `
      <div class="w-12 h-12 rounded-md overflow-hidden bg-black/40 border border-white/5 shrink-0">
        ${src ? `<img src="${src}" class="w-full h-full object-cover" onerror="this.style.display='none'"/>` : ""}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs text-slate-300 truncate">#${i + 1} · ${fmt(p)} · ${caption || "<em>no caption</em>"}</div>
        <div class="flex items-center gap-3 mt-1 text-[11px]">
          <span class="text-fuchsia-300">♥ ${fmt2(p.likes || 0)}</span>
          <span class="text-amber-300">💬 ${fmt2(p.comments || 0)}</span>
          <span class="text-slate-400">${erPct}% ER</span>
        </div>
      </div>`;
    topEl.appendChild(row);
  });

  // insights — concrete bullet points
  const insights = [];
  if (lift > 2) insights.push(`🔥 Your best post got <strong>${lift}× more engagement</strong> than your average — this is your signal.`);
  if (dominantFmt === "Reel") insights.push(`📹 <strong>Reels dominate</strong>: ${fmtCount.Reel}/3 of your top posts are videos. <strong>Make more.</strong>`);
  if (dominantFmt === "Carousel") insights.push(`🖼 Your audience loves <strong>carousels</strong>: ${fmtCount.Carousel}/3 of top posts are multi-slide.`);
  if (dominantFmt === "Photo") insights.push(`📸 Photos still win here — ${fmtCount.Photo}/3 of top posts. Quality matters more than format.`);
  if (avgHour != null) insights.push(`⏰ Top posts were uploaded around <strong>${hourLabel}</strong> (${partOfDay}). Schedule there.`);

  if (winningTags.length) {
    const tagStr = winningTags.map((t) => t[0]).join(" ");
    insights.push(`🏷 These hashtags appear in your top posts: <span class="text-fuchsia-300">${tagStr}</span> — keep using them.`);
  }

  // what flopped — bottom 25% pattern
  const bottom = sorted.slice(-Math.max(2, Math.floor(posts.length * 0.25)));
  if (bottom.length >= 2) {
    const bFmts = { Reel: 0, Photo: 0, Carousel: 0 };
    bottom.forEach((p) => bFmts[fmt(p)]++);
    const flopFmt = Object.entries(bFmts).sort((a, b) => b[1] - a[1])[0];
    if (flopFmt[1] >= bottom.length * 0.6 && flopFmt[0] !== dominantFmt) {
      insights.push(`📉 <strong>${flopFmt[0]}s under-perform</strong> here — ${flopFmt[1]}/${bottom.length} of your lowest posts. Reduce or rework.`);
    }
  }

  // caption length pattern
  const topCapLens = top3.map((p) => (p.caption || "").length);
  const avgTopLen = topCapLens.reduce((a, b) => a + b, 0) / Math.max(topCapLens.length, 1);
  const allCapAvg = posts.reduce((s, p) => s + (p.caption || "").length, 0) / posts.length;
  if (Math.abs(avgTopLen - allCapAvg) > 30) {
    if (avgTopLen > allCapAvg) {
      insights.push(`✍️ Your top posts have <strong>longer captions</strong> (${Math.round(avgTopLen)} vs avg ${Math.round(allCapAvg)} chars). Write more.`);
    } else {
      insights.push(`✍️ Your top posts have <strong>shorter punchier captions</strong> (${Math.round(avgTopLen)} vs avg ${Math.round(allCapAvg)} chars). Trim the fat.`);
    }
  }

  // emoji pattern
  const emojiRx = /\p{Extended_Pictographic}/gu;
  const topEmojiAvg = top3.reduce((s, p) => s + ((p.caption || "").match(emojiRx) || []).length, 0) / Math.max(top3.length, 1);
  const allEmojiAvg = posts.reduce((s, p) => s + ((p.caption || "").match(emojiRx) || []).length, 0) / posts.length;
  if (Math.abs(topEmojiAvg - allEmojiAvg) > 0.7) {
    if (topEmojiAvg > allEmojiAvg) {
      insights.push(`😊 Your audience reacts to <strong>emoji-heavy captions</strong> (avg ${topEmojiAvg.toFixed(1)} vs ${allEmojiAvg.toFixed(1)} per post).`);
    } else {
      insights.push(`🚫 <strong>Fewer emojis = better engagement</strong> for this audience.`);
    }
  }

  if (!insights.length) insights.push("Not enough variation yet. Post more so we can spot patterns.");

  insights.slice(0, 7).forEach((txt) => {
    const li = document.createElement("div");
    li.className = "flex gap-2 text-sm text-slate-300 leading-relaxed p-2 rounded-md bg-white/5";
    li.innerHTML = `<span>${txt}</span>`;
    insEl.appendChild(li);
  });
}
function fmt2(n) { return fmt(n); }

// ====================================================
// ACCOUNT HEALTH SCORE
// ====================================================
function renderHealthScore(posts, profile) {
  // Compute 5 sub-scores out of 100 each, weighted average for overall.
  const followers = profile.followers || 0;

  // 1) Engagement (per benchmark: <0.5% bad, 1% ok, 2%+ great)
  const avgEng = posts.length
    ? posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length
    : 0;
  const er = followers ? (avgEng / followers) * 100 : 0;
  const engagementScore = Math.min(100, Math.round((er / 3) * 100));

  // 2) Consistency: posting frequency from timestamps
  let consistencyScore = 50;
  const ts = posts.map((p) => p.timestamp).filter(Boolean).sort();
  if (ts.length >= 3) {
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 86400);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // 1-3 days = best (100), 4-7 = good (75), 8-14 = ok (50), >14 = low
    if (avgGap <= 3) consistencyScore = 100;
    else if (avgGap <= 7) consistencyScore = 75;
    else if (avgGap <= 14) consistencyScore = 50;
    else if (avgGap <= 30) consistencyScore = 30;
    else consistencyScore = 15;
    // bonus for recency: post in last 14 days
    const lastTs = ts[ts.length - 1];
    const daysSinceLast = (Date.now() / 1000 - lastTs) / 86400;
    if (daysSinceLast > 30) consistencyScore = Math.round(consistencyScore * 0.5);
  } else if (posts.length === 0) {
    consistencyScore = 0;
  }

  // 3) Content variety: mix of formats
  const formats = { Reel: 0, Photo: 0, Carousel: 0 };
  for (const p of posts) {
    if (p.is_video) formats.Reel++;
    else if (p.is_carousel) formats.Carousel++;
    else formats.Photo++;
  }
  const usedFormats = Object.values(formats).filter((v) => v > 0).length;
  const varietyScore = usedFormats === 3 ? 100 : usedFormats === 2 ? 70 : usedFormats === 1 ? 40 : 0;

  // 4) Profile completeness: bio + category + external_url + verified/business
  let completenessRaw = 0;
  if ((profile.biography || "").trim()) completenessRaw += 30;
  if (profile.category) completenessRaw += 20;
  if (profile.external_url) completenessRaw += 20;
  if (profile.profile_pic_url) completenessRaw += 15;
  if (profile.is_business || profile.is_professional) completenessRaw += 15;
  const completenessScore = Math.min(100, completenessRaw);

  // 5) Audience scale (followers tier mapped to 0-100, log-ish)
  const sizeScore = followers === 0 ? 0
    : followers < 1_000 ? 20
    : followers < 10_000 ? 40
    : followers < 100_000 ? 60
    : followers < 1_000_000 ? 80
    : 100;

  // weighted overall (engagement is king)
  const overall = Math.round(
    engagementScore * 0.35 +
    consistencyScore * 0.25 +
    varietyScore * 0.15 +
    completenessScore * 0.15 +
    sizeScore * 0.10
  );

  // grade letter
  const grade =
    overall >= 90 ? "A+" :
    overall >= 80 ? "A " :
    overall >= 70 ? "B+" :
    overall >= 60 ? "B " :
    overall >= 50 ? "C " :
    overall >= 40 ? "D " : "F ";

  // animate gauge
  const dashOffset = 326 - (326 * overall) / 100;
  $("health-gauge").setAttribute("stroke-dashoffset", dashOffset);
  $("health-score").textContent = overall;
  $("health-grade").textContent = "Grade " + grade.trim();

  // summary text
  const summary = (() => {
    if (overall >= 80) return `Strong account. ER ${er.toFixed(2)}% beats the average for this size — keep doing what works.`;
    if (overall >= 60) return `Healthy fundamentals. ${er.toFixed(2)}% ER is decent — main lever is posting consistency (currently ${consistencyScore >= 70 ? "good" : "needs work"}).`;
    if (overall >= 40) return `Room to grow. Biggest gap: ${engagementScore < 40 ? "engagement is below benchmark" : consistencyScore < 50 ? "posting cadence is irregular" : "content variety"}.`;
    return `Underperforming. Focus first on consistency (post every 2–3 days) and engagement (ask questions, reply to comments fast).`;
  })();
  $("health-summary").textContent = summary;

  // sub-score chips
  const subEl = $("health-subscores");
  subEl.innerHTML = "";
  const subs = [
    { label: "Engagement", value: engagementScore, color: "fuchsia", detail: er.toFixed(2) + "% ER" },
    { label: "Consistency", value: consistencyScore, color: "amber", detail: ts.length >= 2 ? Math.round((ts[ts.length-1]-ts[0])/86400/(ts.length-1)) + "d gap" : "—" },
    { label: "Variety", value: varietyScore, color: "sky", detail: usedFormats + "/3 formats" },
    { label: "Profile", value: completenessScore, color: "emerald", detail: completenessRaw + "/100" },
  ];
  subs.forEach((s) => {
    const tile = document.createElement("div");
    tile.className = "rounded-xl bg-white/5 border border-white/10 p-3";
    tile.innerHTML = `
      <div class="flex items-center justify-between mb-1.5">
        <span class="text-[10px] uppercase tracking-wider text-slate-400">${s.label}</span>
        <span class="text-${s.color}-300 font-display font-bold text-sm">${s.value}</span>
      </div>
      <div class="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div class="h-full bg-gradient-to-r from-${s.color}-500 to-${s.color}-300 rounded-full" style="width:${s.value}%"></div>
      </div>
      <div class="text-[10px] text-slate-500 mt-1">${s.detail}</div>`;
    subEl.appendChild(tile);
  });
}

// ====================================================
// WELCOME FLOW · DEMO BUTTONS · INPUT-FROM-MODAL
// ====================================================
function initWelcomeFlow() {
  const seen = localStorage.getItem("ig_welcome_seen_v1");
  if (!seen) {
    $("welcome-modal").classList.remove("hidden");
    $("welcome-modal").classList.add("flex");
  }
  $("welcome-close").addEventListener("click", closeWelcome);
  $("welcome-skip").addEventListener("click", closeWelcome);
  $("welcome-modal").addEventListener("click", (e) => {
    if (e.target.id === "welcome-modal") closeWelcome();
  });
  document.querySelectorAll(".welcome-demo-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const u = b.dataset.demo;
      closeWelcome();
      setMode("lookup");
      $("lookup-input").value = u;
      doLookup();
    })
  );
  $("welcome-go").addEventListener("click", () => {
    const u = $("welcome-input").value.trim().replace(/^@+/, "");
    if (!u) return;
    closeWelcome();
    setMode("lookup");
    $("lookup-input").value = u;
    doLookup();
  });
  $("welcome-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("welcome-go").click();
  });
}
function closeWelcome() {
  $("welcome-modal").classList.add("hidden");
  $("welcome-modal").classList.remove("flex");
  localStorage.setItem("ig_welcome_seen_v1", "1");
}

// ====================================================
// THEME PICKER
// ====================================================
const THEMES = [
  { id: "default", name: "Pink", colors: ["#ec4899", "#fbbf24"] },
  { id: "violet", name: "Violet", colors: ["#a855f7", "#38bdf8"] },
  { id: "emerald", name: "Emerald", colors: ["#10b981", "#38bdf8"] },
  { id: "rose", name: "Rose", colors: ["#f43f5e", "#f97316"] },
  { id: "indigo", name: "Indigo", colors: ["#6366f1", "#ec4899"] },
];

function initThemePicker() {
  const saved = localStorage.getItem("ig_theme_v1") || "default";
  applyTheme(saved);

  const sw = $("theme-swatches");
  THEMES.forEach((t) => {
    const b = document.createElement("button");
    b.className = "rounded-lg p-2 border-2 transition";
    b.style.borderColor = saved === t.id ? "white" : "transparent";
    b.style.background = `linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})`;
    b.style.height = "32px";
    b.title = t.name;
    b.addEventListener("click", () => {
      applyTheme(t.id);
      document.querySelectorAll("#theme-swatches button").forEach((x) => (x.style.borderColor = "transparent"));
      b.style.borderColor = "white";
    });
    sw.appendChild(b);
  });

  $("theme-btn").addEventListener("click", () => {
    $("theme-drawer").classList.toggle("hidden");
    $("ai-history-drawer").classList.add("hidden");
  });
  $("theme-drawer-close").addEventListener("click", () => $("theme-drawer").classList.add("hidden"));
}

function applyTheme(id) {
  if (id === "default") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", id);
  localStorage.setItem("ig_theme_v1", id);
}

// ====================================================
// AI HISTORY DRAWER
// ====================================================
const LS_AI_HISTORY = "ig_ai_history_v1";

function loadAiHistory() {
  try { return JSON.parse(localStorage.getItem(LS_AI_HISTORY) || "[]"); }
  catch { return []; }
}
function saveAiHistoryEntry(entry) {
  const h = loadAiHistory();
  h.unshift(entry);
  // cap at 50
  localStorage.setItem(LS_AI_HISTORY, JSON.stringify(h.slice(0, 50)));
  updateHistoryBadge();
}
function updateHistoryBadge() {
  const h = loadAiHistory();
  const pill = $("ai-history-pill");
  if (h.length > 0) {
    pill.textContent = h.length;
    pill.classList.remove("hidden");
  } else pill.classList.add("hidden");
}

function initAiHistoryDrawer() {
  updateHistoryBadge();
  $("ai-history-btn").addEventListener("click", () => {
    $("ai-history-drawer").classList.toggle("hidden");
    $("theme-drawer").classList.add("hidden");
    renderAiHistoryList();
  });
  $("ai-history-close").addEventListener("click", () => $("ai-history-drawer").classList.add("hidden"));
  $("ai-history-clear").addEventListener("click", () => {
    if (confirm("Clear all AI history?")) {
      localStorage.removeItem(LS_AI_HISTORY);
      updateHistoryBadge();
      renderAiHistoryList();
    }
  });
}

function renderAiHistoryList() {
  const list = $("ai-history-list");
  list.innerHTML = "";
  const h = loadAiHistory();
  if (!h.length) {
    list.innerHTML = '<p class="text-xs text-slate-500 text-center py-6">No saved analyses yet.<br/>Use AI strategist to start.</p>';
    return;
  }
  h.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "rounded-lg bg-black/40 border border-white/10 p-3 hover:border-fuchsia-400/40 transition cursor-pointer";
    const d = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-semibold text-fuchsia-300 truncate">@${e.username || "—"}</span>
        <span class="text-[10px] text-slate-500">${d}</span>
      </div>
      <div class="text-[11px] text-slate-400 truncate">${e.kind || "custom"} · ${e.provider}</div>
      <div class="text-xs text-slate-300 mt-1 line-clamp-2">${(e.text || "").slice(0, 200)}</div>`;
    row.addEventListener("click", () => {
      renderAiOutput(e.text);
      $("ai-output").scrollIntoView({ behavior: "smooth" });
      $("ai-history-drawer").classList.add("hidden");
    });
    list.appendChild(row);
  });
}

// hook: after every successful AI response, save it
const _origRenderAiOutput = typeof renderAiOutput === "function" ? renderAiOutput : null;

// ====================================================
// CMD+K COMMAND PALETTE
// ====================================================
const CMDK_COMMANDS = [
  { id: "lookup", icon: "search", label: "Lookup an account", run: () => { setMode("lookup"); $("lookup-input").focus(); } },
  { id: "watchlist", icon: "bookmark", label: "Open watchlist", run: () => setMode("watchlist") },
  { id: "compare", icon: "git-compare", label: "Open compare", run: () => setMode("compare") },
  { id: "export", icon: "archive", label: "Data export", run: () => setMode("export") },
  { id: "live", icon: "zap", label: "Live API", run: () => setMode("live") },
  { id: "theme", icon: "palette", label: "Change theme", run: () => $("theme-btn").click() },
  { id: "history", icon: "history", label: "AI history", run: () => $("ai-history-btn").click() },
  { id: "print", icon: "printer", label: "Export dashboard as PDF", run: () => window.print() },
  { id: "ai-strategy", icon: "sparkles", label: "AI: Full growth strategy", run: () => clickAiPreset("strategy") },
  { id: "ai-reels", icon: "film", label: "AI: 10 reel scripts", run: () => clickAiPreset("content") },
  { id: "ai-brands", icon: "briefcase", label: "AI: Brand outreach plan", run: () => clickAiPreset("brands") },
  { id: "ai-audit", icon: "clipboard-check", label: "AI: Account audit", run: () => clickAiPreset("audit") },
  { id: "ai-bio", icon: "pen-tool", label: "AI: Rewrite my bio", run: () => clickAiPreset("bio") },
  { id: "ai-roast", icon: "flame", label: "AI: 🔥 Roast my account", run: () => clickAiPreset("roast") },
  { id: "ai-competitor", icon: "trophy", label: "AI: Steal from top post", run: () => clickAiPreset("competitor") },
  { id: "welcome", icon: "info", label: "Show welcome screen again", run: () => { localStorage.removeItem("ig_welcome_seen_v1"); $("welcome-modal").classList.remove("hidden"); $("welcome-modal").classList.add("flex"); } },
];

function clickAiPreset(kind) {
  const btn = document.querySelector(`.ai-prompt-btn[data-prompt="${kind}"]`);
  if (btn) {
    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => btn.click(), 300);
  }
}

let cmdkSelected = 0;
function initCmdkPalette() {
  const open = () => {
    $("cmdk").classList.remove("hidden");
    $("cmdk").classList.add("flex");
    $("cmdk-input").value = "";
    cmdkSelected = 0;
    renderCmdkResults();
    setTimeout(() => $("cmdk-input").focus(), 50);
  };
  const close = () => {
    $("cmdk").classList.add("hidden");
    $("cmdk").classList.remove("flex");
  };

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("cmdk").classList.contains("hidden")) open();
      else close();
    }
    if (e.key === "Escape" && !$("cmdk").classList.contains("hidden")) close();
  });

  $("cmdk").addEventListener("click", (e) => {
    if (e.target.id === "cmdk") close();
  });

  $("cmdk-input").addEventListener("input", () => {
    cmdkSelected = 0;
    renderCmdkResults();
  });
  $("cmdk-input").addEventListener("keydown", (e) => {
    const items = document.querySelectorAll("#cmdk-results [data-cmd]");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cmdkSelected = Math.min(items.length - 1, cmdkSelected + 1);
      highlightCmdk();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cmdkSelected = Math.max(0, cmdkSelected - 1);
      highlightCmdk();
    } else if (e.key === "Enter") {
      const item = items[cmdkSelected];
      if (item) {
        const id = item.dataset.cmd;
        close();
        executeCmdk(id);
      }
    }
  });
}

function renderCmdkResults() {
  const q = ($("cmdk-input").value || "").toLowerCase().trim();
  const list = $("cmdk-results");
  list.innerHTML = "";

  // detect "@username" → look up directly
  if (/^@?[\w.]{2,30}$/.test(q.replace(/^@/, ""))) {
    const u = q.replace(/^@/, "");
    if (u.length >= 2) {
      const a = document.createElement("button");
      a.className = "w-full flex items-center gap-2 px-3 py-2 hover:bg-fuchsia-500/15 text-sm transition";
      a.dataset.cmd = "search:" + u;
      a.innerHTML = `<i data-lucide="search" class="w-4 h-4 text-fuchsia-300"></i>Lookup <strong class="text-fuchsia-300">@${u}</strong>`;
      a.onclick = () => {
        $("cmdk").classList.add("hidden");
        setMode("lookup");
        $("lookup-input").value = u;
        doLookup();
      };
      list.appendChild(a);
    }
  }

  // command matches
  const filtered = q ? CMDK_COMMANDS.filter((c) => c.label.toLowerCase().includes(q)) : CMDK_COMMANDS;
  filtered.forEach((c) => {
    const a = document.createElement("button");
    a.className = "w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-sm transition";
    a.dataset.cmd = c.id;
    a.innerHTML = `<i data-lucide="${c.icon}" class="w-4 h-4 text-slate-400"></i>${c.label}`;
    a.onclick = () => {
      $("cmdk").classList.add("hidden");
      executeCmdk(c.id);
    };
    list.appendChild(a);
  });

  if (!list.children.length) {
    list.innerHTML = '<div class="text-xs text-slate-500 px-3 py-4 text-center">No matches.</div>';
  }
  lucide.createIcons();
  highlightCmdk();
}

function highlightCmdk() {
  const items = document.querySelectorAll("#cmdk-results [data-cmd]");
  items.forEach((el, i) => {
    if (i === cmdkSelected) el.classList.add("bg-white/10");
    else el.classList.remove("bg-white/10");
  });
  items[cmdkSelected]?.scrollIntoView({ block: "nearest" });
}

function executeCmdk(id) {
  if (id.startsWith("search:")) {
    setMode("lookup");
    $("lookup-input").value = id.slice(7);
    doLookup();
    return;
  }
  const cmd = CMDK_COMMANDS.find((c) => c.id === id);
  if (cmd) cmd.run();
}

// ====================================================
// POSTS TABLE — search, filter, sort
// ====================================================
let postsTableState = { sort: { col: "date", dir: "desc" }, search: "", filter: "all", raw: [] };

function initPostsTableControls() {
  $("posts-table-search").addEventListener("input", (e) => {
    postsTableState.search = e.target.value.toLowerCase();
    rerenderPostsTable();
  });
  $("posts-table-filter").addEventListener("change", (e) => {
    postsTableState.filter = e.target.value;
    rerenderPostsTable();
  });
}

function rerenderPostsTable() {
  let rows = [...postsTableState.raw];
  if (postsTableState.search) {
    rows = rows.filter((r) => (r.caption || "").toLowerCase().includes(postsTableState.search));
  }
  if (postsTableState.filter !== "all") {
    rows = rows.filter((r) => (r.mediaType || "").toLowerCase().includes(postsTableState.filter.toLowerCase()));
  }
  // sort
  const { col, dir } = postsTableState.sort;
  const cmp = (a, b) => {
    let av, bv;
    if (col === "likes") { av = a.likes || 0; bv = b.likes || 0; }
    else if (col === "comments") { av = a.comments || 0; bv = b.comments || 0; }
    else if (col === "engagement") { av = (a.likes || 0) + (a.comments || 0); bv = (b.likes || 0) + (b.comments || 0); }
    else { av = a.timestamp || 0; bv = b.timestamp || 0; }
    return dir === "desc" ? bv - av : av - bv;
  };
  rows.sort(cmp);

  // build head with sort
  const sortIcon = (c) => (postsTableState.sort.col === c ? (postsTableState.sort.dir === "desc" ? " ↓" : " ↑") : "");
  $("posts-table-head").innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-white/5">
      <th class="py-2 pr-3">Post</th>
      <th class="py-2 px-3 cursor-pointer hover:text-fuchsia-300" data-sort="caption">Caption</th>
      <th class="py-2 px-3">Type</th>
      <th class="py-2 px-3 text-right cursor-pointer hover:text-fuchsia-300" data-sort="likes">Likes${sortIcon("likes")}</th>
      <th class="py-2 px-3 text-right cursor-pointer hover:text-fuchsia-300" data-sort="comments">Comments${sortIcon("comments")}</th>
      <th class="py-2 px-3 text-right cursor-pointer hover:text-fuchsia-300" data-sort="engagement">Engagement${sortIcon("engagement")}</th>
      <th class="py-2 pl-3 text-right cursor-pointer hover:text-fuchsia-300" data-sort="date">Date${sortIcon("date")}</th>
    </tr>`;
  // bind sort
  $("posts-table-head").querySelectorAll("[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (postsTableState.sort.col === col) {
        postsTableState.sort.dir = postsTableState.sort.dir === "desc" ? "asc" : "desc";
      } else {
        postsTableState.sort.col = col;
        postsTableState.sort.dir = "desc";
      }
      rerenderPostsTable();
    });
  });

  const tbody = $("posts-table");
  tbody.innerHTML = "";
  rows.slice(0, 100).forEach((p) => {
    const tr = document.createElement("tr");
    const caption = (p.caption || "").replace(/\s+/g, " ").slice(0, 100);
    const thumb = p.thumbnail || p.display_url;
    const src = thumb ? `/api/image?url=${encodeURIComponent(thumb)}` : "";
    const hasLive = p.likes != null;
    const eng = (p.likes || 0) + (p.comments || 0);
    tr.innerHTML = `
      <td class="pr-3"><a href="${p.permalink || "#"}" target="_blank" rel="noreferrer"><div class="w-10 h-10 rounded-md overflow-hidden bg-black/40 border border-white/5">${src ? `<img src="${src}" class="w-full h-full object-cover" onerror="this.style.display='none'"/>` : ""}</div></a></td>
      <td class="px-3 text-slate-300 max-w-md">${caption || '<span class="text-slate-500">—</span>'}</td>
      <td class="px-3"><span class="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/5">${p.mediaType || "Post"}</span></td>
      <td class="px-3 text-right">${hasLive ? fmt(p.likes) : '<span class="text-slate-600">—</span>'}</td>
      <td class="px-3 text-right">${hasLive ? fmt(p.comments) : '<span class="text-slate-600">—</span>'}</td>
      <td class="px-3 text-right ${eng > 0 ? "text-fuchsia-300 font-semibold" : "text-slate-600"}">${eng > 0 ? fmt(eng) : "—"}</td>
      <td class="pl-3 text-right text-slate-400 whitespace-nowrap">${fmtDate(p.timestamp)}</td>`;
    tbody.appendChild(tr);
  });
  $("posts-table-count").textContent = rows.length;
}

// override renderPostsTable + renderMergedPostsTable to use the new state
const _origRenderPostsTable = window.renderPostsTable;
window.renderPostsTable = function (posts) {
  postsTableState.raw = posts.map((p) => ({
    ...p,
    // ensure mediaType exists
    mediaType: p.mediaType || (p.is_video ? "Video" : p.is_carousel ? "Carousel" : "Image"),
  }));
  rerenderPostsTable();
};
// ====================================================
document.addEventListener("DOMContentLoaded", async () => {
  // mode tabs
  document.querySelectorAll(".mode-tab").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode))
  );
  setMode("lookup");
  updateWatchlistCount();

  // lookup wiring
  $("lookup-btn").addEventListener("click", doLookup);
  $("lookup-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLookup();
  });

  // watchlist wiring
  $("watchlist-refresh-btn").addEventListener("click", refreshWatchlistAll);
  $("watchlist-export-btn").addEventListener("click", exportWatchlistCsv);
  $("watchlist-add-btn").addEventListener("click", async () => {
    const u = $("watchlist-add-input").value.trim().replace(/^@+/, "");
    if (!u) return;
    if (addToWatchlist(u)) {
      $("watchlist-add-input").value = "";
      // immediately fetch + snapshot
      try {
        const r = await fetch(`/api/lookup?username=${encodeURIComponent(u)}`);
        const data = await r.json();
        if (r.ok && data.available) recordSnapshot(data);
      } catch {}
      renderWatchlist();
    }
  });
  $("watchlist-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("watchlist-add-btn").click();
  });
  // AI panel
  initAiPanel();
  // welcome / theme / history / print
  initWelcomeFlow();
  initThemePicker();
  initAiHistoryDrawer();
  initCmdkPalette();
  initPostsTableControls();
  $("export-pdf-btn").addEventListener("click", () => window.print());

  // dashboard action bar
  $("dashboard-refresh-btn").addEventListener("click", () => {
    if (window.__lastLookup?.username) {
      $("lookup-input").value = window.__lastLookup.username;
      doLookup();
    }
  });
  $("reel-ideas-refresh").addEventListener("click", () => {
    if (window.__lastReelIdeas) {
      renderReelIdeas(window.__lastReelIdeas.posts, window.__lastReelIdeas.profile);
    }
  });
  $("collab-refresh").addEventListener("click", refreshSimilarAccounts);
  $("related-refresh").addEventListener("click", refreshSimilarAccounts);

  $("detail-close").addEventListener("click", () => $("watchlist-detail").classList.add("hidden"));
  $("detail-log-btn").addEventListener("click", () => {
    $("detail-log-form").classList.toggle("hidden");
    if (!$("detail-log-form").classList.contains("hidden")) {
      $("log-date").value = new Date().toISOString().slice(0, 10);
      $("log-reach").focus();
    }
  });
  $("log-cancel-btn").addEventListener("click", () => $("detail-log-form").classList.add("hidden"));
  $("log-save-btn").addEventListener("click", saveManualEntry);

  // compare wiring
  $("compare-add-btn").addEventListener("click", () => {
    const u = $("compare-input").value.trim().replace(/^@+/, "");
    if (u) {
      addToCompare(u);
      $("compare-input").value = "";
    }
  });
  $("compare-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("compare-add-btn").click();
  });

  // FB SDK auto-init if App ID saved
  const savedAppId = getAppId();
  const savedConfigId = getConfigId();
  if (savedAppId) {
    $("appid-input").value = savedAppId;
    try {
      await loadFbSdk(savedAppId);
    } catch (e) {
      console.warn(e);
    }
  }
  if (savedConfigId) $("configid-input").value = savedConfigId;

  $("save-appid-btn").addEventListener("click", async () => {
    const id = $("appid-input").value.trim();
    const configId = $("configid-input").value.trim();
    if (!/^\d{6,}$/.test(id)) {
      showLiveError("App ID should be a long numeric string (top of your Meta app dashboard).");
      return;
    }
    if (configId && !/^\d{6,}$/.test(configId)) {
      showLiveError("Config ID should also be a long numeric string.");
      return;
    }
    setAppId(id);
    setConfigId(configId);
    hideLiveError();
    try {
      await loadFbSdk(id);
      $("save-appid-btn").textContent = "Credentials saved ✓";
      setTimeout(() => ($("save-appid-btn").textContent = "Save credentials"), 1800);
    } catch (e) {
      showLiveError(e.message);
    }
  });

  $("fb-login-btn").addEventListener("click", async () => {
    try {
      hideLiveError();
      if (!getAppId()) {
        showLiveError("Save your Meta App ID first.");
        return;
      }
      if (!fbSdkReady) await loadFbSdk(getAppId());
      showLoading("Opening Facebook login…");
      const token = await fbLogin();
      hideLoading();
      await loadLiveDashboard(token);
    } catch (e) {
      hideLoading();
      $("live-panel").classList.remove("hidden");
      showLiveError(e.message);
    }
  });

  $("fb-logout-btn").addEventListener("click", async () => {
    await fbLogout();
    $("dashboard").classList.add("hidden");
    $("live-panel").classList.remove("hidden");
    $("fb-logout-btn").classList.add("hidden");
    setConnected(false);
  });

  // export drop zone
  const input = $("file-input");
  const drop = $("drop-zone");
  input.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  });
  // server-side path parse
  $("export-path-btn").addEventListener("click", parseExportFromPath);
  $("export-path-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") parseExportFromPath();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("ring-2", "ring-fuchsia-400/40", "bg-black/40");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("ring-2", "ring-fuchsia-400/40", "bg-black/40");
    })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  $("reset-btn").addEventListener("click", () => {
    setMode(currentMode);
    resetUI();
  });

  initConceptStudio();
  initMetaConnectWizard();
});

// ============================================================
// INSTAGRAM LOGIN (preferred Live API flow)
// ============================================================
// Direct Instagram OAuth — bypasses the Facebook Page linkage that the
// legacy FB Login flow required. The instagram_business_basic scope
// works WITHOUT Meta Business Verification, so this path unblocks
// brand-new apps that hit the "verification pending" wall.
//
// Flow:
//   1) Click → redirect to https://www.instagram.com/oauth/authorize
//   2) User approves → IG redirects back to current origin with ?code=…
//   3) Page-load detects the code, posts it to /api/instagram/exchange
//      (server side because client_secret can't be in JS)
//   4) Server returns long-lived (60-day) access_token
//   5) Frontend stores token + fetches profile via graph.instagram.com
// ============================================================

const LS_IG_APP_ID = "ig_direct_app_id_v1";
const LS_IG_APP_SECRET = "ig_direct_app_secret_v1";
const LS_IG_TOKEN = "ig_direct_token_v1";
const LS_IG_USER_ID = "ig_direct_user_id_v1";
const LS_IG_STATE = "ig_direct_oauth_state_v1";

const IG_GRAPH = "https://graph.instagram.com";
const IG_OAUTH_URL = "https://www.instagram.com/oauth/authorize";
// Default scope — instagram_business_basic doesn't require Business Verification
const IG_SCOPES = "instagram_business_basic,instagram_business_manage_insights";

function igDirectGetConfig() {
  return {
    appId: localStorage.getItem(LS_IG_APP_ID) || "",
    appSecret: localStorage.getItem(LS_IG_APP_SECRET) || "",
  };
}
function igDirectSaveConfig(appId, appSecret) {
  localStorage.setItem(LS_IG_APP_ID, appId);
  if (appSecret) localStorage.setItem(LS_IG_APP_SECRET, appSecret);
  igDirectRefreshConfigStatus();
}
function igDirectGetToken() {
  return {
    token: localStorage.getItem(LS_IG_TOKEN) || "",
    userId: localStorage.getItem(LS_IG_USER_ID) || "",
  };
}
function igDirectSaveToken(token, userId) {
  localStorage.setItem(LS_IG_TOKEN, token);
  if (userId) localStorage.setItem(LS_IG_USER_ID, String(userId));
}
function igDirectClearToken() {
  localStorage.removeItem(LS_IG_TOKEN);
  localStorage.removeItem(LS_IG_USER_ID);
}

function igRedirectUri() {
  // OAuth redirects strip hash fragments but keep the path — point back at the page root
  return location.origin + "/";
}

function igDirectRefreshConfigStatus() {
  const cfg = igDirectGetConfig();
  const pill = $("ig-direct-config-status");
  if (!pill) return;
  if (cfg.appId && cfg.appSecret) {
    pill.textContent = "Configured";
    pill.className = "ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-200";
  } else if (cfg.appId || cfg.appSecret) {
    pill.textContent = "Incomplete";
    pill.className = "ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-200";
  } else {
    pill.textContent = "Empty";
    pill.className = "ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-400";
  }
  // populate redirect hint
  const hint = $("ig-direct-redirect-hint");
  if (hint) hint.innerHTML = `Use this redirect URI in your Meta App: <code class="bg-black/40 px-1 rounded text-fuchsia-200">${igRedirectUri()}</code>`;
}

function igDirectShowError(msg) {
  const box = $("ig-direct-error");
  if (!box) return;
  box.classList.remove("hidden");
  box.textContent = msg;
}
function igDirectHideError() {
  $("ig-direct-error")?.classList.add("hidden");
}

function igDirectUpdateUIForToken() {
  const { token } = igDirectGetToken();
  const loginBtn = $("ig-direct-login-btn");
  const logoutBtn = $("ig-direct-logout-btn");
  const status = $("ig-direct-status");
  if (token) {
    loginBtn?.classList.add("hidden");
    logoutBtn?.classList.remove("hidden");
    if (status) status.innerHTML = `<span class="inline-flex items-center gap-1 text-emerald-300"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Signed in</span>`;
  } else {
    loginBtn?.classList.remove("hidden");
    logoutBtn?.classList.add("hidden");
    if (status) status.textContent = "";
  }
}

function igStartOAuth() {
  const cfg = igDirectGetConfig();
  if (!cfg.appId) {
    igDirectShowError("Instagram App ID missing. Expand the config section above and paste your Instagram App ID + Secret.");
    $("ig-direct-config")?.setAttribute("open", "");
    $("ig-direct-app-id")?.focus();
    return;
  }
  if (!cfg.appSecret) {
    igDirectShowError("Instagram App Secret missing. Expand the config section above and paste it.");
    $("ig-direct-config")?.setAttribute("open", "");
    $("ig-direct-app-secret")?.focus();
    return;
  }
  // CSRF protection
  const state = (crypto.getRandomValues(new Uint32Array(2)).join("-"));
  sessionStorage.setItem(LS_IG_STATE, state);

  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: igRedirectUri(),
    response_type: "code",
    scope: IG_SCOPES,
    state,
  });
  location.href = `${IG_OAUTH_URL}?${params.toString()}`;
}

async function igExchangeCode(code) {
  const cfg = igDirectGetConfig();
  const res = await fetch("/api/instagram/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: igRedirectUri(),
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function igGraphCall(path, params = {}) {
  const { token } = igDirectGetToken();
  if (!token) throw new Error("Not signed in");
  const url = new URL(`${IG_GRAPH}/v22.0/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

async function igLoadDashboardViaDirectToken() {
  igDirectHideError();
  showLoading("Fetching your Instagram profile…");
  try {
    // /me with the Instagram Login API
    const profile = await igGraphCall("me", {
      fields: "id,user_id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,account_type",
    });
    showLoading("Fetching recent posts…");
    let media = [];
    try {
      const m = await igGraphCall("me/media", {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
        limit: 25,
      });
      media = m.data || [];
    } catch (e) {
      console.warn("media fetch failed:", e.message);
    }
    let insights = [];
    try {
      const i = await igGraphCall("me/insights", { metric: "reach,profile_views", period: "day" });
      insights = i.data || [];
    } catch {}
    renderLiveDashboard(profile, media, insights);
    hideLoading();
    $("dashboard").classList.remove("hidden");
    setConnected(true, profile.username ? "@" + profile.username : "Instagram");
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    hideLoading();
    igDirectShowError("Couldn't fetch profile: " + e.message);
    // if token expired/invalid, clear it
    if (/oauth|token|invalid|expired/i.test(e.message)) {
      igDirectClearToken();
      igDirectUpdateUIForToken();
    }
  }
}

async function igHandleOAuthCallback() {
  const sp = new URLSearchParams(location.search);
  const code = sp.get("code");
  const state = sp.get("state");
  const error = sp.get("error");
  if (error) {
    igDirectShowError("Instagram returned an error: " + (sp.get("error_description") || error));
    history.replaceState(null, "", location.pathname);
    return;
  }
  if (!code) return;
  const expected = sessionStorage.getItem(LS_IG_STATE);
  if (state && expected && state !== expected) {
    igDirectShowError("OAuth state mismatch — possible CSRF. Try signing in again.");
    history.replaceState(null, "", location.pathname);
    return;
  }
  sessionStorage.removeItem(LS_IG_STATE);
  // exchange
  setMode("live");
  igDirectShowError(""); igDirectHideError();
  showLoading("Exchanging Instagram code for token…");
  try {
    const { access_token, user_id } = await igExchangeCode(code);
    igDirectSaveToken(access_token, user_id);
    history.replaceState(null, "", location.pathname);
    igDirectUpdateUIForToken();
    await igLoadDashboardViaDirectToken();
  } catch (e) {
    hideLoading();
    igDirectShowError("Token exchange failed: " + e.message);
    history.replaceState(null, "", location.pathname);
  }
}

function initInstagramDirectLogin() {
  if (!$("ig-direct-login")) return;
  // hydrate inputs
  const cfg = igDirectGetConfig();
  if ($("ig-direct-app-id")) $("ig-direct-app-id").value = cfg.appId;
  if ($("ig-direct-app-secret")) $("ig-direct-app-secret").value = cfg.appSecret;
  igDirectRefreshConfigStatus();
  igDirectUpdateUIForToken();

  $("ig-direct-save")?.addEventListener("click", () => {
    const id = $("ig-direct-app-id").value.trim();
    const secret = $("ig-direct-app-secret").value.trim();
    if (!/^\d{4,}$/.test(id)) {
      igDirectShowError("App ID should be a numeric string from the Meta App dashboard.");
      return;
    }
    if (!secret || secret.length < 16) {
      igDirectShowError("App Secret looks too short. It should be a long hex string.");
      return;
    }
    igDirectSaveConfig(id, secret);
    igDirectHideError();
    const btn = $("ig-direct-save");
    const orig = btn.textContent;
    btn.textContent = "Saved ✓";
    setTimeout(() => (btn.textContent = orig), 1500);
  });

  $("ig-direct-login-btn")?.addEventListener("click", () => {
    igDirectHideError();
    igStartOAuth();
  });
  $("ig-direct-logout-btn")?.addEventListener("click", () => {
    igDirectClearToken();
    igDirectUpdateUIForToken();
    $("dashboard").classList.add("hidden");
    setConnected(false);
  });

  // Handle OAuth callback if we're returning from instagram.com
  if (location.search.includes("code=") || location.search.includes("error=")) {
    igHandleOAuthCallback();
  } else {
    // If a token is already saved, auto-load when the live panel opens
    const { token } = igDirectGetToken();
    if (token && currentMode === "live") {
      // delay so UI is ready
      setTimeout(() => igLoadDashboardViaDirectToken(), 300);
    }
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initInstagramDirectLogin);
} else {
  initInstagramDirectLogin();
}

// ============================================================
// LIVE API · verification-pending banner
// ============================================================
// Flip this to false (or remove the banner element from index.html) once
// Meta Business Verification completes and the Live API works publicly.
const PULSE_LIVE_VERIFICATION_STATUS = "pending"; // "pending" | "verified"

function initLiveVerificationBanner() {
  const banner = $("live-verification-banner");
  if (!banner) return;
  const dismissedThisSession = sessionStorage.getItem("ig_live_banner_dismissed_v1") === "1";
  if (PULSE_LIVE_VERIFICATION_STATUS === "pending" && !dismissedThisSession) {
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
  $("live-verification-dismiss")?.addEventListener("click", () => {
    banner.classList.add("hidden");
    sessionStorage.setItem("ig_live_banner_dismissed_v1", "1");
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLiveVerificationBanner);
} else {
  initLiveVerificationBanner();
}

// ============================================================
// META CONNECT WIZARD
// ============================================================
// Walks the user through: HTTPS tunnel → Meta app config →
// App ID input → Facebook login.
// ============================================================

const wizardState = {
  tunnelUrl: null,
  pollTimer: null,
  metaAck: false, // user confirmed they pasted the URLs into Meta dashboard
};

function setWizardPill(stepEl, kind, label) {
  if (!stepEl) return;
  stepEl.className = "wizard-pill " + ({ idle: "wizard-pill-idle", active: "wizard-pill-active", done: "wizard-pill-done", error: "wizard-pill-error" }[kind] || "wizard-pill-idle");
  stepEl.textContent = label;
}
function setStepDone(num, done) {
  const el = document.querySelector(`.wizard-step[data-step="${num}"]`);
  if (!el) return;
  el.classList.toggle("done", !!done);
}

function updateWizardPasteCards(tunnelUrl) {
  const base = tunnelUrl ? tunnelUrl.replace(/\/$/, "") : "(start the tunnel above first)";
  const host = tunnelUrl ? new URL(tunnelUrl).hostname : "(your-tunnel).trycloudflare.com";
  const setVal = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  setVal("wizard-paste-domain", host);
  setVal("wizard-paste-privacy", tunnelUrl ? `${base}/privacy` : "(start tunnel first)/privacy");
  setVal("wizard-paste-terms", tunnelUrl ? `${base}/terms` : "(start tunnel first)/terms");
  setVal("wizard-paste-redirect", tunnelUrl ? `${base}/` : "(start tunnel first)/");
}

async function pollTunnelStatus() {
  try {
    const r = await fetch("/api/tunnel/status");
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function applyTunnelStatus(s) {
  if (!s) return;
  const pill = $("wizard-tunnel-status");
  const result = $("wizard-tunnel-result");
  const urlInput = $("wizard-tunnel-url");
  const openLink = $("wizard-tunnel-open");
  const stopBtn = $("wizard-tunnel-stop");
  const startBtn = $("wizard-tunnel-start");
  const uptime = $("wizard-tunnel-uptime");
  const errBox = $("wizard-tunnel-error");

  if (s.status === "running" && s.url) {
    wizardState.tunnelUrl = s.url;
    setWizardPill(pill, "done", s.provider ? `Live · ${s.provider}` : "Running");
    setStepDone(1, true);
    result.classList.remove("hidden");
    urlInput.value = s.url;
    openLink.href = s.url;
    stopBtn.classList.remove("hidden");
    startBtn.classList.add("hidden");
    if (s.uptime) {
      uptime.classList.remove("hidden");
      uptime.textContent = `up ${s.uptime}s${s.provider ? " · " + s.provider : ""}`;
    }
    updateWizardPasteCards(s.url);
    errBox.classList.add("hidden");
  } else if (s.status === "starting") {
    setWizardPill(pill, "active", "Starting…");
    setStepDone(1, false);
    stopBtn.classList.remove("hidden");
    startBtn.classList.add("hidden");
  } else if (s.status === "error") {
    setWizardPill(pill, "error", "Error");
    setStepDone(1, false);
    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    errBox.classList.remove("hidden");
    errBox.textContent = s.error || "Tunnel failed to start.";
  } else {
    // stopped
    wizardState.tunnelUrl = null;
    setWizardPill(pill, "idle", "Not started");
    setStepDone(1, false);
    result.classList.add("hidden");
    stopBtn.classList.add("hidden");
    startBtn.classList.remove("hidden");
    uptime.classList.add("hidden");
    updateWizardPasteCards(null);
  }
}

function startTunnelPolling() {
  if (wizardState.pollTimer) return;
  wizardState.pollTimer = setInterval(async () => {
    const s = await pollTunnelStatus();
    applyTunnelStatus(s);
    if (s && s.status === "running") {
      // can stop polling once we have a stable URL
      // (keep slow heartbeat to detect manual drops)
    }
  }, 3000);
}

function refreshCredsPill() {
  const appId = $("appid-input").value.trim();
  const ok = /^\d{6,}$/.test(appId);
  setWizardPill($("wizard-creds-status"), ok ? "done" : "idle", ok ? "Saved" : "Empty");
  setStepDone(3, ok);
}

// translate Meta SDK / Graph errors into actionable next-step text
function explainOAuthError(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("url") && m.includes("not whitelisted")) {
    return "The redirect URL you're loading from isn't in your Meta app's allowed list. Reload through the HTTPS tunnel URL from Step 1 and confirm it's pasted into 'Valid OAuth Redirect URIs'.";
  }
  if (m.includes("login window closed") || m.includes("popup")) {
    return "Browser blocked the popup, or you closed it. Allow popups for this site and click Continue again.";
  }
  if (m.includes("declined") || m.includes("permissions")) {
    return "Approve the Instagram + Pages permissions when Facebook asks. If you accidentally declined, click Continue and re-grant.";
  }
  if (m.includes("invalid app id") || m.includes("app id")) {
    return "Double-check the App ID — it should be a long number from the top of your Meta app dashboard.";
  }
  if (m.includes("none has instagram linked") || m.includes("requires your ig")) {
    return "Open Instagram → Settings → Account → switch to Professional (Business/Creator) and link it to a Facebook Page you admin.";
  }
  if (m.includes("missing pages_show_list")) {
    return "Your app is missing the pages_show_list permission. Add 'Facebook Login for Business' product in your Meta dashboard.";
  }
  if (m.includes("rate limited") || m.includes("rate-limit")) {
    return "Meta is throttling you — wait 1-2 minutes and try again.";
  }
  return "Open the wizard's setup steps and verify each piece (especially the redirect URI matches what you pasted in Step 2).";
}

function showLiveErrorWithHint(msg) {
  $("live-error-box").classList.remove("hidden");
  $("live-error-msg").textContent = msg;
  const hint = $("live-error-hint");
  if (hint) hint.textContent = explainOAuthError(msg);
  setWizardPill($("wizard-connect-status"), "error", "Failed");
}

function isHostedHttpsDeploy() {
  return location.protocol === "https:" &&
    !["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);
}

function initMetaConnectWizard() {
  if (!$("meta-wizard")) return;

  const httpsDeploy = isHostedHttpsDeploy();

  if (httpsDeploy) {
    // On a hosted HTTPS deploy, the tunnel step is unnecessary.
    // Replace Step 1's body with a "Already HTTPS" notice and pre-fill the paste cards.
    const step1 = document.querySelector('.wizard-step[data-step="1"]');
    if (step1) {
      step1.classList.add("done");
      const body = step1.querySelector(".wizard-step-body");
      if (body) {
        body.innerHTML = `
          <div class="flex items-start gap-2 text-xs text-emerald-200 bg-emerald-500/8 border border-emerald-400/25 rounded-lg p-3">
            <i data-lucide="check-circle" class="w-4 h-4 mt-0.5 shrink-0"></i>
            <div>
              <strong>Already HTTPS.</strong> This deployment is on <code class="bg-black/30 px-1 rounded">${escapeHtml(location.hostname)}</code> —
              no tunnel needed. Use Step 2 below to copy the URLs into your Meta App.
            </div>
          </div>`;
      }
      setWizardPill($("wizard-tunnel-status"), "done", "HTTPS deploy");
    }
    updateWizardPasteCards(location.origin);
  } else {
    // Local-server mode: full tunnel-controls wiring.
    updateWizardPasteCards(null);

    $("wizard-tunnel-start").addEventListener("click", async () => {
      setWizardPill($("wizard-tunnel-status"), "active", "Starting…");
      $("wizard-tunnel-error").classList.add("hidden");
      try {
        const r = await fetch("/api/tunnel/start", { method: "POST" });
        const s = await r.json();
        applyTunnelStatus(s);
        startTunnelPolling();
        if (s.status !== "running") {
          const interval = setInterval(async () => {
            const st = await pollTunnelStatus();
            applyTunnelStatus(st);
            if (st && (st.status === "running" || st.status === "error" || st.status === "stopped")) clearInterval(interval);
          }, 1000);
        }
      } catch (e) {
        setWizardPill($("wizard-tunnel-status"), "error", "Error");
        $("wizard-tunnel-error").classList.remove("hidden");
        $("wizard-tunnel-error").textContent = "Failed to talk to the local server: " + e.message;
      }
    });

    $("wizard-tunnel-stop").addEventListener("click", async () => {
      try {
        const r = await fetch("/api/tunnel/stop", { method: "POST" });
        const s = await r.json();
        applyTunnelStatus(s);
      } catch {}
    });

    $("wizard-tunnel-copy").addEventListener("click", () => {
      const v = $("wizard-tunnel-url").value;
      if (v) {
        navigator.clipboard.writeText(v).catch(() => {});
        flash("wizard-tunnel-copy", "Copied ✓");
      }
    });

    // initial state: poll once on load to discover already-running tunnel
    pollTunnelStatus().then(applyTunnelStatus);
  }

  // paste-card copy buttons
  document.querySelectorAll(".wizard-paste-copy").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.copy;
      const el = document.getElementById(target);
      if (!el) return;
      const txt = el.textContent || "";
      if (txt && !txt.startsWith("(")) {
        navigator.clipboard.writeText(txt).catch(() => {});
        const orig = btn.innerHTML;
        btn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i>`;
        if (window.lucide) window.lucide.createIcons();
        setTimeout(() => { btn.innerHTML = orig; if (window.lucide) window.lucide.createIcons(); }, 1100);
      }
    });
  });

  // creds pill react to input
  $("appid-input").addEventListener("input", refreshCredsPill);

  refreshCredsPill();
  if (window.lucide) window.lucide.createIcons();

  // step 2 marker: when user has pasted URLs into Meta + step 1 done, step 2 is implicitly ready.
  // We watch for App ID save → mark step 2 done as best-effort.
  $("save-appid-btn").addEventListener("click", () => {
    setTimeout(() => {
      refreshCredsPill();
      // if step 1 is done and creds are saved, presume step 2 also done
      if (document.querySelector('.wizard-step[data-step="1"]')?.classList.contains("done")) {
        setStepDone(2, true);
        setWizardPill($("wizard-meta-status"), "done", "Done");
      }
    }, 100);
  });

  // wrap login button → mark step 4 active/done
  const origLoginHandler = $("fb-login-btn").onclick;
  $("fb-login-btn").addEventListener("click", () => {
    setWizardPill($("wizard-connect-status"), "active", "Connecting…");
  }, true);
}

// patch showLiveError to also show the friendly hint
(function patchShowLiveError() {
  if (typeof showLiveError !== "function") return;
  const orig = showLiveError;
  window.showLiveError = function (msg) {
    orig.apply(this, arguments);
    showLiveErrorWithHint(msg);
  };
})();

// ============================================================
// CONCEPT STUDIO
// ============================================================
// Lets the user pick 1+ accounts they've looked up and generates
// content concepts (Reels / Carousels / Photos / Stories) tailored
// to those accounts' followers, audience, top posts, hashtags, and
// posting cadence — each with a realistic view-range estimate.
// ============================================================

const LS_CONCEPT_HISTORY = "ig_concept_history_v1";
const CONCEPT_HISTORY_CAP = 30;

const CONCEPT_STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by","from",
  "is","are","was","were","be","been","being","this","that","these","those","it","its",
  "i","my","me","you","your","we","our","us","they","them","their","he","she","his","her",
  "what","when","where","who","how","why","which","not","no","yes","just","so","as","if",
  "more","most","than","then","there","here","very","also","like","get","got","go","going",
  "make","made","do","did","does","done","new","now","up","down","out","over","into","about",
  "would","could","should","will","can","cant","won","dont","im","you're","ive","one","two","three","etc",
  "all","some","any","each","every","day","week","month","year","today","tomorrow","yesterday"
]);

const conceptStudioState = {
  selected: new Set(),         // usernames currently selected
  filters: {
    format: new Set(["reel","carousel","photo"]),
    tone: new Set(["educational","entertaining"]),
    ambition: new Set(["safe","growth"]),
    minViews: 0,               // single-value filter
    tier: "all",               // single-value filter
  },
  lastResults: null,           // last generated concept list (for copy-all)
  serverCacheLoaded: false,    // whether we've fetched /api/cache/list
  groupBy: "none",
  engine: "rules",             // "rules" or "ai"
};

// Pull the AI provider/key/model the user already configured in the AI panel.
// Returns null if no usable key exists.
function getAiCreds() {
  const provider = localStorage.getItem("ig_ai_provider_v1") || "gemini";
  const key = localStorage.getItem(`ig_ai_key_${provider}_v1`) || localStorage.getItem("ig_ai_key_v1") || "";
  const model = localStorage.getItem(`ig_ai_model_${provider}_v1`) ||
    (typeof AI_MODELS !== "undefined" ? AI_MODELS[provider]?.[0]?.id : "");
  if (!key || !model || !provider) return null;
  return { provider, key, model };
}

function aiProviderLabel(provider) {
  return ({ gemini: "Gemini", groq: "Groq", openai: "OpenAI", anthropic: "Claude" })[provider] || provider;
}

// ---------- history (persistent) ----------
function loadConceptHistory() {
  try { return JSON.parse(localStorage.getItem(LS_CONCEPT_HISTORY) || "{}"); }
  catch { return {}; }
}
function saveConceptHistory(h) {
  // LRU cap
  const entries = Object.entries(h).sort((a, b) => (b[1].cached_at || 0) - (a[1].cached_at || 0));
  const trimmed = Object.fromEntries(entries.slice(0, CONCEPT_HISTORY_CAP));
  localStorage.setItem(LS_CONCEPT_HISTORY, JSON.stringify(trimmed));
  updateConceptsCount();
}
function updateConceptsCount() {
  const h = loadConceptHistory();
  const n = Object.keys(h).length;
  const pill = $("concepts-count");
  if (!pill) return;
  if (n > 0) { pill.textContent = n; pill.classList.remove("hidden"); }
  else pill.classList.add("hidden");
}
function recordConceptSource(d) {
  if (!d || !d.username) return;
  const h = loadConceptHistory();
  const key = d.username.toLowerCase();
  // store a compact snapshot — only what the engine needs
  h[key] = {
    username: d.username,
    full_name: d.full_name || "",
    biography: d.biography || "",
    category: d.category || "",
    is_business: !!d.is_business,
    is_verified: !!d.is_verified,
    followers: d.followers || 0,
    following: d.following || 0,
    posts_count: d.posts_count || 0,
    profile_pic_url: d.profile_pic_url || "",
    cached_at: Math.floor(Date.now() / 1000),
    posts: (d.posts || []).map(p => ({
      likes: p.likes || 0,
      comments: p.comments || 0,
      caption: (p.caption || "").slice(0, 600),
      media_type: p.media_type || (p.is_video ? "VIDEO" : "IMAGE"),
      is_video: !!p.is_video,
      is_carousel: !!p.is_carousel || p.media_type === "CAROUSEL_ALBUM",
      timestamp: p.timestamp || 0,
    })),
  };
  saveConceptHistory(h);
}

// ---------- analysis primitives ----------
function tokenizeCaption(caption) {
  if (!caption) return [];
  return caption
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#]/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 24 && !w.startsWith("#") && !CONCEPT_STOPWORDS.has(w));
}
function extractHashtags(caption) {
  if (!caption) return [];
  const matches = caption.match(/#[\p{L}\p{N}_]{2,40}/gu) || [];
  return matches.map(t => t.toLowerCase());
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function topN(map, n) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function analyzeAccount(acc) {
  const posts = acc.posts || [];
  const totalPosts = posts.length;
  const likes = posts.map(p => p.likes || 0);
  const comments = posts.map(p => p.comments || 0);

  const medianLikes = median(likes);
  const medianComments = median(comments);
  const avgEngagement = totalPosts
    ? likes.reduce((s, x) => s + x, 0) / totalPosts + comments.reduce((s, x) => s + x, 0) / totalPosts
    : 0;
  const er = acc.followers ? (avgEngagement / acc.followers) * 100 : 0;

  // top performers (top 30%)
  const sorted = [...posts].sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments));
  const top = sorted.slice(0, Math.max(3, Math.ceil(totalPosts * 0.3)));

  // hashtag frequency (weighted by engagement)
  const hashtagScore = {};
  const keywordScore = {};
  let videoCount = 0, carouselCount = 0, imageCount = 0;

  for (const p of posts) {
    const weight = (p.likes || 0) + (p.comments || 0) + 10;
    extractHashtags(p.caption).forEach(h => hashtagScore[h] = (hashtagScore[h] || 0) + weight);
    tokenizeCaption(p.caption).forEach(w => keywordScore[w] = (keywordScore[w] || 0) + weight);
    if (p.is_video) videoCount++;
    else if (p.is_carousel) carouselCount++;
    else imageCount++;
  }

  // performance by format
  const formatPerf = { reel: [], carousel: [], photo: [] };
  for (const p of posts) {
    const eng = (p.likes || 0) + (p.comments || 0);
    if (p.is_video) formatPerf.reel.push(eng);
    else if (p.is_carousel) formatPerf.carousel.push(eng);
    else formatPerf.photo.push(eng);
  }
  const formatMedian = {
    reel: median(formatPerf.reel),
    carousel: median(formatPerf.carousel),
    photo: median(formatPerf.photo),
  };
  // strongest format = highest median, but require at least 2 samples
  let strongestFormat = "reel";
  let bestMed = 0;
  for (const f of ["reel", "carousel", "photo"]) {
    if (formatPerf[f].length >= 2 && formatMedian[f] > bestMed) {
      bestMed = formatMedian[f];
      strongestFormat = f;
    }
  }

  // posting cadence (days between posts, last N)
  const ts = posts.map(p => p.timestamp).filter(Boolean).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 86400);
  const medianGap = median(gaps);

  // best posting hour bucket
  const hourBuckets = Array(24).fill(0);
  const hourCounts = Array(24).fill(0);
  for (const p of posts) {
    if (!p.timestamp) continue;
    const h = new Date(p.timestamp * 1000).getHours();
    hourBuckets[h] += (p.likes || 0) + (p.comments || 0);
    hourCounts[h]++;
  }
  let bestHour = 18, bestScore = 0;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] >= 1) {
      const avg = hourBuckets[h] / hourCounts[h];
      if (avg > bestScore) { bestScore = avg; bestHour = h; }
    }
  }

  return {
    account: acc,
    totalPosts,
    medianLikes,
    medianComments,
    engagementRate: er,
    top,
    hashtagScore,
    keywordScore,
    formatMix: { video: videoCount, carousel: carouselCount, image: imageCount },
    formatMedian,
    strongestFormat,
    medianGap,
    bestHour,
    topHashtags: topN(hashtagScore, 8).map(([h]) => h),
    topKeywords: topN(keywordScore, 12).map(([k]) => k),
  };
}

// ---------- view estimator ----------
// Returns { low, mid, high } predicted views for a concept on a given account.
// Heuristic, not a model — based on follower-reach norms + engagement-rate signal.
function estimateViews(analysis, format, ambition) {
  const F = analysis.account.followers || 0;
  const E = analysis.engagementRate / 100;     // 0..1
  const L = analysis.medianLikes || 0;

  // base reach to followers (fraction of followers who see it)
  // Instagram norms (2025-ish industry rules of thumb):
  //   feed photo: 25-35% of followers
  //   carousel:   30-45% (algo boost for multi-slide)
  //   reel:       70-150% (often exceeds follower count via discover)
  //   story:      10-20%
  const baseReachFrac = { photo: 0.30, carousel: 0.40, reel: 0.95, story: 0.16 }[format] || 0.30;
  const ownReach = F * baseReachFrac;

  // engagement quality multiplier — high ER accounts get more discover-feed pickup
  // ER 1% → 1.0×, 3% → 1.3×, 6%+ → 1.6×
  const erBoost = 1 + Math.min(0.6, E * 10);

  // tail (off-account reach for reels especially)
  const tailMult = { photo: 0.10, carousel: 0.20, reel: 1.20, story: 0.02 }[format] || 0.10;
  const tail = F * tailMult * erBoost;

  // base mid estimate
  let mid = ownReach * erBoost + tail;

  // fall back to engagement-derived view count for very small accounts where formulas break
  if (L > 0 && mid < L * 4) {
    // typical view-to-like ratio: reel ~30:1, photo ~12:1, carousel ~18:1
    const viewPerLike = { reel: 30, carousel: 18, photo: 12, story: 8 }[format] || 18;
    mid = Math.max(mid, L * viewPerLike);
  }

  // ambition shifts the range
  const ambMult = { safe: 1.0, growth: 1.5, viral: 4.0 }[ambition] || 1.0;
  mid *= ambMult;

  // low/high spread — bigger for reels + viral ambition
  const spread = { reel: 0.45, carousel: 0.32, photo: 0.28, story: 0.22 }[format] || 0.3;
  const viralKick = ambition === "viral" ? 3.0 : (ambition === "growth" ? 1.4 : 1.0);

  return {
    low: Math.max(50, Math.round(mid * (1 - spread))),
    mid: Math.round(mid),
    high: Math.round(mid * (1 + spread) * viralKick),
  };
}

// ---------- concept templates ----------
// Each template returns { title, hook, why, format, tone, hashtags, ambition }
// or null if it doesn't fit the inputs.
const CONCEPT_TEMPLATES = [
  // ----- educational -----
  (a) => a.topKeywords.length >= 2 && {
    title: `5 things nobody tells you about ${a.topKeywords[0]}`,
    hook: `"I wish someone told me this when I started with ${a.topKeywords[0]}…"`,
    why: `${a.account.username}'s top posts revolve around ${a.topKeywords.slice(0, 3).join(", ")} — list-format Reels in this niche convert because viewers screenshot them.`,
    format: "reel", tone: "educational", ambition: "safe",
    hashtags: a.topHashtags.slice(0, 5),
  },
  (a) => a.topKeywords.length >= 1 && {
    title: `The ${a.topKeywords[0]} mistake costing you results`,
    hook: `Stop scrolling — you're doing ${a.topKeywords[0]} wrong.`,
    why: `Mistake-callout Reels hit because the negative framing triggers loss-aversion. Your audience already follows you for ${a.topKeywords[0]}, so they'll save this.`,
    format: "reel", tone: "educational", ambition: "growth",
    hashtags: a.topHashtags.slice(0, 5),
  },
  (a) => a.topKeywords.length >= 3 && {
    title: `Beginner's guide: ${a.topKeywords[0]} in 60 seconds`,
    hook: `Everything I learned about ${a.topKeywords[0]} in my first year — compressed.`,
    why: `Saves & shares are highest on definitive-guide Carousels. ${a.account.username}'s ${a.formatMix.carousel} prior carousels show your audience already engages with this format.`,
    format: "carousel", tone: "educational", ambition: "safe",
    hashtags: a.topHashtags.slice(0, 5),
  },
  // ----- entertaining -----
  (a) => a.topKeywords.length >= 1 && {
    title: `POV: you just discovered ${a.topKeywords[0]}`,
    hook: `*camera shake* "wait, this changes everything"`,
    why: `POV Reels are #1 for non-follower reach in 2025 — algorithm pushes them to the discover feed.`,
    format: "reel", tone: "entertaining", ambition: "growth",
    hashtags: ["#pov", "#fyp", ...a.topHashtags.slice(0, 3)],
  },
  (a) => a.engagementRate > 1.5 && {
    title: `Day in the life: ${a.account.full_name || a.account.username}`,
    hook: `7:14am — Coffee. Then the chaos begins.`,
    why: `Your ${a.engagementRate.toFixed(1)}% engagement rate means your audience is invested in *you*, not just your topic. DITL content compounds that.`,
    format: "reel", tone: "entertaining", ambition: "safe",
    hashtags: ["#dayinmylife", "#routine", ...a.topHashtags.slice(0, 3)],
  },
  (a) => a.top.length >= 1 && {
    title: `Reading mean comments on my top post`,
    hook: `Someone really said this. I had to share.`,
    why: `Self-deprecating reaction Reels generate massive comment volume — comments compound to feed pickup. Your top post already proved the audience cares.`,
    format: "reel", tone: "entertaining", ambition: "viral",
    hashtags: ["#reactions", "#comments", ...a.topHashtags.slice(0, 3)],
  },
  // ----- inspiring -----
  (a) => a.account.followers > 1000 && {
    title: `From 0 to ${fmt(a.account.followers)} — the honest version`,
    hook: `What worked. What didn't. What I'd skip if I started over.`,
    why: `Origin-story Carousels build deep parasocial trust — they're the #1 driver of follower → customer conversion for ${a.account.is_business ? "business" : "creator"} accounts.`,
    format: "carousel", tone: "inspiring", ambition: "growth",
    hashtags: ["#journey", "#milestone", ...a.topHashtags.slice(0, 3)],
  },
  (a) => a.topKeywords.length >= 1 && {
    title: `The one thing that changed my approach to ${a.topKeywords[0]}`,
    hook: `For 2 years I did this wrong. Then I tried this.`,
    why: `Single-pivot stories have higher save rates than list content. Your audience already trusts you on ${a.topKeywords[0]}.`,
    format: "reel", tone: "inspiring", ambition: "safe",
    hashtags: a.topHashtags.slice(0, 5),
  },
  // ----- promotional / signature -----
  (a) => a.account.is_business && {
    title: `Behind the product: how we actually make this`,
    hook: `You see the finished version. Here's the messy middle.`,
    why: `Behind-the-scenes content has 2.3× the watch-time of polished promo posts. As a Business account, this also lowers ad-spend per acquisition.`,
    format: "reel", tone: "promotional", ambition: "safe",
    hashtags: ["#behindthescenes", ...a.topHashtags.slice(0, 4)],
  },
  (a) => a.top.length >= 3 && {
    title: `Recreating my top 3 posts — what would you swap?`,
    hook: `Top post = ${fmt(a.top[0].likes + a.top[0].comments)} engagements. Let's analyze why.`,
    why: `Meta-content (content about your content) signals confidence and invites comments — every comment compounds reach.`,
    format: "carousel", tone: "educational", ambition: "growth",
    hashtags: a.topHashtags.slice(0, 5),
  },
  // ----- format-strength-aligned -----
  (a) => a.strongestFormat === "carousel" && {
    title: `The 7-slide framework I use for every ${a.topKeywords[0] || "post"}`,
    hook: `Slide 1 → hook. Slide 7 → CTA. Here's what fills 2–6.`,
    why: `Carousels are your strongest format (${fmt(a.formatMedian.carousel)} median engagement) — leaning in compounds what already works.`,
    format: "carousel", tone: "educational", ambition: "safe",
    hashtags: a.topHashtags.slice(0, 5),
  },
  (a) => a.strongestFormat === "reel" && a.topKeywords.length >= 1 && {
    title: `Trending sound + ${a.topKeywords[0]} = unfair reach`,
    hook: `I matched a trending audio to my niche. Look what happened.`,
    why: `Reels are your strongest format (${fmt(a.formatMedian.reel)} median engagement). Riding a trending sound on top of niche-fit content is the cheapest path to non-follower reach.`,
    format: "reel", tone: "entertaining", ambition: "viral",
    hashtags: ["#trending", ...a.topHashtags.slice(0, 4)],
  },
  // ----- story -----
  (a) => ({
    title: `Poll Story: which of these next?`,
    hook: `2 concept ideas. You vote. I make the winner.`,
    why: `Story polls have the highest reply rate of any format. DMs spike, which the algo reads as a strong-tie signal — your next feed post then gets pushed harder.`,
    format: "story", tone: "promotional", ambition: "safe",
    hashtags: [],
  }),
];

// Multi-account "fusion" templates
const FUSION_TEMPLATES = [
  (analyses) => {
    if (analyses.length < 2) return null;
    const [a, b] = analyses;
    const aKw = a.topKeywords[0];
    const bKw = b.topKeywords[0];
    if (!aKw || !bKw) return null;
    return {
      title: `What ${aKw} can learn from ${bKw} (and vice versa)`,
      hook: `Two worlds, same playbook. Here's the overlap nobody's talking about.`,
      why: `Combining ${a.account.username}'s ${aKw}-audience (${fmt(a.account.followers)}) with ${b.account.username}'s ${bKw}-audience (${fmt(b.account.followers)}) creates a fusion concept — works because both audiences will see it new.`,
      format: "carousel", tone: "educational", ambition: "growth",
      hashtags: [...a.topHashtags.slice(0, 3), ...b.topHashtags.slice(0, 2)],
      multiAccountBoost: 1.4,
    };
  },
  (analyses) => {
    if (analyses.length < 2) return null;
    const total = analyses.reduce((s, a) => s + a.account.followers, 0);
    return {
      title: `Collab Reel: ${analyses.map(a => "@" + a.account.username).join(" × ")}`,
      hook: `One topic. ${analyses.length} perspectives. Stitch-style.`,
      why: `Cross-account Reels combine ${fmt(total)} followers and let the algorithm dual-deliver to both audiences. Collab posts have 2-3× the first-hour reach of solo posts.`,
      format: "reel", tone: "entertaining", ambition: "viral",
      hashtags: analyses.flatMap(a => a.topHashtags.slice(0, 2)).slice(0, 6),
      multiAccountBoost: 1.6,
    };
  },
  (analyses) => {
    if (analyses.length < 2) return null;
    const shared = findSharedHashtags(analyses);
    if (!shared.length) return null;
    return {
      title: `${shared[0]} — what works for ${analyses[0].account.username} that you haven't tried`,
      hook: `Same niche. Different approach. Here's the gap.`,
      why: `Both accounts use ${shared.slice(0, 3).join(", ")} — but their engagement profiles diverge. This concept fills the gap.`,
      format: "carousel", tone: "educational", ambition: "growth",
      hashtags: shared.slice(0, 5),
    };
  },
];

function findSharedHashtags(analyses) {
  if (analyses.length < 2) return [];
  const sets = analyses.map(a => new Set(a.topHashtags));
  const first = [...sets[0]];
  return first.filter(h => sets.every(s => s.has(h)));
}

function detectBestThemeAcrossAccounts(analyses) {
  const combined = {};
  for (const a of analyses) {
    for (const [kw, score] of Object.entries(a.keywordScore)) {
      combined[kw] = (combined[kw] || 0) + score;
    }
  }
  const top = topN(combined, 1);
  return top.length ? top[0][0] : "—";
}

// ---------- Viral DNA: hooks, patterns, actions ----------
function extractHooks(analyses, limit = 5) {
  // a "hook" = the first sentence of the highest-engagement captions
  const candidates = [];
  for (const a of analyses) {
    for (const p of a.top) {
      const raw = (p.caption || "").trim();
      if (!raw) continue;
      // first sentence: up to first newline / period / question / exclamation
      let hook = raw.split(/\n|(?<=[.!?])\s/)[0].trim();
      // strip emojis-only lines, urls
      hook = hook.replace(/https?:\/\/\S+/g, "").trim();
      if (hook.length < 12 || hook.length > 180) continue;
      candidates.push({
        text: hook,
        engagement: (p.likes || 0) + (p.comments || 0),
        from: a.account.username,
      });
    }
  }
  candidates.sort((a, b) => b.engagement - a.engagement);
  // dedupe by lowercase prefix
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const k = c.text.toLowerCase().slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

function detectViralPatterns(analyses) {
  const patterns = [];

  // 1) format winner across all
  const fmtSum = { reel: 0, carousel: 0, photo: 0 };
  for (const a of analyses) {
    fmtSum.reel += a.formatMedian.reel || 0;
    fmtSum.carousel += a.formatMedian.carousel || 0;
    fmtSum.photo += a.formatMedian.photo || 0;
  }
  const fmtWinner = Object.entries(fmtSum).sort((a, b) => b[1] - a[1])[0];
  if (fmtWinner[1] > 0) {
    const label = FORMAT_LABEL[fmtWinner[0]];
    patterns.push(`${label}s outperform other formats — median ${fmt(Math.round(fmtWinner[1] / analyses.length))} engagements.`);
  }

  // 2) hashtag overlap (signals niche-cluster strength)
  if (analyses.length >= 2) {
    const shared = findSharedHashtags(analyses);
    if (shared.length) {
      patterns.push(`Shared hashtag cluster: ${shared.slice(0, 4).join(" ")} — niche overlap means cross-pollination is realistic.`);
    }
  } else if (analyses[0].topHashtags.length) {
    patterns.push(`Signature hashtags: ${analyses[0].topHashtags.slice(0, 4).join(" ")} — keep using these for algo trust.`);
  }

  // 3) engagement-rate context (compared to industry norms)
  const avgER = analyses.reduce((s, a) => s + a.engagementRate, 0) / analyses.length;
  if (avgER >= 6) patterns.push(`Engagement rate ${avgER.toFixed(1)}% — top 5% of all accounts. Audience trusts you; lean into deeper content.`);
  else if (avgER >= 3) patterns.push(`Engagement rate ${avgER.toFixed(1)}% — above industry average (~1.5%). You can risk experimental formats.`);
  else if (avgER >= 1) patterns.push(`Engagement rate ${avgER.toFixed(1)}% — healthy band. Hooks and first-3-seconds matter most for you.`);
  else patterns.push(`Engagement rate ${avgER.toFixed(1)}% — below average. Priority: posting more in the strongest format, fewer "filler" posts.`);

  // 4) cadence
  const cadences = analyses.map(a => a.medianGap).filter(g => g > 0);
  if (cadences.length) {
    const avgGap = cadences.reduce((s, x) => s + x, 0) / cadences.length;
    if (avgGap > 7) patterns.push(`Posting cadence: every ${avgGap.toFixed(1)} days — accounts that post 2-3× weekly grow 1.7× faster.`);
    else if (avgGap < 1) patterns.push(`Posting cadence: ${avgGap.toFixed(1)} days between posts — high volume. Quality > quantity now.`);
    else patterns.push(`Posting cadence: every ${avgGap.toFixed(1)} days — healthy rhythm; algorithm trusts you.`);
  }

  // 5) best hour
  const hours = analyses.map(a => a.bestHour);
  if (hours.length) {
    const sorted = [...hours].sort();
    const med = sorted[Math.floor(sorted.length / 2)];
    patterns.push(`Best post window: ~${med}:00 — your audience is most active here.`);
  }
  return patterns.slice(0, 5);
}

function generateMatchedActions(analyses) {
  // concrete to-do items derived from the analyses
  const actions = [];
  const main = analyses[0]; // primary account drives the most personalized actions
  if (!main) return actions;

  // 1) double-down on winning format
  const fmtMap = { reel: "Reels", carousel: "Carousels", photo: "Photos" };
  if (main.strongestFormat && main.formatMedian[main.strongestFormat]) {
    actions.push(`Post 2 more ${fmtMap[main.strongestFormat]} this week — they outperform your other formats.`);
  }

  // 2) recycle a top hook
  if (main.top.length) {
    const top = main.top[0];
    const eng = (top.likes || 0) + (top.comments || 0);
    actions.push(`Recreate your top post (${fmt(eng)} eng) with a new angle — proven hook + new visual = highest expected ceiling.`);
  }

  // 3) niche keyword expansion
  if (main.topKeywords.length >= 2) {
    actions.push(`Build a 3-post mini-series on "${main.topKeywords[0]}" — your audience already searches for this.`);
  }

  // 4) untested format
  const untested = ["reel", "carousel"].find(f => (main.formatMix[f === "reel" ? "video" : "carousel"] || 0) < 2);
  if (untested) actions.push(`Try a ${fmtMap[untested]} — you've barely tested this format and your peers earn ${fmt(main.formatMedian[untested] || 1000)}+ engagements with it.`);

  // 5) posting time
  actions.push(`Schedule your next post at ${main.bestHour}:00 — your historical peak engagement hour.`);

  // 6) multi-account collab
  if (analyses.length >= 2) {
    const second = analyses[1];
    actions.push(`DM @${second.account.username} for a Collab Reel — algorithm dual-delivers to both audiences.`);
  }

  // 7) hashtag refresh
  if (main.topHashtags.length >= 5) {
    actions.push(`Refresh your hashtag mix: keep ${main.topHashtags.slice(0, 2).join(" ")}, retire any tag you haven't used in 60 days.`);
  }

  return actions.slice(0, 6);
}

function tierFor(followers) {
  if (followers < 10000) return "nano";
  if (followers < 100000) return "micro";
  if (followers < 1000000) return "mid";
  return "macro";
}

// ---------- AI-powered concept generator ----------
// Sends the analyses to /api/ai with a structured prompt, parses the JSON
// response, and runs each concept through the local estimateViews() to keep
// the numbers calibrated to the real follower counts.
function buildAiConceptPrompt(analyses, filters, dna) {
  const accountSummaries = analyses.map(a => ({
    username: a.account.username,
    full_name: a.account.full_name,
    followers: a.account.followers,
    posts_count: a.account.posts_count,
    engagement_rate_pct: +a.engagementRate.toFixed(2),
    median_likes: a.medianLikes,
    median_comments: a.medianComments,
    biography: (a.account.biography || "").slice(0, 280),
    category: a.account.category || "",
    is_business: a.account.is_business,
    strongest_format: a.strongestFormat,
    format_mix: a.formatMix,
    top_hashtags: a.topHashtags.slice(0, 10),
    top_keywords: a.topKeywords.slice(0, 12),
    best_post_hour: a.bestHour,
    posting_cadence_days: a.medianGap ? +a.medianGap.toFixed(1) : null,
    top_post_captions: a.top.slice(0, 5).map(p => ({
      engagement: (p.likes || 0) + (p.comments || 0),
      caption: (p.caption || "").slice(0, 240),
      format: p.is_video ? "reel" : (p.is_carousel ? "carousel" : "photo"),
    })),
  }));

  const formats = [...filters.format].join(", ") || "reel, carousel, photo";
  const tones = [...filters.tone].join(", ") || "educational, entertaining";
  const ambitions = [...filters.ambition].join(", ") || "safe, growth";

  const system = [
    "You are a senior Instagram content strategist who has grown multiple accounts to 7-figure followings.",
    "You analyze a set of accounts and propose CONCRETE, NON-GENERIC content concepts that match each account's actual audience and style.",
    "You never propose vague ideas like 'post more reels'. Every concept must have: a specific title, a specific hook, the exact format, suggested hashtags, and a sentence on why it works for THIS account.",
    "You ALWAYS respond with a strict JSON array — no prose, no markdown fence, no explanation. Just the array."
  ].join("\n");

  const fusionNote = analyses.length >= 2
    ? "\n- Include at least 2 FUSION concepts that combine 2+ of the selected accounts (collab Reels, shared-niche carousels, etc.)."
    : "";

  const user = `Generate exactly 10 Instagram content concepts tailored to these accounts:

${JSON.stringify(accountSummaries, null, 2)}

Constraints:
- Allowed formats: ${formats}
- Allowed tones: ${tones}
- Allowed ambition levels: ${ambitions} (safe = close to what works now; growth = stretch; viral = high-ceiling)
- Each concept must reference a specific keyword, hashtag, or pattern from the account data above — no generic ideas.${fusionNote}

Return a JSON array of 10 objects with EXACTLY these fields:
[
  {
    "title": "string (max 80 chars, no trailing period)",
    "hook": "string (max 140 chars, the actual opening line of the post or reel)",
    "why": "string (max 220 chars, why this works for THIS account, reference a specific number/keyword/hashtag from the data)",
    "format": "one of: reel, carousel, photo, story",
    "tone": "one of: educational, entertaining, inspiring, promotional",
    "ambition": "one of: safe, growth, viral",
    "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"],
    "for_account": "the username this concept targets (or 'username1 × username2' for fusion)",
    "fusion": false
  }
]

Reminder: respond with ONLY the JSON array. No prose. No markdown fence.`;

  return { system, user };
}

function parseAiConceptResponse(text) {
  if (!text) return [];
  // strip markdown fences if present
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // find first [ ... ] block
  const first = s.indexOf("[");
  const last = s.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];
  s = s.slice(first, last + 1);
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr.filter(c => c && typeof c === "object" && c.title && c.format);
  } catch {
    // attempt a salvage: chunk by `}` then parse each obj
    const out = [];
    const parts = s.split(/\}\s*,\s*\{/);
    for (let i = 0; i < parts.length; i++) {
      let chunk = parts[i];
      if (i > 0) chunk = "{" + chunk;
      if (i < parts.length - 1) chunk = chunk + "}";
      try {
        const obj = JSON.parse(chunk.replace(/^\[/, "").replace(/\]$/, ""));
        if (obj && obj.title) out.push(obj);
      } catch {}
    }
    return out;
  }
}

async function callAi(creds, system, user) {
  // /api/ai shape (matches existing handle_ai server route):
  //   { provider, model, api_key, prompt, context }
  // The server concatenates system + prompt + context. We pack system+user into prompt and leave context empty.
  const payload = {
    provider: creds.provider,
    model: creds.model,
    api_key: creds.key,
    prompt: system + "\n\n---\n\n" + user,
    context: "",
  };
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.text || "";
}

async function generateConceptsViaAi(selectedUsernames, filters) {
  const history = loadConceptHistory();
  let accounts = selectedUsernames.map(u => history[u.toLowerCase()]).filter(Boolean);
  if (filters.tier && filters.tier !== "all") {
    accounts = accounts.filter(a => tierFor(a.followers || 0) === filters.tier);
  }
  if (!accounts.length) return { concepts: [], summary: null, dna: null, source: "ai" };

  const analyses = accounts.map(analyzeAccount);
  const dna = {
    hooks: extractHooks(analyses, 5),
    patterns: detectViralPatterns(analyses),
    actions: generateMatchedActions(analyses),
  };

  const creds = getAiCreds();
  if (!creds) throw new Error("No AI key configured. Open the AI panel and paste a Gemini, Groq, OpenAI, or Claude key.");

  const { system, user } = buildAiConceptPrompt(analyses, filters, dna);
  const raw = await callAi(creds, system, user);
  const rawConcepts = parseAiConceptResponse(raw);

  if (!rawConcepts.length) {
    throw new Error("AI returned an unparseable response. Falling back to rule-based.");
  }

  // calibrate views using local estimator and attach metadata the renderer needs
  const concepts = [];
  for (const c of rawConcepts) {
    if (!filters.format.has(c.format)) continue;
    if (!filters.tone.has(c.tone)) continue;
    if (!filters.ambition.has(c.ambition)) continue;

    // pick the analysis closest to the target username
    const target = (c.for_account || "").split(/\s*[×x]\s*/i)[0].replace(/^@/, "").toLowerCase();
    const lead = analyses.find(a => a.account.username.toLowerCase() === target) || analyses[0];
    let est = estimateViews(lead, c.format, c.ambition);
    if (c.fusion && analyses.length >= 2) {
      const boost = 1.4;
      est = { low: Math.round(est.low * boost), mid: Math.round(est.mid * boost), high: Math.round(est.high * boost) };
    }
    concepts.push({
      title: String(c.title).slice(0, 120),
      hook: String(c.hook || ""),
      why: String(c.why || ""),
      format: c.format,
      tone: c.tone,
      ambition: c.ambition,
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.slice(0, 8) : [],
      forAccount: c.for_account || lead.account.username,
      accountFollowers: lead.account.followers,
      bestHour: lead.bestHour,
      estimate: est,
      confidence: confidenceFor(lead, { format: c.format }),
      fusion: !!c.fusion,
    });
  }

  // apply minViews filter
  const minViews = filters.minViews || 0;
  const filtered = minViews ? concepts.filter(c => c.estimate.high >= minViews) : concepts;
  filtered.sort((a, b) => b.estimate.mid - a.estimate.mid);

  // summary stays the same
  const totalFollowers = analyses.reduce((s, a) => s + a.account.followers, 0);
  const avgER = analyses.reduce((s, a) => s + a.engagementRate, 0) / analyses.length;
  const formatTotals = { reel: 0, carousel: 0, photo: 0 };
  for (const a of analyses) {
    formatTotals.reel += a.formatMedian.reel;
    formatTotals.carousel += a.formatMedian.carousel;
    formatTotals.photo += a.formatMedian.photo;
  }
  const strongest = Object.entries(formatTotals).sort((a, b) => b[1] - a[1])[0][0];

  return {
    concepts: filtered,
    summary: {
      followers: totalFollowers,
      er: avgER,
      strongest,
      theme: detectBestThemeAcrossAccounts(analyses),
      accountCount: analyses.length,
    },
    dna,
    source: "ai",
    aiProvider: creds.provider,
    aiModel: creds.model,
  };
}

// ---------- main generator ----------
function generateConcepts(selectedUsernames, filters) {
  const history = loadConceptHistory();
  let accounts = selectedUsernames.map(u => history[u.toLowerCase()]).filter(Boolean);

  // honor tier filter (single-value)
  if (filters.tier && filters.tier !== "all") {
    accounts = accounts.filter(a => tierFor(a.followers || 0) === filters.tier);
  }
  if (!accounts.length) return { concepts: [], summary: null, dna: null };

  const analyses = accounts.map(analyzeAccount);

  // run all per-account templates against each account
  const concepts = [];
  for (const a of analyses) {
    for (const tpl of CONCEPT_TEMPLATES) {
      let c;
      try { c = tpl(a); } catch { c = null; }
      if (!c) continue;
      if (!filters.format.has(c.format)) continue;
      if (!filters.tone.has(c.tone)) continue;
      if (!filters.ambition.has(c.ambition)) continue;
      const est = estimateViews(a, c.format, c.ambition);
      concepts.push({
        ...c,
        forAccount: a.account.username,
        accountFollowers: a.account.followers,
        bestHour: a.bestHour,
        estimate: est,
        confidence: confidenceFor(a, c),
      });
    }
  }

  // run fusion templates if 2+ accounts
  if (analyses.length >= 2) {
    for (const tpl of FUSION_TEMPLATES) {
      let c;
      try { c = tpl(analyses); } catch { c = null; }
      if (!c) continue;
      if (!filters.format.has(c.format)) continue;
      if (!filters.tone.has(c.tone)) continue;
      if (!filters.ambition.has(c.ambition)) continue;
      // estimate using highest-follower account, then apply collab boost
      const lead = analyses.reduce((m, a) => a.account.followers > m.account.followers ? a : m, analyses[0]);
      const est = estimateViews(lead, c.format, c.ambition);
      const boost = c.multiAccountBoost || 1.3;
      concepts.push({
        ...c,
        forAccount: analyses.map(a => a.account.username).join(" × "),
        accountFollowers: analyses.reduce((s, a) => s + a.account.followers, 0),
        bestHour: lead.bestHour,
        estimate: { low: Math.round(est.low * boost), mid: Math.round(est.mid * boost), high: Math.round(est.high * boost) },
        confidence: "medium",
        fusion: true,
      });
    }
  }

  // dedupe identical titles
  const seen = new Set();
  const unique = concepts.filter(c => {
    const k = c.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // minViews filter (single-value int) — drop concepts whose HIGH estimate is below floor
  const minViews = filters.minViews || 0;
  let filtered = minViews ? unique.filter(c => c.estimate.high >= minViews) : unique;

  // sort by mid view estimate descending, but cap at 12
  filtered.sort((a, b) => b.estimate.mid - a.estimate.mid);
  const final = filtered.slice(0, 12);

  // summary
  const totalFollowers = analyses.reduce((s, a) => s + a.account.followers, 0);
  const avgER = analyses.reduce((s, a) => s + a.engagementRate, 0) / analyses.length;
  const formatTotals = { reel: 0, carousel: 0, photo: 0 };
  for (const a of analyses) {
    formatTotals.reel += a.formatMedian.reel;
    formatTotals.carousel += a.formatMedian.carousel;
    formatTotals.photo += a.formatMedian.photo;
  }
  const strongest = Object.entries(formatTotals).sort((a, b) => b[1] - a[1])[0][0];
  const theme = detectBestThemeAcrossAccounts(analyses);

  return {
    concepts: final,
    summary: {
      followers: totalFollowers,
      er: avgER,
      strongest,
      theme,
      accountCount: analyses.length,
    },
    dna: {
      hooks: extractHooks(analyses, 5),
      patterns: detectViralPatterns(analyses),
      actions: generateMatchedActions(analyses),
    },
  };
}

function confidenceFor(analysis, concept) {
  // confidence based on data volume + relevance
  let score = 0;
  if (analysis.totalPosts >= 10) score += 2;
  else if (analysis.totalPosts >= 5) score += 1;
  if (analysis.engagementRate >= 2) score += 1;
  if (analysis.topHashtags.length >= 5) score += 1;
  if (concept.format === analysis.strongestFormat) score += 2;
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

// Pull server-side cache list into local concept history, so anything ever
// fetched on this machine remains pickable — even after browser-storage clears.
async function syncServerCacheIntoHistory() {
  try {
    const r = await fetch("/api/cache/list");
    if (!r.ok) return;
    const { accounts } = await r.json();
    const history = loadConceptHistory();
    let added = 0;
    for (const a of accounts || []) {
      const key = (a.username || "").toLowerCase();
      if (!key) continue;
      // if not in local history, seed a thin record so it appears in the picker.
      // Posts will be loaded on first selection via /api/lookup?cache=1
      if (!history[key]) {
        history[key] = {
          username: a.username,
          full_name: a.full_name || "",
          followers: a.followers || 0,
          posts_count: 0,
          profile_pic_url: a.profile_pic_url || "",
          is_verified: !!a.is_verified,
          is_business: !!a.is_business,
          cached_at: a.cached_at || 0,
          posts: [],
          _server_cache_only: true,
        };
        added++;
      }
    }
    if (added) saveConceptHistory(history);
  } catch (e) {
    console.warn("syncServerCacheIntoHistory:", e);
  }
}

// On-demand hydrate from disk cache when a thin record is selected
async function hydrateAccountFromCache(username) {
  try {
    const r = await fetch(`/api/lookup?username=${encodeURIComponent(username)}&cache=1`);
    if (!r.ok) return;
    const data = await r.json();
    if (data && data.username) recordConceptSource(data);
  } catch {}
}

// ---------- rendering ----------
function renderConceptAccountGrid() {
  const grid = $("concepts-account-grid");
  if (!grid) return;
  const history = loadConceptHistory();
  const entries = Object.entries(history).sort((a, b) => (b[1].cached_at || 0) - (a[1].cached_at || 0));
  $("concepts-empty-history").classList.toggle("hidden", entries.length > 0);
  grid.innerHTML = "";
  for (const [key, acc] of entries) {
    const chip = document.createElement("div");
    chip.className = "concept-account-chip" + (conceptStudioState.selected.has(key) ? " selected" : "");
    chip.dataset.username = key;
    const initial = (acc.full_name || acc.username || "?").charAt(0).toUpperCase();
    const picSrc = acc.profile_pic_url ? `/api/image?url=${encodeURIComponent(acc.profile_pic_url)}` : "";
    chip.innerHTML = `
      <div class="chip-avatar">${picSrc ? `<img src="${picSrc}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'), {textContent: '${initial}'}))" />` : initial}</div>
      <div class="chip-meta">
        <div class="chip-name">@${acc.username}</div>
        <div class="chip-stats">${fmt(acc.followers)} · ${acc.posts ? acc.posts.length : 0} posts cached</div>
      </div>`;
    chip.addEventListener("click", () => {
      if (conceptStudioState.selected.has(key)) conceptStudioState.selected.delete(key);
      else conceptStudioState.selected.add(key);
      renderConceptAccountGrid();
      updateConceptsSelectedHint();
    });
    grid.appendChild(chip);
  }
}

function updateConceptsSelectedHint() {
  const n = conceptStudioState.selected.size;
  const hint = $("concepts-selected-count");
  const btn = $("concepts-generate-btn");
  if (n === 0) {
    hint.textContent = "Select 1+ accounts to start";
    btn.disabled = true;
  } else if (n === 1) {
    hint.textContent = "1 account selected — single-account concepts will be generated";
    btn.disabled = false;
  } else {
    hint.textContent = `${n} accounts selected — fusion concepts also unlocked`;
    btn.disabled = false;
  }
}

function readConceptFilters() {
  // already kept in state — return shallow snapshot
  return {
    format: new Set(conceptStudioState.filters.format),
    tone: new Set(conceptStudioState.filters.tone),
    ambition: new Set(conceptStudioState.filters.ambition),
  };
}

const FORMAT_ICON = { reel: "film", carousel: "layers", photo: "image", story: "circle-dot" };
const FORMAT_LABEL = { reel: "Reel", carousel: "Carousel", photo: "Photo", story: "Story" };

function flashConceptsBanner(text) {
  // Transient inline banner above the results — auto-dismisses
  let banner = document.getElementById("concepts-flash-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "concepts-flash-banner";
    banner.className = "mt-3 mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-400/25 text-xs text-amber-200 flex items-center gap-2";
    const wrap = $("concepts-results");
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(banner, wrap);
  }
  banner.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5"></i><span class="flex-1">${escapeHtml(text)}</span>`;
  if (window.lucide) window.lucide.createIcons();
  clearTimeout(banner._t);
  banner._t = setTimeout(() => banner.remove(), 6000);
}

function renderConceptResults(result) {
  conceptStudioState.lastResults = result;
  const wrap = $("concepts-results");
  wrap.innerHTML = "";

  // summary
  if (result.summary) {
    $("concepts-summary").classList.remove("hidden");
    $("concepts-sum-followers").textContent = fmt(result.summary.followers);
    $("concepts-sum-er").textContent = result.summary.er.toFixed(2) + "%";
    $("concepts-sum-format").textContent = FORMAT_LABEL[result.summary.strongest] || "—";
    $("concepts-sum-theme").textContent = result.summary.theme;
    $("concepts-export-btn").classList.remove("hidden");
    // attach an "engine" badge so the user knows where these came from
    if (result.source === "ai") {
      flashConceptsBanner(`Generated by ${aiProviderLabel(result.aiProvider)} (${result.aiModel}). View estimates are still locally calibrated to follower counts.`);
    }
  } else {
    $("concepts-summary").classList.add("hidden");
    $("concepts-export-btn").classList.add("hidden");
  }

  // Viral DNA panel
  const dnaWrap = $("concepts-viral-dna");
  if (result.dna && (result.dna.hooks.length || result.dna.patterns.length || result.dna.actions.length)) {
    dnaWrap.classList.remove("hidden");
    const hookList = $("dna-hooks");
    hookList.innerHTML = result.dna.hooks.length
      ? result.dna.hooks.map(h => `
          <li class="flex items-start gap-2">
            <span class="text-fuchsia-400 mt-0.5">›</span>
            <span class="flex-1"><span class="text-slate-100">"${escapeHtml(h.text)}"</span><span class="block text-[10px] text-slate-500 mt-0.5">@${escapeHtml(h.from)} · ${fmt(h.engagement)} eng</span></span>
          </li>`).join("")
      : `<li class="text-slate-500 italic">No captioned posts to extract hooks from yet.</li>`;
    $("dna-patterns").innerHTML = result.dna.patterns.length
      ? result.dna.patterns.map(p => `<li class="flex items-start gap-2"><i data-lucide="trending-up" class="w-3 h-3 text-emerald-300 mt-1 shrink-0"></i><span>${escapeHtml(p)}</span></li>`).join("")
      : `<li class="text-slate-500 italic">Not enough data to detect patterns.</li>`;
    $("dna-actions").innerHTML = result.dna.actions.length
      ? result.dna.actions.map((a, i) => `<li class="flex items-start gap-2"><span class="text-fuchsia-300 font-semibold mt-0.5">${i + 1}.</span><span>${escapeHtml(a)}</span></li>`).join("")
      : `<li class="text-slate-500 italic">No matched actions yet.</li>`;
  } else {
    dnaWrap.classList.add("hidden");
  }

  if (!result.concepts.length) {
    $("concepts-results-title").classList.add("hidden");
    $("concepts-group-toggle").classList.add("hidden");
    wrap.innerHTML = `<div class="col-span-full text-center py-10 text-slate-500 text-sm">
      <i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2 opacity-30"></i>
      <p>No concepts matched the current filters. Try enabling more formats / tones / ambition levels, or lowering the min-views floor.</p>
    </div>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  $("concepts-results-title").classList.remove("hidden");
  $("concepts-group-toggle").classList.remove("hidden");

  // grouping
  const groups = {};
  if (conceptStudioState.groupBy === "format") {
    for (const c of result.concepts) (groups[FORMAT_LABEL[c.format] || c.format] = groups[FORMAT_LABEL[c.format] || c.format] || []).push(c);
  } else if (conceptStudioState.groupBy === "ambition") {
    for (const c of result.concepts) (groups[c.ambition] = groups[c.ambition] || []).push(c);
  } else {
    groups[""] = result.concepts;
  }

  for (const [groupName, concepts] of Object.entries(groups)) {
    if (groupName) {
      const header = document.createElement("div");
      header.className = "col-span-full mt-2 mb-1 text-[10px] uppercase tracking-wider text-fuchsia-300/80";
      header.textContent = groupName + ` · ${concepts.length}`;
      wrap.appendChild(header);
    }
    for (const c of concepts) wrap.appendChild(renderConceptCard(c));
  }

  if (window.lucide) window.lucide.createIcons();
}

function renderConceptCard(c) {
  const card = document.createElement("div");
  card.className = "concept-card";
  const fmtIcon = FORMAT_ICON[c.format] || "file";
  const fmtCls = `concept-format-${c.format}`;
  const fmtLabel = FORMAT_LABEL[c.format] || c.format;
  const hourLabel = `${c.bestHour}:00`;
  const hashtagHtml = (c.hashtags || []).map(h => `<span class="concept-hashtag">${escapeHtml(h)}</span>`).join("");
  card.innerHTML = `
    <button class="concept-copy-btn" title="Copy concept"><i data-lucide="copy" class="w-3.5 h-3.5"></i></button>
    <div class="concept-card-header">
      <div class="concept-format-icon ${fmtCls}"><i data-lucide="${fmtIcon}" class="w-4 h-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">${fmtLabel} · ${c.tone} · ${c.ambition}${c.fusion ? " · fusion" : ""}</div>
        <div class="concept-title">${escapeHtml(c.title)}</div>
      </div>
    </div>
    <div class="concept-hook">${escapeHtml(c.hook)}</div>
    <div class="concept-why">${escapeHtml(c.why)}</div>
    ${hashtagHtml ? `<div class="concept-hashtags">${hashtagHtml}</div>` : ""}
    <div class="concept-meta-row">
      <span><i data-lucide="at-sign" class="w-3 h-3"></i>${escapeHtml(c.forAccount)}</span>
      <span><i data-lucide="clock" class="w-3 h-3"></i>~${hourLabel} best post hour</span>
    </div>
    <div class="concept-view-estimate">
      <div class="concept-view-range">
        <span class="concept-view-num">${fmt(c.estimate.low)}–${fmt(c.estimate.high)}</span>
        <span class="concept-view-label">est. views</span>
      </div>
      <span class="concept-confidence ${c.confidence}">${c.confidence} confidence</span>
    </div>`;
  card.querySelector(".concept-copy-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    copyConceptToClipboard(c);
    const btn = card.querySelector(".concept-copy-btn");
    btn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i>`;
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => {
      btn.innerHTML = `<i data-lucide="copy" class="w-3.5 h-3.5"></i>`;
      if (window.lucide) window.lucide.createIcons();
    }, 1200);
  });
  return card;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function conceptToText(c) {
  return [
    `[${FORMAT_LABEL[c.format] || c.format}] ${c.title}`,
    ``,
    `Hook: ${c.hook}`,
    ``,
    `Why it works: ${c.why}`,
    ``,
    `Hashtags: ${(c.hashtags || []).join(" ")}`,
    `Best post hour: ~${c.bestHour}:00`,
    `For: @${c.forAccount}`,
    `Estimated views: ${fmt(c.estimate.low)}–${fmt(c.estimate.high)} (mid ~${fmt(c.estimate.mid)}) · ${c.confidence} confidence`,
  ].join("\n");
}
function copyConceptToClipboard(c) {
  navigator.clipboard.writeText(conceptToText(c)).catch(() => {});
}
function copyAllConcepts() {
  const r = conceptStudioState.lastResults;
  if (!r || !r.concepts.length) return;
  const txt = r.concepts.map((c, i) => `=== Concept ${i + 1} ===\n${conceptToText(c)}`).join("\n\n");
  navigator.clipboard.writeText(txt).catch(() => {});
  const btn = $("concepts-export-btn");
  const orig = btn.innerHTML;
  btn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i>Copied ${r.concepts.length} concepts`;
  if (window.lucide) window.lucide.createIcons();
  setTimeout(() => { btn.innerHTML = orig; if (window.lucide) window.lucide.createIcons(); }, 1800);
}

// ---------- wiring ----------
function initConceptStudio() {
  if (!$("concepts-panel")) return;

  // Hook into existing lookup pipeline so every lookup auto-populates history.
  if (typeof renderLookupDashboard === "function" && !renderLookupDashboard.__conceptHooked) {
    const orig = renderLookupDashboard;
    window.renderLookupDashboard = function (d) {
      const r = orig.apply(this, arguments);
      try { recordConceptSource(d); } catch (e) { console.warn("concept history hook:", e); }
      return r;
    };
    window.renderLookupDashboard.__conceptHooked = true;
  }

  updateConceptsCount();

  // filter buttons (multi-select Sets and single-value filters both supported)
  document.querySelectorAll("[data-concepts-filter]").forEach(group => {
    const key = group.dataset.conceptsFilter;
    const currentVal = conceptStudioState.filters[key];
    const isSingle = !(currentVal instanceof Set);
    group.querySelectorAll(".concept-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.val;
        if (isSingle) {
          // radio-style
          group.querySelectorAll(".concept-filter-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          conceptStudioState.filters[key] = key === "minViews" ? parseInt(v, 10) || 0 : v;
        } else {
          if (currentVal.has(v)) currentVal.delete(v);
          else currentVal.add(v);
          btn.classList.toggle("active");
        }
      });
    });
  });

  // group-by toggle
  const groupToggle = $("concepts-group-toggle");
  if (groupToggle) {
    groupToggle.querySelectorAll(".concept-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        groupToggle.querySelectorAll(".concept-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        conceptStudioState.groupBy = btn.dataset.group;
        if (conceptStudioState.lastResults) renderConceptResults(conceptStudioState.lastResults);
      });
    });
  }

  $("concepts-select-all").addEventListener("click", () => {
    const history = loadConceptHistory();
    Object.keys(history).forEach(k => conceptStudioState.selected.add(k));
    renderConceptAccountGrid();
    updateConceptsSelectedHint();
  });
  $("concepts-clear").addEventListener("click", () => {
    conceptStudioState.selected.clear();
    renderConceptAccountGrid();
    updateConceptsSelectedHint();
  });
  $("concepts-go-lookup").addEventListener("click", () => {
    setMode("lookup");
    $("lookup-input").focus();
  });
  // engine toggle (Rule-based vs AI-powered)
  function applyEngineToggle() {
    const btnRules = $("concepts-engine-rules");
    const btnAi = $("concepts-engine-ai");
    const label = $("concepts-engine-label");
    const warning = $("concepts-ai-key-warning");
    btnRules.classList.toggle("active", conceptStudioState.engine === "rules");
    btnAi.classList.toggle("active", conceptStudioState.engine === "ai");
    if (conceptStudioState.engine === "rules") {
      label.textContent = "Rule-based · instant · free";
      warning.classList.add("hidden");
    } else {
      const creds = getAiCreds();
      if (creds) {
        label.textContent = `${aiProviderLabel(creds.provider)} · ${creds.model}`;
        warning.classList.add("hidden");
      } else {
        label.textContent = "AI-powered · no key configured";
        warning.classList.remove("hidden");
      }
    }
  }
  $("concepts-engine-rules").addEventListener("click", () => {
    conceptStudioState.engine = "rules";
    applyEngineToggle();
  });
  $("concepts-engine-ai").addEventListener("click", () => {
    conceptStudioState.engine = "ai";
    applyEngineToggle();
  });
  $("concepts-go-ai-key").addEventListener("click", () => {
    setMode("lookup");
    setTimeout(() => {
      const ai = document.querySelector("#ai-key") || document.querySelector("[id^='ai-']");
      if (ai && ai.scrollIntoView) ai.scrollIntoView({ behavior: "smooth", block: "center" });
      const keyInput = $("ai-key");
      if (keyInput) keyInput.focus();
    }, 200);
  });
  applyEngineToggle();

  $("concepts-generate-btn").addEventListener("click", async () => {
    const selected = [...conceptStudioState.selected];
    if (!selected.length) return;
    const btn = $("concepts-generate-btn");
    const wantAi = conceptStudioState.engine === "ai";
    const creds = wantAi ? getAiCreds() : null;
    if (wantAi && !creds) {
      $("concepts-ai-key-warning").classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    btn.innerHTML = wantAi
      ? `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>Asking ${aiProviderLabel(creds.provider)}…`
      : `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>Analyzing…`;
    if (window.lucide) window.lucide.createIcons();

    // Hydrate any thin (server-cache-only) records before analysis
    const history = loadConceptHistory();
    const toHydrate = selected.filter(u => history[u] && history[u]._server_cache_only);
    if (toHydrate.length) {
      await Promise.all(toHydrate.map(u => hydrateAccountFromCache(u)));
    }

    const filters = readConceptFilters();

    const finish = (result, fallbackBanner) => {
      renderConceptResults(result);
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="sparkles" class="w-4 h-4"></i>Generate concepts`;
      if (window.lucide) window.lucide.createIcons();
      if (fallbackBanner) flashConceptsBanner(fallbackBanner);
    };

    if (wantAi) {
      try {
        const aiResult = await generateConceptsViaAi(selected, filters);
        if (!aiResult.concepts.length) {
          // AI returned nothing usable — fallback
          const rb = generateConcepts(selected, filters);
          finish(rb, "AI returned no concepts; showing rule-based instead.");
        } else {
          finish(aiResult);
        }
      } catch (e) {
        console.warn("AI concepts failed:", e);
        const rb = generateConcepts(selected, filters);
        finish(rb, `AI mode failed (${e.message}). Showing rule-based instead.`);
      }
    } else {
      // small defer so the spinner paints
      setTimeout(() => {
        const result = generateConcepts(selected, filters);
        finish(result);
      }, 60);
    }
  });
  $("concepts-export-btn").addEventListener("click", copyAllConcepts);
}

// patch setMode + cmdk to recognize concepts mode
(function patchModeForConcepts() {
  if (typeof setMode !== "function") return;
  const orig = setMode;
  window.setMode = function (mode) {
    const r = orig.apply(this, arguments);
    const p = $("concepts-panel");
    if (p) {
      p.classList.toggle("hidden", mode !== "concepts");
      if (mode === "concepts") {
        // pull server-side cache once per session, then render the grid
        if (!conceptStudioState.serverCacheLoaded) {
          conceptStudioState.serverCacheLoaded = true;
          syncServerCacheIntoHistory().finally(() => {
            renderConceptAccountGrid();
            updateConceptsSelectedHint();
          });
        }
        renderConceptAccountGrid();
        updateConceptsSelectedHint();
      }
    }
    return r;
  };
  // expose to cmdk palette
  if (Array.isArray(CMDK_COMMANDS)) {
    CMDK_COMMANDS.push(
      { id: "concepts", icon: "lightbulb", label: "Open Concept Studio", run: () => setMode("concepts") },
      { id: "concepts-current", icon: "sparkles", label: "Generate concepts for current account", run: () => {
        if (window.__lastLookup) {
          recordConceptSource(window.__lastLookup);
          conceptStudioState.selected.clear();
          conceptStudioState.selected.add(window.__lastLookup.username.toLowerCase());
          setMode("concepts");
          setTimeout(() => $("concepts-generate-btn").click(), 120);
        } else {
          setMode("concepts");
        }
      }},
    );
  }
})();

// ============================================================
// DISCOVER — find influencers by niche + country
// ============================================================
// Asks the configured AI for candidate usernames matching the criteria,
// then bulk-looks-up each via /api/lookup to confirm + pull real stats.
// ============================================================

const discoverState = {
  filters: { minEr: 0, acctType: "any" },
  results: [],
  inflight: false,
};

const LS_DISCOVER_SAVED = "ig_discover_saved_v1";
function loadDiscoverSaved() {
  try { return JSON.parse(localStorage.getItem(LS_DISCOVER_SAVED) || "[]"); }
  catch { return []; }
}
function saveDiscoverSaved(arr) {
  localStorage.setItem(LS_DISCOVER_SAVED, JSON.stringify(arr.slice(0, 20)));
}

function currentDiscoverFilters() {
  const nicheSel = $("discover-niche").value;
  const niche = nicheSel === "custom" ? $("discover-niche-custom").value.trim() : nicheSel;
  const countrySel = $("discover-country").value;
  const country = countrySel === "custom" ? $("discover-country-custom").value.trim() : countrySel;
  return {
    niche, nicheSel,
    country, countrySel,
    language: $("discover-language").value,
    tier: $("discover-tier").value,
    count: parseInt($("discover-count").value, 10) || 15,
    minEr: discoverState.filters.minEr,
    acctType: discoverState.filters.acctType,
  };
}

function applyDiscoverFiltersToUI(f) {
  $("discover-niche").value = f.nicheSel || (f.niche ? "custom" : "fitness");
  if ((f.nicheSel || "") === "custom") {
    $("discover-niche-custom").classList.remove("hidden");
    $("discover-niche-custom").value = f.niche || "";
  } else {
    $("discover-niche-custom").classList.add("hidden");
  }
  $("discover-country").value = f.countrySel || f.country || "any";
  if ((f.countrySel || "") === "custom") {
    $("discover-country-custom").classList.remove("hidden");
    $("discover-country-custom").value = f.country || "";
  } else {
    $("discover-country-custom").classList.add("hidden");
  }
  $("discover-language").value = f.language || "any";
  $("discover-tier").value = f.tier || "any";
  $("discover-count").value = String(f.count || 15);
  discoverState.filters.minEr = f.minEr || 0;
  discoverState.filters.acctType = f.acctType || "any";
  // sync filter button states
  document.querySelectorAll("[data-discover-filter='minEr'] .concept-filter-btn").forEach(b => {
    b.classList.toggle("active", parseFloat(b.dataset.val) === discoverState.filters.minEr);
  });
  document.querySelectorAll("[data-discover-filter='acctType'] .concept-filter-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.val === discoverState.filters.acctType);
  });
}

function renderDiscoverSavedChips() {
  const saved = loadDiscoverSaved();
  const row = $("discover-saved-row");
  const list = $("discover-saved-list");
  if (!row || !list) return;
  row.classList.toggle("hidden", !saved.length);
  list.innerHTML = "";
  saved.forEach((q, idx) => {
    const chip = document.createElement("button");
    chip.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/40 border border-fuchsia-400/25 hover:border-fuchsia-400/60 text-xs text-fuchsia-200 transition";
    chip.innerHTML = `<i data-lucide="star" class="w-3 h-3"></i>${escapeHtml(q.label)}<i data-lucide="x" class="w-3 h-3 ml-1 opacity-50 hover:opacity-100 saved-x"></i>`;
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("saved-x")) {
        const arr = loadDiscoverSaved();
        arr.splice(idx, 1);
        saveDiscoverSaved(arr);
        renderDiscoverSavedChips();
        return;
      }
      applyDiscoverFiltersToUI(q);
      $("discover-find-btn").click();
    });
    list.appendChild(chip);
  });
  if (window.lucide) window.lucide.createIcons();
}

const COUNTRY_LABELS = {
  any: "globally", US: "United States", UK: "the United Kingdom", CA: "Canada", AU: "Australia",
  FR: "France", DE: "Germany", ES: "Spain", IT: "Italy", NL: "the Netherlands",
  MA: "Morocco", DZ: "Algeria", TN: "Tunisia", EG: "Egypt", SA: "Saudi Arabia",
  AE: "the UAE", BR: "Brazil", MX: "Mexico", AR: "Argentina", IN: "India",
  PK: "Pakistan", ID: "Indonesia", PH: "the Philippines", JP: "Japan", KR: "South Korea",
  TR: "Turkey", NG: "Nigeria", ZA: "South Africa",
};

const LANG_LABELS = {
  any: "", en: "English", fr: "French", es: "Spanish", ar: "Arabic", de: "German",
  it: "Italian", pt: "Portuguese", ja: "Japanese", ko: "Korean", tr: "Turkish", hi: "Hindi",
};

const TIER_RANGES = {
  any: [0, Infinity],
  nano: [0, 10_000],
  micro: [10_000, 100_000],
  mid: [100_000, 1_000_000],
  macro: [1_000_000, Infinity],
};

function buildDiscoverPrompt({ niche, country, language, tier, count }) {
  const countryLbl = COUNTRY_LABELS[country] || country || "globally";
  const langLbl = LANG_LABELS[language] || "";
  const tierRange = TIER_RANGES[tier];
  const tierDesc = tier === "any" ? "any follower count"
    : tier === "nano" ? "under 10K followers"
    : tier === "micro" ? "between 10K and 100K followers"
    : tier === "mid" ? "between 100K and 1M followers"
    : "over 1M followers";

  const system = (
    "You are an Instagram influencer-discovery expert. Given a niche, country, language, and audience size, " +
    "you return REAL, ACTIVE Instagram usernames that match the criteria. " +
    "You only list usernames you are confident exist publicly on Instagram. " +
    "You NEVER make up usernames. If unsure, list fewer. " +
    "You always respond with a strict JSON array — no prose, no markdown fence."
  );

  const user = `List ${count} Instagram usernames of creators / influencers in this niche and segment:

- Niche: ${niche}
- Country / Region: ${countryLbl}
- Primary language: ${langLbl || "any"}
- Audience size: ${tierDesc}

Constraints:
- Only return usernames you are CONFIDENT exist publicly on Instagram (no guessing, no made-up names).
- Prefer accounts that are active in the last 12 months.
- Mix established names with rising creators when possible.
- Skip mega-celebrities unless the country/niche makes them obviously relevant.

Return ONLY a JSON array of objects with these fields:
[
  {
    "username": "string (the @ handle, without the @)",
    "why": "1 sentence — why they fit this niche + country (max 140 chars)",
    "specialty": "1-3 word tag (e.g. 'vegan meal prep', 'street fashion')"
  }
]

No prose. No markdown fence. Just the JSON array.`;

  return { system, user };
}

function parseDiscoverAiResponse(text) {
  if (!text) return [];
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("[");
  const last = s.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];
  s = s.slice(first, last + 1);
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(o => o && typeof o.username === "string")
      .map(o => ({
        username: o.username.replace(/^@+/, "").trim(),
        why: String(o.why || ""),
        specialty: String(o.specialty || ""),
      }))
      .filter(o => /^[\w.]{1,30}$/.test(o.username));
  } catch {
    return [];
  }
}

async function bulkLookup(usernames, onProgress) {
  // sequential to be polite + survive rate limits
  const out = [];
  let i = 0;
  for (const u of usernames) {
    i++;
    if (onProgress) onProgress(i, usernames.length, u);
    try {
      const r = await fetch(`/api/lookup?username=${encodeURIComponent(u)}`);
      const d = await r.json();
      if (r.ok && d && d.available) {
        out.push(d);
        recordConceptSource(d); // also feed into Concept Studio history
      } else {
        out.push({ username: u, available: false, error: d?.error || `HTTP ${r.status}` });
      }
    } catch (e) {
      out.push({ username: u, available: false, error: e.message });
    }
    // small pacing between requests
    await new Promise(res => setTimeout(res, 350));
  }
  return out;
}

function applyDiscoverFilters(profiles) {
  const { minEr, acctType } = discoverState.filters;
  return profiles.filter(p => {
    if (!p.available) return false;
    const er = p.followers && p.posts?.length
      ? (p.posts.reduce((s, x) => s + (x.likes || 0) + (x.comments || 0), 0) / p.posts.length / p.followers) * 100
      : 0;
    if (minEr && er < minEr) return false;
    if (acctType === "business" && !p.is_business) return false;
    if (acctType === "creator" && !p.is_professional && !p.is_business) return false;
    if (acctType === "verified" && !p.is_verified) return false;
    return true;
  });
}

function renderDiscoverResults(profiles, meta) {
  const wrap = $("discover-results");
  wrap.innerHTML = "";
  if (!profiles.length) {
    const reasons = [];
    if (meta?.tierRejected) reasons.push(`<li><strong class="text-amber-200">${meta.tierRejected}</strong> were outside the <code class="bg-black/30 px-1 rounded">${meta.tier}</code> follower tier</li>`);
    if (meta?.erRejected) reasons.push(`<li><strong class="text-amber-200">${meta.erRejected}</strong> had engagement below <code class="bg-black/30 px-1 rounded">${meta.minEr}%</code></li>`);
    if (meta?.typeRejected) reasons.push(`<li><strong class="text-amber-200">${meta.typeRejected}</strong> weren't <code class="bg-black/30 px-1 rounded">${meta.acctType}</code> accounts</li>`);
    if (meta?.privateRejected) reasons.push(`<li><strong class="text-amber-200">${meta.privateRejected}</strong> were private</li>`);
    if (meta?.unavailable) reasons.push(`<li><strong class="text-amber-200">${meta.unavailable}</strong> were unavailable</li>`);

    wrap.innerHTML = `<div class="col-span-full text-center py-8 text-sm">
      <i data-lucide="filter-x" class="w-8 h-8 mx-auto mb-2 opacity-40 text-fuchsia-300"></i>
      <p class="text-slate-300 font-medium">No accounts passed your filters.</p>
      ${reasons.length ? `<ul class="mt-3 mx-auto text-left inline-block text-xs text-slate-400 space-y-1">${reasons.join("")}</ul>` : ""}
      <div class="mt-5 flex flex-wrap gap-2 justify-center">
        <button data-discover-relax="tier" class="px-3 py-1.5 rounded-lg bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border border-fuchsia-400/30 text-fuchsia-200 text-xs font-medium transition">Set tier to Any</button>
        <button data-discover-relax="er" class="px-3 py-1.5 rounded-lg bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border border-fuchsia-400/30 text-fuchsia-200 text-xs font-medium transition">Set engagement to Any</button>
        <button data-discover-relax="type" class="px-3 py-1.5 rounded-lg bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border border-fuchsia-400/30 text-fuchsia-200 text-xs font-medium transition">Set type to Any</button>
        <button data-discover-relax="all" class="px-3 py-1.5 rounded-lg bg-gradient-to-tr from-fuchsia-500 to-pink-500 text-white text-xs font-semibold transition">Relax all + re-run</button>
      </div>
      <p class="text-[11px] text-slate-600 mt-4">Of ${meta?.totalLookedUp || "all"} candidates the AI proposed, all existed on Instagram — but none matched what you asked for.</p>
    </div>`;
    // wire relax buttons
    wrap.querySelectorAll("[data-discover-relax]").forEach(b => {
      b.addEventListener("click", () => {
        const k = b.dataset.discoverRelax;
        if (k === "tier" || k === "all") {
          $("discover-tier").value = "any";
        }
        if (k === "er" || k === "all") {
          discoverState.filters.minEr = 0;
          document.querySelectorAll("[data-discover-filter='minEr'] .concept-filter-btn").forEach(x =>
            x.classList.toggle("active", x.dataset.val === "0"));
        }
        if (k === "type" || k === "all") {
          discoverState.filters.acctType = "any";
          document.querySelectorAll("[data-discover-filter='acctType'] .concept-filter-btn").forEach(x =>
            x.classList.toggle("active", x.dataset.val === "any"));
        }
        if (k === "all") {
          $("discover-find-btn").click();
        } else if (discoverState.results.length) {
          // re-run client-side filter on cached results
          const filtered = applyDiscoverFilters(discoverState.results);
          renderDiscoverResults(filtered, { ...meta, tierRejected: 0, erRejected: 0, typeRejected: 0, privateRejected: 0 });
        }
      });
    });
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  // sort by followers desc
  profiles.sort((a, b) => (b.followers || 0) - (a.followers || 0));
  for (const p of profiles) {
    const card = document.createElement("div");
    card.className = "concept-card";
    const initial = (p.full_name || p.username || "?").charAt(0).toUpperCase();
    const picSrc = p.profile_pic_url ? `/api/image?url=${encodeURIComponent(p.profile_pic_url)}` : "";
    const er = p.followers && p.posts?.length
      ? (p.posts.reduce((s, x) => s + (x.likes || 0) + (x.comments || 0), 0) / p.posts.length / p.followers) * 100
      : 0;
    const badges = [];
    if (p.is_verified) badges.push(`<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-sky-400/30 text-sky-300 bg-sky-500/10">Verified</span>`);
    if (p.is_business) badges.push(`<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-amber-400/30 text-amber-300 bg-amber-500/10">Business</span>`);
    else if (p.is_professional) badges.push(`<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-fuchsia-400/30 text-fuchsia-300 bg-fuchsia-500/10">Creator</span>`);
    if (p.is_private) badges.push(`<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-rose-400/30 text-rose-300 bg-rose-500/10">Private</span>`);

    card.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="w-12 h-12 rounded-xl overflow-hidden bg-gradient-to-br from-fuchsia-500/30 to-purple-500/20 border border-white/10 flex items-center justify-center text-white font-semibold shrink-0">
          ${picSrc ? `<img src="${picSrc}" loading="lazy" decoding="async" class="w-full h-full object-cover" onerror="this.replaceWith(Object.assign(document.createElement('span'), {textContent: '${initial}'}))" />` : initial}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-display font-semibold text-sm text-white truncate">${escapeHtml(p.full_name || p.username)}</div>
          <div class="text-xs text-fuchsia-300">@${escapeHtml(p.username)}</div>
          <div class="flex flex-wrap gap-1 mt-1.5">${badges.join("")}</div>
        </div>
      </div>
      ${p._discover_why ? `<div class="concept-why italic">"${escapeHtml(p._discover_why)}"</div>` : ""}
      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="bg-black/30 border border-white/5 rounded-lg p-2">
          <div class="font-display font-semibold text-sm text-white">${fmt(p.followers)}</div>
          <div class="text-[9px] uppercase tracking-wider text-slate-500">Followers</div>
        </div>
        <div class="bg-black/30 border border-white/5 rounded-lg p-2">
          <div class="font-display font-semibold text-sm text-white">${er.toFixed(1)}%</div>
          <div class="text-[9px] uppercase tracking-wider text-slate-500">Engagement</div>
        </div>
        <div class="bg-black/30 border border-white/5 rounded-lg p-2">
          <div class="font-display font-semibold text-sm text-white">${fmt(p.posts_count)}</div>
          <div class="text-[9px] uppercase tracking-wider text-slate-500">Posts</div>
        </div>
      </div>
      ${p._discover_specialty ? `<div class="text-[10px] text-slate-400"><i data-lucide="tag" class="w-3 h-3 inline -mt-0.5"></i> ${escapeHtml(p._discover_specialty)}</div>` : ""}
      <div class="flex flex-wrap gap-2 mt-auto pt-3 border-t border-white/5">
        <button data-discover-action="lookup" data-username="${escapeHtml(p.username)}" class="text-xs px-2.5 py-1.5 rounded-md bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border border-fuchsia-400/30 text-fuchsia-200 transition inline-flex items-center gap-1">
          <i data-lucide="search" class="w-3 h-3"></i>Open
        </button>
        <button data-discover-action="watch" data-username="${escapeHtml(p.username)}" class="text-xs px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 transition inline-flex items-center gap-1">
          <i data-lucide="bookmark" class="w-3 h-3"></i>Watch
        </button>
        <button data-discover-action="concept" data-username="${escapeHtml(p.username)}" class="text-xs px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 transition inline-flex items-center gap-1">
          <i data-lucide="lightbulb" class="w-3 h-3"></i>Concepts
        </button>
      </div>`;
    wrap.appendChild(card);
  }
  // wire actions
  wrap.querySelectorAll("[data-discover-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.discoverAction;
      const u = btn.dataset.username;
      if (action === "lookup") {
        setMode("lookup");
        $("lookup-input").value = u;
        setTimeout(() => $("lookup-btn").click(), 100);
      } else if (action === "watch") {
        if (addToWatchlist(u)) {
          btn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i>Tracked`;
          if (window.lucide) window.lucide.createIcons();
        }
      } else if (action === "concept") {
        conceptStudioState.selected.clear();
        conceptStudioState.selected.add(u.toLowerCase());
        setMode("concepts");
      }
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

function refreshDiscoverEngineLabel() {
  const creds = getAiCreds();
  const label = $("discover-engine-label");
  const warn = $("discover-ai-key-warning");
  if (creds) {
    label.textContent = `${aiProviderLabel(creds.provider)} · ${creds.model}`;
    warn.classList.add("hidden");
  } else {
    label.textContent = "No AI key configured";
    warn.classList.remove("hidden");
  }
}

function initDiscover() {
  if (!$("discover-panel")) return;

  // Niche/Country custom toggle
  $("discover-niche").addEventListener("change", (e) => {
    $("discover-niche-custom").classList.toggle("hidden", e.target.value !== "custom");
  });
  $("discover-country").addEventListener("change", (e) => {
    $("discover-country-custom").classList.toggle("hidden", e.target.value !== "custom");
  });

  // Filter button groups
  document.querySelectorAll("[data-discover-filter]").forEach(group => {
    const key = group.dataset.discoverFilter;
    group.querySelectorAll(".concept-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".concept-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const v = btn.dataset.val;
        discoverState.filters[key] = key === "minEr" ? parseFloat(v) : v;
        // re-filter existing results in place
        if (discoverState.results.length) {
          const filtered = applyDiscoverFilters(discoverState.results);
          renderDiscoverResults(filtered, { totalLookedUp: discoverState.results.length, unavailable: discoverState.results.filter(p => !p.available).length });
        }
      });
    });
  });

  $("discover-go-ai-key").addEventListener("click", () => {
    setMode("lookup");
    setTimeout(() => {
      const keyInput = $("ai-key");
      if (keyInput) { keyInput.scrollIntoView({ behavior: "smooth", block: "center" }); keyInput.focus(); }
    }, 200);
  });

  $("discover-find-btn").addEventListener("click", async () => {
    if (discoverState.inflight) return;
    const creds = getAiCreds();
    if (!creds) {
      $("discover-ai-key-warning").classList.remove("hidden");
      return;
    }
    const nicheSel = $("discover-niche").value;
    const niche = nicheSel === "custom" ? $("discover-niche-custom").value.trim() : nicheSel;
    if (!niche) return;
    const countrySel = $("discover-country").value;
    const country = countrySel === "custom" ? $("discover-country-custom").value.trim() : countrySel;
    const language = $("discover-language").value;
    const tier = $("discover-tier").value;
    const count = parseInt($("discover-count").value, 10) || 15;

    const btn = $("discover-find-btn");
    const progress = $("discover-progress");
    const wrap = $("discover-results");
    discoverState.inflight = true;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>Asking AI…`;
    if (window.lucide) window.lucide.createIcons();
    progress.classList.remove("hidden");
    progress.textContent = `Asking ${aiProviderLabel(creds.provider)} for ${count} candidates…`;
    wrap.innerHTML = "";

    try {
      const { system, user } = buildDiscoverPrompt({ niche, country, language, tier, count });
      const raw = await callAi(creds, system, user);
      const candidates = parseDiscoverAiResponse(raw);
      if (!candidates.length) throw new Error("AI returned no parseable candidates");

      progress.textContent = `AI proposed ${candidates.length} candidates. Verifying via Instagram…`;
      btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>Verifying…`;
      if (window.lucide) window.lucide.createIcons();

      const profiles = await bulkLookup(
        candidates.map(c => c.username),
        (i, total, u) => { progress.textContent = `Verifying ${i} / ${total} · @${u}`; }
      );

      // attach AI-supplied "why" and "specialty" to each profile
      for (const p of profiles) {
        const candidate = candidates.find(c => c.username.toLowerCase() === (p.username || "").toLowerCase());
        if (candidate) {
          p._discover_why = candidate.why;
          p._discover_specialty = candidate.specialty;
        }
      }

      // apply tier filter (post-lookup since we now know real follower counts)
      const tierRange = TIER_RANGES[tier];
      let tierRejected = 0, erRejected = 0, typeRejected = 0, privateRejected = 0;
      const tierFiltered = profiles.filter(p => {
        if (!p.available) return false;
        if (!p.followers) return tier === "any";
        const inTier = p.followers >= tierRange[0] && p.followers <= tierRange[1];
        if (!inTier) tierRejected++;
        return inTier;
      });
      const finalFiltered = tierFiltered.filter(p => {
        if (p.is_private) { privateRejected++; return false; }
        const er = p.followers && p.posts?.length
          ? (p.posts.reduce((s, x) => s + (x.likes || 0) + (x.comments || 0), 0) / p.posts.length / p.followers) * 100
          : 0;
        if (discoverState.filters.minEr && er < discoverState.filters.minEr) { erRejected++; return false; }
        const at = discoverState.filters.acctType;
        if (at === "business" && !p.is_business) { typeRejected++; return false; }
        if (at === "creator" && !p.is_professional && !p.is_business) { typeRejected++; return false; }
        if (at === "verified" && !p.is_verified) { typeRejected++; return false; }
        return true;
      });

      discoverState.results = tierFiltered;
      const unavailable = profiles.filter(p => !p.available).length;
      renderDiscoverResults(finalFiltered, { totalLookedUp: profiles.length, unavailable, tierRejected, erRejected, typeRejected, privateRejected, tier, minEr: discoverState.filters.minEr, acctType: discoverState.filters.acctType });
      progress.textContent = `Found ${finalFiltered.length} matches · verified ${profiles.length}${unavailable ? ` · ${unavailable} unavailable` : ""}${tierRejected ? ` · ${tierRejected} wrong tier` : ""}${erRejected ? ` · ${erRejected} low ER` : ""}${typeRejected ? ` · ${typeRejected} wrong type` : ""}`;
      const filtered = finalFiltered;
      // reveal save + bulk-concepts buttons now that we have results
      if (filtered.length) {
        $("discover-save-btn").classList.remove("hidden");
        $("discover-bulk-concepts-btn").classList.remove("hidden");
        $("discover-bulk-concepts-btn").innerHTML = `<i data-lucide="lightbulb" class="w-3.5 h-3.5"></i>Concepts for all ${filtered.length}`;
        if (window.lucide) window.lucide.createIcons();
      }
    } catch (e) {
      wrap.innerHTML = `<div class="col-span-full text-center py-10 text-rose-300 text-sm">
        <i data-lucide="alert-triangle" class="w-8 h-8 mx-auto mb-2"></i>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
      progress.classList.add("hidden");
      if (window.lucide) window.lucide.createIcons();
    } finally {
      discoverState.inflight = false;
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="search" class="w-4 h-4"></i>Find influencers`;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  // Save query
  $("discover-save-btn").addEventListener("click", () => {
    const f = currentDiscoverFilters();
    if (!f.niche) return;
    const arr = loadDiscoverSaved();
    const label = `${f.niche} · ${COUNTRY_LABELS[f.country] || f.country || "global"}${f.tier !== "any" ? " · " + f.tier : ""}`;
    // dedupe
    const idx = arr.findIndex(x => x.niche === f.niche && x.country === f.country && x.tier === f.tier && x.language === f.language);
    if (idx >= 0) arr.splice(idx, 1);
    arr.unshift({ ...f, label, savedAt: Date.now() });
    saveDiscoverSaved(arr);
    renderDiscoverSavedChips();
    const btn = $("discover-save-btn");
    btn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i>Saved`;
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => {
      btn.innerHTML = `<i data-lucide="star" class="w-3.5 h-3.5"></i>Save query`;
      if (window.lucide) window.lucide.createIcons();
    }, 1500);
  });

  // Bulk concepts: push every available result into Concept Studio history,
  // select them all, switch tabs, and trigger generation.
  $("discover-bulk-concepts-btn").addEventListener("click", () => {
    const profiles = (discoverState.results || []).filter(p => p.available);
    if (!profiles.length) return;
    conceptStudioState.selected.clear();
    for (const p of profiles) {
      try { recordConceptSource(p); } catch {}
      conceptStudioState.selected.add(p.username.toLowerCase());
    }
    setMode("concepts");
    setTimeout(() => {
      const btn = $("concepts-generate-btn");
      if (btn && !btn.disabled) btn.click();
    }, 200);
  });

  renderDiscoverSavedChips();
  refreshDiscoverEngineLabel();
}

// patch setMode to handle the discover tab
(function patchModeForDiscover() {
  if (typeof setMode !== "function") return;
  const orig = setMode;
  window.setMode = function (mode) {
    const r = orig.apply(this, arguments);
    const p = $("discover-panel");
    if (p) {
      p.classList.toggle("hidden", mode !== "discover");
      if (mode === "discover") refreshDiscoverEngineLabel();
    }
    return r;
  };
  if (Array.isArray(CMDK_COMMANDS)) {
    CMDK_COMMANDS.push({ id: "discover", icon: "compass", label: "Discover influencers", run: () => setMode("discover") });
  }
})();

// init Discover on DOM ready (already-loaded by the time this runs at file end)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDiscover);
} else {
  initDiscover();
}

// ============================================================
// AUTH (Pulse-level account, optional)
// ============================================================
// Frontend scaffold for sign-in. Defaults to demo mode (no backend).
// To wire real auth: set window.PULSE_AUTH_CONFIG in index.html or
// via /api/config, with supabaseUrl + supabaseAnonKey (or another provider).
// See DEPLOY.md for the full setup.
// ============================================================

const LS_AUTH_USER = "ig_auth_user_v1";

function getAuthConfig() {
  return window.PULSE_AUTH_CONFIG || {};
}
function isAuthConfigured() {
  const cfg = getAuthConfig();
  return !!(cfg.supabaseUrl && cfg.supabaseAnonKey) || !!cfg.customAuthEndpoint;
}
function loadAuthUser() {
  try { return JSON.parse(localStorage.getItem(LS_AUTH_USER) || "null"); }
  catch { return null; }
}
function saveAuthUser(u) {
  if (u) localStorage.setItem(LS_AUTH_USER, JSON.stringify(u));
  else localStorage.removeItem(LS_AUTH_USER);
  updateAuthBtnLabel();
}
function updateAuthBtnLabel() {
  const u = loadAuthUser();
  const lbl = $("auth-open-label");
  if (!lbl) return;
  if (u && u.email) {
    lbl.textContent = u.email.split("@")[0];
  } else {
    lbl.textContent = "Sign in";
  }
}

async function authSubmitMagicLink(email) {
  const cfg = getAuthConfig();
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    // Supabase magic-link flow (no SDK needed; raw REST call)
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": cfg.supabaseAnonKey },
      body: JSON.stringify({ email, options: { emailRedirectTo: location.origin } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.msg || err.error_description || `HTTP ${res.status}`);
    }
    return { sent: true };
  }
  if (cfg.customAuthEndpoint) {
    const res = await fetch(cfg.customAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { sent: true };
  }
  // demo mode — just stash the email locally as a fake "user"
  saveAuthUser({ email, demo: true, signedInAt: Date.now() });
  return { sent: false, demo: true };
}

function openAuthModal() {
  const modal = $("auth-modal");
  if (!modal) return;
  // refresh demo banner
  const demo = $("auth-demo-banner");
  if (demo) demo.classList.toggle("hidden", isAuthConfigured());
  // pre-fill if signed-in
  const u = loadAuthUser();
  if (u && u.email) $("auth-email").value = u.email;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  setTimeout(() => $("auth-email").focus(), 80);
}
function closeAuthModal() {
  const modal = $("auth-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

function initAuth() {
  if (!$("auth-modal")) return;
  // Detect magic-link callback on page load (Supabase appends #access_token=… on success)
  if (location.hash.includes("access_token=")) {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const access_token = params.get("access_token");
      const cfg = getAuthConfig();
      if (access_token && cfg.supabaseUrl && cfg.supabaseAnonKey) {
        // fetch user profile
        fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
          headers: { "apikey": cfg.supabaseAnonKey, "Authorization": `Bearer ${access_token}` },
        }).then(r => r.json()).then(u => {
          if (u && u.email) saveAuthUser({ email: u.email, id: u.id, access_token });
          // clean the URL
          history.replaceState(null, "", location.pathname + location.search);
        }).catch(() => {});
      }
    } catch {}
  }

  $("auth-open-btn")?.addEventListener("click", openAuthModal);
  $("auth-close")?.addEventListener("click", closeAuthModal);
  $("auth-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "auth-modal") closeAuthModal();
  });
  $("auth-submit")?.addEventListener("click", async () => {
    const email = ($("auth-email").value || "").trim();
    const status = $("auth-status");
    const btn = $("auth-submit");
    status.classList.add("hidden");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.classList.remove("hidden");
      status.className = "text-xs text-center text-rose-300";
      status.textContent = "That doesn't look like a valid email.";
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin mr-2 align-middle"></span>Sending…`;
    try {
      const r = await authSubmitMagicLink(email);
      status.classList.remove("hidden");
      if (r.demo) {
        status.className = "text-xs text-center text-amber-300";
        status.textContent = "Demo mode — signed in locally. Wire auth via DEPLOY.md to enable real sync.";
        setTimeout(closeAuthModal, 1800);
      } else {
        status.className = "text-xs text-center text-emerald-300";
        status.textContent = "Magic link sent. Check your email — click the link to finish signing in.";
      }
    } catch (e) {
      status.classList.remove("hidden");
      status.className = "text-xs text-center text-rose-300";
      status.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.innerHTML = "Email me a magic link";
    }
  });
  $("auth-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("auth-submit").click();
  });

  updateAuthBtnLabel();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAuth);
} else {
  initAuth();
}
