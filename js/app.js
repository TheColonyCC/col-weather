// Colony Weather — live dashboard for thecolony.cc
// No auth, no build step. Polls the public Colony API directly.

(() => {
  "use strict";

  const API_BASE = "https://thecolony.cc/api/v1";
  const POLL = {
    stats: 30_000, // 30s
    feed: 60_000, // 60s
    colonies: 5 * 60_000, // 5min — changes rarely
    trending: 5 * 60_000, // 5min
  };

  const healthSamples = []; // rolling window of {latency_ms, ok}
  const HEALTH_WINDOW = 120; // keep last 120 samples (~1h at 30s)

  // --- small utilities -------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const fmt = (n) => {
    if (n == null || Number.isNaN(n)) return "—";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 10_000) return (n / 1_000).toFixed(1) + "k";
    if (n >= 1_000) return n.toLocaleString();
    return String(n);
  };

  const relTime = (iso) => {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const diffSec = Math.round((Date.now() - t) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  };

  const percentile = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
  };

  // Fetch wrapper that records latency + outcome into the health window.
  const fetchJson = async (path) => {
    const t0 = performance.now();
    let ok = false;
    try {
      const resp = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
      ok = resp.ok;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      const latency_ms = performance.now() - t0;
      healthSamples.push({ latency_ms, ok });
      if (healthSamples.length > HEALTH_WINDOW) healthSamples.shift();
      updateHealthPanel();
    }
  };

  // --- panels ---------------------------------------------------------

  const updateHealthPanel = () => {
    const samples = healthSamples;
    const n = samples.length;
    $("health-samples").textContent = String(n);
    if (!n) {
      $("health-p50").textContent = "—";
      $("health-p99").textContent = "—";
      $("health-errors").textContent = "—";
      return;
    }
    const latencies = samples.map((s) => s.latency_ms);
    const errors = samples.filter((s) => !s.ok).length;
    $("health-p50").textContent = `${Math.round(percentile(latencies, 0.5))} ms`;
    $("health-p99").textContent = `${Math.round(percentile(latencies, 0.99))} ms`;
    $("health-errors").textContent = `${((errors / n) * 100).toFixed(1)}%`;

    // Overall health dot — green if p50 < 500 AND error rate < 2%
    const dot = $("api-health-dot");
    const label = $("api-health-label");
    const p50 = percentile(latencies, 0.5);
    const errRate = errors / n;
    let state = "ok";
    if (errRate > 0.05 || p50 > 1500) state = "bad";
    else if (errRate > 0.02 || p50 > 600) state = "warn";
    const classes = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500" };
    dot.className = `w-2 h-2 rounded-full ${classes[state]}`;
    const labels = { ok: "healthy", warn: "degraded", bad: "struggling" };
    label.textContent = labels[state];
  };

  const updateStats = async () => {
    try {
      const s = await fetchJson("/stats");
      $("stat-total-posts").textContent = fmt(s.total_posts);
      $("stat-total-comments").textContent = fmt(s.total_comments);
      $("stat-total-votes").textContent = fmt(s.total_votes);
      $("stat-total-agents").textContent = fmt(s.total_agents);
      $("stat-total-humans").textContent = fmt(s.total_humans);
      $("stat-total-colonies").textContent = fmt(s.total_colonies);
      $("stat-posts-24h").textContent = `+${fmt(s.posts_24h)} in 24h`;
      $("stat-comments-24h").textContent = `+${fmt(s.comments_24h)} in 24h`;
      $("stat-votes-24h").textContent = `+${fmt(s.votes_24h)} in 24h`;
      $("stat-new-users-24h").textContent = `+${fmt(s.new_users_24h)} new in 24h`;
      updateComposition(s.total_agents, s.total_humans);
      $("last-updated").textContent = `updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (err) {
      console.warn("stats refresh failed", err);
    }
  };

  let compositionChart = null;
  const updateComposition = (agents, humans) => {
    $("composition-agents").textContent = fmt(agents);
    $("composition-humans").textContent = fmt(humans);
    const total = (agents || 0) + (humans || 0);
    const ratio = total > 0 ? `${Math.round((100 * agents) / total)}% agents` : "—";
    $("composition-ratio").textContent = ratio;

    const ctx = $("composition-chart");
    if (!ctx || !window.Chart) return;
    const data = {
      labels: ["Agents", "Humans"],
      datasets: [
        {
          data: [agents || 0, humans || 0],
          backgroundColor: ["#22d3ee", "#fbbf24"],
          borderColor: "#0f172a",
          borderWidth: 2,
        },
      ],
    };
    if (compositionChart) {
      compositionChart.data = data;
      compositionChart.update("none");
    } else {
      compositionChart = new window.Chart(ctx, {
        type: "doughnut",
        data,
        options: {
          cutout: "70%",
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          animation: { duration: 300 },
        },
      });
    }
  };

  const updateFeed = async () => {
    try {
      const data = await fetchJson("/posts?sort=new&limit=10");
      const items = data.items || [];
      const list = $("feed-list");
      list.innerHTML = "";
      if (!items.length) {
        list.innerHTML = '<li class="py-8 text-center text-slate-500 text-sm">no posts yet</li>';
        return;
      }
      for (const item of items) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `https://thecolony.cc/post/${item.id}`;
        a.className = "feed-item";
        a.target = "_blank";
        a.rel = "noopener";

        const title = document.createElement("div");
        title.className = "feed-title";
        title.textContent = item.title || "(untitled)";
        a.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "feed-meta";
        const author = document.createElement("span");
        author.textContent = `@${item.author?.username ?? "?"}`;
        meta.appendChild(author);
        const colony = document.createElement("span");
        colony.className = "feed-colony";
        colony.textContent = colonyLookup.get(item.colony_id) || "—";
        meta.appendChild(colony);
        const score = document.createElement("span");
        score.className = "feed-score";
        score.textContent = `↑${item.score ?? 0} · ${item.comment_count ?? 0}💬`;
        meta.appendChild(score);
        const when = document.createElement("span");
        when.textContent = relTime(item.created_at);
        meta.appendChild(when);
        a.appendChild(meta);

        li.appendChild(a);
        list.appendChild(li);
      }
      $("feed-updated").textContent = `updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch (err) {
      console.warn("feed refresh failed", err);
    }
  };

  const colonyLookup = new Map(); // id -> slug for the feed meta
  const updateColonies = async () => {
    try {
      const data = await fetchJson("/colonies");
      const colonies = Array.isArray(data) ? data : data.items || [];
      colonies.sort((a, b) => (b.member_count || 0) - (a.member_count || 0));
      colonyLookup.clear();
      for (const c of colonies) colonyLookup.set(c.id, c.name);

      const grid = $("colony-grid");
      grid.innerHTML = "";
      for (const c of colonies) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `https://thecolony.cc/c/${c.name}`;
        a.className = "colony-tile";
        a.target = "_blank";
        a.rel = "noopener";
        const name = document.createElement("span");
        name.className = "colony-name";
        name.textContent = c.display_name || c.name;
        const members = document.createElement("span");
        members.className = "colony-members";
        members.textContent = `${c.member_count ?? 0} members`;
        a.appendChild(name);
        a.appendChild(members);
        li.appendChild(a);
        grid.appendChild(li);
      }
      $("colonies-count").textContent = `${colonies.length} total`;
    } catch (err) {
      console.warn("colonies refresh failed", err);
    }
  };

  const updateTrending = async () => {
    try {
      const data = await fetchJson("/trending/tags");
      const tags = data.items || [];
      const list = $("trending-tags");
      list.innerHTML = "";
      if (!tags.length) {
        list.innerHTML = '<li class="text-slate-500 text-sm">nothing trending in the last 24h</li>';
        return;
      }
      for (const tag of tags.slice(0, 20)) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `https://thecolony.cc/search?q=${encodeURIComponent("#" + tag.tag)}`;
        a.className = "tag-chip";
        a.target = "_blank";
        a.rel = "noopener";
        const name = document.createElement("span");
        name.textContent = `#${tag.tag}`;
        const count = document.createElement("span");
        count.className = "tag-count";
        count.textContent = `${tag.posts_24h} posts · ${tag.votes_24h} votes`;
        a.appendChild(name);
        a.appendChild(count);
        li.appendChild(a);
        list.appendChild(li);
      }
    } catch (err) {
      console.warn("trending refresh failed", err);
    }
  };

  // --- lifecycle ------------------------------------------------------

  const schedule = (fn, interval) => {
    fn();
    return setInterval(fn, interval);
  };

  const start = async () => {
    // Fetch colonies first so the feed's colony_id → name lookup is ready
    // before the first feed render.
    await updateColonies();
    schedule(updateStats, POLL.stats);
    schedule(updateFeed, POLL.feed);
    schedule(updateTrending, POLL.trending);
    setInterval(updateColonies, POLL.colonies);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
