// Page shell: state, routing, rendering, actions and wallet connection.
// Loaded last; depends on i18n, abi, chain, fmt, dns and ui.
// Routes: #/ home, #/market listings, #/name/<name> detail, #/me account, #/account/<addr>.


(function () {
  "use strict";

  const A = window.ABI;
  const Chain = window.Chain;
  const {
    parseEther,
    formatEther,
    shortAddr,
    fmtEthShort,
    fmtDate,
    fmtDur,
    esc,
    priceText,
  } = window.Fmt;
  const {
    RECORD_TYPES,
    parseIpv4,
    parseIpv6,
    arrToHex,
    encodeRecordSet,
    decodeRecordSet,
    explainRecords,
    checkRecord,
  } = window.DNS;
  const { icon, ethNum, addrLink, emptyBox, subhead } = window.UI;

  const DEFAULT_CONTRACT = "0xf090f16dEc8b6D24082Edd25B1C8D26f2bC86128";
  const DEFAULT_RPCS = [
    "http://127.0.0.1:8545",
    "http://127.0.0.1:8546",
    "http://127.0.0.1:8547",
  ];
  const SEPOLIA_FALLBACK = {
    contract: "0x74D67b2ab7a6a57fb9c96e3C7fDe93aAB6d098f7",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    scanBlocks: 5000,
    deployBlock: 12186698,
  };

  const ZERO = "0x0000000000000000000000000000000000000000";
  const ONE = 10n ** 18n;

  const $ = (id) => document.getElementById(id);
  const t = (...a) => window.T.t(...a);
  const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
  let chainNow = 0;
  const nowSec = () => chainNow || Math.floor(Date.now() / 1000);

  let me = null;
  let world = null;
  let busy = false;
  let hashHistory = [];

  const pendingTxs = [];

  const settling = new Map();
  let currentRawRecords = "0x";
  const filters = { type: "all", min: "", max: "", sort: "new", tab: "active", win: 24 * 3600 };

  function setKeyEditing(on) {
    const view = $("keyView");
    const box = $("keyEditBox");
    if (!view || !box) return;
    view.classList.toggle("hidden", on);
    box.classList.toggle("hidden", !on);
    if (on && $("keyAddr") && $("keyAddr").focus) $("keyAddr").focus();
  }

  async function readRecordSet(name) {
    try {
      const [hex] = await Chain.call("getRecords", [name]);
      return decodeRecordSet(hex);
    } catch (e) {
      return null;
    }
  }

  // Validate a name and return the error code.
  function nameError(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return t("域名不能为空");
    if (s.length > 253) return t("域名最多 253 个字符");
    if (!s.includes(".")) return t("至少两段，例如 shop.eth");
    for (const label of s.split(".")) {
      if (!label) return t("点号两边不能为空");
      if (label.length > 63) return t("每一段最多 63 个字符");
      if (!/^[a-z0-9-]+$/.test(label)) return t("只能用字母、数字和连字符");
      if (label.startsWith("-") || label.endsWith("-")) return t("连字符不能放在头尾");
    }
    return null;
  }

  let toastTimer = null;

  // Show a short toast message.
  function toast(text, kind) {
    const el = $("toast");
    if (!el) return;
    el.textContent = text;
    el.className = "toast " + (kind || "info");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
  }

  // Parse the location hash into a route object.
  function parseHash() {
    const h = (location.hash || "").replace(/^#/, "") || "/";
    if (h === "/" || h === "") return { page: "home" };
    if (h === "/market") return { page: "market" };
    if (h === "/me") return { page: "me" };
    if (h === "/me/domains") return { page: "me-domains" };
    if (h === "/me/orders") return { page: "me-orders" };
    if (h === "/me/balance") return { page: "me-balance" };
    const m = h.match(/^\/name\/(.+)$/);
    if (m) return { page: "name", name: decodeURIComponent(m[1]).toLowerCase() };
    const a = h.match(/^\/account\/(0x[0-9a-fA-F]{40})$/);
    if (a) return { page: "account", address: a[1].toLowerCase() };
    return { page: "home" };
  }

  const go = (path) => {
    location.hash = path;
  };

  function currentHash() {
    return location.hash || "#/";
  }

  function syncHistory() {
    const h = currentHash();
    if (hashHistory[hashHistory.length - 1] !== h) hashHistory.push(h);
    if (hashHistory.length > 12) hashHistory.shift();
  }

  function prevHash() {
    return hashHistory.length >= 2 ? hashHistory[hashHistory.length - 2] : "#/";
  }

  function listNav() {
    const back = prevHash();
    if (back.startsWith("#/me")) return { href: back, label: t("我的"), nav: "me" };
    if (back.startsWith("#/name/")) return { href: back, label: t("域名"), nav: "market" };
    if (back.startsWith("#/account/")) return { href: back, label: t("地址"), nav: "market" };
    if (back === "#/" || back === "" || back === "#") return { href: "#/", label: t("首页"), nav: "home" };
    return { href: back, label: t("市场"), nav: "market" };
  }

  // Render the current route and bind page handlers.
  async function render() {
    syncHistory();
    const route = parseHash();

    const nav = listNav();
    document.querySelectorAll("[data-nav]").forEach((el) => {
      const n = el.dataset.nav;
      const on =
        n === route.page ||
        (route.page.startsWith("me-") && n === "me") ||
        (route.page === "account" && n === "market") ||
        (route.page === "name" && n === nav.nav);
      el.classList.toggle("active", on);
    });

    const app = $("app");
    try {
      if (!world) {
        app.innerHTML = `<div class="state">${t("正在读取链上数据…")}</div>`;
        return;
      }
      const pages = {
        home: renderHome,
        market: renderMarket,
        name: () => renderName(route.name),
        me: renderMe,
        "me-domains": renderMeDomains,
        "me-orders": renderMeOrders,
        "me-balance": renderMeBalance,
      };
      if (route.page === "name") {
        const d = await Chain.domain(route.name);
        app.innerHTML = renderName(route.name, d);
        await fillNamePage(route.name, d);
      } else if (route.page === "account") {
        const acct = await Chain.loadAccount(route.address);
        app.innerHTML = renderAccount(route.address, acct);
      } else {
        app.innerHTML = (pages[route.page] || renderHome)();
      }
    } catch (e) {
      app.innerHTML = `<div class="state bad">${t("页面渲染出错：{0}", esc(e.message))}</div>`;
    }
    window.scrollTo(0, 0);
  }

  // Re-read chain state for the current route.
  async function refresh(force) {
    if (busy) {
      if (force) refreshQueued = true;
      return;
    }
    busy = true;
    try {
      world = await Chain.loadWorld(!!force);
      try {
        chainNow = await Chain.chainTime();
      } catch (e) {

      }
      me = Chain.cfg().account;
      if ($("acctBal")) {
        $("acctBal").textContent = me ? fmtEthShort(world.accountBalance) + " ETH" : "";
        $("acctBal").title = me ? formatEther(world.accountBalance) + " ETH" : "";
      }
      renderAcctBar();
      syncSignerMark();
      fillWalletSel();

      const wbtn = $("btnWallet");
      if (wbtn) {
        const canUse = Chain.walletList().length > 0;
        wbtn.classList.toggle("hidden", !canUse || Chain.cfg().signer === "wallet");
      }
    } catch (e) {
      $("app").innerHTML = `<div class="state bad">${esc(t(e.message))}</div>`;
      busy = false;
      return;
    }
    busy = false;
    await render();

    if (refreshQueued) {
      refreshQueued = false;
      await refresh(true);
    }
  }

  function listingCard(d) {
    return `
      <a class="listing" href="#/name/${encodeURIComponent(d.name)}">
        <div class="ltop">
          <span class="lname">${esc(d.name)}</span>
          <span class="badge ${d.open ? "ok" : "info"}">${icon(d.open ? "globe" : "target")}${
            d.open ? t("公开") : t("限定")
          }</span>
        </div>
        <div class="lprice">${ethNum(d.price)}<span class="unit">ETH</span></div>
        ${
          d.pending
            ? `<div class="lfoot warn">${icon("clock")}${t("确认中 · 还差 {0} 块", d.pendingBlocks)}</div>`
            : d.deadline === 0
              ? `<div class="lfoot">${icon("clock")}${t("无期限")}</div>`
              : `<div class="lfoot">${icon("clock")}${fmtDur(d.deadline - nowSec())}</div>`
        }
      </a>`;
  }

  // Home: search box, stats and the live listing board.
  function renderHome() {
    const listed = listedDomains();
    const volume = world.settled.reduce((s, x) => s + x.price, 0n);

    return `
      <section class="hero">
        <h1>${t("找到你的域名")}</h1>
        <div class="herosearch">
          ${icon("search")}
          <input id="homeSearch" placeholder="${t("输入域名，例如 shop.eth")}" autocomplete="off" />
          <button data-action="home-search">${t("搜索")}</button>
        </div>
      </section>

      <div class="statsstrip">
        <div class="statitem">
          <div class="num">${listed.length}</div>
          <div class="cap">${t("在售域名")}</div>
        </div>
        <div class="statitem">
          <div class="num">${world.settled.length}</div>
          <div class="cap">${t("最近成交")}</div>
        </div>
        <div class="statitem">
          <div class="num">${ethNum(volume)}<span class="unit">ETH</span></div>
          <div class="cap">${t("最近成交额")}</div>
        </div>
      </div>

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${t("正在出售")}</h2>
          <a class="section-action" href="#/market">${t("查看全部")}${icon("chev")}</a>
        </div>
        ${listed.length ? `<div class="grid-listings">${listed.slice(0, 6).map(listingCard).join("")}</div>` : emptyBox(t("暂无在售域名"), "store")}
      </section>`;
  }

  const listedDomains = () => world.listed;

  function applyFilters(list) {
    let out = list.slice();
    if (filters.type === "open") out = out.filter((d) => d.open);
    if (filters.type === "directed") out = out.filter((d) => !d.open);
    try {
      if (filters.min.trim() !== "") {
        const m = parseEther(filters.min);
        out = out.filter((d) => d.price >= m);
      }
      if (filters.max.trim() !== "") {
        const m = parseEther(filters.max);
        out = out.filter((d) => d.price <= m);
      }
    } catch (e) {

    }
    if (filters.sort === "price-asc") out.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    else if (filters.sort === "price-desc") out.sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
    else out.sort((a, b) => b.deadline - a.deadline);
    return out;
  }

  // Market: filters over the listing set.
  function renderMarket() {
    const listed = listedDomains();
    const volume = world.settled.reduce((s, x) => s + x.price, 0n);

    const tabs = `
      <div class="segment">
        <button class="${filters.tab === "active" ? "active" : ""}" data-action="market-tab" data-tab="active">${t(
          "在售"
        )} ${listed.length}</button>
        <button class="${filters.tab === "sold" ? "active" : ""}" data-action="market-tab" data-tab="sold">${t(
          "已成交"
        )} ${world.settled.length}</button>
      </div>`;

    if (filters.tab === "sold") {
      return `
        <section class="section">
          <div class="toolbar">${tabs}</div>
          <div class="list">
            ${world.settled
              .map(
                (s) => `
              <div class="listrow">
                <div class="lr-main">
                  <a class="lr-name" href="#/name/${encodeURIComponent(s.name)}">${esc(s.name)}</a>
                  <div class="lr-sub">${t("买家")} ${addrLink(s.buyer)}</div>
                </div>
                <div class="lr-price">${ethNum(s.price)}<span class="unit">ETH</span></div>
              </div>`
              )
              .join("")}
          </div>
          ${world.settled.length ? "" : emptyBox(t("还没有成交记录"), "receipt")}
        </section>`;
    }

    const shown = applyFilters(listed);
    return `
      <section class="section">
        <div class="toolbar">
          ${tabs}
          <div class="filters">
            <select data-filter="type">
              <option value="all" ${filters.type === "all" ? "selected" : ""}>${t("全部")}</option>
              <option value="open" ${filters.type === "open" ? "selected" : ""}>${t("公开出售")}</option>
              <option value="directed" ${filters.type === "directed" ? "selected" : ""}>${t("限定买家")}</option>
            </select>
            <input data-filter="min" placeholder="${t("最低价")}" value="${esc(filters.min)}" size="8" />
            <input data-filter="max" placeholder="${t("最高价")}" value="${esc(filters.max)}" size="8" />
            <select data-filter="sort">
              <option value="new" ${filters.sort === "new" ? "selected" : ""}>${t("最新")}</option>
              <option value="price-asc" ${filters.sort === "price-asc" ? "selected" : ""}>${t("价格低到高")}</option>
              <option value="price-desc" ${filters.sort === "price-desc" ? "selected" : ""}>${t("价格高到低")}</option>
            </select>
          </div>
        </div>
        ${
          shown.length
            ? `<div class="grid-listings">${shown.map(listingCard).join("")}</div>`
            : emptyBox(t("没有符合条件的挂单"), "search")
        }
      </section>`;
  }

  function listingOf(name, d) {
    if (!d || !d.registered || !d.listed) return null;
    return {
      price: d.price,
      buyer: d.buyer,
      deadline: d.deadline,
      open: d.open,
      persisted: !!(world.registered && world.registered.has(String(name).toLowerCase())),
    };
  }

  // Name page: ownership, records, listing and history.
  function renderName(name, d) {
    const registered = !!d && d.registered;
    const isOwner = registered && same(d.owner, me);
    const inListing = listingOf(name, d);
    const listed = !!inListing;
    const canBuy = listed && !isOwner && (inListing.open || same(inListing.buyer, me));
    const nav = listNav();

    const badges = [];
    if (!registered) badges.push(`<span class="badge ok">${t("可注册")}</span>`);
    if (isOwner) badges.push(`<span class="badge">${t("我持有")}</span>`);
    if (listed) {
      badges.push(
        `<span class="badge ${inListing.open ? "ok" : "info"}">${icon(inListing.open ? "globe" : "target")}${
          inListing.open ? t("公开出售") : t("限定买家")
        }</span>`
      );
      if (!inListing.persisted) badges.push(`<span class="badge warn">${icon("record")}${t("广播")}</span>`);
    }

    const copyable = (value) => `
      <div class="iv" title="${esc(value)}">${addrLink(value, value)}</div>
      <button class="act" data-action="copy" data-copy="${esc(value)}" title="${t("复制")}">${icon("copy")}</button>`;

    const rows = [];
    if (registered) {
      rows.push(
        `<div class="inforow"><span class="ik">${t("所有者")}</span>${copyable(d.owner)}</div>`,
        `<div class="inforow"><span class="ik">${t("DNS 编辑权限")}</span>${copyable(d.key)}</div>`,
        `<div class="inforow"><span class="ik">${t("到期")}</span><div class="iv">${fmtDate(d.expiry)}</div><span class="badge">${icon(
          "clock"
        )}${fmtDur(d.expiry - nowSec())}</span></div>`
      );
    } else {
      rows.push(
        `<div class="inforow"><span class="ik">${t("状态")}</span><div class="iv plain">${t("尚未注册")}</div><span></span></div>`,
        `<div class="inforow"><span class="ik">${t("注册价")}</span><div class="iv">${ethNum(
          world.fee
        )} ETH</div><span class="badge">${t("/ 年")}</span></div>`
      );
    }

    let side = "";
    if (!registered) {
      side = `
        <div class="cta-card">
          <div class="cta-price">${ethNum(world.fee)}<span class="unit">ETH</span></div>
          <button class="primary cta" id="ctaMain" data-action="register" data-name="${esc(name)}">${t("注册")}</button>
        </div>`;
    } else if (isOwner) {
      side = `
        <div class="cta-card">
          <div class="cta-price">${ethNum(world.fee)}<span class="unit">ETH</span></div>
          <button class="primary cta" id="ctaMain" data-action="renew" data-name="${esc(name)}">${t("续费")}</button>
        </div>`;
    } else if (canBuy) {
      side = `
        <div class="cta-card">
          <div class="cta-price">${ethNum(inListing.price)}<span class="unit">ETH</span></div>
          ${
            inListing.open
              ? ""
              : `<div class="cta-tags"><span class="badge info">${icon("target")}${t("限定买家")}</span></div>`
          }
          <button class="primary cta" id="ctaMain" data-action="buy" data-name="${esc(name)}">${
        BigInt(inListing.price) === 0n ? t("免费领取") : t("购买")
      }</button>
        </div>`;
    } else if (listed) {
      side = `
        <div class="cta-card">
          <div class="cta-price">${ethNum(inListing.price)}<span class="unit">ETH</span></div>
          <div class="cta-tags"><span class="badge info">${icon("target")}${t("限定买家")}</span></div>
          <button class="cta" disabled>${t("不可购买")}</button>
        </div>`;
    }

    return `
      <a class="backbtn" href="${nav.href}">${icon("back")}${nav.label}</a>
      <div class="namehead">
        <h1 class="nametitle">${esc(name)}</h1>
        <div class="chips" id="nameChips">${badges.join("")}</div>
      </div>
      <div class="detail-layout${side ? "" : " single"}">
        <div class="detail-main">
          <div class="card"><div class="card-body">${rows.join("")}</div></div>
          <div id="nameExtra"></div>
        </div>
        ${side ? `<aside class="detail-side" id="nameSide">${side}</aside>` : `<div id="nameSide" hidden></div>`}
      </div>`;
  }

  // Human-readable text for one event.
  function describeEvent(e) {
    const d = e.data;
    const eth = (v) => ethNum(BigInt(v)) + " ETH";
    const zero = "0x0000000000000000000000000000000000000000";
    const op = e.from && e.from !== zero ? addrLink(e.from) : "";
    switch (e.event) {
      case "Registered":
        return { icon: "plus", label: t("注册"), detail: addrLink(d.owner) };
      case "Renewed":
        return { icon: "refresh", label: t("续期"), detail: op };
      case "Transferred":
        return { icon: "user", label: t("过户"), detail: addrLink(d.from) + " → " + addrLink(d.to) };
      case "SigningKeyChanged":
        return {
          icon: "key",
          label: t("编辑权限变更"),
          detail: addrLink(d.signingKey) + " · " + t("版本 {0}", d.keyVersion),
        };
      case "SaleApproved":
        return {
          icon: "tag",
          label: t("挂单"),
          detail: eth(d.price) + " · " + (d.buyer === zero ? t("公开出售") : addrLink(d.buyer)),
        };
      case "SaleCancelled":
        return { icon: "x", label: t("撤销挂单"), detail: t("操作者 {0}", op) };
      case "Settled":
        return {
          icon: "check",
          label: t("成交"),
          detail: eth(d.price) + " · " + addrLink(d.seller) + " → " + addrLink(d.buyer),
        };
      case "RecordsUpdated":
        return { icon: "record", label: t("更新 DNS 记录"), detail: addrLink(d.writer) };
      case "Expired":
        return { icon: "alert", label: t("到期回收"), detail: t("操作者 {0}", op) };
      default:
        return { icon: "record", label: e.event, detail: "" };
    }
  }

  // Event log for one name, newest first.
  function renderHistory(entries, scanBlocks) {
    const head = `
      <div class="section-head">
        <h2 class="section-title">${t("活动记录")}</h2>
        <span class="badge" title="${t("最近 {0} 个块", Number(scanBlocks).toLocaleString("en-US"))}">${icon("clock")}${Number(scanBlocks).toLocaleString("en-US")} ${t("块")}</span>
      </div>`;

    if (!entries.length) {
      return `<div class="card"><div class="card-body">${head}${emptyBox(t("这个范围内没有变动"), "clock")}</div></div>`;
    }

    const items = entries
      .slice()
      .reverse()
      .map((e) => {
        const d = describeEvent(e);
        return `<div class="tl-item">
          <span class="tl-icon">${icon(d.icon)}</span>
          <div class="tl-body">
            <div class="tl-title">${d.label}</div>
            ${d.detail ? `<div class="tl-detail">${d.detail}</div>` : ""}
          </div>
          <span class="tl-time">${fmtAgo(e.ts)}</span>
        </div>`;
      })
      .join("");

    return `<div class="card"><div class="card-body">${head}<div class="timeline">${items}</div></div></div>`;
  }

  function fmtAgo(ts) {
    if (!ts) return "";
    return t("{0}前", fmtDur(nowSec() - ts));
  }

  // DNS records table with per-type formatting.
  function renderDnsTable(recordSet, isOwner, name) {
    if (recordSet === null) {
      return `<div class="empty">${icon("record")}<span>${t("旧格式记录")}</span></div>
        <div class="mono muted" style="font-size:12px;word-break:break-all">${esc(currentRawRecords)}</div>
        ${
          isOwner
            ? `<div class="formrow end" style="margin-top:14px"><button class="subtle" data-action="dns-reset" data-name="${esc(
                name
              )}">${t("清空并改用记录表")}</button></div>`
            : ""
        }`;
    }
    if (!recordSet.length) return emptyBox(t("还没有 DNS 记录"), "record");

    const rows = recordSet
      .map(
        (r, i) => `<tr>
          <td>${esc(r.name)}</td>
          <td><span class="rtype">${esc(r.type)}</span></td>
          <td class="val">${esc(r.value)}</td>
          ${
            isOwner
              ? `<td><button class="act danger" data-action="dns-del" data-name="${esc(
                  name
                )}" data-index="${i}" title="${t("删除")}">${icon("trash")}</button></td>`
              : "<td></td>"
          }
        </tr>`
      )
      .join("");

    return `<table class="rectable">
      <thead><tr><th>${t("名称")}</th><th>${t("类型")}</th><th>${t("内容")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Load chain data for the name page.
  async function fillNamePage(name, d) {
    const box = $("nameExtra");
    if (!box) return;

    if (!d || !d.registered) {
      box.innerHTML = "";
      return;
    }

    let records = "0x";
    try {
      records = (await Chain.call("getRecords", [name]))[0];
    } catch (e) {
      records = "0x";
    }

    const isOwner = same(d.owner, me);

    let history = [];
    try {
      history = await Chain.loadNameHistory(name);
    } catch (e) {
      history = [];
    }

    let fin = lastFinality;
    if (!fin) {
      try {
        fin = await Chain.finality();
      } catch (e) {
        fin = null;
      }
    }

    const lastAct = history.length ? history[history.length - 1].block : 0;
    const chainLeft = fin ? Math.max(0, lastAct - fin.finalized) : 0;
    const waiting = isSettling(name) || chainLeft > 0;
    const left = Math.max(settleLeft(name), chainLeft);

    const lname = String(name).toLowerCase();
    if (chainLeft > 0) {
      if (!settling.has(lname)) settling.set(lname, { block: lastAct, derived: true });
    } else {
      const cur = settling.get(lname);
      if (cur && cur.derived) settling.delete(lname);
    }
    const inListing = listingOf(name, d);
    currentRawRecords = records;
    const recordSet = decodeRecordSet(records);

    box.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div class="section-head">
            <h2 class="section-title">${t("DNS 记录")}</h2>
            ${
              isOwner
                ? `<button class="section-action" data-action="dns-open" data-name="${esc(name)}" ${
                    waiting ? `disabled title="${t("链上确认中")}"` : ""
                  }>${icon("plus")}${t("添加记录")}</button>`
                : ""
            }
          </div>
          ${renderDnsTable(recordSet, isOwner, name)}
          ${
            isOwner
              ? `<div id="dnsForm" class="dnsform hidden">
                   <div class="formrow">
                     <div class="fieldcol"><span>${t("名称")}</span><input id="dnsName" value="@" /></div>
                     <div class="fieldcol"><span>${t("类型")}</span>
                       <select id="dnsType">${RECORD_TYPES.map((x) => `<option>${x}</option>`).join("")}</select>
                     </div>
                     <div class="fieldcol grow">
                       <span>${t("内容")}</span>
                       <input id="dnsValue" placeholder="1.2.3.4" />
                       <div id="recPreview" class="recpreview"></div>
                     </div>
                   </div>
                   <div class="formrow end">
                     <button class="subtle" data-action="dns-cancel">${t("取消")}</button>
                     <button class="primary" data-action="dns-add" data-name="${esc(name)}">${t("添加")}</button>
                   </div>
                 </div>`
              : ""
          }
        </div>
      </div>`;

    box.insertAdjacentHTML("beforeend", renderHistory(history, world.scanBlocks));

    if (waiting) {
      const lag = fin && fin.lag ? fin.lag : Math.max(left, 1);
      const pct = Math.max(4, Math.min(100, Math.round((1 - left / lag) * 100)));

      const cta = $("ctaMain");
      if (cta) {
        cta.disabled = true;
        cta.classList.add("pending");
        cta.innerHTML =
          `<span class="cta-wait">${t("等待落地")}</span>` +
          `<span class="cta-eta">${t("还差 {0} 块", left)}</span>` +
          `<i class="cta-bar" style="width:${pct}%"></i>`;
        cta.title = t("链上确认中");
      }

    }

    if (isOwner) {
      const side = $("nameSide");
      if (side) side.insertAdjacentHTML("beforeend", `
        <div class="card">
            <div class="card-body">
              <div class="section-head">
                <h2 class="section-title">${t("挂单")}</h2>
                ${
                  inListing
                    ? `<button class="section-action" data-action="cancel" data-name="${esc(name)}">${icon(
                        "x"
                      )}${t("撤销挂单")}</button>`
                    : ""
                }
              </div>
              ${
                inListing
                  ? `<div class="kvlist">
                      <div><span class="k">${t("价格")}</span><span class="v">${ethNum(inListing.price)} ETH</span></div>
                      <div><span class="k">${t("买家")}</span><span class="v">${
                        inListing.open ? t("公开出售") : shortAddr(inListing.buyer)
                      }</span></div>
                      <div><span class="k">${t("挂单方式")}</span><span class="v">${
                        inListing.persisted ? t("登记挂单") : t("广播挂单")
                      }</span></div>
                      <div><span class="k">${t("剩余")}</span><span class="v">${
                        inListing.deadline === 0
                          ? t("无期限")
                          : fmtDur(inListing.deadline - nowSec())
                      }</span></div>
                    </div>`
                  : `<div class="formgrid">
                      <div class="fieldcol span2"><span>${t("买家地址")}</span><input id="sellBuyer" placeholder="${t(
                        "留空则公开出售"
                      )}" /></div>
                      <div class="fieldcol"><span>${t("价格 (ETH)")}</span><input id="sellPrice" value="1" /></div>
                      <div class="fieldcol"><span>${t("挂单方式")}</span>
                        <select id="sellMode">
                          <option value="persist">${t("登记挂单")}</option>
                          <option value="broadcast">${t("广播挂单")}</option>
                        </select>
                      </div>
                      <div class="fieldcol span2">
                        <label class="check"><input type="checkbox" id="sellExpiryOn" /> ${t("设置截止时间")}</label>
                        <input id="sellHours" class="hidden" placeholder="${t('24 小时')}" />
                      </div>
                     </div>
                     <div class="formrow end">
                      <button class="primary" data-action="sell" data-name="${esc(name)}" ${waiting ? `disabled title="${t("链上确认中")}"` : ""}>${t("挂单出售")}</button>
                     </div>`
              }
            </div>
          </div>
          <div class="card">
            <div class="card-body">
              <div class="section-head">
                <h2 class="section-title">${t("DNS 编辑权限")}</h2>
              </div>
              <div class="formrow nowrap" id="keyView">
                <div class="readonly">${esc(d.key)}</div>
                <button class="act" data-action="key-edit" title="${t("修改")}" ${waiting ? `disabled title="${t("链上确认中")}"` : ""}>${icon("pencil")}</button>
              </div>
              <div class="formrow nowrap hidden" id="keyEditBox">
                <input id="keyAddr" value="${esc(d.key)}" placeholder="0x" style="flex:1;min-width:0" />
                <button class="act" id="keyCancelBtn" data-action="key-cancel" title="${t("取消")}">${icon("x")}</button>
                <button class="act" id="keySaveBtn" data-action="key-save" data-name="${esc(name)}" title="${t(
                  "保存"
                )}">${icon("check")}</button>
              </div>
            </div>
          </div>`
        );
    }

    const editBtn = $("keyEditBtn");
    if (editBtn) editBtn.className = "act";
  }

  // Public account page.
  function renderAccount(address, a) {
    if (!a) return `<div class="state">${t("读不到这个地址")}</div>`;

    const nav = listNav();
    const head = `
      <a class="backbtn" href="${nav.href}">${icon("back")}${nav.label}</a>
      <div class="accthead">
        <span class="avatar lg"></span>
        <h1 class="acctaddr">${esc(address)}</h1>
        <button class="act" data-action="copy" data-copy="${esc(address)}" title="${t("复制")}">${icon("copy")}</button>
      </div>`;

    const stats = `
      <div class="statsstrip left">
        <div class="statitem"><div class="num">${a.domains.length}</div><div class="cap">${t("持有域名")}</div></div>
        <div class="statitem"><div class="num">${a.listings.length}</div><div class="cap">${t("在售")}</div></div>
        <div class="statitem"><div class="num">${ethNum(a.earnings)}<span class="unit">ETH</span></div><div class="cap">${t("可提现")}</div></div>
        <div class="statitem"><div class="num">${ethNum(a.balance)}<span class="unit">ETH</span></div><div class="cap">${t("余额")}</div></div>
      </div>`;

    const domains = a.domains.length
      ? `<div class="list">${a.domains
          .map(
            (d) => `
          <a class="listrow" href="#/name/${encodeURIComponent(d.name)}">
            <div class="lr-main">
              <div class="lr-name">${esc(d.name)}</div>
              <div class="lr-sub">${t("到期 {0}", fmtDate(d.expiry))}</div>
            </div>
            ${
              d.listed
                ? `<span class="badge ok">${icon("globe")}${t("在售")}</span>`
                : `<span class="badge">${t("未挂单")}</span>`
            }
            <span class="act">${icon("chev")}</span>
          </a>`
          )
          .join("")}</div>`
      : emptyBox(t("这个地址没有域名"), "grid");

    const sales = a.sales.length
      ? `<div class="list">${a.sales
          .slice()
          .reverse()
          .map(
            (s) => `
          <div class="listrow">
            <div class="lr-main">
              <a class="lr-name" href="#/name/${encodeURIComponent(s.name)}">${esc(s.name)}</a>
              <div class="lr-sub">${
                same(s.seller, address) ? t("卖出给 {0}", addrLink(s.buyer)) : t("买入自 {0}", addrLink(s.seller))
              }</div>
            </div>
            <div class="lr-price">${ethNum(s.price)}<span class="unit">ETH</span></div>
          </div>`
          )
          .join("")}</div>`
      : emptyBox(t("这个范围内没有成交"), "receipt");

    return `
      ${head}
      ${stats}
      <section class="section">
        <div class="section-head"><h2 class="section-title">${t("持有的域名")}</h2></div>
        ${domains}
      </section>
      <section class="section">
        <div class="section-head"><h2 class="section-title">${t("最近成交")}</h2></div>
        ${sales}
      </section>`;
  }

  // Refresh pending transaction timers.
  async function tickPending() {
    if (!pendingTxs.length) return;
    let fin = null;
    try {
      fin = await Chain.finality();
    } catch (e) {

    }
    if (!fin) return;

    let matured = false;

    for (const x of pendingTxs) {
      if (x.done || x.reorged || !x.blockHash) continue;
      try {
        const blk = await Chain.rpc("eth_getBlockByNumber", ["0x" + x.block.toString(16), false]);
        if (blk && blk.hash && blk.hash !== x.blockHash) {
          x.reorged = true;
          x.reorgedAt = Date.now();
          toast(t("这笔交易已经被重组掉了"), "bad");
          Chain.invalidate();
          matured = true;
        }
      } catch (e) {

      }
    }

    for (const x of pendingTxs) {
      if (x.done || x.reorged) continue;
      if (x.block <= fin.finalized) {
        x.done = true;
        x.doneAt = Date.now();
        matured = true;
      }
    }

    lastFinality = fin;

    let cleared = false;
    for (const [name, s] of [...settling]) {
      if (s.block <= fin.finalized) {
        settling.delete(name);
        cleared = true;
      }
    }
    if (cleared) matured = true;

    if (pendingTxs.every((x) => x.done || x.reorged)) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }

    if (matured) await refresh(true);
  }

  function isSettling(name) {
    return !!(name && settling.has(String(name).toLowerCase()));
  }

  function settleLeft(name) {
    const s = settling.get(String(name).toLowerCase());
    if (!s) return 0;
    if (!lastFinality) return 1;
    return Math.max(0, s.block - lastFinality.finalized);
  }

  // Track a pending transaction until it is finalized.
  function trackTx(label, receipt, name) {
    if (name) {
      settling.set(String(name).toLowerCase(), { block: receipt.blockNumber, label, hash: receipt.hash });
    }
    pendingTxs.push({
      label,
      block: receipt.blockNumber,
      hash: receipt.hash,
      blockHash: receipt.blockHash,
      done: false,
      doneAt: 0,
      reorged: false,
    });
    if (pendingTxs.length > 6) pendingTxs.shift();
    if (!pendingTimer) pendingTimer = setInterval(tickPending, 2500);
  }

  let pendingTimer = null;
  let lastFinality = null;
  let refreshQueued = false;

  // Account hub for the connected wallet.
  function renderMe() {
    if (!me) return `<div class="state">${t("请先在右上角连接账户")}</div>`;

    const mine = world.mine;
    const listed = world.myListings;
    const incoming = world.incoming;

    const card = (href, iconName, title, sub) => `
      <a class="hubcard" href="${href}">
        <span class="hubicon">${icon(iconName)}</span>
        <span class="hubtext">
          <span class="hubtitle">${title}</span>
          ${sub ? `<span class="hubsub">${sub}</span>` : ""}
        </span>
        <span class="hubchev">${icon("chev")}</span>
      </a>`;

    return `
      <div class="hubwrap">
        <div class="pagehead"><h1>${t("我的")}</h1></div>
        <div class="hub">
          ${card("#/me/domains", "grid", t("管理域名"), t("{0} 个域名", mine.length))}
          ${card("#/me/orders", "receipt", t("订单"), t("{0} 笔待接手", incoming.length))}
          ${card("#/me/balance", "wallet", t("余额"), t("可提现 {0} ETH", ethNum(world.earnings)))}
          ${card("#/market", "store", t("购买域名"), "")}
        </div>
      </div>`;
  }

  // Names held by the current account.
  function renderMeDomains() {
    if (!me) return `<div class="state">${t("请先在右上角连接账户")}</div>`;
    const mine = world.mine;

    return `
      ${subhead(t("管理域名"))}
      ${
        mine.length
          ? `<div class="list">${mine
              .map(
                (d) => `
            <div class="listrow">
              <div class="lr-main">
                <a class="lr-name" href="#/name/${encodeURIComponent(d.name)}">${esc(d.name)}</a>
                <div class="lr-sub">${t("到期 {0}", fmtDate(d.expiry))}</div>
              </div>
              ${
                d.listed
                  ? `<span class="badge ok">${icon("globe")}${t("在售")}</span>`
                  : `<span class="badge">${t("未挂单")}</span>`
              }
              <a class="act" href="#/name/${encodeURIComponent(d.name)}" title="${t("管理")}">${icon("chev")}</a>
            </div>`
              )
              .join("")}</div>`
          : emptyBox(t("还没有域名"), "grid")
      }`;
  }

  // Listings and settlements for the current account.
  function renderMeOrders() {
    if (!me) return `<div class="state">${t("请先在右上角连接账户")}</div>`;
    const mine = world.myListings;
    const incoming = world.incoming;
    const settled = world.mySettled;

    const group = (title, count, rows, emptyText, emptyIcon) => `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${title} <span class="muted">${count}</span></h2>
        </div>
        ${rows || emptyBox(emptyText, emptyIcon)}
      </section>`;

    const mineRows = mine.length
      ? `<div class="list">${mine
          .map(
            (d) => `
        <div class="listrow">
          <div class="lr-main">
            <a class="lr-name" href="#/name/${encodeURIComponent(d.name)}">${esc(d.name)}</a>
            <div class="lr-sub">${d.open ? t("公开出售") : t("限定买家 {0}", addrLink(d.buyer))}</div>
          </div>
          <div class="lr-price">${ethNum(d.price)}<span class="unit">ETH</span></div>
          <div class="lr-actions">
            <button class="act danger" data-action="cancel" data-name="${esc(d.name)}" ${
              isSettling(d.name) || d.pending ? "disabled" : ""
            } title="${isSettling(d.name) || d.pending ? t("链上确认中") : t("撤销挂单")}">${icon("x")}</button>
          </div>
        </div>`
          )
          .join("")}</div>`
      : "";

    const incomingRows = incoming.length
      ? `<div class="list">${incoming
          .map(
            (d) => `
        <div class="listrow">
          <div class="lr-main">
            <a class="lr-name" href="#/name/${encodeURIComponent(d.name)}">${esc(d.name)}</a>
            <div class="lr-sub">${t("来自 {0}", addrLink(d.owner))}</div>
          </div>
          <div class="lr-price">${ethNum(d.price)}<span class="unit">ETH</span></div>
          <div class="lr-actions">
            <button class="primary" style="height:32px;padding:0 14px" data-action="buy" data-name="${esc(
              d.name
            )}" ${isSettling(d.name) || d.pending ? "disabled" : ""}>${t("接手")}</button>
          </div>
        </div>`
          )
          .join("")}</div>`
      : "";

    const settledRows = settled.length
      ? `<div class="list">${settled
          .map(
            (s) => `
        <div class="listrow">
          <div class="lr-main">
            <a class="lr-name" href="#/name/${encodeURIComponent(s.name)}">${esc(s.name)}</a>
            <div class="lr-sub">${
              same(s.seller, me) ? t("卖出给 {0}", addrLink(s.buyer)) : t("买入自 {0}", addrLink(s.seller))
            }</div>
          </div>
          <div class="lr-price">${ethNum(s.price)}<span class="unit">ETH</span></div>
        </div>`
          )
          .join("")}</div>`
      : "";

    return `
      ${subhead(t("订单"))}
      ${group(t("我挂出的"), mine.length, mineRows, t("没有挂单"), "receipt")}
      ${group(t("给我的挂单"), incoming.length, incomingRows, t("没有待接手的订单"), "receipt")}
      ${group(t("最近成交"), settled.length, settledRows, t("这个范围内没有成交"), "receipt")}`;
  }

  // Withdrawable balance and fee status.
  function renderMeBalance() {
    if (!me) return `<div class="state">${t("请先在右上角连接账户")}</div>`;
    const sold = world.mySettled.filter((s) => same(s.seller, me));
    const volume = sold.reduce((a, b) => a + b.price, 0n);
    const income = world.earnings;

    return `
      ${subhead(t("余额"))}
      <div class="statsstrip left">
        <div class="statitem">
          <div class="num">${ethNum(income)}<span class="unit">ETH</span></div>
          <div class="cap">${t("可提现")}</div>
        </div>
        <div class="statitem">
          <div class="num">${ethNum(volume)}<span class="unit">ETH</span></div>
          <div class="cap">${t("累计卖出")}</div>
        </div>
        <div class="statitem">
          <div class="num">${sold.length}</div>
          <div class="cap">${t("卖出笔数")}</div>
        </div>
      </div>
      <div class="card" style="max-width:420px">
        <div class="card-body">
          <div class="formrow">
            <div class="fieldcol grow"><span>${t("可提现余额")}</span><div class="readonly">${ethNum(
              income
            )} ETH</div></div>
            <button class="primary" ${income === 0n ? "disabled" : ""} data-action="withdraw">${t("提现")}</button>
          </div>
        </div>
      </div>`;
  }

  let txInFlight = false;

  // Send one transaction and track it until finality.
  async function doTx(fn, args, value, okText, name) {
    if (txInFlight) {
      toast(t("上一笔还在处理，稍等"), "bad");
      return;
    }
    txInFlight = true;
    try {
      toast(t("交易已提交…"));
      const r = await Chain.send(fn, args, value);
      if (!r.ok) throw new Error(r.reason ? t(r.reason) : t("交易失败"));
      toast(okText, "ok");
      if (r.blockNumber) trackTx(okText, r, name);
      Chain.invalidate();
      await refresh(true);
    } catch (e) {
      toast(t(e.message), "bad");
    } finally {
      txInFlight = false;
    }
  }

  const WRITE_ACTIONS = new Set([
    "register",
    "renew",
    "buy",
    "sell",
    "cancel",
    "dns-add",
    "dns-del",
    "dns-reset",
    "key-save",
  ]);

  // Dispatch button actions by data-act.
  async function act(action, name, el) {
    if (name && WRITE_ACTIONS.has(action) && isSettling(name)) {
      const lname = String(name).toLowerCase();
      const s = settling.get(lname) || {};
      let still = true;
      if (s.derived) {
        try {
          const fin = await Chain.finality();
          lastFinality = fin;
          if (s.block <= fin.finalized) {
            settling.delete(lname);
            still = false;
          }
        } catch (e) {

        }
      }
      if (still) {
        toast(t("上一笔操作还没落地，稍等"), "bad");
        return;
      }
    }
    switch (action) {
      case "copy": {
        const v = el.dataset.copy || "";
        try {
          await navigator.clipboard.writeText(v);
          toast(t("已复制"), "ok");
        } catch (e) {
          toast(t("复制失败"), "bad");
        }
        break;
      }
      case "home-search": {
        const v = $("homeSearch").value.trim().toLowerCase();
        if (!v) break;
        const bad = nameError(v);
        if (bad) {
          toast(bad, "bad");
          break;
        }
        go("/name/" + encodeURIComponent(v));
        break;
      }
      case "market-tab":
        filters.tab = el.dataset.tab;
        await render();
        break;
      case "register":
        const bad = nameError(name);
        if (bad) {
          toast(bad, "bad");
          return;
        }
        await doTx("register", [name], world.fee, t("注册成功"), name);
        break;
      case "renew":
        await doTx("renew", [name], world.fee, t("续期成功"), name);
        break;
      case "cancel":
        await doTx("cancelApproval", [name], 0n, t("已撤销挂单"), name);
        break;
      case "buy": {
        const d = world.listed.find((x) => x.name === name) || world.mine.find((x) => x.name === name);
        if (!d) return;
        await doTx("buy", [name], d.price, t("交割完成"), name);
        break;
      }
      case "withdraw":
        await doTx("withdraw", [], 0n, t("已提现"));
        break;
      case "sell": {
        try {
          const buyerRaw = ($("sellBuyer") && $("sellBuyer").value.trim()) || "";
          const buyer = buyerRaw === "" ? ZERO : buyerRaw;
          if (buyer !== ZERO && !/^0x[0-9a-fA-F]{40}$/.test(buyer)) throw new Error(t("买家地址格式不正确"));
          const price = parseEther($("sellPrice").value);
          const persist = ($("sellMode") && $("sellMode").value === "persist") || false;

          const d = await Chain.domain(name);
          if (!d || !d.registered) throw new Error(t("读不到这个域名"));

          const expiryOn = !!($("sellExpiryOn") && $("sellExpiryOn").checked);
          let deadline;
          if (!expiryOn) {
            deadline = 0n;
          } else {
            const hours = Number(($("sellHours") && $("sellHours").value.trim()) || "24");
            if (!(hours > 0)) throw new Error(t("有效期必须大于 0"));
            deadline = BigInt(Math.min(nowSec() + Math.round(hours * 3600), d.expiry));
          }
          if (deadline !== 0n && Number(deadline) <= nowSec()) throw new Error(t("域名本身快到期了"));
          await doTx("approveSale", [name, buyer, price, deadline, persist], 0n, t("已挂单"), name);
        } catch (e) {
          toast(t(e.message), "bad");
        }
        break;
      }
      case "key-edit":
        setKeyEditing(true);
        break;
      case "key-cancel":
        setKeyEditing(false);
        break;
      case "key-save": {
        const key = $("keyAddr").value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(key)) return toast(t("钥匙地址格式不正确"), "bad");
        await doTx("setSigningKey", [name, key], 0n, t("编辑权限已更新"), name);
        setKeyEditing(false);
        break;
      }
      case "dns-open": {
        const form = $("dnsForm");
        if (form) {
          form.classList.remove("hidden");
          if ($("dnsValue")) $("dnsValue").focus();
        }
        break;
      }
      case "dns-cancel": {
        const form = $("dnsForm");
        if (form) form.classList.add("hidden");
        break;
      }
      case "dns-add": {
        const rn = ($("dnsName").value.trim() || "@").trim();
        const type = $("dnsType").value;
        const value = $("dnsValue").value.trim();
        const bad = checkRecord(rn, type, value);
        if (bad) return toast(bad, "bad");
        const set = (await readRecordSet(name)) || [];
        set.push({ name: rn, type, value });
        await doTx("setRecords", [name, encodeRecordSet(set)], 0n, t("已添加记录"), name);
        break;
      }
      case "dns-del": {
        const idx = Number(el.dataset.index);
        const set = await readRecordSet(name);
        if (!set || !set[idx]) return toast(t("记录已经变了，请刷新"), "bad");
        set.splice(idx, 1);
        await doTx("setRecords", [name, encodeRecordSet(set)], 0n, t("已删除记录"), name);
        break;
      }
      case "dns-reset": {
        await doTx("setRecords", [name, "0x"], 0n, t("已清空记录"), name);
        break;
      }
    }
  }

  // Live preview of the DNS record editor.
  function updateRecPreview() {
    const box = $("recPreview");
    const input = $("dnsValue");
    const sel = $("dnsType");
    if (!box || !input) return;

    const type = sel ? sel.value : "A";
    const raw = input.value.trim();
    box.className = "recpreview";

    if (type !== "A" && type !== "AAAA") {
      box.textContent = "";
      return;
    }
    if (!raw) {
      box.textContent = "";
      return;
    }

    const bytes = type === "A" ? parseIpv4(raw) : parseIpv6(raw);
    if (!bytes) {
      box.textContent = type === "A" ? t("不是有效的 IPv4 地址") : t("不是有效的 IPv6 地址");
      box.className = "recpreview bad";
      return;
    }
    box.textContent = t("字节 {0}", arrToHex(bytes));
    box.className = "recpreview ok";
  }

  // Apply translations to static nodes.
  function applyStaticLang() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      const arg = el.dataset.i18nArg;
      el.textContent = arg ? t(key, arg) : t(key);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    const lang = window.T.getLang();
    document.querySelectorAll("[data-net]").forEach((el) => {
      el.addEventListener("click", () => {
        const preset = networkPresets()[el.dataset.net];
        if (!preset) {
          toast(t("没有这条网络的配置"), "bad");
          return;
        }
        applyPreset(preset, el.dataset.net);
      });
    });

    document.querySelectorAll(".langbtn[data-lang]").forEach((el) => {
      el.classList.toggle("on", el.dataset.lang === lang);
    });
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }

  let filterTimer = null;

  // Bind global controls once on boot.
  function bind() {
    document.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-action]");
      if (!hit) return;
      e.preventDefault();
      act(hit.dataset.action, hit.dataset.name, hit);
    });

    document.addEventListener("change", async (e) => {
      if (e.target.id === "sellExpiryOn") {
        const box = $("sellHours");
        if (box) box.classList.toggle("hidden", !e.target.checked);
        return;
      }
      if (e.target.dataset.scan !== undefined) {
        const blocks = Number(e.target.value);
        Chain.setConfig({ scanBlocks: blocks });
        Chain.invalidate();
        await refresh(true);
        return;
      }
      const f = e.target.dataset.filter;
      if (!f) return;
      filters[f] = e.target.value;
      render();
    });

    document.addEventListener("input", (e) => {
      if (e.target.id === "dnsValue") {
        updateRecPreview();
        return;
      }
      if (e.target.id === "dnsType") {
        const v = $("dnsValue");
        if (v) {
          v.placeholder =
            e.target.value === "A" ? "1.2.3.4"
            : e.target.value === "AAAA" ? "2001:db8::1"
            : e.target.value === "MX" ? "10 mail.shop.eth"
            : e.target.value === "CNAME" ? "target.shop.eth"
            : t("任意文本");
        }
        updateRecPreview();
        return;
      }
      const f = e.target.dataset.filter;
      if (!f || f === "type" || f === "sort") return;
      filters[f] = e.target.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => render(), 300);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target.id === "homeSearch") act("home-search");
    });

    $("acctSel").addEventListener("change", async (e) => {
      const [kind, addr] = String(e.target.value || "").split(":");
      if (!addr) return;
      try {
        Chain.pickAccount(addr, kind === "wallet" ? "wallet" : kind === "view" ? "view" : "node");
        await refresh(true);
        renderAcctBar();
      } catch (err) {
        toast(t(err.message), "bad");
      }
    });

    document.querySelectorAll(".langbtn[data-lang]").forEach((el) => {
      el.addEventListener("click", () => window.T.setLang(el.dataset.lang));
    });

    window.T.onChange(() => {
      applyStaticLang();
      render();
      renderAcctBar();
    });

    const PANELS = ["conn", "prefs", "acctPanel"];
    const togglePanel = (id) => {
      PANELS.filter((x) => x !== id).forEach((x) => {
        const el = $(x);
        if (el) el.classList.add("hidden");
      });
      const box = $(id);
      if (box) box.classList.toggle("hidden");
    };

    $("netChip").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel("conn");
    });
    $("btnSettings").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel("prefs");
    });
    document.addEventListener("click", (e) => {
      for (const id of PANELS) {
        const box = $(id);
        if (!box || box.classList.contains("hidden")) continue;
        if (!box.contains(e.target)) box.classList.add("hidden");
      }
    });
    $("btnWallet").addEventListener("click", connectWalletFlow);

    $("acctChip").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel("acctPanel");
    });

    $("btnWallet2").addEventListener("click", async () => {
      if (Chain.cfg().signer === "wallet") {
        Chain.disconnectWallet();
        await refresh(true);
        renderAcctBar();
        toast(t("已断开浏览器钱包"), "ok");
        return;
      }
      await connectWalletFlow();
      renderAcctBar();
    });

    $("btnUseAddr").addEventListener("click", async () => {
      const addr = ($("customAddr").value || "").trim();
      try {
        Chain.pickAccount(addr, "view");
        await refresh(true);
        renderAcctBar();
        toast(t("已切换到只读查看：写操作需要连接钱包"), "ok");
      } catch (err) {
        toast(t(err.message), "bad");
      }
    });
    if ($("customAddr")) {
      $("customAddr").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("btnUseAddr").click();
      });
    }
    $("btnApply").addEventListener("click", () => {
      connectFromApply = true;
      connect();
    });

    $("btnReset").addEventListener("click", () => {
      try {
        localStorage.removeItem(CONFIG_KEY);
      } catch (e) {

      }
      location.reload();
    });

    window.addEventListener("hashchange", () => {
      render();
      refresh(false);
    });
  }

  const RPC_SLOTS = 3;
  const CONFIG_KEY = "nameregistry.config";

  // Persist contract and RPC settings.
  function saveConfig(chainId, info) {
    try {
      localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify({
          chainId,
          chainName: info && info.chainName,
          rpcs: readRpcs(),
          contract: $("contractAddr").value.trim(),
          scanBlocks: readScanBlocks(),
          at: Date.now(),
        })
      );
    } catch (e) {

    }
  }

  // Load persisted settings.
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Read the log scan window from settings.
  function readScanBlocks() {
    const el = $("scanBlocks");
    if (!el) return 10000;
    const v = Number(el.value);
    return Number.isFinite(v) && v > 0 ? v : 10000;
  }

  // Read the RPC list from settings.
  function readRpcs() {
    const out = [];
    document.querySelectorAll(".rpcinput").forEach((el) => {
      const v = el.value.trim();
      if (v) out.push(v);
    });
    return out;
  }

  // Show per-node health and finality distance.
  function renderNodeHealth(health) {
    if (!health) return;

    const badge = $("agreeBadge");
    if (!health.live) {
      badge.textContent = t("无节点");
      badge.className = "agree bad";
    } else if (health.agree) {
      badge.textContent = `${health.live}/${health.total}`;
      badge.className = "agree ok";
    } else {
      badge.textContent = `${health.live}/${health.total}`;
      badge.className = "agree bad";
      badge.title = health.behind && health.reasons.length === 1 ? t("节点落后") : t("节点不一致");
    }
    badge.title = health.agree
      ? t("合约代码和区块 {0} 的状态根都一致", health.height)
      : health.reasons.join("；");

  }

  function accountOptions() {
    const cfg = Chain.cfg();
    const out = [];
    (cfg.nodeAccounts || []).forEach((a) => out.push({ v: "node:" + a, tag: t("节点账户"), label: shortAddr(a) }));
    if (cfg.signer === "wallet") {
      (cfg.accounts && cfg.accounts.length ? cfg.accounts : [cfg.account])
        .filter(Boolean)
        .forEach((a) => out.push({ v: "wallet:" + a, tag: t("钱包"), label: shortAddr(a) }));
    } else if (cfg.signer === "view" && cfg.account) {
      out.push({ v: "view:" + cfg.account, tag: t("只读"), label: shortAddr(cfg.account) });
    }
    if (!out.length && cfg.account) out.push({ v: "node:" + cfg.account, tag: t("账户"), label: shortAddr(cfg.account) });
    return out;
  }

  // Rebuild the account picker and signer label.
  function renderAcctBar() {
    const cfg = Chain.cfg();
    const connected = !!cfg.account;

    const name = $("acctName");
    if (name) {
      const ro = cfg.signer === "view" ? t("只读") + " · " : "";
      name.textContent = connected ? ro + shortAddr(cfg.account) : t("未连接账户");
    }

    const chip = $("acctChip");
    if (chip) {
      chip.title = cfg.signer === "view" ? t("只读查看") : t("账户");
      chip.classList.toggle("readonly", cfg.signer === "view");
    }

    const opts = accountOptions();
    const sel = $("acctSel");
    const single = $("acctSingle");
    if (sel && single) {
      if (opts.length > 1) {
        const want = opts
          .map((o) => `<option value="${o.v}">${o.tag} · ${o.label}</option>`)
          .join("");
        if (sel.innerHTML !== want) sel.innerHTML = want;
        const now = cfg.signer + ":" + cfg.account;
        if (opts.some((o) => o.v === now)) sel.value = now;
        sel.classList.remove("hidden");
        single.classList.add("hidden");
      } else {
        sel.classList.add("hidden");
        single.classList.remove("hidden");
        single.textContent = connected ? (cfg.signer === "view" ? t("只读") + " · " : "") + shortAddr(cfg.account) : t("未连接");
      }
    }

    const b2 = $("btnWallet2");
    if (b2) {
      b2.textContent = cfg.signer === "wallet" ? t("断开钱包") : t("连接钱包");
      b2.classList.toggle("primary", cfg.signer !== "wallet");
      b2.classList.toggle("subtle", cfg.signer === "wallet");
    }
  }

  function syncSignerMark() {
    const mark = $("signerMark");
    if (!mark) return;
    const byWallet = Chain.cfg().signer === "wallet";
    mark.classList.toggle("hidden", !byWallet);
    mark.title = byWallet ? t("由浏览器钱包签名") : "";
  }

  function fillWalletSel() {
    const sel = $("walletSel");
    if (!sel) return;
    const list = Chain.walletList();
    if (list.length < 2) {
      sel.classList.add("hidden");
      return;
    }
    const keep = sel.value;
    sel.innerHTML = list.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
    sel.value = keep && list.some((w) => w.id === keep) ? keep : list[0].id;
    sel.classList.remove("hidden");
  }

  // Ask the wallet for accounts and switch to the page chain.
  async function connectWalletFlow() {
    try {
      const list = Chain.walletList();
      if (!list.length) {
        toast(t("没有检测到浏览器钱包"), "bad");
        return;
      }
      const picked = $("walletSel") && $("walletSel").value;
      const w = await Chain.connectWallet(picked || undefined);

      const sel = $("acctSel");
      if (sel) {
        sel.innerHTML = (w.accounts || [w.account])
          .map((a) => `<option value="${a}">${shortAddr(a)}</option>`)
          .join("");
        sel.value = w.account;
      }

      await refresh(true);
      toast(t("已连接浏览器钱包"), "ok");
    } catch (e) {
      toast(t(e.message), "bad");
    }
  }

  let connecting = false;

  let connectFromApply = false;

  function setConnecting(on) {
    const btn = $("btnApply");
    if (btn) {
      btn.disabled = on;
      btn.textContent = on ? t("连接中…") : t("应用");
    }
    if (on) {
      $("netDot").className = "dot warn";
      $("netText").textContent = t("连接中…");
      $("agreeBadge").textContent = "";
      $("app").innerHTML = `<div class="state">${esc(t("正在连接…"))}</div>`;
    }
  }

  // Connect: load deployment info, bind events, boot the page.
  async function connect() {
    if (connecting) return;

    const rpcs = readRpcs();
    const contract = $("contractAddr").value.trim() || DEFAULT_CONTRACT;
    if (!rpcs.length) {
      toast(t("至少要填一个节点地址"), "bad");
      return;
    }

    connecting = true;
    setConnecting(true);
    try {
      Chain.setConfig({ scanBlocks: readScanBlocks() });
      const info = await Chain.connect(rpcs, contract);

      const saved = loadConfig();
      if (saved && saved.chainId !== info.chainId) {
        const d = Chain.chainDefaults(info.chainId);
        if ($("scanBlocks")) $("scanBlocks").value = String(d.scanBlocks);
        Chain.setConfig({ scanBlocks: d.scanBlocks });
      }

      const sel = $("acctSel");
      sel.innerHTML = info.accounts
        .map((a) => `<option value="${a}">${shortAddr(a)}</option>`)
        .join("");
      sel.value = info.account || "";

      $("netDot").className = info.health.agree ? "dot ok" : "dot warn";
      $("netText").textContent = info.chainName || "chain " + info.chainId;
      const chip = $("netChip");
      if (chip) chip.title = t("连接设置") + " · chain " + info.chainId;
      renderNodeHealth(info.health);
      renderAcctBar();
      if (connectFromApply) pendingNet = "";
      syncNetButtons(info.chainId);
      saveConfig(info.chainId, info);

      $("conn").classList.add("hidden");
      toast(
        t("已连接 {0} · {1}/{2} 个节点", info.chainName || "chain " + info.chainId, info.health.live, info.health.total),
        info.health.agree ? "ok" : "warn"
      );

      if (!info.accounts.length && info.signer !== "wallet") {
        if (window.ethereum) {
          toast(t("节点没有解锁账户，点右上角「连接钱包」"), "warn");
        } else {
          toast(t("这个节点没有可用账户，也没有浏览器钱包"), "warn");
        }
      }

      await refresh(true);
      const again = await Chain.probeNodes();
      renderNodeHealth(again);
      if (!again.agree) toast(t("节点之间不一致，页面只使用其中一个节点的数据"), "warn");
    } catch (e) {
      $("netDot").className = "dot bad";
      $("netText").textContent = t("未连接");
      $("agreeBadge").textContent = "";
      $("app").innerHTML = `<div class="state bad">${esc(t(e.message))}</div>`;
      toast(t(e.message), "bad");
      $("conn").classList.remove("hidden");
    } finally {
      connecting = false;
      connectFromApply = false;
      setConnecting(false);
    }
  }

  // Load deployment.json, falling back to URL params or defaults.
  async function loadDeployment() {
    try {
      const res = await fetch("deployment.json", { cache: "no-store" });
      if (!res.ok) return null;
      const dep = await res.json();
      return dep && dep.contract ? dep : null;
    } catch (e) {

    }
    return null;
  }

  let deployed = null;

  let pendingNet = "";

  // Built-in network presets.
  function networkPresets() {
    const custom = { contract: DEFAULT_CONTRACT, rpcs: DEFAULT_RPCS.slice(), scan: 10000 };
    const src = deployed || SEPOLIA_FALLBACK;
    const sepolia = {
      contract: src.contract,
      rpcs: String(src.rpc || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      scan: Number(src.scanBlocks) || 5000,
      deployBlock: Number(src.deployBlock) || 0,
    };
    return { sepolia, custom };
  }

  // Fill the form from a preset; connecting is a separate step.
  function applyPreset(preset, name) {
    if (!preset) return;
    $("contractAddr").value = preset.contract;
    document.querySelectorAll(".rpcinput").forEach((el, i) => {
      el.value = preset.rpcs[i] || preset.rpcs[0] || "";
    });
    if ($("scanBlocks")) $("scanBlocks").value = String(preset.scan);
    Chain.setConfig({ deployBlock: preset.deployBlock || 0 });
    pendingNet = name;
    document.querySelectorAll("[data-net]").forEach((el) => {
      el.classList.toggle("on", el.dataset.net === name);
    });
    toast(t("已填入 {0} 的连接参数，点「应用」生效", name === "custom" ? "Custom" : "Sepolia"), "ok");
  }

  function syncNetButtons(chainId) {
    const now = pendingNet
      ? pendingNet
      : chainId === 11155111 || chainId === 11155112
        ? "sepolia"
        : chainId === 31337 || chainId === 1337
          ? "custom"
          : "";
    document.querySelectorAll("[data-net]").forEach((el) => {
      el.classList.toggle("on", el.dataset.net === now);
    });
  }

  // Entry point: configuration, wallet setup and first render.
  async function boot() {
    applyStaticLang();

    const saved = loadConfig();
    document.querySelectorAll(".rpcinput").forEach((el, i) => {
      el.value = (saved && saved.rpcs && saved.rpcs[i]) || DEFAULT_RPCS[i] || DEFAULT_RPCS[0];
    });
    $("contractAddr").value = (saved && saved.contract) || DEFAULT_CONTRACT;
    if ($("scanBlocks") && saved && saved.scanBlocks) $("scanBlocks").value = String(saved.scanBlocks);

    deployed = await loadDeployment();
    const dep = deployed && !(saved && saved.contract) ? deployed : null;
    if (dep) {
      $("contractAddr").value = dep.contract;
      const rpcs = String(dep.rpc || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (rpcs.length) {
        document.querySelectorAll(".rpcinput").forEach((el, i) => {
          el.value = rpcs[i] || rpcs[0];
        });
      }
      if (dep.scanBlocks && $("scanBlocks")) $("scanBlocks").value = String(dep.scanBlocks);
      if (dep.deployBlock) Chain.setConfig({ deployBlock: Number(dep.deployBlock) });
    }

    const q = new URLSearchParams(location.search);
    const qNetRaw = (q.get("net") || "").trim();
    const qNet = qNetRaw === "local" ? "custom" : qNetRaw;
    if (qNet === "custom" || qNet === "sepolia") {
      const preset = networkPresets()[qNet];
      if (preset) {
        $("contractAddr").value = preset.contract;
        document.querySelectorAll(".rpcinput").forEach((el, i) => {
          el.value = preset.rpcs[i] || preset.rpcs[0] || "";
        });
        if ($("scanBlocks")) $("scanBlocks").value = String(preset.scan);
        Chain.setConfig({ deployBlock: preset.deployBlock || 0 });
      }
    }
    const qContract = (q.get("contract") || "").trim();
    const qRpc = (q.get("rpc") || "").trim();
    const qScan = Number(q.get("scan") || 0);
    if (qContract) $("contractAddr").value = qContract;
    if (qRpc) {
      document.querySelectorAll(".rpcinput").forEach((el, i) => {
        const u = qRpc.split(",")[i];
        if (u && u.trim()) el.value = u.trim();
        else if (i > 0) el.value = qRpc.split(",")[0].trim();
      });
    }
    if (qScan && $("scanBlocks")) $("scanBlocks").value = String(qScan);

    bind();
    if (!location.hash) go("/");
    connect();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
