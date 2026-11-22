// DNS record codec: parse, validate, encode and explain the on-chain payload.


(function (global) {
  const T = global.T;
  const t = (...a) => T.t(...a);

  function hexToArr(hex) {
    const body = hex.replace(/^0x/i, "");
    const out = [];
    for (let i = 0; i < body.length; i += 2) out.push(parseInt(body.substr(i, 2), 16));
    return out;
  }

  const arrToHex = (arr) => "0x" + arr.map((b) => b.toString(16).padStart(2, "0")).join("");

  // Parse an IPv4 address.
  function parseIpv4(text) {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    const out = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  // Parse an IPv6 address.
  function parseIpv6(text) {
    if (!text.includes(":")) return null;
    const halves = text.split("::");
    if (halves.length > 2) return null;

    const toGroups = (part) => (part ? part.split(":") : []);
    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];
    const all = [...head, ...tail];
    if (all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;

    let groups;
    if (halves.length === 2) {
      const missing = 8 - all.length;
      if (missing < 1) return null;
      groups = [...head, ...Array(missing).fill("0"), ...tail];
    } else {
      if (all.length !== 8) return null;
      groups = all;
    }

    const out = [];
    for (const g of groups) {
      const v = parseInt(g, 16);
      out.push(v >> 8, v & 0xff);
    }
    return out;
  }

  // Parse an IP address of either family.
  function parseIp(text) {
    const s = String(text).trim();
    return parseIpv4(s) || parseIpv6(s);
  }

  // Format an IP address from bytes.
  function formatIp(bytes) {
    if (bytes.length === 4) return bytes.join(".");
    if (bytes.length !== 16) return null;

    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));

    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < 8; i++) {
      if (groups[i] === "0") {
        if (curStart < 0) {
          curStart = i;
          curLen = 0;
        }
        curLen++;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
        }
      } else {
        curStart = -1;
        curLen = 0;
      }
    }
    if (bestLen >= 2) {
      return groups.slice(0, bestStart).join(":") + "::" + groups.slice(bestStart + bestLen).join(":");
    }
    return groups.join(":");
  }

  // Render a record set as readable lines.
  function explainRecords(hex) {
    if (!hex || hex === "0x") return { ip: null, hex: "0x", bytes: 0 };
    const bytes = hexToArr(hex);
    return { ip: formatIp(bytes), hex, bytes: bytes.length };
  }

  const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"];

  // Encode a record set into the on-chain payload.
  function encodeRecordSet(records) {
    const text = records.map((r) => `${r.name} ${r.type} ${r.value}`).join("\n");
    const bytes = new TextEncoder().encode(text);
    return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Decode the on-chain payload into a record set.
  function decodeRecordSet(hex) {
    if (!hex || hex === "0x") return [];
    try {
      const bytes = new Uint8Array(hexToArr(hex));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const out = [];
      for (const line of text.split("\n")) {
        const row = line.trim();
        if (!row) continue;
        const m = row.match(/^(\S+)\s+(A|AAAA|CNAME|MX|TXT)\s+(.+)$/i);
        if (!m) return null;
        out.push({ name: m[1], type: m[2].toUpperCase(), value: m[3].trim() });
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  // Validate one record against its type.
  function checkRecord(name, type, value) {
    if (!/^(@|[a-zA-Z0-9-]{1,63})$/.test(name)) return t("名称只能是一段标签，或 @ 表示域名本身");
    if (!RECORD_TYPES.includes(type)) return t("不支持的类型");

    if (type === "A") {
      if (!parseIpv4(value)) return t("A 记录的内容必须是 IPv4 地址");
    } else if (type === "AAAA") {
      if (!parseIpv6(value)) return t("AAAA 记录的内容必须是 IPv6 地址");
    } else if (type === "CNAME") {
      if (!/^[a-zA-Z0-9.-]+$/.test(value)) return t("CNAME 记录的内容必须是域名");
    } else if (type === "MX") {
      if (!/^\d{1,5}\s+\S+$/.test(value)) return t("MX 记录格式是「优先级 邮件服务器」");
    } else if (type === "TXT") {
      if (!value) return t("TXT 记录的内容不能为空");
    }
    return null;
  }

  global.DNS = {
    RECORD_TYPES,
    hexToArr,
    arrToHex,
    parseIpv4,
    parseIpv6,
    parseIp,
    formatIp,
    explainRecords,
    encodeRecordSet,
    decodeRecordSet,
    checkRecord,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
