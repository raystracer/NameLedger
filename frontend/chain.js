// Chain access: JSON-RPC, multi-node checks, event scans, receipts and finality.
// Reads go through rpc() and call(); writes go through send() and waitReceipt().
// The contract has no enumeration, so listings are rebuilt from SaleApproved logs.


(function (global) {
  "use strict";

  const A = global.ABI;

  const CHAIN_DEFAULTS = {
    31337: { name: "RPC", finalityDepth: 1, scanBlocks: 10000, blockTime: 0 },
    1337: { name: "RPC", finalityDepth: 1, scanBlocks: 10000, blockTime: 0 },
    1: { name: "Ethereum", finalityDepth: 64, scanBlocks: 5000, blockTime: 12 },
    11155111: { name: "Sepolia", finalityDepth: 64, scanBlocks: 5000, blockTime: 12 },
    17000: { name: "Holesky", finalityDepth: 64, scanBlocks: 5000, blockTime: 12 },
    560048: { name: "Hoodi", finalityDepth: 64, scanBlocks: 5000, blockTime: 12 },
  };

  const CHAIN_META = {
    11155111: {
      chainName: "Sepolia",
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    },
    560048: {
      chainName: "Hoodi",
      nativeCurrency: { name: "Hoodi Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.hoodi.ethpandaops.io"],
      blockExplorerUrls: ["https://explorer.hoodi.ethpandaops.io"],
    },
  };

  // Chain parameters used with wallet_addEthereumChain.
  function walletChainParams() {
    const known = CHAIN_META[state.chainId];
    const d = chainDefaults(state.chainId);
    const params = {
      chainId: "0x" + state.chainId.toString(16),
      chainName: d.name,
      nativeCurrency: { name: d.name + " Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: [state.rpcs[0] || known && known.rpcUrls[0]].filter(Boolean),
    };
    const explorer = known && known.blockExplorerUrls;
    if (explorer) params.blockExplorerUrls = explorer;
    return params;
  }

  // Default finality and scan settings per chain.
  function chainDefaults(chainId) {
    return (
      CHAIN_DEFAULTS[chainId] || {
        name: "chain " + chainId,
        finalityDepth: 12,
        scanBlocks: 5000,
        blockTime: 12,
      }
    );
  }

  const state = {
    rpcs: ["http://127.0.0.1:8545"],
    contract: "",
    account: null,
    chainId: 0,
    accounts: [],
    scanBlocks: 10000,
    finalityDepth: 1,
    signer: "node",
    nodeAccounts: [],
  };

  let rpcId = 1;

  // Apply contract, RPC list and scan window.
  function setConfig(cfg) {
    if (cfg.contract && cfg.contract !== state.contract) deployBlockCache = null;
    Object.assign(state, cfg);
    if (cfg.deployBlock !== undefined) {
      deployBlockCache = Number(cfg.deployBlock) || 0;
    }
    cache.world = null;
  }

  const cfg = () => state;

  const SIG = {};
  for (const [topic0, def] of Object.entries(A.EVENTS)) SIG[def.name] = topic0;

  const addrTopic = (a) => "0x" + "0".repeat(24) + a.toLowerCase().slice(2);

  class RpcError extends Error {}

  const TIMEOUT_MS = 12000;
  const canTimeout = typeof AbortController !== "undefined";

  const describe = (err) => A.decodeError(err && err.data) || (err && err.message) || JSON.stringify(err);

  // POST one JSON-RPC request with a timeout.
  async function postOnce(url, method, params) {
    let res;
    const ctrl = canTimeout ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params || [] }),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new RpcError(e && e.name === "AbortError" ? "节点超时 " + url : "连不上 " + url);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new RpcError(url + " 响应异常（HTTP " + res.status + "）");
    const json = await res.json();
    if (json.error) throw new RpcError(describe(json.error));
    return json.result;
  }

  // Node order for reads: healthy nodes first.
  function readOrder() {
    if (!state.pinUrl) return state.rpcs;
    return [state.pinUrl, ...state.rpcs.filter((u) => u !== state.pinUrl)];
  }

  // One JSON-RPC call with failover across nodes.
  async function rpc(method, params) {
    let lastErr = null;
    for (const url of readOrder()) {
      try {
        return await postOnce(url, method, params);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new RpcError("没有可用的节点");
  }

  // Batched JSON-RPC call with failover.
  async function rpcBatch(payloads) {
    if (!payloads.length) return [];

    const body = payloads.map((p) => ({
      jsonrpc: "2.0",
      id: rpcId++,
      method: p.method,
      params: p.params,
    }));

    let lastErr = null;
    for (const url of readOrder()) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastErr = new RpcError("连不上 " + url);
        continue;
      }
      if (!res.ok) {
        lastErr = new RpcError(url + " 响应异常（HTTP " + res.status + "）");
        continue;
      }
      const json = await res.json();
      const byId = new Map(json.map((r) => [r.id, r]));
      return body.map((req) => {
        const r = byId.get(req.id);
        return r && !r.error ? r.result : null;
      });
    }
    throw lastErr || new RpcError("没有可用的节点");
  }

  // Read a contract function through the RPC layer.
  async function call(fn, args) {
    const hex = await rpc("eth_call", [{ to: state.contract, data: A.encodeCall(fn, args) }, "latest"]);
    return A.decodeResult(fn, hex);
  }

  // Batch several read calls.
  async function callBatch(items) {
    const payloads = items.map((it) => ({
      method: "eth_call",
      params: [{ to: state.contract, data: A.encodeCall(it.fn, it.args) }, "latest"],
    }));
    const results = await rpcBatch(payloads);
    return results.map((r, i) => {
      if (typeof r !== "string" || r.length < 10) return null;
      return A.decodeResult(items[i].fn, r);
    });
  }

  const writerUrl = () => state.writer || state.rpcs[0];

  const announcedWallets = [];
  const walletEvents = [];

  // Keep the wallet list updated.
  function watchWallets() {
    const w = typeof globalThis !== "undefined" ? globalThis : null;
    if (!w || w.__walletWatchInstalled) return;
    w.__walletWatchInstalled = true;

    if (typeof w.addEventListener === "function") {
      w.addEventListener("eip6963:announceProvider", (e) => {
        const d = e && e.detail;
        if (!d || !d.provider || !d.info) return;
        if (announcedWallets.some((x) => x.info.rdns === d.info.rdns)) return;
        announcedWallets.push({ info: d.info, provider: d.provider });
        walletEvents.forEach((fn) => fn(announcedWallets));
      });
      try {
        w.dispatchEvent(new Event("eip6963:requestProvider"));
      } catch (err) {

      }
    }
  }

  // Providers discovered through EIP-6963.
  function walletList() {
    watchWallets();
    const out = announcedWallets.map((x) => ({ id: x.info.rdns, name: x.info.name, provider: x.provider }));
    if (!out.length) {
      const w = typeof globalThis !== "undefined" ? globalThis : null;
      if (w && w.ethereum) out.push({ id: "injected", name: "浏览器钱包", provider: w.ethereum });
    }
    return out;
  }

  function walletProvider() {
    watchWallets();
    const list = walletList();
    if (!list.length) return null;
    if (state.walletRdns) {
      const picked = list.find((x) => x.id === state.walletRdns);
      if (picked) return picked.provider;
    }
    return list[0].provider;
  }

  const onWalletList = (fn) => {
    watchWallets();
    walletEvents.push(fn);
  };

  // Request accounts and add or switch the chain.
  async function connectWallet(walletId) {
    if (walletId) state.walletRdns = walletId;
    const eth = walletProvider();
    if (!eth) throw new RpcError("这个浏览器没有钱包插件");

    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new RpcError("钱包没有授权账户");

    const walletChainId = parseInt(await eth.request({ method: "eth_chainId" }), 16);
    if (state.chainId && walletChainId !== state.chainId) {
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + state.chainId.toString(16) }],
        });
      } catch (e) {
        try {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [walletChainParams()],
          });
        } catch (e2) {
          throw new RpcError(
            `钱包在 chain ${walletChainId}，读的是 chain ${state.chainId}，请在钱包里切到这条链`
          );
        }
      }
    }

    state.signer = "wallet";
    state.account = accounts[0];
    state.accounts = accounts;

    if (eth.on) {
      eth.on("accountsChanged", (list) => {
        state.account = list[0] || null;
        state.accounts = list;
      });
    }

    cache.world = null;
    return { account: state.account, accounts: state.accounts, signer: state.signer };
  }

  // Poll for a receipt across nodes.
  async function waitReceipt(hash, timeoutMs = 180000) {
    const started = Date.now();
    let wait = 400;
    while (Date.now() - started < timeoutMs) {
      let r = null;
      try {
        r = await rpc("eth_getTransactionReceipt", [hash]);
      } catch (e) {
        r = null;
      }
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, wait));
      wait = Math.min(wait * 1.4, 4000);
    }
    throw new RpcError("等待交易确认超时");
  }

  // Sign and send a transaction through the current signer.
  async function send(fn, args, valueWei) {
    if (!state.account) throw new RpcError("请先连接账户");
    if (state.signer === "view") {
      throw new RpcError("这个地址只能查看，不能发交易。请连接浏览器钱包或选择节点账户");
    }
    const tx = { from: state.account, to: state.contract, data: A.encodeCall(fn, args) };
    const v = valueWei ? BigInt(valueWei) : 0n;
    if (v > 0n) tx.value = "0x" + v.toString(16);
    let hash;
    if (state.signer === "wallet") {
      const eth = walletProvider();
      if (!eth) throw new RpcError("钱包已经断开");
      hash = await eth.request({ method: "eth_sendTransaction", params: [tx] });
    } else {
      hash = await postOnce(writerUrl(), "eth_sendTransaction", [tx]);
    }
    const receipt = await waitReceipt(hash);

    let reason = null;
    if (receipt.status !== "0x1") {
      try {
        const url = state.signer === "wallet" ? rpcUrl() : writerUrl();
        await postOnce(url, "eth_call", [tx, "0x" + parseInt(receipt.blockNumber, 16).toString(16)]);
      } catch (e) {
        reason = e.message;
      }
    }

    return {
      hash,
      ok: receipt.status === "0x1",
      reason,
      gas: parseInt(receipt.gasUsed, 16),
      blockNumber: parseInt(receipt.blockNumber, 16),
      blockHash: receipt.blockHash,
    };
  }

  let deployBlockCache = null;

  // Find the contract deploy block from deployment info or logs.
  async function deployBlock() {
    if (deployBlockCache !== null) return deployBlockCache;

    try {
      const hasCode = async (n) =>
        (await rpc("eth_getCode", [state.contract, "0x" + n.toString(16)])) !== "0x";

      let lo = 0;
      let hi = parseInt(await rpc("eth_blockNumber", []), 16);
      if (!(await hasCode(hi))) throw new RpcError("这个地址上没有合约代码");
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (await hasCode(mid)) hi = mid;
        else lo = mid + 1;
      }
      deployBlockCache = lo;
      return lo;
    } catch (e) {
      const head = parseInt(await rpc("eth_blockNumber", []), 16);
      const step = 5000;
      for (let end = head; end > 0; end -= step) {
        const start = Math.max(0, end - step + 1);
        try {
          const logs = await rpc("eth_getLogs", [
            {
              address: state.contract,
              fromBlock: "0x" + start.toString(16),
              toBlock: "0x" + end.toString(16),
            },
          ]);
          if (logs.length) {
            const first = Math.min(...logs.map((l) => parseInt(l.blockNumber, 16)));
            deployBlockCache = Math.max(0, first - 1);
            return deployBlockCache;
          }
        } catch (err) {
          break;
        }
      }
      deployBlockCache = Math.max(0, head - Number(state.scanBlocks || 5000));
      return deployBlockCache;
    }
  }

  let chunkSize = 5000;

  // Scan one block range for matching logs.
  async function getLogsInRange(from, to, topics) {
    try {
      return await rpc("eth_getLogs", [
        {
          address: state.contract,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics,
        },
      ]);
    } catch (e) {
      if (chunkSize > 200 && to > from) {
        chunkSize = Math.max(200, Math.floor(chunkSize / 2));
        return getLogsInRange(from, to, topics);
      }
      throw e;
    }
  }

  // Scan event logs in client-sized chunks.
  async function getLogs({ topics, fromBlock, toBlock = "latest" }) {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    const from = fromBlock == null ? await deployBlock() : fromBlock;
    const to = toBlock === "latest" ? latest : toBlock;
    if (from > to) return [];

    const out = [];
    for (let start = from; start <= to; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, to);
      out.push(...(await getLogsInRange(start, end, topics)));
    }
    return out;
  }

  // Binary search the first block whose timestamp passes a value.
  async function findBlock(ts) {
    const floor = await deployBlock();
    let lo = floor;
    let hi = parseInt(await rpc("eth_blockNumber", []), 16);
    const tsOf = async (n) => Number((await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp);
    if ((await tsOf(hi)) < ts) return hi;
    if ((await tsOf(lo)) >= ts) return lo;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await tsOf(mid)) < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const uniqNames = (logs) => {
    const set = new Set();
    for (const log of logs) {
      const ev = A.decodeLog(log);
      if (ev && ev.name) set.add(String(ev.name).toLowerCase());
    }
    return [...set];
  };

  // Rebuild the listed names from registry state and logs.
  async function loadDomains(names) {
    const out = [];
    const now = await chainTime();
    for (let i = 0; i < names.length; i += 80) {
      const chunk = names.slice(i, i + 80);
      const items = [];
      for (const n of chunk) items.push({ fn: "resolve", args: [n] }, { fn: "saleOf", args: [n] });
      const results = await callBatch(items);
      for (let j = 0; j < chunk.length; j++) {
        const res = results[j * 2];
        const sale = results[j * 2 + 1];
        if (!res || !sale) continue;
        const [owner, key, version, expiry] = res;
        const [buyer, price, deadline, active] = sale;
        const listed = !!active;
        out.push({
          name: chunk[j],
          owner,
          key,
          version: Number(version),
          expiry: Number(expiry),
          registered: owner !== "0x0000000000000000000000000000000000000000",
          buyer,
          price: BigInt(price),
          deadline: Number(deadline),
          listed,
          open: listed && buyer === "0x0000000000000000000000000000000000000000",
        });
      }
    }
    return out;
  }

  // Read one name and its listing.
  async function domain(name) {
    const [d] = await loadDomains([name]);
    return d || null;
  }

  // Registry listings for the market page.
  async function loadListed(range) {
    const [count] = await call("listedCount", []);

    const registered = new Set();
    for (let off = 0; off < Number(count); off += 200) {
      const [page] = await call("listedNames", [off, 200]);
      for (const n of page) registered.add(String(n).toLowerCase());
    }

    const logs = await getLogs({ topics: [[SIG.SaleApproved]], fromBlock: range.from });
    const broadcast = new Set();
    const approvalBlock = new Map();
    for (const log of logs) {
      const ev = A.decodeLog(log);
      if (!ev || !ev.name) continue;
      const key = String(ev.name).toLowerCase();
      if (ev.persist === false) broadcast.add(key);
      const bn = parseInt(log.blockNumber, 16);
      if (!approvalBlock.has(key) || approvalBlock.get(key) < bn) approvalBlock.set(key, bn);
    }

    const names = [...new Set([...registered, ...broadcast])];
    const domains = await loadDomains(names);
    for (const d of domains) {
      d.persisted = registered.has(d.name);
      d.approvalBlock = approvalBlock.get(String(d.name).toLowerCase()) || 0;
    }

    return {
      items: domains.filter((d) => d.listed && d.registered),
      registered,
    };
  }

  // Names held by an address.
  async function loadMine(account) {
    const [names] = await call("domainsOf", [account]);
    if (!names.length) return [];
    const domains = await loadDomains(names.map((n) => String(n).toLowerCase()));
    return domains.filter((d) => d.registered && d.owner.toLowerCase() === account.toLowerCase());
  }

  // Recent settlements for an address.
  async function loadMySettled(account, range) {
    const who = addrTopic(account);
    const r = { fromBlock: range.from };
    const [asSeller, asBuyer] = await Promise.all([
      getLogs({ topics: [[SIG.Settled], null, null, who], ...r }),
      getLogs({ topics: [[SIG.Settled], null, who], ...r }),
    ]);
    const seen = new Set();
    return [...asSeller, ...asBuyer]
      .filter((l) => {
        if (seen.has(l.transactionHash + l.logIndex)) return false;
        seen.add(l.transactionHash + l.logIndex);
        return true;
      })
      .map((l) => {
        const ev = A.decodeLog(l);
        return {
          name: String(ev.name).toLowerCase(),
          buyer: ev.buyer,
          seller: ev.seller,
          price: BigInt(ev.price),
          block: parseInt(l.blockNumber, 16),
        };
      })
      .sort((a, b) => b.block - a.block);
  }

  async function withMeta(entries) {
    if (!entries.length) return entries;

    const blocks = [...new Set(entries.map((e) => e.block))];
    const txs = [...new Set(entries.map((e) => e.txHash).filter(Boolean))];

    const reqs = [
      ...blocks.map((b) => ({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] })),
      ...txs.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })),
    ];
    const res = await rpcBatch(reqs);

    const times = new Map();
    blocks.forEach((b, i) => {
      const blk = res[i];
      times.set(b, blk ? parseInt(blk.timestamp, 16) : 0);
    });
    const senders = new Map();
    txs.forEach((h, i) => {
      const tx = res[blocks.length + i];
      if (tx && tx.from) senders.set(h, tx.from);
    });

    for (const e of entries) {
      e.ts = times.get(e.block) || 0;
      e.from = senders.get(e.txHash) || null;
    }
    return entries;
  }

  // Everything the public account page needs.
  async function loadAccount(address) {
    const who = String(address).toLowerCase();
    const range = await scanRange();

    const [names] = await call("domainsOf", [who]);
    const domainList = await loadDomains((names || []).map((n) => String(n).toLowerCase()));
    const domains = domainList.filter((d) => d.registered);
    const listings = domains.filter((d) => d.listed);

    const [[earnings], balanceHex, sales] = await Promise.all([
      call("earningsOf", [who]),
      rpc("eth_getBalance", [who, "latest"]),
      loadMySettled(who, range),
    ]);

    return {
      address: who,
      domains,
      listings,
      earnings: BigInt(earnings),
      balance: BigInt(balanceHex),
      sales,
    };
  }

  // Events for one name.
  async function loadNameHistory(name) {
    const range = await scanRange();
    const wanted = [
      "Registered",
      "Renewed",
      "Transferred",
      "SigningKeyChanged",
      "SaleApproved",
      "SaleCancelled",
      "Settled",
      "RecordsUpdated",
      "Expired",
    ];

    const logs = await getLogs({
      topics: [wanted.map((n) => SIG[n])],
      fromBlock: range.from,
      toBlock: range.to,
    });

    const entries = [];
    for (const log of logs) {
      const ev = A.decodeLog(log);
      if (!ev || ev.name !== name) continue;
      entries.push({
        event: ev.event,
        data: ev,
        block: parseInt(log.blockNumber, 16),
        logIndex: parseInt(log.logIndex, 16),
        txHash: log.transactionHash,
      });
    }

    await withMeta(entries);
    entries.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    return entries;
  }

  // Recent settlements globally.
  async function loadSettled(range) {
    const logs = await getLogs({ topics: [[SIG.Settled]], fromBlock: range.from });
    return logs
      .map((l) => {
        const ev = A.decodeLog(l);
        return {
          name: String(ev.name).toLowerCase(),
          buyer: ev.buyer,
          seller: ev.seller,
          price: BigInt(ev.price),
          block: parseInt(l.blockNumber, 16),
        };
      })
      .sort((a, b) => b.block - a.block);
  }

  // One log scan pass over a block range.
  async function scanRange() {
    const to = parseInt(await rpc("eth_blockNumber", []), 16);
    const from = Math.max(0, to - state.scanBlocks + 1);
    return { from, to };
  }

  const cache = { world: null, at: 0 };

  // Home page snapshot: chain head, stats and listings.
  async function loadWorld(force) {
    if (!force && cache.world && Date.now() - cache.at < 4000) return cache.world;

    const account = state.account;

    const range = await scanRange();

    const [listedRes, settled, mine, mySettled, globals] = await Promise.all([
      loadListed(range),
      loadSettled(range),
      account ? loadMine(account) : [],
      account ? loadMySettled(account, range) : [],
      (async () => {
        const [fee, lease] = await Promise.all([call("FEE", []), call("LEASE", [])]);
        const contractBalance = BigInt(await rpc("eth_getBalance", [state.contract, "latest"]));
        const accountBalance = account ? BigInt(await rpc("eth_getBalance", [account, "latest"])) : 0n;
        const earnings = account ? BigInt((await call("earningsOf", [account]))[0]) : 0n;
        return {
          fee: BigInt(fee),
          lease: Number(lease),
          contractBalance,
          accountBalance,
          earnings,
        };
      })(),
    ]);

    let fin = null;
    try {
      fin = await finality();
    } catch (e) {
      fin = null;
    }
    const markPending = (d) => {
      d.pending = !!(fin && d.approvalBlock && d.approvalBlock > fin.finalized);
      d.pendingBlocks = d.pending ? d.approvalBlock - fin.finalized : 0;
      return d;
    };

    const listed = listedRes.items.map(markPending);

    const myListings = mine.filter((d) => d.listed).map(markPending);

    const incoming = listed.filter(
      (d) =>
        account &&
        d.buyer !== "0x0000000000000000000000000000000000000000" &&
        d.buyer.toLowerCase() === account.toLowerCase() &&
        d.owner.toLowerCase() !== account.toLowerCase()
    );

    const world = {
      listed,
      registered: listedRes.registered,
      settled,
      mine,
      myListings,
      incoming,
      mySettled,
      fromBlock: range.from,
      toBlock: range.to,
      scanBlocks: state.scanBlocks,
      ...globals,
    };
    cache.world = world;
    cache.at = Date.now();
    return world;
  }

  const invalidate = () => {
    cache.world = null;
  };

  // Finality distance for the current chain.
  async function finality() {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);

    try {
      const blk = await rpc("eth_getBlockByNumber", ["finalized", false]);
      if (blk && blk.number) {
        const finalized = parseInt(blk.number, 16);
        if (finalized < head) {
          return { mode: "tag", head, finalized, lag: head - finalized };
        }
      }
    } catch (e) {

    }

    const depth = chainDefaults(state.chainId).finalityDepth;
    return {
      mode: "depth",
      head,
      finalized: Math.max(0, head - depth),
      depth,
      lag: depth,
    };
  }

  let chainTimeCache = { at: 0, ts: 0 };

  // Latest block timestamp.
  async function chainTime() {
    if (Date.now() - chainTimeCache.at < 3000 && chainTimeCache.ts) return chainTimeCache.ts;
    const blk = await rpc("eth_getBlockByNumber", ["latest", false]);
    const ts = blk ? parseInt(blk.timestamp, 16) : Math.floor(Date.now() / 1000);
    chainTimeCache = { at: Date.now(), ts };
    return ts;
  }

  // Probe nodes: chain id, block number, state root and code.
  async function probeNodes() {
    const results = [];

    for (const url of state.rpcs) {
      try {
        const chainId = parseInt(await postOnce(url, "eth_chainId", []), 16);
        const blockNumber = parseInt(await postOnce(url, "eth_blockNumber", []), 16);
        const code = await postOnce(url, "eth_getCode", [state.contract, "latest"]);
        const genesis = await postOnce(url, "eth_getBlockByNumber", ["0x0", false]);
        results.push({ url, ok: true, chainId, blockNumber, code, genesis: genesis && genesis.hash });
      } catch (e) {
        results.push({ url, ok: false, error: e.message });
      }
    }

    const live = results.filter((r) => r.ok);
    if (!live.length) {
      return { total: results.length, live: 0, agree: false, height: 0, results };
    }

    const height = Math.min(...live.map((r) => r.blockNumber));
    for (const r of live) {
      try {
        const blk = await postOnce(r.url, "eth_getBlockByNumber", ["0x" + height.toString(16), false]);
        r.stateRoot = blk.stateRoot;
        r.blockHash = blk.hash;
      } catch (e) {
        r.ok = false;
        r.error = e.message;
      }
    }

    const good = results.filter((r) => r.ok);
    const reasons = [];

    if (!good.length) reasons.push("所有节点都不可用");

    const chainIds = new Set(good.map((r) => r.chainId));
    if (chainIds.size > 1) reasons.push("chainId 不同：" + [...chainIds].join(" / "));

    const geneses = new Set(good.map((r) => r.genesis).filter(Boolean));
    if (geneses.size > 1) reasons.push("创世块哈希不同，不是同一条链");

    const codes = new Set(good.map((r) => r.code));
    if (codes.size > 1) {
      const missing = good.filter((r) => r.code === "0x").length;
      reasons.push(missing ? `${missing} 个节点上这个地址没有合约代码` : "合约代码不一致");
    }

    const roots = new Set(good.map((r) => r.stateRoot));
    if (roots.size > 1) reasons.push(`区块 ${height} 上的状态根不同`);

    const heights = good.map((r) => r.blockNumber);
    const spread = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
    if (spread > 4) reasons.push(`块高相差 ${spread} 个块`);
    const behind = spread > 50;

    const agree = reasons.length === 0;

    state.pinUrl = agree ? null : (good[0] && good[0].url) || null;

    return {
      pinned: state.pinUrl,
      total: results.length,
      live: good.length,
      agree,
      behind,
      reasons,
      height,
      chainId: chainIds.size === 1 ? good[0].chainId : null,
      results,
    };
  }

  async function connect(rpcUrls, contract) {
    state.rpcs = (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]).filter(Boolean);
    if (!state.rpcs.length) throw new RpcError("至少要有一个节点地址");

    if (contract !== state.contract) deployBlockCache = null;
    state.contract = contract;

    const health = await probeNodes();
    const first = health.results.find((r) => r.ok);
    if (!first) throw new RpcError("所有节点都连不上");

    state.chainId = first.chainId;
    state.writer = first.url;

    let accounts = [];
    try {
      accounts = await postOnce(first.url, "eth_accounts", []);
    } catch (e) {
      accounts = [];
    }

    state.nodeAccounts = accounts;

    if (state.signer === "wallet" && state.account) {
      state.accounts = [state.account];
    } else if (state.signer === "view" && state.account) {
      state.accounts = [state.account];
    } else {
      state.signer = "node";
      state.accounts = accounts;
      state.account = accounts[0] || null;
    }
    cache.world = null;

    return {
      chainId: state.chainId,
      chainName: chainDefaults(state.chainId).name,
      accounts: state.accounts,
      account: state.account,
      signer: state.signer,
      walletAvailable: !!walletProvider(),
      health,
    };
  }

  // Select the signer account.
  function pickAccount(addr, kind) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(addr || ""))) {
      throw new RpcError("地址格式不对");
    }
    state.account = addr;
    if (kind === "wallet") {
      state.signer = "wallet";
      state.accounts = [addr];
    } else if (kind === "view") {
      state.signer = "view";
      state.accounts = [addr];
    } else {
      state.signer = "node";
      state.accounts = state.nodeAccounts.length ? state.nodeAccounts.slice() : [addr];
    }
    cache.world = null;
    return { account: state.account, accounts: state.accounts, signer: state.signer };
  }

  // Drop the wallet connection.
  function disconnectWallet() {
    state.signer = "node";
    state.accounts = state.nodeAccounts.slice();
    state.account = state.accounts[0] || null;
    cache.world = null;
    return { account: state.account, accounts: state.accounts, signer: state.signer };
  }

  global.Chain = {
    cfg,
    pickAccount,
    disconnectWallet,
    setConfig,
    connect,
    connectWallet,
    walletList,
    onWalletList,
    chainDefaults,
    probeNodes,
    rpc,
    call,
    callBatch,
    send,
    domain,
    deployBlock,
    loadDomains,
    loadWorld,
    loadNameHistory,
    head: async () => parseInt(await rpc("eth_blockNumber", []), 16),
    chainTime,
    finality,
    finalityDepth: () => state.finalityDepth,
    loadAccount,
    invalidate,
    RpcError,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
