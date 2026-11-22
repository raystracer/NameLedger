// Pure formatters: wei amounts, addresses, dates and HTML escaping.


(function (global) {
  const T = global.T;
  const t = (...a) => T.t(...a);
  const ONE = 10n ** 18n;

  // Parse an ETH amount into wei.
  function parseEther(s) {
    const raw = String(s).trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(t("金额格式不正确"));
    const [w, f = ""] = raw.split(".");
    return BigInt(w) * ONE + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
  }

  // Format wei as an ETH amount.
  function formatEther(v) {
    const x = BigInt(v);
    const w = x / ONE;
    const f = (x % ONE).toString().padStart(18, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  }

  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");

  // Short ETH amount for cards.
  function fmtEthShort(v) {
    const x = BigInt(v);
    const w = x / ONE;
    const dp = w.toString().length >= 4 ? 2 : 4;
    const frac = ((x % ONE) * BigInt(10) ** BigInt(dp)) / ONE;
    const s = frac.toString().padStart(dp, "0").replace(/0+$/, "");
    return s ? `${w}.${s}` : `${w}`;
  }

  // Format a timestamp as a date.
  function fmtDate(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Format a duration in blocks or days.
  function fmtDur(sec) {
    const s = Math.max(0, Math.floor(sec));
    if (s >= 86400) return t("{0} 天", Math.floor(s / 86400));
    if (s >= 3600) return t("{0} 小时", Math.floor(s / 3600));
    if (s >= 60) return t("{0} 分钟", Math.floor(s / 60));
    return t("{0} 秒", s);
  }

  // Escape text for HTML.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const priceText = (p) => (BigInt(p) === 0n ? t("赠送") : formatEther(p) + " ETH");

  global.Fmt = {
    parseEther,
    formatEther,
    shortAddr,
    fmtEthShort,
    fmtDate,
    fmtDur,
    esc,
    priceText,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
