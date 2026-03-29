// ── Vercel Serverless Telegram Bot for Arth Finance Advisor ──────────────────
// Handles webhook from Telegram, builds template responses for data commands,
// uses Groq AI only for free-form chat questions.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_URL  = process.env.DASHBOARD_URL;
const GROQ_MODEL     = "llama-3.3-70b-versatile";
const MAX_TOKENS     = 2048;
const CACHE_TTL_MS   = 5 * 60 * 1000;

// ── In-memory cache (survives warm invocations ~5 min) ───────────────────────
let dataCache = { data: null, ts: 0 };
let conversationMemory = [];
const MAX_MEMORY = 10;

// ── Number helpers ───────────────────────────────────────────────────────────
const N = (v) => typeof v === "number" ? v : parseFloat(String(v || "0").replace(/[^0-9.\-]/g, "")) || 0;
const I = (v) => Math.round(N(v)).toLocaleString("en-IN");
const fmt = (v) => {
  const n = Math.round(N(v));
  return (n < 0 ? "-" : "") + "Rs " + Math.abs(n).toLocaleString("en-IN");
};

// ── Telegram API ─────────────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  const MAX_LEN = 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) chunks.push(text.slice(i, i + MAX_LEN));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
  }
}

// ── Data Fetcher with Cache ──────────────────────────────────────────────────
async function getFinancialData() {
  if (dataCache.data && Date.now() - dataCache.ts < CACHE_TTL_MS) return dataCache.data;
  const resp = await fetch(DASHBOARD_URL, { redirect: "follow" });
  let raw = await resp.json();
  if (raw?.data) raw = raw.data;
  const summary = buildBotSummary(raw);
  dataCache = { data: summary, ts: Date.now() };
  return summary;
}

// ── buildBotSummary — ported from FinanceBot.gs (mirrors React dashboard) ────
function buildBotSummary(p) {
  p = p || {};

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

  // Income + salary history
  const incRows = findSheet(p.income, ["Income Tracker"]);
  const validRows = incRows.filter(r => N(r["Salary"] || r["salary"]) > 0);
  const cur = validRows.length > 0 ? validRows[validRows.length - 1] : {};
  const salary = N(cur["Salary"] || cur["salary"]);
  const tutoring = N(cur["DevOps Tutoring"] || cur["Tutoring"]);
  const lendingInt = N(cur["Personal Lending Interest"] || cur["Lending Interest"]);
  const otherInc = N(cur["Other Income"]);
  const grossTotal = N(cur["Gross Total"] || cur["gross_total"]);
  const ccBills = N(cur["CreditCard Bills"] || cur["Credit Card Bills"]);
  const hdfcEmi = N(cur["HDFC EMI"]);
  const idfcEmi = N(cur["IDFC EMI"]);
  const sbiEmi = N(cur["SBI EMI"]);
  const loanEMI = hdfcEmi + idfcEmi + sbiEmi;
  const inHand = N(cur["In Hand"] || cur["in_hand"]);
  const month = String(cur["Month"] || cur["month"] || "");
  const age = N(cur["Age"] || cur["age"]) || 30;

  const salaryHistory = validRows.slice(-6).map(r => ({
    month: String(r["Month"] || ""),
    gross: N(r["Gross Total"] || r["gross_total"]),
    inHand: N(r["In Hand"] || r["in_hand"]),
  }));

  // Loans
  const loanNames = ["HDFC", "IDFC", "SBI"];
  const defaultRates = { HDFC: 10.5, IDFC: 13.5, SBI: 9.35 };
  const defaultTotal = { HDFC: 72, IDFC: 60, SBI: 25 };
  const loans = [];
  let totalDebt = 0;
  for (const name of loanNames) {
    const lRows = (p.loans || {})[name];
    if (!Array.isArray(lRows) || lRows.length === 0) continue;
    const lr = lRows[0];
    const emi = N(lr["EMI"]);
    const outstanding = N(lr["Outstanding"]);
    const rate = N(lr["Interest Rate"]) || defaultRates[name];
    const totalEmis = N(lr["Total EMIs"] || lr["Tenure"]) || defaultTotal[name];
    const paidEmis = N(lr["EMIs Paid"] || lr["Paid"]);
    const emisLeft = Math.max(0, totalEmis - paidEmis);
    if (emi > 0 || outstanding > 0) {
      loans.push({ name, emi, outstanding, rate, totalEmis, paidEmis, emisLeft });
      totalDebt += outstanding;
    }
  }

  // Investments
  const stocksSec = p.stocks || {};
  const investments = [];
  let totalStocksCurrent = 0;
  const portSummary = findSheet(stocksSec, ["Portfolio Summary"]);
  for (const row of portSummary) {
    const cls = String(row["Asset Class"] || "").trim();
    if (!cls || cls === "TOTAL" || cls.includes("HOW TO") || cls === "Step") continue;
    const cv = N(row["Current Value"] || row["Current Value (₹)"]);
    const pl = N(row["P&L"] || row["P&L (₹)"]);
    if (cv > 0) { investments.push({ name: cls, current: cv, pl }); totalStocksCurrent += cv; }
  }
  if (investments.length === 0) {
    for (const sn of ["Mutual Funds", "Equity", "Options", "Crypto", "Real Estate"]) {
      const sRows = stocksSec[sn];
      if (!Array.isArray(sRows)) continue;
      let tv = 0, tp = 0;
      for (const sr of sRows) {
        tv += N(sr["Current Value (₹)"] || sr["Current Value"] || sr["Value"] || sr["Market Value"]);
        tp += N(sr["P&L (₹)"] || sr["P&L"] || sr["Returns (₹)"] || sr["Gain"]);
      }
      if (tv > 0) { investments.push({ name: sn, current: tv, pl: tp }); totalStocksCurrent += tv; }
    }
  }

  // LendenClub
  const lcSec = p.lendenClub || {};
  const tabSummary = findSheet(lcSec, ["Tab Summary"]);
  let lcDisbursed = 0, lcInterest = 0, lcOutstanding = 0, lcLoans = 0, lcNPA = 0;
  for (const t of tabSummary) {
    lcDisbursed += N(t["Disbursed"]); lcInterest += N(t["Interest"]);
    lcOutstanding += N(t["Outstanding"]); lcLoans += N(t["Loans"]); lcNPA += N(t["NPA"] || t["npa"]);
  }
  const lcSummaryRows = findSheet(lcSec, ["LC Summary"]);
  let lcPooled = 0;
  for (let i = lcSummaryRows.length - 1; i >= 0; i--) {
    const pool = N(lcSummaryRows[i]["Closing Pool"]);
    if (pool > 0) { lcPooled = pool; break; }
  }

  // Personal lending
  const plRows = findSheet(p.personalLending || {}, ["Borrowers"]);
  let plCap = 0, plMonthly = 0, plOverdue = 0, plPendingInt = 0;
  const borrowers = [];
  for (const pr of plRows) {
    const amt = N(pr["Amount"]);
    if (!pr["Name"] || amt === 0) continue;
    if (/closed|inactive/i.test(String(pr["Loan Status"] || ""))) continue;
    const mInt = N(pr["Monthly Int"]);
    const pend = N(pr["Pending Int"]);
    plCap += amt; plMonthly += mInt; plPendingInt += pend;
    if (pend > 0) plOverdue++;
    borrowers.push({ name: pr["Name"], amount: amt, monthly: mInt, overdue: pend });
  }

  // Real estate
  const reProp = findSheet(p.realEstate || {}, ["Property Detail", "Real Estate", "Property", "Land"]);
  const reRow = reProp.length > 0 ? reProp[0] : {};
  let reName = String(reRow["Property Name"] || reRow["Name"] || reRow["Builder"] || "");
  let reTotalCost = N(reRow["Total Cost"] || reRow["Total Amount"]);
  let rePaid = N(reRow["Paid"] || reRow["Amount Paid"]);
  let reRemaining = N(reRow["Remaining"] || reRow["Balance"]);
  if (reTotalCost === 0 && rePaid === 0) {
    reName = "Tricolour Properties"; reTotalCost = 857500; rePaid = 542500; reRemaining = 315000;
  }

  // Derived (mirrors App.jsx line 3993)
  const totalInvestments = totalStocksCurrent + lcPooled + plCap + rePaid;
  const netWorth = totalInvestments - totalDebt;
  const emiBurdenPct = salary > 0 ? Math.round((loanEMI / salary) * 100) : 0;
  const savingsRatePct = grossTotal > 0 ? Math.round((Math.max(0, inHand) / grossTotal) * 100) : 0;

  // Goals (mirrors App.jsx 1452-1460)
  const idfcOut = loans.find(l => l.name === "IDFC")?.outstanding || 0;
  const sbiOut = loans.find(l => l.name === "SBI")?.outstanding || 0;
  const monthlyCap = Math.max(0, inHand - 15000);

  return {
    month, age, salary, tutoring, lendingInterest: lendingInt, otherIncome: otherInc,
    grossIncome: grossTotal, creditCardBills: ccBills, loanEMI, inHand, salaryHistory,
    loans, totalDebt, investments, totalStocksCurrent,
    lcPooled, lcDisbursed, lcInterest, lcOutstanding, lcActiveLoans: lcLoans, lcNPA,
    plTotalCapital: plCap, plMonthlyInterest: plMonthly, plOverdueCount: plOverdue,
    plPendingInt, borrowers,
    reName, reTotalCost, rePaid, reRemaining,
    rePct: reTotalCost > 0 ? Math.round((rePaid / reTotalCost) * 100) : 0,
    totalInvestments, totalAssets: totalInvestments, netWorth,
    emiBurdenPct, savingsRatePct, monthlyCap,
    goals: {
      idfcPct: Math.min(100, Math.round((totalInvestments / 1000000) * 100)),
      sbiPct: sbiOut > 0 ? 0 : 100,
      invPct: Math.min(100, Math.round((totalInvestments / 1000000) * 100)),
      lcPct: Math.min(100, Math.round((lcPooled / 500000) * 100)),
      nwPct: Math.min(100, Math.max(0, Math.round((netWorth / 10000000) * 100))),
    },
  };
}

// ── Template Responses (100% consistent, no AI) ─────────────────────────────

function templateSummary(d) {
  const invLines = (d.investments || []).map(i => `  - ${i.name}: ${fmt(i.current)} (P&L ${fmt(i.pl)})`).join("\n") || "  No stock data";
  const loanLines = (d.loans || []).map(l => `  - ${l.name}: ${fmt(l.outstanding)} @ ${l.rate}% | EMI ${fmt(l.emi)}/mo | ${l.emisLeft} EMIs left`).join("\n");
  const plLines = (d.borrowers || []).map(b => `  - ${b.name}: ${fmt(b.amount)} @ ${fmt(b.monthly)}/mo${b.overdue > 0 ? ` (OVERDUE ${fmt(b.overdue)})` : ""}`).join("\n") || "  None";

  return `*Arth Financial Snapshot (${d.month || "Current"})*

*INCOME*
  Salary: ${fmt(d.salary)}/mo
  Tutoring: ${fmt(d.tutoring)}/mo
  Lending Interest: ${fmt(d.lendingInterest)}/mo
  Gross Income: ${fmt(d.grossIncome)}
  Credit Card Bills: ${fmt(d.creditCardBills)}
  Loan EMIs: ${fmt(d.loanEMI)}
  In-Hand: ${fmt(d.inHand)}

*INVESTMENTS* (Total: ${fmt(d.totalStocksCurrent)})
${invLines}

*LOANS* (Total Debt: ${fmt(d.totalDebt)})
${loanLines}
  EMI Burden: ${d.emiBurdenPct}% of salary${d.emiBurdenPct > 50 ? " -- HIGH" : ""}

*LENDENCLUB P2P*
  Capital Pooled: ${fmt(d.lcPooled)}
  Disbursed: ${fmt(d.lcDisbursed)}
  Interest Earned: ${fmt(d.lcInterest)}
  Active Loans: ${d.lcActiveLoans}
  NPA: ${fmt(d.lcNPA)}

*PERSONAL LENDING* (Total: ${fmt(d.plTotalCapital)})
${plLines}
  Monthly Interest: ${fmt(d.plMonthlyInterest)}${d.plPendingInt > 0 ? `\n  !! OVERDUE: ${fmt(d.plPendingInt)}` : ""}

*REAL ESTATE*
  ${d.reName || "Property"}: ${fmt(d.rePaid)} paid of ${fmt(d.reTotalCost)} (${d.rePct}%)
  Balance: ${fmt(d.reRemaining)}

*NET WORTH*
  Total Assets: ${fmt(d.totalAssets)}
  Total Liabilities: ${fmt(d.totalDebt)}
  Net Worth: ${fmt(d.netWorth)}

*HEALTH*
  EMI Burden: ${d.emiBurdenPct}% of salary
  Savings Rate: ${d.savingsRatePct}% of gross income`;
}

function templateNetWorth(d) {
  const invLines = (d.investments || []).map(i => `  - ${i.name}: ${fmt(i.current)}`).join("\n") || "  None";
  return `*Net Worth Breakdown (${d.month || "Current"})*

*ASSETS*
  Stocks & MF:
${invLines}
  Stocks Subtotal: ${fmt(d.totalStocksCurrent)}
  LendenClub P2P: ${fmt(d.lcPooled)}
  Personal Lending: ${fmt(d.plTotalCapital)}
  Real Estate (paid): ${fmt(d.rePaid)}
  ---
  TOTAL ASSETS: ${fmt(d.totalAssets)}

*LIABILITIES*
${(d.loans || []).map(l => `  - ${l.name}: ${fmt(l.outstanding)}`).join("\n")}
  ---
  TOTAL DEBT: ${fmt(d.totalDebt)}

*NET WORTH: ${fmt(d.netWorth)}*
${d.netWorth < 0 ? "  (In deficit - home loan dominates)" : "  (Positive and growing)"}

*Priority Debt Payoff:*
${(d.loans || []).sort((a, b) => b.rate - a.rate).map((l, i) => `  ${i + 1}. ${l.name} @ ${l.rate}% - ${fmt(l.outstanding)}`).join("\n")}`;
}

function templateGoals(d) {
  const g = d.goals || {};
  const idfcOut = d.loans?.find(l => l.name === "IDFC")?.outstanding || 0;
  const sbiOut = d.loans?.find(l => l.name === "SBI")?.outstanding || 0;
  return `*Financial Goals Progress (${d.month || "Current"})*

1. *Clear IDFC Loan (13.5%)*
   Outstanding: ${fmt(idfcOut)}
   Status: ${idfcOut === 0 ? "DONE" : "In progress"}

2. *Clear SBI Loan (9.35%)*
   Outstanding: ${fmt(sbiOut)}
   Status: ${sbiOut === 0 ? "DONE" : "In progress"}

3. *Rs 10L Total Investments*
   Current: ${fmt(d.totalAssets)} (${g.invPct || 0}%)

4. *Rs 5L LendenClub Pool*
   Current: ${fmt(d.lcPooled)} (${g.lcPct || 0}%)

5. *Rs 1 Crore Net Worth*
   Current: ${fmt(d.netWorth)} (${g.nwPct || 0}%)

Monthly savings capacity: ${fmt(d.monthlyCap)}/mo`;
}

function templateAlerts(d) {
  const alerts = [];
  if (d.emiBurdenPct > 50) alerts.push(`!! EMI Burden CRITICAL at ${d.emiBurdenPct}% of salary (should be <50%)`);
  if (d.savingsRatePct < 20) alerts.push(`!! Savings Rate LOW at ${d.savingsRatePct}% of gross (target: >20%)`);
  if (d.plPendingInt > 0) alerts.push(`!! OVERDUE: ${fmt(d.plPendingInt)} pending interest from borrowers`);
  if (d.lcNPA > 0) alerts.push(`!! LendenClub NPA: ${fmt(d.lcNPA)} at risk`);
  for (const l of (d.loans || [])) {
    if (l.rate > 12) alerts.push(`!! ${l.name} loan at ${l.rate}% - high rate, prioritise payoff`);
  }
  if (alerts.length === 0) alerts.push("All parameters on track. No alerts.");
  return `*Arth Alerts (${d.month || "Current"})*\n\n${alerts.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
}

function helpMessage() {
  return `*Arth - Your AI Finance Advisor*

I have live access to all your financial data.

*Quick Commands:*
/summary - Full financial snapshot
/alerts - What's off-track right now
/goals - Goal-by-goal progress
/networth - Net worth breakdown
/clear - Clear conversation memory
/help - Show this menu

*Ask anything:*
- Should I prepay my IDFC loan?
- How much SIP do I need for Rs 1Cr?
- Am I saving enough this month?
- How long to become debt-free?`;
}

// ── Groq AI (only for free-form chat) ────────────────────────────────────────
function buildSystemPrompt(d) {
  const g = d.goals || {};
  const histText = (d.salaryHistory || []).map(h => `  ${h.month}: gross Rs ${I(h.gross)}, in-hand Rs ${I(h.inHand)}`).join("\n") || "  No history";
  const loanLines = (d.loans || []).map(l => `- ${l.name}: Rs ${I(l.outstanding)} @ ${l.rate}% | EMI Rs ${I(l.emi)} | ${l.emisLeft} EMIs left${l.name === "IDFC" ? " <-- PRIORITY" : ""}`).join("\n");
  const invLines = (d.investments || []).map(i => `- ${i.name}: Rs ${I(i.current)} | P&L Rs ${I(i.pl)}`).join("\n") || "  No data";
  const plLines = (d.borrowers || []).map(b => `- ${b.name}: Rs ${I(b.amount)} @ Rs ${I(b.monthly)}/mo${b.overdue > 0 ? ` (OVERDUE Rs ${I(b.overdue)})` : ""}`).join("\n") || "  None";
  const eb = d.emiBurdenPct || 0;

  return `You are Arth - a sharp, empathetic personal financial advisor for Naresh, a ${d.age || 30}-year-old software professional in Hyderabad, India.

You have COMPLETE, LIVE access to their finances as of ${d.month || "Current"}.
CRITICAL: Use ONLY the EXACT numbers below. Do NOT recalculate or change any figure.

INCOME (Gross: Rs ${I(d.grossIncome)}/mo):
- Salary: Rs ${I(d.salary)}/mo | Tutoring: Rs ${I(d.tutoring)}/mo
- Lending interest: Rs ${I(d.lendingInterest)}/mo | In-hand: Rs ${I(d.inHand)}/mo
- CC bills: Rs ${I(d.creditCardBills)}/mo | Savings rate: ${d.savingsRatePct}%

SALARY HISTORY:
${histText}

LOANS (Total: Rs ${I(d.totalDebt)}):
${loanLines}
- EMI burden: Rs ${I(d.loanEMI)}/mo = ${eb}% of salary ${eb > 50 ? "!! HIGH" : ""}

INVESTMENTS (Total assets: Rs ${I(d.totalAssets)}):
${invLines}
- Personal lending: Rs ${I(d.plTotalCapital)} @ 24%/yr
- LendenClub P2P: Rs ${I(d.lcPooled)} | ~10% ROI | NPA: Rs ${I(d.lcNPA)}
- Real estate: Rs ${I(d.rePaid)} paid of Rs ${I(d.reTotalCost)} (${d.rePct}%)

NET WORTH: Rs ${I(d.netWorth)} (${d.netWorth < 0 ? "deficit" : "positive"})

GOALS:
1. Clear IDFC (13.5%) - Outstanding Rs ${I(d.loans?.[1]?.outstanding || 0)}
2. Clear SBI - Outstanding Rs ${I(d.loans?.[2]?.outstanding || 0)}
3. Rs 10L investments - ${g.invPct || 0}% | Current Rs ${I(d.totalAssets)}
4. Rs 5L LC pool - ${g.lcPct || 0}% | Current Rs ${I(d.lcPooled)}
5. Rs 1Cr net worth - ${g.nwPct || 0}%

STYLE: Speak like a trusted CA. Use exact Rs numbers. Indian financial context (80C, 24b, LTCG, NPS, ELSS). Under 350 words unless asked to elaborate.`;
}

async function callGroq(d, userMessage) {
  const systemPrompt = buildSystemPrompt(d);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationMemory,
    { role: "user", content: userMessage },
  ];

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: MAX_TOKENS }),
  });

  const json = await resp.json();
  if (json.error) return `AI error: ${json.error.message || "Unknown"}`;

  const reply = json.choices?.[0]?.message?.content || "No response.";

  conversationMemory.push({ role: "user", content: userMessage });
  conversationMemory.push({ role: "assistant", content: reply });
  if (conversationMemory.length > MAX_MEMORY * 2) conversationMemory = conversationMemory.slice(-MAX_MEMORY * 2);

  return reply;
}

// ── Webhook Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, message: "Arth bot active" });

  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = String(msg.chat.id);
    const text = msg.text.trim().split("@")[0];

    if (CHAT_ID && chatId !== CHAT_ID) return res.status(200).json({ ok: true });

    // Quick commands — no data needed
    if (text === "/start" || text === "/help") {
      await sendTelegram(chatId, helpMessage());
      return res.status(200).json({ ok: true });
    }
    if (text === "/clear") {
      conversationMemory = [];
      dataCache = { data: null, ts: 0 };
      await sendTelegram(chatId, "Memory and data cache cleared!");
      return res.status(200).json({ ok: true });
    }

    // Data commands — template responses
    const d = await getFinancialData();

    if (text === "/summary") {
      await sendTelegram(chatId, templateSummary(d));
    } else if (text === "/networth") {
      await sendTelegram(chatId, templateNetWorth(d));
    } else if (text === "/goals") {
      await sendTelegram(chatId, templateGoals(d));
    } else if (text === "/alerts") {
      await sendTelegram(chatId, templateAlerts(d));
    } else {
      // Free-form chat — uses Groq AI
      const reply = await callGroq(d, text);
      await sendTelegram(chatId, reply);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({ ok: true });
  }
}
