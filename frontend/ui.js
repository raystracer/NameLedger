// Stateless HTML fragments shared by the pages.


(function (global) {
  const T = global.T;
  const t = (...a) => T.t(...a);
  const { shortAddr } = global.Fmt;
  const ONE = 10n ** 18n;

  const icon = (name, cls) => `<svg class="icon${cls ? " " + cls : ""}"><use href="#i-${name}"/></svg>`;

  // Inline ETH amount.
  function ethNum(v) {
    const x = BigInt(v);
    const w = x / ONE;
    const f = (x % ONE).toString().padStart(18, "0").replace(/0+$/, "");
    if (!f) return String(w);
    return `${w}.${f.length > 4 ? f.slice(0, 4) : f}`;
  }

  const addrLink = (a, label) =>
    a ? `<a class="addr" href="#/account/${a.toLowerCase()}">${label || shortAddr(a)}</a>` : "";

  // Empty state box.
  function emptyBox(text, iconName) {
    return `<div class="empty">${icon(iconName || "record")}<span>${text}</span></div>`;
  }

  // Small section heading.
  function subhead(title) {
    return `<a class="backbtn" href="#/me">${icon("back")}${t("我的")}</a><div class="pagehead"><h1>${title}</h1></div>`;
  }

  global.UI = { icon, ethNum, addrLink, emptyBox, subhead };
})(typeof globalThis !== "undefined" ? globalThis : this);
