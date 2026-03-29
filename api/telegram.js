// ── Vercel Serverless Telegram Bot for Arth Finance Advisor (v2.0) ───────────
// 10 template commands, AI chat with Gemini fallback, inline keyboards,
// smart caching, progress bars, month-over-month comparison.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_URL  = process.env.DASHBOARD_URL;
const GROQ_MODEL     = "llama-3.3-70b-versatile";
const MAX_TOKENS     = 4096;
const CACHE_TTL_TEMPLATE = 15 * 60 * 1000;
const CACHE_TTL_CHAT     = 5 * 60 * 1000;

let dataCache = { data: null, ts: 0 };
let conversationMemory = [];
const MAX_MEMORY = 10;

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

// ── Telegram API ─────────────────────────────────────────────────────────────
async function sendTelegram(chatId, text, opts = {}) {
  const MAX_LEN = 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) chunks.push(text.slice(i, i + MAX_LEN));
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chatId, text: chunks[i] };
    if (i === chunks.length - 1 && opts.reply_markup) body.reply_markup = opts.reply_markup;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
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

// ── Data Fetcher with Smart Cache ────────────────────────────────────────────
async function getFinancialData(forTemplate = true) {
  const ttl = forTemplate ? CACHE_TTL_TEMPLATE : CACHE_TTL_CHAT;
  if (dataCache.data && Date.now() - dataCache.ts < ttl) return dataCache.data;
  const resp = await fetch(DASHBOARD_URL, { redirect: "follow" });
  let raw = await resp.json();
  if (raw?.data) raw = raw.data;
  const summary = buildBotSummary(raw);
  dataCache = { data: summary, ts: Date.now() };
  return summary;
}

// ── buildBotSummary (mirrors React dashboard calculations) ───────────────────
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

  // Income (current month)
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

  // Previous month (for /compare)
  const prev = validRows.length > 1 ? validRows[validRows.length - 2] : {};
  const prevMonthData = {
    month: String(prev["Month"] || ""),
    salary: N(prev["Salary"] || prev["salary"]),
    grossIncome: N(prev["Gross Total"] || prev["gross_total"]),
    creditCardBills: N(prev["CreditCard Bills"] || prev["Credit Card Bills"]),
    loanEMI: N(prev["HDFC EMI"]) + N(prev["IDFC EMI"]) + N(prev["SBI EMI"]),
    inHand: N(prev["In Hand"] || prev["in_hand"]),
    tutoring: N(prev["DevOps Tutoring"] || prev["Tutoring"]),
    lendingInterest: N(prev["Personal Lending Interest"] || prev["Lending Interest"]),
  };

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

  // Derived (mirrors App.jsx)
  const totalInvestments = totalStocksCurrent + lcPooled + plCap + rePaid;
  const netWorth = totalInvestments - totalDebt;
  const emiBurdenPct = salary > 0 ? Math.round((loanEMI / salary) * 100) : 0;
  const savingsRatePct = grossTotal > 0 ? Math.round((Math.max(0, inHand) / grossTotal) * 100) : 0;

  // Goals
  const monthlyCap = Math.max(0, inHand - 15000);

  return {
    month, age, salary, tutoring, lendingInterest: lendingInt, otherIncome: otherInc,
    grossIncome: grossTotal, creditCardBills: ccBills, loanEMI, inHand, salaryHistory,
    hdfcEmi, idfcEmi, sbiEmi, prevMonthData,
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
      sbiPct: (loans.find(l => l.name === "SBI")?.outstanding || 0) > 0 ? 0 : 100,
      invPct: Math.min(100, Math.round((totalInvestments / 1000000) * 100)),
      lcPct: Math.min(100, Math.round((lcPooled / 500000) * 100)),
      nwPct: Math.min(100, Math.max(0, Math.round((netWorth / 10000000) * 100))),
    },
  };
}

// ── Template Responses (100% consistent, no AI) ─────────────────────────────

function templateSummary(d) {
  const invLines = (d.investments || []).map(i => `  ${i.name}: ${fmt(i.current)} (P&L ${fmt(i.pl)})`).join("\n") || "  No stock data";
  const loanLines = (d.loans || []).map(l => `  ${l.name}: ${fmt(l.outstanding)} @ ${l.rate}% | EMI ${fmt(l.emi)}/mo | ${l.emisLeft} left`).join("\n");
  const plLines = (d.borrowers || []).map(b => `  ${b.name}: ${fmt(b.amount)} @ ${fmt(b.monthly)}/mo${b.overdue > 0 ? ` (OVERDUE ${fmt(b.overdue)})` : ""}`).join("\n") || "  None";

  return `ARTH FINANCIAL SNAPSHOT (${d.month || "Current"})

INCOME
  Salary: ${fmt(d.salary)}/mo
  Tutoring: ${fmt(d.tutoring)}/mo
  Lending Interest: ${fmt(d.lendingInterest)}/mo
  Gross Income: ${fmt(d.grossIncome)}
  CC Bills: ${fmt(d.creditCardBills)}
  Loan EMIs: ${fmt(d.loanEMI)}
  In-Hand: ${fmt(d.inHand)}

INVESTMENTS (${fmt(d.totalStocksCurrent)})
${invLines}

LOANS (Debt: ${fmt(d.totalDebt)})
${loanLines}
  EMI Burden: ${d.emiBurdenPct}%${d.emiBurdenPct > 50 ? " -- HIGH" : ""}

LENDENCLUB P2P
  Pooled: ${fmt(d.lcPooled)} | Interest: ${fmt(d.lcInterest)}
  Active: ${d.lcActiveLoans} loans | NPA: ${fmt(d.lcNPA)}

PERSONAL LENDING (${fmt(d.plTotalCapital)})
${plLines}
  Monthly: ${fmt(d.plMonthlyInterest)}${d.plPendingInt > 0 ? ` | OVERDUE: ${fmt(d.plPendingInt)}` : ""}

REAL ESTATE
  ${d.reName || "Property"}: ${fmt(d.rePaid)} of ${fmt(d.reTotalCost)} (${d.rePct}%)

NET WORTH: ${fmt(d.netWorth)}
  Assets: ${fmt(d.totalAssets)} | Debt: ${fmt(d.totalDebt)}
  Savings Rate: ${d.savingsRatePct}%`;
}

function templateNetWorth(d) {
  const invLines = (d.investments || []).map(i => `  ${i.name}: ${fmt(i.current)}`).join("\n") || "  None";
  return `NET WORTH BREAKDOWN (${d.month || "Current"})

ASSETS
${invLines}
  Stocks Subtotal: ${fmt(d.totalStocksCurrent)}
  LendenClub P2P: ${fmt(d.lcPooled)}
  Personal Lending: ${fmt(d.plTotalCapital)}
  Real Estate: ${fmt(d.rePaid)}
  ---------------
  TOTAL: ${fmt(d.totalAssets)}

LIABILITIES
${(d.loans || []).map(l => `  ${l.name}: ${fmt(l.outstanding)}`).join("\n")}
  ---------------
  TOTAL: ${fmt(d.totalDebt)}

NET WORTH: ${fmt(d.netWorth)}
${d.netWorth < 0 ? "(Deficit - debt exceeds assets)" : "(Positive)"}

PAYOFF PRIORITY (highest rate first)
${(d.loans || []).sort((a, b) => b.rate - a.rate).map((l, i) => `  ${i + 1}. ${l.name} @ ${l.rate}% - ${fmt(l.outstanding)}`).join("\n")}`;
}

function templateGoals(d) {
  const g = d.goals || {};
  const idfcOut = d.loans?.find(l => l.name === "IDFC")?.outstanding || 0;
  const sbiOut = d.loans?.find(l => l.name === "SBI")?.outstanding || 0;
  const idfcLoan = d.loans?.find(l => l.name === "IDFC");
  const sbiLoan = d.loans?.find(l => l.name === "SBI");
  const idfcProgress = idfcLoan ? pct(idfcLoan.paidEmis, idfcLoan.totalEmis) : (idfcOut === 0 ? 100 : 0);
  const sbiProgress = sbiLoan ? pct(sbiLoan.paidEmis, sbiLoan.totalEmis) : (sbiOut === 0 ? 100 : 0);

  return `FINANCIAL GOALS (${d.month || "Current"})

1. Clear IDFC Loan (13.5%)
   ${fmt(idfcOut)} remaining
   ${bar(idfcProgress)}

2. Clear SBI Loan (9.35%)
   ${fmt(sbiOut)} remaining
   ${bar(sbiProgress)}

3. Rs 10L Investments
   Current: ${fmt(d.totalAssets)}
   ${bar(g.invPct || 0)}

4. Rs 5L LendenClub Pool
   Current: ${fmt(d.lcPooled)}
   ${bar(g.lcPct || 0)}

5. Rs 1 Crore Net Worth
   Current: ${fmt(d.netWorth)}
   ${bar(g.nwPct || 0)}

Savings capacity: ${fmt(d.monthlyCap)}/mo`;
}

function templateAlerts(d) {
  const alerts = [];
  if (d.emiBurdenPct > 50) alerts.push(`EMI Burden CRITICAL at ${d.emiBurdenPct}% (should be <50%)`);
  if (d.savingsRatePct < 20) alerts.push(`Savings Rate LOW at ${d.savingsRatePct}% (target: >20%)`);
  if (d.plPendingInt > 0) alerts.push(`OVERDUE: ${fmt(d.plPendingInt)} pending from borrowers`);
  if (d.lcNPA > 0) alerts.push(`LendenClub NPA: ${fmt(d.lcNPA)} at risk`);
  for (const l of (d.loans || [])) {
    if (l.rate > 12) alerts.push(`${l.name} loan at ${l.rate}% - prioritise payoff`);
  }
  if (alerts.length === 0) alerts.push("All parameters on track. No alerts.");
  return `ARTH ALERTS (${d.month || "Current"})\n\n${alerts.map((a, i) => `${i + 1}. !! ${a}`).join("\n")}`;
}

function templateCompare(d) {
  const p = d.prevMonthData;
  if (!p || !p.month) return "No previous month data available for comparison.";
  return `MONTH COMPARISON
${p.month} --> ${d.month}

Salary:       ${fmt(p.salary)} --> ${fmt(d.salary)}${arrow(d.salary, p.salary)}
Gross Income: ${fmt(p.grossIncome)} --> ${fmt(d.grossIncome)}${arrow(d.grossIncome, p.grossIncome)}
Tutoring:     ${fmt(p.tutoring)} --> ${fmt(d.tutoring)}${arrow(d.tutoring, p.tutoring)}
Lending Int:  ${fmt(p.lendingInterest)} --> ${fmt(d.lendingInterest)}${arrow(d.lendingInterest, p.lendingInterest)}
CC Bills:     ${fmt(p.creditCardBills)} --> ${fmt(d.creditCardBills)}${arrow(d.creditCardBills, p.creditCardBills)}
Loan EMIs:    ${fmt(p.loanEMI)} --> ${fmt(d.loanEMI)}${arrow(d.loanEMI, p.loanEMI)}
In-Hand:      ${fmt(p.inHand)} --> ${fmt(d.inHand)}${arrow(d.inHand, p.inHand)}

EMI Burden: ${d.emiBurdenPct}% | Savings Rate: ${d.savingsRatePct}%`;
}

function templateBorrowers(d) {
  if (!d.borrowers || d.borrowers.length === 0) return "No active borrowers.";
  const lines = d.borrowers.map((b, i) => {
    let s = `${i + 1}. ${b.name}\n   Principal: ${fmt(b.amount)}\n   Monthly Interest: ${fmt(b.monthly)}/mo`;
    if (b.overdue > 0) s += `\n   !! OVERDUE: ${fmt(b.overdue)}`;
    else s += `\n   Overdue: --`;
    return s;
  }).join("\n\n");

  return `PERSONAL LENDING BREAKDOWN

${lines}

---------------
Total Lent: ${fmt(d.plTotalCapital)}
Monthly Income: ${fmt(d.plMonthlyInterest)}/mo
Total Overdue: ${d.plPendingInt > 0 ? fmt(d.plPendingInt) : "--"}
Borrowers with overdue: ${d.plOverdueCount}
Yield: 24%/yr`;
}

function templateLoans(d) {
  if (!d.loans || d.loans.length === 0) return "No active loans. Debt-free!";
  const lines = d.loans.map((l, i) => {
    const progress = pct(l.paidEmis, l.totalEmis);
    const payoffMonths = l.emisLeft;
    const payoffDate = payoffMonths > 0 ? monthsFromNow(payoffMonths) : "Done";
    let label = `${i + 1}. ${l.name}`;
    if (l.name === "IDFC") label += " <-- PRIORITY";
    return `${label}
   Outstanding: ${fmt(l.outstanding)} @ ${l.rate}%
   EMI: ${fmt(l.emi)}/mo
   Progress: ${l.paidEmis}/${l.totalEmis} EMIs paid
   ${bar(progress)}
   Est. payoff: ${payoffDate}`;
  }).join("\n\n");

  return `LOAN BREAKDOWN

${lines}

---------------
Total Debt: ${fmt(d.totalDebt)}
Total EMI: ${fmt(d.loanEMI)}/mo
EMI Burden: ${d.emiBurdenPct}% of salary`;
}

function templateExpenses(d) {
  const gross = d.grossIncome || 1;
  const items = [
    { name: "CC Bills", val: d.creditCardBills },
    { name: "HDFC EMI", val: d.hdfcEmi },
    { name: "IDFC EMI", val: d.idfcEmi },
    { name: "SBI EMI", val: d.sbiEmi },
  ];
  const totalOut = d.creditCardBills + d.loanEMI;
  const lines = items
    .filter(i => i.val > 0)
    .map(i => `  ${i.name}: ${fmt(i.val)}  (${pct(i.val, gross)}% of gross)`)
    .join("\n");

  return `EXPENSE BREAKDOWN (${d.month || "Current"})

OUTFLOWS
${lines}
  ---------------
  Total Outflow: ${fmt(totalOut)}  (${pct(totalOut, gross)}% of gross)

DEPLOYMENTS (this month)
  LendenClub: ${fmt(N(0))}
  Equity/MF: ${fmt(N(0))}
  Real Estate: ${fmt(N(0))}

REMAINING
  In-Hand: ${fmt(d.inHand)}  (${pct(d.inHand, gross)}% of gross)

Gross Income: ${fmt(d.grossIncome)}`;
}

function templateProjection(d) {
  const cap = d.monthlyCap;
  if (cap <= 0) return "Savings capacity is below baseline (Rs 15,000). Cannot project goal timelines until in-hand improves.";

  const lines = [];

  const idfcOut = d.loans?.find(l => l.name === "IDFC")?.outstanding || 0;
  if (idfcOut > 0) {
    const m = Math.ceil(idfcOut / cap);
    lines.push(`1. Clear IDFC (${fmt(idfcOut)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else {
    lines.push("1. Clear IDFC: DONE");
  }

  const sbiOut = d.loans?.find(l => l.name === "SBI")?.outstanding || 0;
  if (sbiOut > 0) {
    const m = Math.ceil(sbiOut / cap);
    lines.push(`2. Clear SBI (${fmt(sbiOut)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else {
    lines.push("2. Clear SBI: DONE");
  }

  const invGap = Math.max(0, 1000000 - d.totalAssets);
  if (invGap > 0) {
    const m = Math.ceil(invGap / cap);
    lines.push(`3. Rs 10L Investments (gap: ${fmt(invGap)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else {
    lines.push("3. Rs 10L Investments: ACHIEVED");
  }

  const lcGap = Math.max(0, 500000 - d.lcPooled);
  if (lcGap > 0) {
    const m = Math.ceil(lcGap / cap);
    lines.push(`4. Rs 5L LC Pool (gap: ${fmt(lcGap)})\n   At ${fmt(cap)}/mo: ~${m} months (${monthsFromNow(m)})`);
  } else {
    lines.push("4. Rs 5L LC Pool: ACHIEVED");
  }

  const nwGap = Math.max(0, 10000000 - d.netWorth);
  if (nwGap > 0) {
    const mFlat = Math.ceil(nwGap / cap);
    const mCagr = Math.ceil(Math.log(10000000 / Math.max(1, d.totalAssets)) / Math.log(1 + 0.12 / 12));
    lines.push(`5. Rs 1Cr Net Worth (gap: ${fmt(nwGap)})\n   Savings only: ~${mFlat} months (${monthsFromNow(mFlat)})\n   With 12% CAGR: ~${mCagr} months (${monthsFromNow(mCagr)})`);
  } else {
    lines.push("5. Rs 1Cr Net Worth: ACHIEVED");
  }

  return `GOAL PROJECTIONS
(Based on ${fmt(cap)}/mo savings capacity)

${lines.join("\n\n")}

Note: Projections assume constant savings. Prepaying high-rate loans first improves timelines.`;
}

// ── Help ─────────────────────────────────────────────────────────────────────
function helpMessage() {
  return `Arth - Your AI Finance Advisor v2.0

I have live access to all your financial data.

Commands:
/summary - Full financial snapshot
/networth - Net worth breakdown
/goals - Goal progress with bars
/alerts - What needs attention
/compare - Month vs month changes
/borrowers - Who owes you what
/loans - Loan details & payoff plan
/expenses - Where your money goes
/projection - When you'll hit goals
/whatif <scenario> - What-if analysis

/clear - Reset memory
/help - This menu

Or just ask anything:
"Should I prepay my IDFC loan?"
"How much SIP for Rs 1Cr in 5 years?"
"What if I get a 20% salary hike?"`;
}

// ── AI System Prompt ─────────────────────────────────────────────────────────
function buildSystemPrompt(d) {
  const g = d.goals || {};
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const histText = (d.salaryHistory || []).map(h => `  ${h.month}: gross Rs ${I(h.gross)}, in-hand Rs ${I(h.inHand)}`).join("\n") || "  No history";
  const loanLines = (d.loans || []).map(l => `- ${l.name}: Rs ${I(l.outstanding)} @ ${l.rate}% | EMI Rs ${I(l.emi)} | ${l.emisLeft} EMIs left${l.name === "IDFC" ? " <-- PRIORITY" : ""}`).join("\n");
  const invLines = (d.investments || []).map(i => `- ${i.name}: Rs ${I(i.current)} | P&L Rs ${I(i.pl)}`).join("\n") || "  No data";
  const plLines = (d.borrowers || []).map(b => `- ${b.name}: Rs ${I(b.amount)} @ Rs ${I(b.monthly)}/mo${b.overdue > 0 ? ` (OVERDUE Rs ${I(b.overdue)})` : ""}`).join("\n") || "  None";
  const eb = d.emiBurdenPct || 0;

  return `You are Arth - a sharp, empathetic personal financial advisor for Naresh, a ${d.age || 30}-year-old software professional in Hyderabad, India.
Today is ${today}. Data is as of ${d.month || "Current"}.

CRITICAL RULES:
1. Use ONLY the EXACT numbers below. Do NOT recalculate or change any figure.
2. All totals are pre-calculated. Use them as-is.
3. Never say "I don't have access to your data" - you have COMPLETE live data below.
4. For casual/non-financial messages (greetings, jokes, "I love you", etc.): respond warmly and briefly, then gently steer toward a financial insight or tip.
5. For what-if scenarios: model the impact using the data below, show before vs after.

INCOME (Gross: Rs ${I(d.grossIncome)}/mo):
- Salary: Rs ${I(d.salary)}/mo | Tutoring: Rs ${I(d.tutoring)}/mo
- Lending interest: Rs ${I(d.lendingInterest)}/mo | In-hand: Rs ${I(d.inHand)}/mo
- CC bills: Rs ${I(d.creditCardBills)}/mo | Savings rate: ${d.savingsRatePct}%

SALARY HISTORY:
${histText}

LOANS (Total debt: Rs ${I(d.totalDebt)}):
${loanLines}
- EMI burden: Rs ${I(d.loanEMI)}/mo = ${eb}% of salary ${eb > 50 ? "!! HIGH" : ""}

INVESTMENTS (Total assets: Rs ${I(d.totalAssets)}):
${invLines}
- LendenClub P2P: Rs ${I(d.lcPooled)} | ~10% ROI | NPA: Rs ${I(d.lcNPA)}
- Real estate: Rs ${I(d.rePaid)} paid of Rs ${I(d.reTotalCost)} (${d.rePct}%)

PERSONAL LENDING (Total: Rs ${I(d.plTotalCapital)} @ 24%/yr):
${plLines}
  Monthly interest income: Rs ${I(d.plMonthlyInterest)}${d.plPendingInt > 0 ? `\n  !! TOTAL OVERDUE: Rs ${I(d.plPendingInt)}` : ""}

NET WORTH: Rs ${I(d.netWorth)} (PRE-CALCULATED, USE AS-IS)
EMI BURDEN: ${eb}% (PRE-CALCULATED, USE AS-IS)
SAVINGS RATE: ${d.savingsRatePct}% (PRE-CALCULATED, USE AS-IS)

GOALS:
1. Clear IDFC (13.5%) - Outstanding Rs ${I(d.loans?.[1]?.outstanding || 0)}
2. Clear SBI - Outstanding Rs ${I(d.loans?.[2]?.outstanding || 0)}
3. Rs 10L investments - ${g.invPct || 0}% done
4. Rs 5L LC pool - ${g.lcPct || 0}% done
5. Rs 1Cr net worth - ${g.nwPct || 0}% done

Monthly savings capacity: Rs ${I(d.monthlyCap)} (in-hand minus Rs 15,000 baseline)

STYLE: Speak like a trusted CA-cum-wealth-manager. Use exact Rs numbers from above. Indian financial context (80C, 24b, LTCG, NPS, ELSS). Be specific and actionable. Under 350 words unless asked to elaborate.`;
}

// ── AI Callers ───────────────────────────────────────────────────────────────

async function callGroqInternal(messages, signal) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: MAX_TOKENS }),
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

async function callAI(d, userMessage) {
  const systemPrompt = buildSystemPrompt(d);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationMemory,
    { role: "user", content: userMessage },
  ];

  // Try Groq with 12s timeout
  if (GROQ_API_KEY) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const reply = await callGroqInternal(messages, controller.signal);
      clearTimeout(timeout);
      updateMemory(userMessage, reply);
      return reply;
    } catch (err) {
      console.log("Groq failed, trying fallback:", err.message);
    }
  }

  // Fallback to Gemini
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
    case "/projection": return templateProjection(d);
    default: return null;
  }
}

// ── Webhook Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, message: "Arth bot v2.0 active" });

  let chatId = null;
  try {
    const update = req.body;

    // Inline keyboard button presses
    if (update.callback_query) {
      const cb = update.callback_query;
      chatId = String(cb.message.chat.id);
      if (CHAT_ID && chatId !== CHAT_ID) {
        await answerCallback(cb.id);
        return res.status(200).json({ ok: true });
      }
      await answerCallback(cb.id);
      const cmd = cb.data;
      const d = await getFinancialData(true);
      const reply = getCommandResponse(cmd, d);
      if (reply) await sendTelegram(chatId, reply);
      return res.status(200).json({ ok: true });
    }

    // Regular messages
    const msg = update?.message || update?.edited_message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    chatId = String(msg.chat.id);
    const rawText = msg.text.trim();
    const text = rawText.split("@")[0];

    if (CHAT_ID && chatId !== CHAT_ID) return res.status(200).json({ ok: true });

    // /start and /help with inline keyboard
    if (text === "/start" || text === "/help") {
      await sendTelegram(chatId, helpMessage(), { reply_markup: mainKeyboard });
      return res.status(200).json({ ok: true });
    }

    // /clear
    if (text === "/clear") {
      conversationMemory = [];
      dataCache = { data: null, ts: 0 };
      await sendTelegram(chatId, "Memory and data cache cleared.");
      return res.status(200).json({ ok: true });
    }

    // Template commands (fast, no AI)
    const templateCmds = ["/summary", "/networth", "/goals", "/alerts", "/compare", "/borrowers", "/loans", "/expenses", "/projection"];
    if (templateCmds.includes(text)) {
      const d = await getFinancialData(true);
      const reply = getCommandResponse(text, d);
      if (reply) await sendTelegram(chatId, reply);
      return res.status(200).json({ ok: true });
    }

    // /whatif -- AI-powered scenario analysis
    if (text.startsWith("/whatif")) {
      const scenario = rawText.replace(/^\/whatif(@\w+)?\s*/i, "").trim();
      if (!scenario) {
        await sendTelegram(chatId, "Usage: /whatif <scenario>\n\nExamples:\n/whatif prepay IDFC 50000\n/whatif start SIP 5000 monthly\n/whatif quit tutoring\n/whatif salary hike 20%\n/whatif close all personal lending");
        return res.status(200).json({ ok: true });
      }
      const d = await getFinancialData(false);
      const reply = await callAI(d, `WHAT-IF ANALYSIS REQUEST: ${scenario}\n\nAnalyze this scenario using my current financial data. Show before vs after impact on relevant metrics (EMI burden, savings rate, net worth, goal timelines). Be specific with Rs numbers and give your recommendation.`);
      await sendTelegram(chatId, reply);
      return res.status(200).json({ ok: true });
    }

    // Free-form AI chat
    const d = await getFinancialData(false);
    const reply = await callAI(d, text);
    await sendTelegram(chatId, reply);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    if (chatId) {
      try { await sendTelegram(chatId, "Something went wrong. Please try again in a moment."); } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  }
}
