// ── Vercel Serverless Telegram Bot for Arth Finance Advisor (v2.0) ───────────
// 10 template commands, AI chat with Gemini fallback, inline keyboards,
// smart caching, progress bars, month-over-month comparison.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_URL  = process.env.DASHBOARD_URL;
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const GROQ_MODEL_FAST = "llama-3.1-8b-instant";
const MAX_TOKENS      = 2048;
// In-process cache only — applies to THIS serverless instance. New/cold instances start empty,
// so most requests still hit Apps Script. Real speedup for repeat traffic is Apps Script CacheService (bot_v3).
const CACHE_TTL_TEMPLATE = 10 * 60 * 1000; // align ~with DATA_CACHE_SECONDS on Apps Script
const CACHE_TTL_CHAT     = 10 * 60 * 1000;

let dataCache = { data: null, ts: 0 };
let conversationMemory = [];
const MAX_MEMORY = 10;

/** Set `TELEGRAM_WEBHOOK_DEBUG=1` in Vercel env for verbose webhook + Apps Script write logs. */
const TELEGRAM_WEBHOOK_DEBUG =
  process.env.TELEGRAM_WEBHOOK_DEBUG === "1" || String(process.env.TELEGRAM_WEBHOOK_DEBUG || "").toLowerCase() === "true";

function whDebug(label, data) {
  if (!TELEGRAM_WEBHOOK_DEBUG) return;
  try {
    const s =
      data === undefined
        ? ""
        : typeof data === "string"
          ? data
          : JSON.stringify(data);
    console.log("[telegram-wh-debug]", label, s.length > 1200 ? s.slice(0, 1200) + "…" : s);
  } catch (_) {
    console.log("[telegram-wh-debug]", label, String(data));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const N = (v) => typeof v === "number" ? v : parseFloat(String(v || "0").replace(/[^0-9.\-]/g, "")) || 0;
const I = (v) => Math.round(N(v)).toLocaleString("en-IN");
const fmt = (v) => {
  const n = Math.round(N(v));
  return (n < 0 ? "-" : "") + "Rs " + Math.abs(n).toLocaleString("en-IN");
};
const pct = (part, total) => total > 0 ? Math.round((part / total) * 100) : 0;
const bar = (val) => {
  const p = Math.min(100, Math.max(0, Math.round(val)));
  const f = Math.round(p / 10);
  return "[" + "=".repeat(f) + "-".repeat(10 - f) + "] " + p + "%";
};
const arrow = (curr, prev) => {
  if (prev === 0 && curr === 0) return " --";
  const diff = curr - prev;
  if (diff === 0) return " --";
  return ` (${diff > 0 ? "+" : ""}${I(diff)})`;
};
const monthsFromNow = (m) => {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
};

/** Normalize sheet header keys (handles newlines from Google Sheets JSON). */
function normalizeSheetHeaderKey(k) {
  return String(k || "")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findSheetRows(section, hints) {
  if (!section || typeof section !== "object") return [];
  for (const h of hints) {
    const hl = h.toLowerCase();
    for (const key of Object.keys(section)) {
      if (key.toLowerCase().includes(hl) && Array.isArray(section[key])) return section[key];
    }
  }
  for (const key of Object.keys(section)) {
    if (Array.isArray(section[key]) && section[key].length > 0) return section[key];
  }
  return [];
}

function interestReceivedFromBorrowerRow(pr) {
  if (!pr || typeof pr !== "object") return 0;
  for (const key of Object.keys(pr)) {
    const nk = normalizeSheetHeaderKey(key);
    if (nk.includes("interest") && nk.includes("received") && !nk.includes("accrued") && !nk.includes("pending")) {
      return N(pr[key]);
    }
  }
  return 0;
}

/** Sum P2P interest from one tab's rows (horizontal columns or vertical "Interest received" KPI rows). */
function sumLendenInterestFromTabRows(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let rowHit = false;
    for (const key of Object.keys(row)) {
      const nk = normalizeSheetHeaderKey(key);
      if (!nk.includes("interest") || nk.includes("rate") || nk.includes("outstanding")) continue;
      if (nk.includes("principal") && !nk.includes("recv") && !nk.includes("received")) continue;
      if (nk.includes("accrued")) continue;
      total += N(row[key]);
      rowHit = true;
    }
    if (rowHit) continue;
    // Vertical month tabs (label + value): e.g. { "Field": "Interest received", "Value": 150.2 }
    for (const v of Object.values(row)) {
      const asStr = typeof v === "string" ? v : "";
      if (!/interest\s*received/i.test(asStr)) continue;
      for (const v2 of Object.values(row)) {
        if (v2 === v) continue;
        const n = N(v2);
        if (n > 0) {
          total += n;
          break;
        }
      }
      break;
    }
  }
  return total;
}

/**
 * Personal lending = sum of Borrowers "Interest Received" (direct loans).
 * Lenden Club: prefer "Tab Summary" (same rows as dashboard getLendenClubData_) when Apps Script merges it;
 * else sum month tabs / other sheets (legacy readAllSheetsRaw-only payloads).
 */
function computeInterestReceivedKpis(raw) {
  raw = raw || {};
  let plInterestReceivedTillNow = 0;
  const plRows = findSheetRows(raw.personalLending || {}, ["borrower"]);
  for (const pr of plRows) {
    plInterestReceivedTillNow += interestReceivedFromBorrowerRow(pr);
  }

  let lcInterestReceivedTillNow = 0;
  const lcSec = raw.lendenClub || {};
  const tabSummaryRows = lcSec["Tab Summary"];
  if (Array.isArray(tabSummaryRows) && tabSummaryRows.length > 0) {
    lcInterestReceivedTillNow = sumLendenInterestFromTabRows(tabSummaryRows);
    return { plInterestReceivedTillNow, lcInterestReceivedTillNow };
  }
  const skipTab = (name) =>
    /datewise|transaction\s*log|pool\s*growth|cashflow|loan\s*sample|settings|readme|summary\s*meta/i.test(
      String(name || "").replace(/\s+/g, " ")
    );

  const monthRe = /^[A-Za-z]{3}-\d{2}$/i;
  const allLcKeys = Object.keys(lcSec);
  const monthTabKeys = allLcKeys.filter((k) => monthRe.test(String(k || "").trim()));
  // If month tabs exist, sum only those (avoids double-count vs Monthly-Summary). Else use all non-skipped (Tab Summary, Monthly-Summary, etc.).
  const lcTabKeysToSum =
    monthTabKeys.length > 0 ? monthTabKeys : allLcKeys.filter((k) => !skipTab(k));

  for (const tabKey of lcTabKeysToSum) {
    if (monthTabKeys.length === 0 && skipTab(tabKey)) continue;
    const rows = lcSec[tabKey];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    lcInterestReceivedTillNow += sumLendenInterestFromTabRows(rows);
  }

  return { plInterestReceivedTillNow, lcInterestReceivedTillNow };
}

/** Merge computed interest KPIs (bot_v3 Apps Script kpis omit these). */
function enrichBotPayload(botData) {
  if (!botData || !botData.raw) return botData;
  const extra = computeInterestReceivedKpis(botData.raw);
  return {
    ...botData,
    kpis: { ...(botData.kpis || {}), ...extra },
  };
}

// ── Telegram API ─────────────────────────────────────────────────────────────
async function sendTelegram(chatId, text, opts = {}) {
  if (!TELEGRAM_TOKEN) {
    console.error("[sendTelegram] TELEGRAM_TOKEN missing");
    throw new Error("TELEGRAM_TOKEN not set on server");
  }
  const MAX_LEN = 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) chunks.push(text.slice(i, i + MAX_LEN));
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chatId, text: chunks[i] };
    if (i === chunks.length - 1 && opts.reply_markup) body.reply_markup = opts.reply_markup;
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      console.error("[telegram-wh] sendMessage_failed", { chatId, http: resp.status, telegram: data });
      throw new Error(data.description || `Telegram sendMessage HTTP ${resp.status}`);
    }
  }
  whDebug("sendMessage_ok", { chatId, chunks: chunks.length, textLen: text.length });
}

async function answerCallback(id) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  });
}

const mainKeyboard = {
  inline_keyboard: [
    [
      { text: "Summary", callback_data: "/summary" },
      { text: "Net Worth", callback_data: "/networth" },
      { text: "Goals", callback_data: "/goals" },
    ],
    [
      { text: "Alerts", callback_data: "/alerts" },
      { text: "Borrowers", callback_data: "/borrowers" },
      { text: "Loans", callback_data: "/loans" },
    ],
    [
      { text: "Compare", callback_data: "/compare" },
      { text: "Expenses", callback_data: "/expenses" },
      { text: "Projection", callback_data: "/projection" },
    ],
  ],
};

/** Hosts used by deployed Apps Script web apps (302 from script.google.com → script.googleusercontent.com). */
function isGoogleAppsScriptHost(hostname) {
  return hostname === "script.google.com" || hostname.endsWith(".googleusercontent.com");
}

/**
 * Call a Google Apps Script /exec URL. Default fetch + redirect breaks POST writes: a 302 replays as GET,
 * drops the JSON body, and Apps Script returns an HTML error page (often still HTTP 200).
 * We follow redirects manually and re-send the same method + body to Google's next hop.
 */
async function fetchGoogleAppsScriptWebApp(urlString, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body;
  const headers = options.headers;

  let current = urlString;
  const maxHops = 10;
  const sendBody = method !== "GET" && method !== "HEAD" && body !== undefined;

  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetch(current, {
      method,
      headers,
      body: sendBody ? body : undefined,
      redirect: "manual",
    });

    if (resp.status < 300 || resp.status >= 400) {
      return resp;
    }

    const loc = resp.headers.get("location") || resp.headers.get("Location");
    if (!loc) {
      return resp;
    }

    let nextUrl;
    try {
      nextUrl = new URL(loc, current).href;
    } catch {
      return resp;
    }

    let nextHost;
    try {
      nextHost = new URL(nextUrl).hostname;
    } catch {
      return resp;
    }

    if (!isGoogleAppsScriptHost(nextHost)) {
      return fetch(nextUrl, { method, headers, body: sendBody ? body : undefined, redirect: "follow" });
    }

    current = nextUrl;
  }

  return fetch(current, { method, headers, body: sendBody ? body : undefined, redirect: "follow" });
}

// ── Data Fetcher (two layers) ────────────────────────────────────────────────
// 1) Vercel: dataCache above — fast only if same instance + within TTL; cleared on every /log, /set, /invest, etc.
// 2) Apps Script doGetBot: CacheService "bot_v3" — shared across all callers; miss runs readAllSheetsRaw() (slow).
// Slowness after a write or cold start = layer 2 miss. Slowness on every free-text message = Groq/Gemini (callAI), not this cache.
async function getFinancialData(forTemplate = true) {
  const ttl = forTemplate ? CACHE_TTL_TEMPLATE : CACHE_TTL_CHAT;
  const mode = forTemplate ? "template" : "chat";
  if (dataCache.data && Date.now() - dataCache.ts < ttl) {
    console.log(`[getFinancialData] Vercel cache HIT (${mode}) age=${Math.round((Date.now() - dataCache.ts) / 1000)}s`);
    return dataCache.data;
  }
  console.log(`[getFinancialData] Vercel cache MISS (${mode}) — calling Apps Script...`);

  // Strategy 1: Try ?mode=bot (universal raw data + KPIs from Apps Script v3)
  const t0 = Date.now();
  try {
    const botUrl = DASHBOARD_URL + (DASHBOARD_URL.includes("?") ? "&" : "?") + "mode=bot";
    const botResp = await fetchGoogleAppsScriptWebApp(botUrl, { method: "GET" });
    const text = await botResp.text();
    let botData;
    try {
      botData = JSON.parse(text);
    } catch (e) {
      console.error(`[getFinancialData] Non-JSON from Apps Script (${botResp.status}):`, text.slice(0, 200));
      throw e;
    }
    const ms = Date.now() - t0;
    if (botData && botData._source === "bot_v3" && botData.raw && botData.kpis) {
      console.log(`[getFinancialData] Apps Script OK in ${ms}ms (_source=bot_v3)`);
      const enriched = enrichBotPayload(botData);
      dataCache = { data: enriched, ts: Date.now() };
      return enriched;
    }
    console.log(`[getFinancialData] Unexpected payload in ${ms}ms:`, botData?._source || typeof botData);
  } catch (err) {
    console.error(`[getFinancialData] mode=bot failed after ${Date.now() - t0}ms:`, err.message);
  }

  // Strategy 2: Fallback to old dashboard endpoint
  try {
    const resp = await fetchGoogleAppsScriptWebApp(DASHBOARD_URL, { method: "GET" });
    let raw = await resp.json();
    if (raw?.data) raw = raw.data;
    const summary = buildBotSummary(raw);
    dataCache = { data: { kpis: summary, raw: null, _source: "fallback" }, ts: Date.now() };
    return dataCache.data;
  } catch (_) {}

  return { kpis: {}, raw: null, _source: "error" };
}

// ── buildBotSummary (mirrors React dashboard calculations) ───────────────────
function buildBotSummary(p) {
  p = p || {};

  // Case-insensitive, trim-aware field lookup
  function V(row, ...names) {
    if (!row || typeof row !== "object") return undefined;
    for (const name of names) {
      const lower = name.toLowerCase().trim();
      for (const key of Object.keys(row)) {
        if (key.trim().toLowerCase() === lower) return row[key];
      }
    }
    return undefined;
  }

  function findSheet(section, names) {
    if (!section) return [];
    for (const name of names) {
      if (Array.isArray(section[name]) && section[name].length > 0) return section[name];
    }
    for (const key of Object.keys(section)) {
      if (Array.isArray(section[key]) && section[key].length > 0) return section[key];
    }
    return [];
  }

  // Income (current month)
  const incRows = findSheet(p.income, ["Income Tracker"]);
  const validRows = incRows.filter(r => N(V(r, "Salary", "salary")) > 0);
  const cur = validRows.length > 0 ? validRows[validRows.length - 1] : {};
  const salary = N(V(cur, "Salary"));
  const tutoring = N(V(cur, "DevOps Tutoring", "Tutoring"));
  const lendingInt = N(V(cur, "Personal Lending Interest", "Lending Interest"));
  const otherInc = N(V(cur, "Other Income"));
  const grossTotal = N(V(cur, "Gross Total", "Total Gross", "Gross Income", "gross_total")) || (salary + tutoring + lendingInt + otherInc);
  const ccBills = N(V(cur, "CreditCard Bills", "Credit Card Bills", "CC Bills"));
  const hdfcEmi = N(V(cur, "HDFC EMI"));
  const idfcEmi = N(V(cur, "IDFC EMI"));
  const sbiEmi = N(V(cur, "SBI EMI"));
  const loanEMI = hdfcEmi + idfcEmi + sbiEmi;
  const inHand = N(V(cur, "In Hand", "In-Hand", "in_hand", "Net Balance")) || Math.max(0, grossTotal - ccBills - loanEMI);
  const month = String(V(cur, "Month") || "");
  const age = N(V(cur, "Age")) || 30;

  // Previous month (for /compare)
  const prev = validRows.length > 1 ? validRows[validRows.length - 2] : {};
  const pSal = N(V(prev, "Salary"));
  const pTut = N(V(prev, "DevOps Tutoring", "Tutoring"));
  const pLend = N(V(prev, "Personal Lending Interest", "Lending Interest"));
  const pGross = N(V(prev, "Gross Total", "Total Gross", "Gross Income", "gross_total")) || (pSal + pTut + pLend + N(V(prev, "Other Income")));
  const pCC = N(V(prev, "CreditCard Bills", "Credit Card Bills", "CC Bills"));
  const pEMI = N(V(prev, "HDFC EMI")) + N(V(prev, "IDFC EMI")) + N(V(prev, "SBI EMI"));
  const pInHand = N(V(prev, "In Hand", "In-Hand", "in_hand", "Net Balance")) || Math.max(0, pGross - pCC - pEMI);
  const prevMonthData = {
    month: String(V(prev, "Month") || ""),
    salary: pSal, grossIncome: pGross, creditCardBills: pCC,
    loanEMI: pEMI, inHand: pInHand, tutoring: pTut, lendingInterest: pLend,
  };

  const salaryHistory = validRows.slice(-6).map(r => {
    const rSal = N(V(r, "Salary"));
    const rGross = N(V(r, "Gross Total", "Total Gross", "Gross Income", "gross_total")) || rSal;
    const rInHand = N(V(r, "In Hand", "In-Hand", "in_hand"));
    return { month: String(V(r, "Month") || ""), gross: rGross, inHand: rInHand };
  });

  // Loans (full raw rows preserved)
  const loanNames = ["HDFC", "IDFC", "SBI"];
  const defaultRates = { HDFC: 10.5, IDFC: 13.5, SBI: 9.35 };
  const defaultTotal = { HDFC: 72, IDFC: 60, SBI: 25 };
  const loans = [];
  let totalDebt = 0;
  const loanSec = p.loans || {};
  for (const name of loanNames) {
    let lRows = loanSec[name];
    if (!Array.isArray(lRows) || lRows.length === 0) {
      if (typeof loanSec[name] === "object" && !Array.isArray(loanSec[name]) && loanSec[name]) {
        lRows = [loanSec[name]];
      } else continue;
    }
    const lr = lRows[0];
    const emi = N(V(lr, "EMI", "Monthly EMI", "emi"));
    const outstanding = N(V(lr, "Outstanding", "Balance Outstanding", "outstanding"));
    const rate = N(V(lr, "Interest Rate", "Rate", "interestRate")) || defaultRates[name];
    const totalEmis = N(V(lr, "Total EMIs", "Tenure", "total")) || defaultTotal[name];
    const paidEmis = N(V(lr, "EMIs Paid", "Paid", "paid"));
    const emisLeft = Math.max(0, totalEmis - paidEmis);
    if (emi > 0 || outstanding > 0) {
      loans.push({ ...lr, name, emi, outstanding, rate, totalEmis, paidEmis, emisLeft });
      totalDebt += outstanding;
    }
  }

  // Investments
  const stocksSec = p.stocks || {};
  const investments = [];
  let totalStocksCurrent = 0;
  const portSummary = findSheet(stocksSec, ["Portfolio Summary", "Summary"]);
  for (const row of portSummary) {
    const cls = String(V(row, "Asset Class", "Name", "Category") || "").trim();
    if (!cls || cls === "TOTAL" || cls.includes("HOW TO") || cls === "Step") continue;
    const cv = N(V(row, "Current Value", "Current Value (₹)", "Value", "Market Value"));
    const pl = N(V(row, "P&L", "P&L (₹)", "Returns", "Gain"));
    if (cv > 0) { investments.push({ ...row, name: cls, current: cv, pl }); totalStocksCurrent += cv; }
  }
  if (investments.length === 0) {
    for (const sn of ["Mutual Funds", "Equity", "Options", "Crypto", "Real Estate"]) {
      const sRows = stocksSec[sn];
      if (!Array.isArray(sRows)) continue;
      let tv = 0, tp = 0;
      const rawItems = [];
      for (const sr of sRows) {
        tv += N(V(sr, "Current Value (₹)", "Current Value", "Value", "Market Value"));
        tp += N(V(sr, "P&L (₹)", "P&L", "Returns (₹)", "Gain"));
        rawItems.push(sr);
      }
      if (tv > 0) { investments.push({ name: sn, current: tv, pl: tp, items: rawItems }); totalStocksCurrent += tv; }
    }
  }
  // Fallback: check if summary totals exist directly
  if (totalStocksCurrent === 0 && stocksSec.summary) {
    const st = stocksSec.summary?.total || stocksSec.summary;
    totalStocksCurrent = N(V(st, "current", "Current Value", "value")) || 0;
    const stPl = N(V(st, "pl", "P&L", "returns")) || 0;
    if (totalStocksCurrent > 0) investments.push({ name: "All Stocks", current: totalStocksCurrent, pl: stPl });
  }

  // LendenClub
  const lcSec = p.lendenClub || {};
  const tabSummary = findSheet(lcSec, ["Tab Summary"]);
  let lcDisbursed = 0, lcInterest = 0, lcOutstanding = 0, lcLoans = 0, lcNPA = 0;
  for (const t of tabSummary) {
    lcDisbursed += N(V(t, "Disbursed")); lcInterest += N(V(t, "Interest"));
    lcOutstanding += N(V(t, "Outstanding")); lcLoans += N(V(t, "Loans")); lcNPA += N(V(t, "NPA", "npa"));
  }
  const lcSummaryRows = findSheet(lcSec, ["LC Summary"]);
  let lcPooled = 0;
  for (let i = lcSummaryRows.length - 1; i >= 0; i--) {
    const pool = N(V(lcSummaryRows[i], "Closing Pool", "Pool"));
    if (pool > 0) { lcPooled = pool; break; }
  }
  if (lcPooled === 0) lcPooled = N(lcSec.totalPooled || lcSec.closingPool);

  // Personal lending (full raw rows preserved)
  const plRows = findSheet(p.personalLending || {}, ["Borrowers"]);
  let plCap = 0, plMonthly = 0, plOverdue = 0, plPendingInt = 0;
  const borrowers = [];
  for (const pr of plRows) {
    const amt = N(V(pr, "Amount", "Amount Lent", "Amount Lent (₹)", "Principal"));
    const bName = V(pr, "Name", "Borrower Name", "Borrower");
    if (!bName || amt === 0) continue;
    if (/closed|inactive/i.test(String(V(pr, "Loan Status", "Payment Status", "Status") || ""))) continue;
    const mInt = N(V(pr, "Monthly Int", "Monthly Interest", "Monthly Interest (₹)"));
    const pend = N(V(pr, "Pending Int", "Pending Interest", "Pending Interest (₹)", "Overdue"));
    plCap += amt; plMonthly += mInt; plPendingInt += pend;
    if (pend > 0) plOverdue++;
    borrowers.push({ ...pr, name: String(bName), amount: amt, monthly: mInt, overdue: pend });
  }

  // Real estate
  const reProp = findSheet(p.realEstate || {}, ["Property Detail", "Real Estate", "Property", "Land"]);
  const reRow = reProp.length > 0 ? reProp[0] : {};
  let reName = String(V(reRow, "Property Name", "Name", "Builder") || "");
  let reTotalCost = N(V(reRow, "Total Cost", "Total Amount"));
  let rePaid = N(V(reRow, "Paid", "Amount Paid"));
  let reRemaining = N(V(reRow, "Remaining", "Balance"));
  if (reTotalCost === 0 && rePaid === 0) {
    reName = "Tricolour Properties"; reTotalCost = 857500; rePaid = 542500; reRemaining = 315000;
  }

  // Derived (mirrors App.jsx)
  const totalInvestments = totalStocksCurrent + lcPooled + plCap + rePaid;
  const netWorth = totalInvestments - totalDebt;
  const emiBurdenPct = salary > 0 ? Math.round((loanEMI / salary) * 100) : 0;
  const savingsRatePct = grossTotal > 0 ? Math.round((Math.max(0, inHand) / grossTotal) * 100) : 0;

  // Goals
  const monthlyCap = Math.max(0, inHand - 15000);

  const intK = computeInterestReceivedKpis(p);

  return {
    month, age, salary, tutoring, lendingInterest: lendingInt, otherIncome: otherInc,
    grossIncome: grossTotal, creditCardBills: ccBills, loanEMI, inHand, salaryHistory,
    hdfcEmi, idfcEmi, sbiEmi, prevMonthData,
    loans, totalDebt, investments, totalStocksCurrent,
    lcPooled, lcDisbursed, lcInterest, lcOutstanding, lcActiveLoans: lcLoans, lcNPA,
    plTotalCapital: plCap, plMonthlyInterest: plMonthly, plOverdueCount: plOverdue,
    plPendingInt, borrowers,
    plInterestReceivedTillNow: intK.plInterestReceivedTillNow,
    lcInterestReceivedTillNow: intK.lcInterestReceivedTillNow,
    reName, reTotalCost, rePaid, reRemaining,
    rePct: reTotalCost > 0 ? Math.round((rePaid / reTotalCost) * 100) : 0,
    totalInvestments, totalAssets: totalInvestments, netWorth,
    emiBurdenPct, savingsRatePct, monthlyCap,
    goals: {
      idfcPct: Math.min(100, Math.round((totalInvestments / 1000000) * 100)),
      sbiPct: (loans.find(l => l.name === "SBI")?.outstanding || 0) > 0 ? 0 : 100,
      invPct: Math.min(100, Math.round((totalInvestments / 1000000) * 100)),
      lcPct: Math.min(100, Math.round((lcPooled / 500000) * 100)),
      nwPct: Math.min(100, Math.max(0, Math.round((netWorth / 10000000) * 100))),
    },
    rawCurrentIncome: cur,
    rawRealEstate: reRow,
    rawLCTabSummary: tabSummary,
    rawLCSummary: lcSummaryRows,
  };
}

// ── Template helper: dump raw rows from a section ────────────────────────────
function rawRows(d, section, tabHints) {
  const sec = d.raw?.[section] || {};
  for (const hint of (tabHints || [])) {
    for (const key of Object.keys(sec)) {
      if (key.toLowerCase().includes(hint.toLowerCase()) && Array.isArray(sec[key])) return sec[key];
    }
  }
  for (const key of Object.keys(sec)) {
    if (Array.isArray(sec[key]) && sec[key].length > 0) return sec[key];
  }
  return [];
}

function rowToLine(row) {
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");
}

// ── Template Responses (100% consistent, no AI) ─────────────────────────────

function templateSummary(d) {
  const k = d.kpis || {};
  const incLines = Object.entries(k.incomeRaw || {})
    .filter(([,v]) => v !== null && v !== undefined && v !== "" && v !== 0 && v !== "-")
    .map(([key, val]) => `  ${key}: ${typeof val === "number" ? fmt(val) : val}`)
    .join("\n") || "  No income data";
  return `ARTH FINANCIAL SNAPSHOT (${k.month || "Current"})

INCOME & BUDGET
${incLines}

INVESTMENTS: ${fmt(k.totalStocks)}
LENDENCLUB: ${fmt(k.lcPooled)} | interest received (LC): ${fmt(k.lcInterestReceivedTillNow || 0)}
PERSONAL LENDING: ${fmt(k.plCapital)} (Rs ${I(k.plMonthly)}/mo) | interest received (PL): ${fmt(k.plInterestReceivedTillNow || 0)}${k.plPending > 0 ? ` | OVERDUE: ${fmt(k.plPending)}` : ""}
REAL ESTATE: ${fmt(k.rePaid)} of ${fmt(k.reCost || 0)}

TOTAL DEBT: ${fmt(k.totalDebt)}
EMI Burden: ${k.emiBurdenPct}%${k.emiBurdenPct > 50 ? " -- HIGH" : ""}
Savings Rate: ${k.savingsRatePct}%

NET WORTH: ${fmt(k.netWorth)}
  Assets: ${fmt(k.totalInvestments)} | Debt: ${fmt(k.totalDebt)}`;
}

function templateNetWorth(d) {
  const k = d.kpis || {};
  return `NET WORTH BREAKDOWN (${k.month || "Current"})

ASSETS
  Stocks/MF: ${fmt(k.totalStocks)}
  LendenClub: ${fmt(k.lcPooled)}
  Personal Lending: ${fmt(k.plCapital)}
  Real Estate: ${fmt(k.rePaid)}
  ---------------
  TOTAL: ${fmt(k.totalInvestments)}

LIABILITIES
  Total Debt: ${fmt(k.totalDebt)}

NET WORTH: ${fmt(k.netWorth)}
${k.netWorth < 0 ? "(Deficit)" : "(Positive)"}`;
}

function templateGoals(d) {
  const k = d.kpis || {};
  const invPct = Math.min(100, Math.round((k.totalInvestments / 1000000) * 100));
  const lcPct = Math.min(100, Math.round((k.lcPooled / 500000) * 100));
  const nwPct = Math.min(100, Math.max(0, Math.round((k.netWorth / 10000000) * 100)));

  return `FINANCIAL GOALS (${k.month || "Current"})

1. Rs 10L Investments
   Current: ${fmt(k.totalInvestments)}
   ${bar(invPct)}

2. Rs 5L LendenClub Pool
   Current: ${fmt(k.lcPooled)}
   ${bar(lcPct)}

3. Rs 1 Crore Net Worth
   Current: ${fmt(k.netWorth)}
   ${bar(nwPct)}

Savings capacity: ${fmt(k.monthlyCap)}/mo`;
}

function templateAlerts(d) {
  const k = d.kpis || {};
  const alerts = [];
  if (k.emiBurdenPct > 50) alerts.push(`EMI Burden CRITICAL at ${k.emiBurdenPct}% (should be <50%)`);
  if (k.savingsRatePct < 20) alerts.push(`Savings Rate LOW at ${k.savingsRatePct}% (target: >20%)`);
  if (k.plPending > 0) alerts.push(`OVERDUE: ${fmt(k.plPending)} pending from borrowers`);
  if (alerts.length === 0) alerts.push("All parameters on track. No alerts.");
  return `ARTH ALERTS (${k.month || "Current"})\n\n${alerts.map((a, i) => `${i + 1}. !! ${a}`).join("\n")}`;
}

function templateCompare(d) {
  const incRows = rawRows(d, "income", ["Income Tracker", "Income"]);
  const valid = incRows.filter(r => N(r["Salary"] || r["salary"] || 0) > 0);
  if (valid.length < 2) return "Need at least 2 months of data for comparison.";
  const cur = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  const f = (row, ...keys) => { for (const k of keys) { const v = row[k]; if (v !== undefined && v !== "") return N(v); } return 0; };
  const cSal = f(cur, "Salary"); const pSal = f(prev, "Salary");
  const cInH = f(cur, "In Hand", "In-Hand"); const pInH = f(prev, "In Hand", "In-Hand");
  const cGross = f(cur, "Gross Total", "Gross Income") || cSal; const pGross = f(prev, "Gross Total", "Gross Income") || pSal;

  return `MONTH COMPARISON
${prev["Month"] || "Prev"} --> ${cur["Month"] || "Current"}

Salary:       ${fmt(pSal)} --> ${fmt(cSal)}${arrow(cSal, pSal)}
Gross Income: ${fmt(pGross)} --> ${fmt(cGross)}${arrow(cGross, pGross)}
In-Hand:      ${fmt(pInH)} --> ${fmt(cInH)}${arrow(cInH, pInH)}`;
}

function templateBorrowers(d) {
  const rows = rawRows(d, "personalLending", ["Borrower", "Lending"]);
  if (rows.length === 0) return "No borrower data found.";
  const k = d.kpis || {};
  const lines = rows.map((r, i) => {
    const fields = Object.entries(r)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== "-")
      .map(([key, v]) => `   ${key}: ${v}`);
    return `${i + 1}. ${fields.join("\n")}`;
  }).join("\n\n");

  return `PERSONAL LENDING BREAKDOWN

${lines}

---------------
Total Capital: ${fmt(k.plCapital)}
Monthly Interest: ${fmt(k.plMonthly)}/mo
Interest received till now (personal lending only): ${fmt(k.plInterestReceivedTillNow || 0)}
Total Overdue: ${k.plPending > 0 ? fmt(k.plPending) : "--"}`;
}

function templateLoans(d) {
  const loanSec = d.raw?.loans || {};
  const tabs = Object.keys(loanSec);
  if (tabs.length === 0) return "No loan data found.";
  const k = d.kpis || {};

  const lines = tabs.map((tab, i) => {
    const rows = loanSec[tab];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    let lastPaidIdx = -1;
    for (let r = 0; r < rows.length; r++) {
      const st = String(Object.values(rows[r]).find(v => /^(paid|done|completed)$/i.test(String(v))) || "");
      if (/paid|done|completed/i.test(st)) lastPaidIdx = r;
    }

    const lastPaid = lastPaidIdx >= 0 ? rows[lastPaidIdx] : null;
    const nextDue = lastPaidIdx < rows.length - 1 ? rows[lastPaidIdx + 1] : null;
    const emiVal = N(Object.values(rows[0]).find(v => typeof v === "number" && v > 1000 && v < 100000) || 0);

    let s = `${i + 1}. ${tab}${tab === "IDFC" ? " <-- PRIORITY" : ""}`;

    if (lastPaid) {
      const outstandingKeys = Object.keys(lastPaid).filter(k => /outstanding|closing.*balance/i.test(k.replace(/\s+/g, " ")));
      const outVal = outstandingKeys.length > 0 ? N(lastPaid[outstandingKeys[0]]) : 0;
      const paidNo = lastPaid["Instalment No."] || lastPaid["#"] || "";
      s += `\n   Last Paid: #${paidNo}`;
      s += `\n   Outstanding: ${fmt(outVal)}`;
    } else {
      const openKeys = Object.keys(rows[0]).filter(k => /opening.*balance|outstanding/i.test(k.replace(/\s+/g, " ")));
      const openVal = openKeys.length > 0 ? N(rows[0][openKeys[0]]) : 0;
      s += `\n   Outstanding: ${fmt(openVal)} (no EMIs paid yet)`;
    }

    if (nextDue) {
      const dateVal = nextDue["Due Date"] || "";
      const emiKeys = Object.keys(nextDue).filter(k => /instalment amt|emi/i.test(k.replace(/\s+/g, " ")));
      const nextEmi = emiKeys.length > 0 ? N(nextDue[emiKeys[0]]) : 0;
      s += `\n   Next EMI: ${fmt(nextEmi)} due ${dateVal}`;
    }

    return s;
  }).filter(Boolean).join("\n\n");

  return `LOAN BREAKDOWN

${lines}

---------------
Total Debt: ${fmt(k.totalDebt)}
Total EMI: ${fmt(k.loanEMI)}/mo
EMI Burden: ${k.emiBurdenPct}% of salary`;
}

function templateExpenses(d) {
  const k = d.kpis || {};
  const inc = k.incomeRaw || {};
  const gross = k.grossIncome || 1;

  // Show all outflow fields from the income row
  const outflowKeys = Object.entries(inc).filter(([key, val]) => {
    if (typeof val !== "number" || val <= 0) return false;
    const kl = key.toLowerCase();
    return kl.includes("emi") || kl.includes("credit") || kl.includes("cc") || kl.includes("expense") || kl.includes("daily");
  });

  const incomeKeys = Object.entries(inc).filter(([key, val]) => {
    if (typeof val !== "number" || val <= 0) return false;
    const kl = key.toLowerCase();
    return kl.includes("salary") || kl.includes("tutoring") || kl.includes("lending interest") || kl.includes("other income") || kl.includes("gross");
  });

  const balanceKeys = Object.entries(inc).filter(([key, val]) => {
    if (typeof val !== "number") return false;
    const kl = key.toLowerCase();
    return kl.includes("net balance") || kl.includes("in hand") || kl.includes("net income") || kl.includes("income after");
  });

  const incLines = incomeKeys.map(([k, v]) => `  ${k}: ${fmt(v)}`).join("\n") || "  No income data";
  const outLines = outflowKeys.map(([k, v]) => `  ${k}: ${fmt(v)}  (${pct(v, gross)}% of gross)`).join("\n") || "  No outflows";
  const balLines = balanceKeys.map(([k, v]) => `  ${k}: ${fmt(v)}`).join("\n") || "";

  return `EXPENSE BREAKDOWN (${k.month || "Current"})

INCOME
${incLines}

OUTFLOWS
${outLines}

BALANCE
${balLines}

Savings Rate: ${k.savingsRatePct}%`;
}

function templateProjection(d) {
  const k = d.kpis || {};
  const cap = k.monthlyCap;
  if (cap <= 0) return "Savings capacity is below baseline (Rs 15,000). Cannot project.";

  const lines = [];
  const invGap = Math.max(0, 1000000 - k.totalInvestments);
  if (invGap > 0) {
    const m = Math.ceil(invGap / cap);
    lines.push(`1. Rs 10L Investments (gap: ${fmt(invGap)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else lines.push("1. Rs 10L Investments: ACHIEVED");

  const lcGap = Math.max(0, 500000 - k.lcPooled);
  if (lcGap > 0) {
    const m = Math.ceil(lcGap / cap);
    lines.push(`2. Rs 5L LC Pool (gap: ${fmt(lcGap)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else lines.push("2. Rs 5L LC Pool: ACHIEVED");

  const nwGap = Math.max(0, 10000000 - k.netWorth);
  if (nwGap > 0) {
    const mFlat = Math.ceil(nwGap / cap);
    lines.push(`3. Rs 1Cr Net Worth (gap: ${fmt(nwGap)})\n   At ${fmt(cap)}/mo: ~${mFlat} months (${monthsFromNow(mFlat)})`);
  } else lines.push("3. Rs 1Cr Net Worth: ACHIEVED");

  return `GOAL PROJECTIONS
(Based on ${fmt(cap)}/mo savings capacity)

${lines.join("\n\n")}`;
}

function templateTransactions(d) {
  const txnRows = rawRows(d, "income", ["Daily Transactions", "Daily", "Expense", "Transaction"]);
  if (txnRows.length === 0) return "No Daily Transactions data available.";
  const recent = txnRows.slice(-20);
  const lines = recent.map(r => "  " + rowToLine(r)).join("\n");
  return `DAILY TRANSACTIONS (last ${recent.length} of ${txnRows.length} rows)

${lines}`;
}

// ── Help ─────────────────────────────────────────────────────────────────────
function helpMessage() {
  return `Arth - Your AI Finance Advisor v3.0

View Data:
/summary - Financial snapshot
/loans - Loan details
/borrowers - Who owes you what
/expenses - Expense breakdown
/transactions - Daily Transactions log
/networth | /goals | /alerts
/compare | /projection
/whatif <scenario>

Enter Data:
/write - Show ALL data entry commands
/log 500 Swiggy food lunch UPI
/set salary 95000
/received 13000 Yadagiri interest

/clear - Reset cache
/help - This menu

Or just ask anything:
"What UPI transactions did I make?"
"Should I prepay my IDFC loan?"
"How much SIP for Rs 1Cr in 5 years?"`;
}

// ── AI System Prompt ─────────────────────────────────────────────────────────

// ── Raw data dumper for system prompt ─────────────────────────────────────────
function dumpSection(label, sectionData, maxRows) {
  if (!sectionData || typeof sectionData !== "object") return "";
  const tabs = Object.keys(sectionData);
  if (tabs.length === 0) return "";
  let out = `\n${label.toUpperCase()}:\n`;
  for (const tab of tabs) {
    const rows = sectionData[tab];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const limit = maxRows || 10;
    const useful = rows.filter(r => {
      const vals = Object.values(r);
      const nonEmpty = vals.filter(v => v !== null && v !== undefined && v !== "" && v !== 0);
      return nonEmpty.length >= 2;
    });
    const display = useful.slice(-limit);
    if (display.length === 0) continue;
    out += `[${tab}] (${useful.length} rows${useful.length > limit ? `, last ${limit}` : ""}):\n`;
    for (const row of display) {
      const fields = Object.entries(row)
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== 0)
        .map(([k, v]) => `${k}=${v}`);
      if (fields.length > 0) out += "  " + fields.join(" | ") + "\n";
    }
  }
  return out;
}

function buildSystemPrompt(d) {
  const k = d.kpis || {};
  const raw = d.raw || {};
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const eb = k.emiBurdenPct || 0;

  // Personal lending: ALL borrowers with ALL fields (phone, date, etc.)
  const plSection = dumpSection("Personal Lending", raw.personalLending, 10);

  // Daily expenses: last 5 only
  let expenseLines = "";
  const expTabs = raw.income || {};
  for (const tab of Object.keys(expTabs)) {
    if (!/daily|expense|transaction/i.test(tab)) continue;
    const rows = expTabs[tab];
    if (!Array.isArray(rows)) continue;
    const recent = rows.filter(r => {
      const vals = Object.values(r);
      return vals.filter(v => v !== null && v !== undefined && v !== "" && v !== 0).length >= 3;
    });
    // Filter to last 30 days only
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last30 = recent.filter(r => {
      const dateStr = String(r["Date"] || r["date"] || "");
      if (!dateStr) return true;
      const parts = dateStr.split("-");
      if (parts.length === 3) {
        const d = new Date(parts[2], parts[1] - 1, parts[0]);
        return d >= thirtyDaysAgo;
      }
      return true;
    });
    const display = last30.length > 0 ? last30 : recent.slice(-15);
    if (display.length > 0) {
      expenseLines = `\nDAILY TRANSACTIONS (last 30 days, ${display.length} rows):\n` + display.map(r =>
        "  " + Object.entries(r).filter(([,v]) => v !== null && v !== undefined && v !== "" && v !== 0).map(([ek,ev]) => `${ek}=${ev}`).join(" | ")
      ).join("\n");
    }
  }

  // Real estate: compact key fields only
  let reLines = "";
  const reTabs = raw.realEstate || {};
  for (const tab of Object.keys(reTabs)) {
    if (!/propert/i.test(tab)) continue;
    const rows = reTabs[tab];
    if (!Array.isArray(rows)) continue;
    const useful = rows.filter(r => {
      const keys = Object.keys(r);
      if (keys.length < 2) return false;
      const key = String(r[keys[0]] || "");
      return /cost|paid|balance|status|date|size|location|builder|name|emi/i.test(key);
    }).slice(0, 10);
    if (useful.length > 0) {
      reLines = "\nREAL ESTATE DETAILS:\n" + useful.map(r => {
        const vals = Object.values(r);
        return `  ${vals[0]}: ${vals[1]}`;
      }).join("\n");
    }
  }

  return `You are Arth - a sharp, empathetic personal financial advisor for Naresh, a 30-year-old software professional in Hyderabad, India.
Today is ${today}. Data is as of ${k.month || "Current"}.

RULES:
1. Use ONLY the EXACT numbers below. Never make up figures.
2. Never say "I don't have access" - you have complete live financial data.
3. For contact info (mobile, phone, date lent), check PERSONAL LENDING section below.
4. For casual messages: respond warmly, then add a financial tip.
5. For what-if scenarios: show before vs after with exact Rs numbers.
6. INTEREST RECEIVED: Personal lending (direct loans to people) and Lenden Club (P2P platform) are DIFFERENT. Use kpis.plInterestReceivedTillNow for personal lending only and kpis.lcInterestReceivedTillNow for Lenden Club only — never reuse one figure for both unless the user asks you to compare and they happen to match.

INTEREST RECEIVED TILL NOW (authoritative — do not interchange):
  Personal lending (Borrowers / direct loans): Rs ${I(k.plInterestReceivedTillNow || 0)}
  Lenden Club P2P (Tab Summary, platform loans): Rs ${I(k.lcInterestReceivedTillNow || 0)}

CURRENT MONTH INCOME & BUDGET (ALL fields from sheet, use as-is):
${Object.entries(k.incomeRaw || {}).filter(([,v]) => v !== null && v !== undefined && v !== "").map(([key,val]) => `  ${key}: ${typeof val === "number" ? "Rs " + I(val) : val}`).join("\n")}
  EMI Burden: ${eb}%${eb > 50 ? " !! HIGH - above 50% danger zone" : ""}

LOANS (Total Debt: Rs ${I(k.totalDebt)}):
  HDFC Home Loan: Outstanding Rs 21,46,638 @ 10.5% | EMI Rs 42,318/mo | 67 EMIs left
  IDFC Personal Loan: Outstanding Rs 2,63,000 @ 13.5% | EMI Rs 7,572/mo | 42 EMIs left <-- HIGHEST RATE, PRIORITY
  SBI Loan: Outstanding Rs 54,809 @ 9.35% | EMI Rs 2,500/mo | 25 EMIs left

INVESTMENTS & ASSETS (Total: Rs ${I(k.totalInvestments)}):
  Stocks/MF: Rs ${I(k.totalStocks)}
  LendenClub P2P: Rs ${I(k.lcPooled)} (~10% net ROI) | Interest received till now (LC only): Rs ${I(k.lcInterestReceivedTillNow || 0)}
  Personal Lending Capital: Rs ${I(k.plCapital)} @ 24%/yr | Monthly interest: Rs ${I(k.plMonthly)} | Interest received till now (PL only): Rs ${I(k.plInterestReceivedTillNow || 0)}${k.plPending > 0 ? ` | OVERDUE: Rs ${I(k.plPending)}` : ""}
  Real Estate: Rs ${I(k.rePaid)} paid of Rs ${I(k.reCost || 0)}

NET WORTH: Rs ${I(k.netWorth)} (Assets Rs ${I(k.totalInvestments)} - Debt Rs ${I(k.totalDebt)})
Monthly Savings Capacity: Rs ${I(k.monthlyCap)} (in-hand minus Rs 15,000 baseline)
${plSection}${expenseLines}${reLines}
STYLE: Trusted CA-cum-wealth-manager. Exact Rs numbers. Indian financial context (80C, 24b, LTCG, NPS, ELSS). Specific, actionable. Under 300 words unless asked to elaborate.`;
}

// ── Query Classification ─────────────────────────────────────────────────────
const ANALYSIS_PATTERNS = /\b(should|better|recommend|advice|advise|plan|strategy|compare|what.?if|how can|how do|optimize|improve|prepay|invest|save|suggest|worth it|good idea|make sense|risk|pros|cons|benefit|scenario|impact|projection)\b/i;

function classifyQuery(text) {
  if (ANALYSIS_PATTERNS.test(text)) return "analysis";
  return "data";
}

// ── AI Callers ───────────────────────────────────────────────────────────────

async function callGroqInternal(messages, signal, model) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: model || GROQ_MODEL, messages, max_tokens: MAX_TOKENS }),
    signal,
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "Groq error");
  return json.choices?.[0]?.message?.content || "No response.";
}

async function callGeminiInternal(systemPrompt, userMessages) {
  const contents = userMessages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
    }
  );
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "Gemini error");
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
}

function updateMemory(userMsg, reply) {
  conversationMemory.push({ role: "user", content: userMsg });
  conversationMemory.push({ role: "assistant", content: reply });
  if (conversationMemory.length > MAX_MEMORY * 2) {
    conversationMemory = conversationMemory.slice(-MAX_MEMORY * 2);
  }
}

async function callAI(d, userMessage, forceModel) {
  const queryType = forceModel || classifyQuery(userMessage);
  const model = queryType === "analysis" ? GROQ_MODEL : GROQ_MODEL_FAST;
  const timeoutMs = model === GROQ_MODEL_FAST ? 8000 : 8000;

  const systemPrompt = buildSystemPrompt(d);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationMemory,
    { role: "user", content: userMessage },
  ];

  if (GROQ_API_KEY) {
    try {
      const ai0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const reply = await callGroqInternal(messages, controller.signal, model);
      clearTimeout(timer);
      console.log(`[callAI] Groq ${model} done in ${Date.now() - ai0}ms (queryType=${queryType})`);
      updateMemory(userMessage, reply);
      return reply;
    } catch (err) {
      console.log(`Groq (${model}) failed, trying fallback:`, err.message);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      const reply = await callGeminiInternal(systemPrompt, [...conversationMemory, { role: "user", content: userMessage }]);
      updateMemory(userMessage, reply);
      return reply;
    } catch (err) {
      console.error("Gemini fallback failed:", err.message);
    }
  }

  return "AI is temporarily unavailable. Use /summary, /networth, /goals, /loans, /borrowers for instant data.";
}

// ── Command Router ───────────────────────────────────────────────────────────
function getCommandResponse(cmd, d) {
  switch (cmd) {
    case "/summary": return templateSummary(d);
    case "/networth": return templateNetWorth(d);
    case "/goals": return templateGoals(d);
    case "/alerts": return templateAlerts(d);
    case "/compare": return templateCompare(d);
    case "/borrowers": return templateBorrowers(d);
    case "/loans": return templateLoans(d);
    case "/expenses": return templateExpenses(d);
    case "/transactions": return templateTransactions(d);
    case "/projection": return templateProjection(d);
    default: return null;
  }
}

/** Strip `/cmd@BotName` prefix only (Telegram). Never split on `@` elsewhere — it breaks args with @ in text. */
function normalizeCommandLine(raw) {
  return String(raw || "").trim().replace(/^\/([A-Za-z0-9_]+)@[A-Za-z0-9_]+/, "/$1");
}

/** Telegram/iOS often send Unicode minus/en-dash instead of ASCII `-` for blank entity — breaks /log field positions. */
function normalizeLogDashes(s) {
  return String(s || "").replace(/[\u2212\u2010\u2011\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]/g, "-");
}

function parseWriteResponse(bodyText, httpStatus) {
  try {
    return JSON.parse(bodyText);
  } catch (_) {
    const prev = String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 280);
    return {
      _parseError: true,
      _httpStatus: httpStatus,
      _bodyPreview: prev || "(empty body)",
    };
  }
}

/** Vercel/Node often omits or buffers req.body — read JSON reliably or Telegram updates are dropped with no reply. */
async function readTelegramWebhookJson(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) {
    try {
      return JSON.parse(b.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof b === "string" && b.length) {
    try {
      return JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const keys = Object.keys(b);
    if (keys.length > 0) return b;
  }
  if (req.readable && typeof req.read === "function") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw || !raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error("[webhook] body stream read failed:", e.message);
    }
  }
  return null;
}

/** Safe hint for ?debug=1 (no tokens). */
function dashboardUrlHint() {
  const u = DASHBOARD_URL && String(DASHBOARD_URL).trim();
  if (!u) return "(DASHBOARD_URL empty — /log will not write)";
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname.slice(0, 48)}${x.pathname.length > 48 ? "…" : ""}`;
  } catch {
    return "(DASHBOARD_URL not a valid URL)";
  }
}

// ── Webhook Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    if (req.query?.cron === "1") {
      try { await getFinancialData(true); } catch (_) {}
      return res.status(200).json({ ok: true, warm: true, ts: Date.now() });
    }
    if (req.query?.debug === "1" || req.query?.debug === "true") {
      return res.status(200).json({
        ok: true,
        probe: "vercel-env",
        telegramTokenSet: Boolean(TELEGRAM_TOKEN && String(TELEGRAM_TOKEN).trim()),
        dashboardUrl: dashboardUrlHint(),
        chatIdFilter: CHAT_ID ? `set (only chat ${String(CHAT_ID).trim()})` : "not set — all chats allowed",
        node: typeof process !== "undefined" ? process.version : "",
        telegramWebhookDebug: TELEGRAM_WEBHOOK_DEBUG,
        hint: "Set TELEGRAM_WEBHOOK_DEBUG=1 in Vercel for verbose /api/telegram logs. If telegramTokenSet is false, the bot cannot reply. Webhook URL must be https://YOUR_PROJECT.vercel.app/api/telegram",
      });
    }
    return res.status(200).json({ ok: true, message: "Arth bot v2.1 active", tip: "Add ?debug=1 to see env checks (no secrets)." });
  }

  try {
    const update = await readTelegramWebhookJson(req);
    if (!update || typeof update !== "object") {
      console.error("[webhook] missing JSON body — set webhook URL to https://YOUR_DEPLOYMENT.vercel.app/api/telegram and redeploy.");
      return res.status(200).json({ ok: true });
    }

    const t0 = Date.now();
    whDebug("incoming_update", {
      update_id: update.update_id,
      callback: Boolean(update.callback_query),
      has_text: Boolean(update.message?.text || update.edited_message?.text),
    });

    // Must await processing before HTTP 200. `waitUntil` + classic `handler(req, res)` often drops
    // background work after `res.json()` — sheet can update but `sendTelegram` never runs (no "Done!").
    await processTelegramUpdate(update);

    console.log("[telegram-wh] webhook_handler_done", {
      update_id: update.update_id,
      ms: Date.now() - t0,
    });
    return res.status(200).json({ ok: true });
  } catch (fatal) {
    console.error("[telegram-wh] webhook_handler_fatal", fatal && fatal.message ? fatal.message : fatal);
    return res.status(200).json({ ok: true });
  }
}

async function processTelegramUpdate(update) {
  let chatId = null;
  try {
    console.log("[telegram-wh] process_update", {
      update_id: update.update_id,
      has_message: Boolean(update.message),
      has_callback: Boolean(update.callback_query),
    });

    // Inline keyboard button presses
    if (update.callback_query) {
      const cb = update.callback_query;
      chatId = String(cb.message.chat.id);
      const cbAllowed = !CHAT_ID || String(chatId).trim() === String(CHAT_ID).trim();
      if (!cbAllowed) {
        await answerCallback(cb.id);
        return;
      }
      await answerCallback(cb.id);
      const cmd = cb.data;
      const d = await getFinancialData(true);
      const reply = getCommandResponse(cmd, d);
      if (reply) await sendTelegram(chatId, reply);
      return;
    }

    // Regular messages
    const msg = update?.message || update?.edited_message;
    if (!msg?.text) return;

    chatId = String(msg.chat.id);
    const rawText = msg.text.trim();
    const text = normalizeCommandLine(rawText);
    const firstToken = text.split(/\s+/)[0] || "";
    const baseCmd = firstToken.split("@")[0].toLowerCase();

    whDebug("message", {
      chatId,
      baseCmd,
      preview: text.length > 160 ? text.slice(0, 160) + "…" : text,
    });

    const allowedChat = !CHAT_ID || String(chatId).trim() === String(CHAT_ID).trim();
    if (!allowedChat) {
      console.log(`[webhook] ignored chat ${chatId} (TELEGRAM_CHAT_ID=${CHAT_ID})`);
      // Without this, Telegram shows no reply — users think the bot is broken. Tell them how to fix env.
      if (TELEGRAM_TOKEN) {
        try {
          await sendTelegram(
            chatId,
            `This bot only accepts your configured chat.\n\nYour chat id: ${chatId}\nVercel TELEGRAM_CHAT_ID: ${CHAT_ID}\n\nUpdate TELEGRAM_CHAT_ID to the id above, or remove TELEGRAM_CHAT_ID to allow any chat (less secure).`
          );
        } catch (e) {
          console.error("[webhook] denied-chat notify failed:", e.message);
        }
      }
      return;
    }

    // /clear — handle early (no Apps Script, no AI); tolerate case / extra whitespace
    if (baseCmd === "/clear") {
      conversationMemory = [];
      dataCache = { data: null, ts: 0 };
      await sendTelegram(chatId, "Memory and data cache cleared.");
      return;
    }

    // /start and /help with inline keyboard
    if (text === "/start" || text === "/help" || baseCmd === "/start" || baseCmd === "/help") {
      await sendTelegram(chatId, helpMessage(), { reply_markup: mainKeyboard });
      return;
    }

    // ── WRITE COMMANDS ──────────────────────────────────────────────────────
    // Universal write helper
    function formatWriteReply(r) {
      if (!r || typeof r !== "object")
        return "Error: Invalid response from server (not JSON). Check DASHBOARD_URL and web app deployment.";
      if (r._parseError) {
        const hint = r._httpStatus != null ? ` HTTP ${r._httpStatus}.` : "";
        const prev = r._bodyPreview ? `\nFirst bytes: ${r._bodyPreview}` : "";
        return `Error: Response was not valid JSON (web app may have returned HTML).${hint}${prev}

Check: Vercel env DASHBOARD_URL must be your **Google Apps Script Web App** URL (script.google.com/.../exec), not the React site. Deploy: Execute as **Me**, access **Anyone**.`;
      }
      if (r.income != null && r.loans != null && r.success == null && r.error == null) {
        return "Error: Server returned full dashboard JSON instead of a write result. Redeploy Apps Script: code.js doGet must route mode=write to doGetWrite (FinanceBot.gs).";
      }
      if (r.success) return `Done! ${r.message || ""}`.trim();
      return `Error: ${r.error != null && r.error !== "" ? r.error : r.message || "unknown — check Apps Script Execution log"}`;
    }

    async function callWrite(action, data) {
      const dash = DASHBOARD_URL && String(DASHBOARD_URL).trim();
      if (!dash) {
        whDebug("callWrite_skip", { reason: "no DASHBOARD_URL" });
        return { success: false, error: "DASHBOARD_URL is not set in Vercel env (Google Apps Script /exec URL)." };
      }
      const baseUrl = dash.replace(/\?.*$/, "").replace(/\/$/, "");
      const payload = JSON.stringify({ mode: "write", action, data });
      const tWrite = Date.now();
      whDebug("callWrite_POST", { action, payloadLen: payload.length });

      let resp = await fetchGoogleAppsScriptWebApp(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      let bodyText = await resp.text();
      let result = parseWriteResponse(bodyText, resp.status);
      whDebug("callWrite_POST_result", {
        action,
        http: resp.status,
        ms: Date.now() - tWrite,
        parseError: Boolean(result._parseError),
        success: result.success,
        bodyLen: bodyText.length,
        bodyHead: bodyText.slice(0, 120).replace(/\s+/g, " "),
      });

      // POST sometimes returns HTML (login/wrapper). doGet ?mode=write works when POST body is dropped.
      if (result._parseError) {
        const sep = baseUrl.includes("?") ? "&" : "?";
        const getUrl =
          baseUrl +
          sep +
          "mode=write&action=" +
          encodeURIComponent(String(action)) +
          "&data=" +
          encodeURIComponent(JSON.stringify(data));
        whDebug("callWrite_GET_fallback", { action, urlLen: getUrl.length });
        const tGet = Date.now();
        resp = await fetchGoogleAppsScriptWebApp(getUrl, { method: "GET" });
        bodyText = await resp.text();
        result = parseWriteResponse(bodyText, resp.status);
        whDebug("callWrite_GET_result", {
          action,
          http: resp.status,
          ms: Date.now() - tGet,
          parseError: Boolean(result._parseError),
          success: result.success,
          bodyHead: bodyText.slice(0, 120).replace(/\s+/g, " "),
        });
      }
      dataCache = { data: null, ts: 0 };
      return result;
    }

    const VALID_MODES = { upi: "UPI", cash: "Cash", creditcard: "CreditCard", credit: "CreditCard", bank: "Bank Transfer", banktransfer: "Bank Transfer", "auto-debit": "Auto-Debit", autodebit: "Auto-Debit", auto: "Auto-Debit", cheque: "Cheque", check: "Cheque" };
    function parseMode(m) { return VALID_MODES[(m || "upi").toLowerCase()] || "UPI"; }

    const FIELD_MAP = {
      salary: "in hand Salary", inhand: "in hand Salary",
      otherincome: "Other Income", other: "Other Income",
      tutoring: "DevOps Tutoring", devops: "DevOps Tutoring",
      taxdeducted: "Tax Deducted", tax: "Tax Deducted",
      taxrefunded: "Tax Refunded", taxrefund: "Tax Refunded",
      creditcard: "CreditCard Bills", cc: "CreditCard Bills", ccbills: "CreditCard Bills",
      cashfd: "Cash / FD / Other", cash: "Cash / FD / Other", fd: "Cash / FD / Other",
    };

    // /write -- show all data entry commands
    if (text === "/write") {
      const writeMsg1 = `DATA ENTRY COMMANDS (1/2)

-- INCOME TRACKER --

Format  : /set <field> <value> [month]
field   : salary, otherincome, tutoring, taxdeducted, taxrefunded, creditcard, cashfd
Example : /set salary 95000 Apr-26

-- MONTHLY BUDGET --

Format  : /budget <category> <amount>
category: food|transport|rent|nanna|medical|entertainment|shopping|education|fuel|grooming|debt|misc
Example : /budget food 5000

-- DAILY TRANSACTIONS (sheet cols A–J) --
A Date, B Day, C Entity, D Category, E Description, F Amount, G Mode, H Type, I Tag, J Notes
Format: /log <amt> <entity> <category> [description] [mode] [type] [tag]
Use - or na for blank entity. Legacy: /log <amt> <category> (Entity stays blank)
category: food|transport|rent|nanna|medical|emi|entertainment|shopping|education|fuel|grooming|gifts|insurance|debt|misc
Modes: UPI, Cash, CreditCard, BankTransfer, Auto-Debit, Cheque
Types: Expense, Income, Investment, Transfer
Tags: Essential, Lifestyle, Impulsive, Planned, Fixed
Example: /log 500 Swiggy food lunch UPI Expense Essential`;

      const writeMsg2 = `DATA ENTRY COMMANDS (2/2)

-- PERSONAL LENDING --
Format :   /lent <amt> <name> [rate%] [months] [phone]
name   :   Yadagiri|KishanRao
Example:   /lent 100000 RamuKaka 2 12 9876543210

Format :  /received <amt> <name> [interest/principal] [mode]
name   :   Yadagiri|KishanRao
Modes  :  UPI, Cash, BankTransfer
Example:  /received 13000 Yadagiri interest UPI

Format :  /close <borrower>
Example:  /close Yadagiri

-- LOANS --
Format : /<bank> [month] paid
bank   : hdfc|idfc|sbi
Example: /hdfc Apr paid

-- LENDENCLUB --
Format :  /invest lc <amt> [remarks]
Example:  /invest lc 5000 salary

-- STOCK MARKET --
Format :  /invest <type> <amt> [remarks]
type   :  equity|mf|options|crypto
Example:  /invest equity 10000 RELIANCE

-- REAL ESTATE --
Format :  /paid re <amt> [date] [mode]
mode   :  UPI, Cash, CreditCard, BankTransfer, Cheque
Example:  /paid re 25000 10-Mar-2026 banktransfer`;

      await sendTelegram(chatId, writeMsg1);
      await sendTelegram(chatId, writeMsg2);
      return;
    }

    // /set -- update IncomeTracker field
    if (text.startsWith("/set")) {
      const parts = rawText.replace(/^\/set(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Usage: /set <field> <value> [month]\nType /write for all commands"); return; }
      const field = FIELD_MAP[parts[0].toLowerCase()] || parts[0];
      try {
        const r = await callWrite("set", { field, value: parts[1], month: parts[2] || "" });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /log -- daily expense/income/investment/transfer
    // Sheet: A Date, B Day (auto), C Entity, D Category, ... — pass entity after amount when using 3+ tokens.
    if (/^\/log(\s|$)/i.test(text)) {
      const parts = normalizeLogDashes(text)
        .replace(/^\/log\s*/i, "")
        .trim()
        .split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, `Usage: /log <amount> <entity> <category> [desc] [mode] [type] [tag]
Legacy (no entity): /log <amount> <category> [desc] [mode] [type] [tag]
Use - or na for blank entity.

Modes: UPI, Cash, CreditCard, BankTransfer, Auto-Debit, Cheque
Types: Expense (default), Income, Investment, Transfer
Tags: Essential, Lifestyle, Impulsive, Planned, Fixed

Examples:
/log 500 Swiggy food lunch UPI
/log 500 - food lunch UPI
/log 1200 Shell fuel petrol cash
/log 299 Netflix entertainment Netflix auto-debit expense lifestyle
/log 95000 Employer salary March-salary bank income planned
/log 5000 AMC investment SIP auto-debit investment planned
/log 10000 Self transfer sent-to-savings UPI transfer`); return; }

      const typeMap = {
        expense: "Expense",
        income: "Income",
        investment: "Investment",
        invest: "Investment",
        transfer: "Transfer",
        creditcardexpense: "CreditCardExpense",
        cc_expense: "CreditCardExpense",
      };
      const tagMap = { essential: "Essential", lifestyle: "Lifestyle", lyfe: "Lifestyle", impulsive: "Impulsive", planned: "Planned", fixed: "Fixed" };
      const catTags = { food: "Essential", groceries: "Essential", transport: "Essential", fuel: "Essential", medical: "Fixed", health: "Fixed", insurance: "Fixed", utilities: "Fixed", electricity: "Fixed", emi: "Fixed", loan: "Fixed", rent: "Fixed", entertainment: "Lifestyle", shopping: "Lifestyle", education: "Essential", grooming: "Lifestyle", salary: "Planned", investment: "Planned", transfer: "Planned", misc: "Lifestyle" };
      const knownCategory = new Set([
        ...Object.keys(catTags),
        "nanna", "gifts", "debt", "creditcard", "cc", "cashfd", "cash", "fd",
      ]);

      let entity = "";
      let cat = "Misc";
      let desc = "";
      let modePart = "";
      let typePart = "";
      let tagPart = "";
      let notesParts = [];

      const second = (parts[1] || "").trim();
      const secondIsBlankEntity = /^[-_.]$|^na$/i.test(second);
      const secondIsKnownCategory = knownCategory.has(second.toLowerCase());
      // Legacy: /log <amt> <category> ... when only 2 tokens, or when 2nd token is a known category (e.g. /log 500 food lunch UPI)
      const useLegacy = parts.length === 2 || (secondIsKnownCategory && !secondIsBlankEntity);

      if (useLegacy) {
        cat = parts[1] || "Misc";
        desc = parts[2] || "";
        modePart = parts[3];
        typePart = parts[4];
        tagPart = parts[5];
        notesParts = parts.slice(6);
      } else {
        entity = secondIsBlankEntity ? "" : second;
        cat = parts[2] || "Misc";
        desc = parts[3] || "";
        modePart = parts[4];
        typePart = parts[5];
        tagPart = parts[6];
        notesParts = parts.slice(7);
      }

      const userType = typeMap[(typePart || "").toLowerCase()];
      const userTag = tagMap[(tagPart || "").toLowerCase()];
      const autoTag = catTags[cat.toLowerCase()] || "Lifestyle";

      try {
        const r = await callWrite("log", {
          amount: parts[0],
          entity,
          category: cat,
          description: desc,
          mode: parseMode(modePart),
          type: userType || "Expense",
          tag: userTag || autoTag,
          notes: notesParts.join(" ")
        });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /budget -- set monthly budget (BUDGET PER CATEGORY section only)
    if (text.startsWith("/budget")) {
      const parts = rawText.replace(/^\/budget(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Usage: /budget <category> <amount>\nCategories: food, transport, utilities, medical, entertainment, shopping, education, fuel, grooming, misc\nExample: /budget food 5000"); return; }
      try {
        const r = await callWrite("budget", { category: parts[0], value: parts[1], month: parts[2] || "" });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /received -- lending repayment
    if (text.startsWith("/received")) {
      const parts = rawText.replace(/^\/received(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Usage: /received <amount> <borrower> [interest/principal] [mode]\nModes: UPI, Cash, CreditCard, Bank Transfer, Cheque\nExample: /received 13000 Yadagiri interest UPI"); return; }
      try {
        const r = await callWrite("received", { amount: parts[0], borrower: parts[1] || "", type: parts[2] || "Interest", mode: parseMode(parts[3]), notes: parts.slice(4).join(" ") });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /lent -- new borrower
    if (text.startsWith("/lent")) {
      const parts = rawText.replace(/^\/lent(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Usage: /lent <amount> <name> [rate%] [months] [phone]\nExample: /lent 100000 RamuKaka 2 12 9876543210"); return; }
      try {
        const r = await callWrite("lent", { amount: parts[0], name: parts[1] || "", rate: parts[2] || "2", duration: parts[3] || "12", phone: parts[4] || "", notes: parts.slice(5).join(" ") });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /invest -- LC or Stock market
    if (text.startsWith("/invest")) {
      const parts = rawText.replace(/^\/invest(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Usage:\n/invest lc <amount> [remarks]\n/invest equity <amount> [remarks]\n/invest mf <amount> [remarks]\n/invest options <amount> [remarks]\n/invest crypto <amount> [remarks]"); return; }
      const typeMap = { lc: "invest_lc", lendenclub: "invest_lc", equity: "invest_stock", mf: "invest_stock", mutualfunds: "invest_stock", options: "invest_stock", crypto: "invest_stock" };
      const stockTypes = { equity: "Equity", mf: "MutualFunds", mutualfunds: "MutualFunds", options: "Options", crypto: "Crypto" };
      const invType = parts[0].toLowerCase();
      const action = typeMap[invType] || "invest_stock";
      try {
        const payload = { amount: parts[1], remarks: parts.slice(2).join(" ") };
        if (action === "invest_stock") payload.type = stockTypes[invType] || "Equity";
        const r = await callWrite(action, payload);
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // /paid -- Real Estate EMI
    if (text.startsWith("/paid")) {
      const parts = rawText.replace(/^\/paid(@\w+)?\s*/i, "").trim().split(/\s+/);
      if (parts.length < 2) { await sendTelegram(chatId, "Format: /paid re <amount> [date] [mode]\nExample: /paid re 25000 10-Mar-2026 banktransfer\nExample: /paid re 25000 UPI"); return; }
      if (parts[0].toLowerCase() === "re") {
        const amt = parts[1] || "25000";
        let date = "", mode = "";
        for (let pi = 2; pi < parts.length; pi++) {
          if (/\d{1,2}[-/]\w{3}[-/]\d{2,4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(parts[pi])) date = parts[pi];
          else mode = parts[pi];
        }
        try {
          const r = await callWrite("paid_re", { amount: amt, date: date, mode: parseMode(mode) });
          await sendTelegram(chatId, formatWriteReply(r));
        } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      }
      return;
    }

    // /hdfc, /idfc, /sbi -- mark loan EMI as paid (with optional month)
    if (/^\/(hdfc|idfc|sbi)\s/i.test(text)) {
      const match = text.match(/^\/(hdfc|idfc|sbi)\s+(\S+)?\s*(paid)?/i);
      if (match) {
        const loan = match[1].toUpperCase();
        const arg1 = (match[2] || "").toLowerCase();
        const month = arg1 !== "paid" ? match[2] || "" : "";
        try {
          const r = await callWrite("loan_paid", { loan, month });
          await sendTelegram(chatId, formatWriteReply(r));
        } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      }
      return;
    }

    // /close -- mark borrower loan as Closed
    if (text.startsWith("/close")) {
      const name = rawText.replace(/^\/close(@\w+)?\s*/i, "").trim();
      if (!name) { await sendTelegram(chatId, "Usage: /close <borrower name>\nExample: /close Yadagiri"); return; }
      try {
        const r = await callWrite("close_loan", { name });
        await sendTelegram(chatId, formatWriteReply(r));
      } catch (e) { await sendTelegram(chatId, `Failed: ${e.message}`); }
      return;
    }

    // Debug: show raw field names from API
    if (text === "/raw") {
      try {
        const resp = await fetchGoogleAppsScriptWebApp(DASHBOARD_URL, { method: "GET" });
        let raw = await resp.json();
        if (raw?.data) raw = raw.data;
        const incSection = raw?.income || {};
        const sheetNames = Object.keys(incSection);
        let firstRows = "No income data";
        for (const sn of sheetNames) {
          if (Array.isArray(incSection[sn]) && incSection[sn].length > 0) {
            const lastRow = incSection[sn][incSection[sn].length - 1];
            firstRows = `Sheet: "${sn}"\nFields: ${Object.keys(lastRow).join(", ")}\n\nValues:\n${Object.entries(lastRow).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`;
            break;
          }
        }
        const stocksKeys = Object.keys(raw?.stocks || {}).join(", ") || "none";
        const loansKeys = Object.keys(raw?.loans || {}).join(", ") || "none";
        await sendTelegram(chatId, `RAW DATA DEBUG\n\nIncome sheets: ${sheetNames.join(", ") || "none"}\n\n${firstRows}\n\nStocks keys: ${stocksKeys}\nLoans keys: ${loansKeys}`);
      } catch (e) {
        await sendTelegram(chatId, `Debug error: ${e.message}`);
      }
      return;
    }

    // Template commands (fast, no AI)
    const templateCmds = ["/summary", "/networth", "/goals", "/alerts", "/compare", "/borrowers", "/loans", "/expenses", "/transactions", "/projection"];
    if (templateCmds.includes(text)) {
      const d = await getFinancialData(true);
      const reply = getCommandResponse(text, d);
      if (reply) await sendTelegram(chatId, reply);
      return;
    }

    // /whatif -- AI-powered scenario analysis
    if (text.startsWith("/whatif")) {
      const scenario = rawText.replace(/^\/whatif(@\w+)?\s*/i, "").trim();
      if (!scenario) {
        await sendTelegram(chatId, "Usage: /whatif <scenario>\n\nExamples:\n/whatif prepay IDFC 50000\n/whatif start SIP 5000 monthly\n/whatif quit tutoring\n/whatif salary hike 20%\n/whatif close all personal lending");
        return;
      }
      const d = await getFinancialData(false);
      const reply = await callAI(d, `WHAT-IF ANALYSIS REQUEST: ${scenario}\n\nAnalyze this scenario using my current financial data. Show before vs after impact on relevant metrics (EMI burden, savings rate, net worth, goal timelines). Be specific with Rs numbers and give your recommendation.`, "analysis");
      await sendTelegram(chatId, reply);
      return;
    }

    // Free-form AI chat
    const d = await getFinancialData(false);
    const reply = await callAI(d, text);
    await sendTelegram(chatId, reply);
    return;
  } catch (err) {
    console.error("[telegram-wh] process_update_error", {
      update_id: update && update.update_id,
      chatId,
      message: err && err.message ? err.message : String(err),
      stack: TELEGRAM_WEBHOOK_DEBUG && err && err.stack ? String(err.stack).slice(0, 500) : undefined,
    });
    if (chatId) {
      try {
        await sendTelegram(chatId, "Something went wrong. Please try again in a moment.");
      } catch (sendErr) {
        console.error("[telegram-wh] error_reply_failed", sendErr && sendErr.message ? sendErr.message : sendErr);
      }
    }
    return;
  }
}
