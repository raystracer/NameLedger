// Contract ABI, selectors and a small ABI codec. No network access.


(function (global) {
  "use strict";

  const ABI = {
    register: { inputs: ["string"], outputs: [], selector: "0xf2c298be", payable: true },
    renew: { inputs: ["string"], outputs: [], selector: "0xa4a9a612", payable: true },
    setSigningKey: { inputs: ["string", "address"], outputs: [], selector: "0x1993486b" },
    approveSale: {
      inputs: ["string", "address", "uint96", "uint64", "bool"],
      outputs: [],
      selector: "0x29b628f4",
    },
    cancelApproval: { inputs: ["string"], outputs: [], selector: "0x2f651485" },
    buy: { inputs: ["string"], outputs: [], selector: "0x492cc769", payable: true },
    setRecords: { inputs: ["string", "bytes"], outputs: [], selector: "0x74d5a64f" },
    withdraw: { inputs: [], outputs: [], selector: "0x3ccfd60b" },
    sweep: { inputs: ["address"], outputs: [], selector: "0x01681a62" },
    uncollectedFee: { inputs: [], outputs: ["uint256"], selector: "0xd59a96af" },
    getRecords: { inputs: ["string"], outputs: ["bytes"], selector: "0x86e80b71" },
    resolve: {
      inputs: ["string"],
      outputs: ["address", "address", "uint32", "uint64"],
      selector: "0x461a4478",
    },
    isAvailable: { inputs: ["string"], outputs: ["bool"], selector: "0x965306aa" },
    namehash: { inputs: ["string"], outputs: ["bytes32"], selector: "0x09879962" },
    saleOf: { inputs: ["string"], outputs: ["address", "uint96", "uint64", "bool"], selector: "0xc1e63308" },
    domainsOf: { inputs: ["address"], outputs: ["string[]"], selector: "0x6404f2bb" },
    domainCount: { inputs: ["address"], outputs: ["uint256"], selector: "0x2fc05881" },
    listedCount: { inputs: [], outputs: ["uint256"], selector: "0xf36065b3" },
    listedNames: { inputs: ["uint256", "uint256"], outputs: ["string[]"], selector: "0x218d76a7" },
    pruneExpired: { inputs: ["string"], outputs: [], selector: "0x6695dd3a" },
    earningsOf: { inputs: ["address"], outputs: ["uint256"], selector: "0x8df08bd4" },
    FEE: { inputs: [], outputs: ["uint256"], selector: "0xc57981b5" },
    LEASE: { inputs: [], outputs: ["uint64"], selector: "0x8a7f8d36" },
  };

  const EVENTS = {
    "0xb2b95cc16bd014f14f6d1bb8d119eba12f8187d5f01fade0cc925dde2dd0cf10": {
      name: "Registered",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "owner", t: "address", i: true },
        { n: "expiry", t: "uint64", i: false },
        { n: "fee", t: "uint256", i: false },
      ],
    },
    "0x6f3f9fe14720db7bdf43cf2d6d204732d50ae60b5a96a577b9fac5630c2dfae8": {
      name: "SaleApproved",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "buyer", t: "address", i: true },
        { n: "price", t: "uint96", i: false },
        { n: "deadline", t: "uint64", i: false },
        { n: "persist", t: "bool", i: false },
      ],
    },
    "0xfb0821b69f2bc76a290860ae0101ebb1ee8be7de08331f5d8cd47f96dd7a64bb": {
      name: "SaleCancelled",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
      ],
    },
    "0x958254ed8029b5ea65a5f2bd18669b34b77ca4ea18e2b4dad25f8bcd24140be3": {
      name: "Settled",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "buyer", t: "address", i: true },
        { n: "seller", t: "address", i: true },
        { n: "price", t: "uint96", i: false },
      ],
    },
    "0xde39951c30ede52f243b2f2c4c82ac34031c856945506e29a3090b4975b39928": {
      name: "Transferred",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "from", t: "address", i: true },
        { n: "to", t: "address", i: true },
      ],
    },
    "0x429096d0d1580a8f54632989629168646be869cf1d82cf27d898b141be4a21df": {
      name: "Expired",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
      ],
    },
    "0xdf769cf7aea8cc0768b4789c5b467af94bacc4b7d8edb7275bca0a79490c4bcd": {
      name: "Renewed",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "expiry", t: "uint64", i: false },
        { n: "fee", t: "uint256", i: false },
      ],
    },
    "0x555b1ce61e47ab4f31d7171732410c34abb8b308bc80d12e9101f61cb729d93b": {
      name: "SigningKeyChanged",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "signingKey", t: "address", i: true },
        { n: "keyVersion", t: "uint32", i: false },
      ],
    },
    "0x5f9d127629d98123d57dd0b42507311bcd3faa1f914f3d40cc86971878051efb": {
      name: "RecordsUpdated",
      fields: [
        { n: "id", t: "bytes32", i: true },
        { n: "name", t: "string", i: false },
        { n: "writer", t: "address", i: true },
      ],
    },
  };

  const ERRORS = {
    "0xda9b9af6": "NoDot：域名至少要有两段，例如 shop.eth",
    "0x378a1c5b": "BadLabel：每一段只能 1~63 个字符，连字符不能放在头尾",
    "0xaf13986d": "ZeroFee：年费不能为 0，抢注必须有成本",
    "0x351261fc": "NothingToSweep：没有待划转的年费",
    "0x4033e4e3": "FeeTransferFailed：年费转给收款地址失败",
    "0x9a0833b6": "WrongFee：交的年费不等于 FEE（多付少付都拒）",
    "0x9e4b2685": "NameTaken：这个名字已经被注册了",
    "0xaba47339": "NotRegistered：这个名字没有登记，或者已经过期",
    "0x30cd7471": "NotOwner：你不是这个域名的所有者",
    "0x472e017e": "NotBuyer：这笔挂单限定给了别人",
    "0xf7760f25": "WrongPrice：付的金额不等于挂单价",
    "0x31acab54": "SaleHasExpired：这笔挂单已经过期",
    "0x61cfef8e": "NoSale：这个名字没有在售",
    "0xea8e4eb5": "NotAuthorized：你既不是所有者，也没有 DNS 编辑权限",
    "0x67a2cc26": "BadRecipient：地址不能是零地址",
    "0x710e1ce5": "BadDeadline：截止时间必须晚于当前时间",
    "0xd0d04f60": "NothingToWithdraw：没有可提现的收入",
    "0x90b8ec18": "TransferFailed：转账失败",
    "0x2ef13105": "EmptyName：域名不能为空",
    "0x161728f4": "NameTooLong：域名超过 253 字节",
    "0x1781cda2": "BadCharacter：域名里有不支持的字符（只允许 a-z 0-9 - .）",
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const strip0x = (h) => (h || "").replace(/^0x/i, "");

  function bytesToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  function hexToBytes(hex) {
    const body = strip0x(hex);
    if (body.length % 2 !== 0) throw new Error("hex 长度必须是偶数");
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.substr(i * 2, 2), 16);
    return out;
  }

  const pad32 = (hex) => strip0x(hex).padStart(64, "0");
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");

  // Split hex data into 32-byte words.
  function splitWords(hex) {
    const body = strip0x(hex);
    const words = [];
    for (let i = 0; i + 64 <= body.length; i += 64) words.push(body.slice(i, i + 64));
    return words;
  }

  // Encode one ABI argument.
  function encodeOne(type, value) {
    if (type === "string") {
      const bytes = enc.encode(value == null ? "" : String(value));
      return {
        dynamic: true,
        data: word(bytes.length) + bytesToHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, "0"),
      };
    }
    if (type === "bytes") {
      const bytes = hexToBytes(value);
      return {
        dynamic: true,
        data: word(bytes.length) + bytesToHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, "0"),
      };
    }
    if (type === "address") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("地址格式不对：" + value);
      return { dynamic: false, data: pad32(strip0x(value).toLowerCase()) };
    }
    if (type.startsWith("uint") || type.startsWith("int")) return { dynamic: false, data: word(value) };
    if (type === "bool") return { dynamic: false, data: word(value ? 1 : 0) };
    if (type === "bytes32") return { dynamic: false, data: pad32(value) };
    throw new Error("不支持的参数类型：" + type);
  }

  // Encode a function call.
  function encodeCall(fn, args) {
    const meta = ABI[fn];
    if (!meta) throw new Error("未知函数：" + fn);
    args = args || [];
    if (args.length !== meta.inputs.length) {
      throw new Error(fn + " 需要 " + meta.inputs.length + " 个参数，收到 " + args.length);
    }
    let head = "";
    let tail = "";
    let tailOffset = meta.inputs.length * 32;
    for (let i = 0; i < meta.inputs.length; i++) {
      const part = encodeOne(meta.inputs[i], args[i]);
      if (part.dynamic) {
        head += word(tailOffset);
        tail += part.data;
        tailOffset += part.data.length / 2;
      } else {
        head += part.data;
      }
    }
    return meta.selector + head + tail;
  }

  // Read one word as a typed value.
  function readValueAt(type, words, at) {
    if (type === "string" || type === "bytes") {
      const len = Number(BigInt("0x" + words[at]));
      const chunks = words.slice(at + 1, at + 1 + Math.ceil(len / 32));
      const dataHex = chunks.join("").slice(0, len * 2);
      return type === "string" ? dec.decode(hexToBytes(dataHex)) : "0x" + dataHex;
    }
    if (type.endsWith("[]")) {
      const len = Number(BigInt("0x" + words[at]));
      const inner = type.slice(0, -2);
      const out = [];
      for (let i = 0; i < len; i++) {
        const off = Number(BigInt("0x" + words[at + 1 + i])) / 32;
        out.push(readValueAt(inner, words, at + 1 + off));
      }
      return out;
    }
    const w = words[at];
    if (type === "address") return "0x" + w.slice(24);
    if (type === "bool") return BigInt("0x" + w) !== 0n;
    if (type === "bytes32") return "0x" + w;
    return BigInt("0x" + w).toString();
  }

  function decodeHead(type, words, headIndex, origin) {
    if (type === "string" || type === "bytes" || type.endsWith("[]")) {
      const offset = Number(BigInt("0x" + words[headIndex])) / 32;
      return readValueAt(type, words, origin + offset);
    }
    return readValueAt(type, words, headIndex);
  }

  // Decode return data for a function.
  function decodeResult(fn, hex) {
    const meta = ABI[fn];
    if (!meta.outputs.length) return null;
    const words = splitWords(hex);
    return meta.outputs.map((t, i) => decodeHead(t, words, i, 0));
  }

  // Decode a custom error into a readable message.
  function decodeError(data) {
    const hex = typeof data === "string" ? data : (data && data.data) || "";
    const body = strip0x(hex);
    if (body.length < 8) return null;
    const selector = "0x" + body.slice(0, 8);
    return ERRORS[selector] || "未知错误 " + selector;
  }

  // Decode one event log.
  function decodeLog(log) {
    const def = EVENTS[(log.topics && log.topics[0]) || ""];
    if (!def) return null;

    const indexed = def.fields.filter((f) => f.i);
    const plain = def.fields.filter((f) => !f.i);
    const words = splitWords(log.data);

    const values = {};
    let headIdx = 0;
    for (const f of plain) {
      values[f.n] = decodeHead(f.t, words, headIdx++, 0);
    }
    indexed.forEach((f, i) => {
      const topic = log.topics[i + 1];
      if (f.t === "address") values[f.n] = "0x" + topic.slice(26);
      else if (f.t === "bytes32") values[f.n] = topic;
      else values[f.n] = BigInt(topic).toString();
    });

    return { event: def.name, ...values };
  }

  const api = { ABI, EVENTS, ERRORS, encodeCall, decodeResult, decodeError, decodeLog, hexToBytes, bytesToHex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.ABI = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
