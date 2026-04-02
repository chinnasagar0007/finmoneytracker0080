import React, { useState, useEffect, useRef, useCallback } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
         AreaChart, Area, LineChart, Line, Legend, ComposedChart } from "recharts";

// ─── CENTRAL API URL ─────────────────────────────────────────────────────────
// Single Apps Script URL that reads all 6 spreadsheets
const DEFAULT_API_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_CENTRAL_API_URL) ||
  "/api/central";

function loadApiUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("apiUrl");
    const stored = localStorage.getItem("pf_central_api");
    return fromQuery || stored || DEFAULT_API_URL;
  } catch (e) {
    return DEFAULT_API_URL;
  }
}
function saveApiUrl(url) {
  try {
    localStorage.setItem("pf_central_api", url);
  } catch (e) {}
}

function withCacheBust(url) {
  return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function isSameOriginRequest(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    return resolved.origin === window.location.origin;
  } catch (e) {
    return String(url || "").startsWith("/");
  }
}

// ─── CENTRAL DATA MAPPER ──────────────────────────────────────────────────────
// The central API returns: { income: { "Sheet Name": [rows] }, stocks: {...}, ... }
// This maps raw sheet rows → the structured data shape the dashboard expects

const num = v => {
  if (typeof v === "number") return v;
  if (!v && v !== 0) return 0;
  const n = parseFloat(String(v).replace(/[₹,\s,]/g, ""));
  return isNaN(n) ? 0 : n;
};

const normalizeLookupKey = value =>
  String(value || "")
    .replace(/[₹%]/g, " ")
    .replace(/[()]/g, " ")
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function getField(row, ...candidates) {
  if (!row || typeof row !== "object") return undefined;
  const wants = candidates.flat().map(normalizeLookupKey).filter(Boolean);
  if (wants.length === 0) return undefined;

  for (const [key, value] of Object.entries(row)) {
    if (value === "" || value == null) continue;
    const normalizedKey = normalizeLookupKey(key);
    if (!normalizedKey) continue;
    if (wants.some(want => normalizedKey === want || normalizedKey.includes(want) || want.split(" ").includes(normalizedKey))) {
      return value;
    }
  }

  return undefined;
}

function hasField(row, ...candidates) {
  const value = getField(row, ...candidates);
  return value !== undefined && String(value).trim() !== "";
}

/** Repayment log "Date" only — hasField(..., "Date") also matches "Date Lent" on borrower rows (wrong sheet / merge). */
function hasRepaymentLogDateCell(row) {
  if (!row || typeof row !== "object") return false;
  for (const [key, value] of Object.entries(row)) {
    if (value === "" || value == null) continue;
    const nk = normalizeLookupKey(key);
    if (nk === "date" && String(value).trim() !== "") return true;
  }
  return false;
}

function unwrapCentralPayload(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const expected = ["income", "lendenClub", "personalLending", "realEstate", "stocks", "loans"];
  if (expected.some(key => key in raw)) return raw;
  // bot_v3 / bot envelope: { _source, raw: { income, personalLending, ... }, kpis } — mapper expects sections at top level
  if (raw.raw && typeof raw.raw === "object" && expected.some(key => key in raw.raw)) {
    return unwrapCentralPayload(raw.raw);
  }
  if (raw.data && typeof raw.data === "object") return unwrapCentralPayload(raw.data);
  if (raw.result && typeof raw.result === "object") return unwrapCentralPayload(raw.result);
  if (raw.payload && typeof raw.payload === "object") return unwrapCentralPayload(raw.payload);
  return raw;
}

function hasUsableMappedData(mapped) {
  if (!mapped) return false;

  return Boolean(
    mapped.income?.salary > 0 ||
    mapped.salaryHistory?.length ||
    mapped.dailyExpenses?.length ||
    mapped.taxLog?.length ||
    mapped.stocks?.mutualFunds?.length ||
    mapped.stocks?.equity?.length ||
    mapped.stocks?.options?.length ||
    mapped.stocks?.crypto?.length ||
    mapped.loans?.hdfc?.schedule?.length ||
    mapped.loans?.idfc?.schedule?.length ||
    mapped.loans?.sbi?.schedule?.length ||
    mapped.lendenClub?.monthSummary?.length ||
    mapped.lendenClub?.tabSummary?.length ||
    mapped.lendenClub?.transactions?.length ||
    mapped.personalLending?.borrowers?.length ||
    mapped.personalLending?.repaymentLog?.length ||
    mapped.realEstate?.totalCost > 0 ||
    mapped.realEstate?.emiSchedule?.length ||
    mapped.realEstate?.valuation?.length
  );
}

function hasUsableLendenClubData(section) {
  if (!section) return false;
  return Boolean(
    num(section.totalPooled) > 0 ||
    section.monthSummary?.length ||
    section.tabSummary?.length ||
    section.transactions?.length ||
    section.loanSamples?.length
  );
}

function hasUsablePersonalLendingData(section) {
  if (!section) return false;
  return Boolean(
    num(section.totalCapital) > 0 ||
    section.borrowers?.length ||
    section.repaymentLog?.length
  );
}

function findSheet(sheetsObj, candidates) {
  if (!sheetsObj) return null;
  const keys = Object.keys(sheetsObj);
  for (const cand of candidates) {
    const want = normalizeLookupKey(cand);
    const key = keys.find(k => {
      const current = normalizeLookupKey(k);
      return current === want || current.includes(want) || want.includes(current);
    });
    if (key) return sheetsObj[key];
  }
  return null;
}

function mapIncomeData(raw) {
  // raw.income → { "Income Tracker": [...], "Monthly Budget": [...], "Daily Expenses": [...], "Tax Log": [...] }
  const incomeSheet = findSheet(raw?.income, ["Income Tracker"]);
  const budgetSheet = findSheet(raw?.income, ["Monthly Budget"]);
  const expSheet    = findSheet(raw?.income, ["Daily Expenses"]);
  const taxSheet    = findSheet(raw?.income, ["Tax Log"]);

  // Current month row = last row that has a Salary value
  const incomeRows = (incomeSheet || []).filter(r => num(r["Salary"] || r["salary"]) > 0);
  const cur = incomeRows[incomeRows.length - 1] || {};

  const income = {
    month:           String(cur["Month"]            || cur["month"]           || ""),
    year:            num(cur["Year"]                || cur["year"]),
    age:             num(cur["Age"]                 || cur["age"]),
    salary:          num(cur["Salary"]              || cur["salary"]),
    tutoring:        num(cur["DevOps Tutoring"]     || cur["Tutoring"]        || cur["tutoring"]),
    lendingInterest: num(cur["Personal Lending Interest"] || cur["Lending Interest"]),
    otherIncome:     num(cur["Other Income"]        || cur["other_income"]),
    taxRefunded:     num(cur["Tax Refunded"]        || cur["tax_refunded"]),
    grossTotal:      num(cur["Gross Total"]         || cur["gross_total"]),
    taxDeducted:     num(cur["Tax Deducted"]        || cur["tax_deducted"]),
    netIncome:       num(cur["Net Income"]          || cur["net_income"]),
    creditCardBills: num(cur["CreditCard Bills"]    || cur["Credit Card Bills"]),
    hdfcEmi:         num(cur["HDFC EMI"]            || cur["hdfc_emi"]),
    idfcEmi:         num(cur["IDFC EMI"]            || cur["idfc_emi"]),
    sbiEmi:          num(cur["SBI EMI"]             || cur["sbi_emi"]),
    totalEmi:        num(cur["Total EMI"]           || cur["total_emi"]),
    inHand:          num(cur["In Hand"]             || cur["in_hand"]),
    personalLending: num(cur["Personal Lending"]    || cur["personal_lending"]),
    lendenClub:      num(cur["LendenClub"]          || cur["lenden_club"]),
    equityStocks:    num(cur["Equity Stocks"]       || cur["equity_stocks"]),
    mutualFunds:     num(cur["Mutual Funds"]        || cur["mutual_funds"]),
  };

  // Budget
  const CATS = ["food","transport","utilities","medical","entertainment","shopping","education","fuel","grooming","misc"];
  const budget = { actual: {} };
  CATS.forEach(c => { budget[c] = 0; budget.actual[c] = 0; });
  (budgetSheet || []).forEach(r => {
    const label = String(r["Category"] || r[""] || Object.values(r)[0] || "").toLowerCase();
    const isB = label.includes("budget") || label.includes("planned") || label.includes("target");
    const isA = label.includes("actual") || label.includes("spent");
    if (isB || isA) {
      CATS.forEach(c => {
        const v = num(r[c.charAt(0).toUpperCase()+c.slice(1)] || r[c]);
        if (isB) budget[c] = v;
        if (isA) budget.actual[c] = v;
      });
    }
  });

  // Daily Expenses
  const dailyExpenses = (expSheet || [])
    .filter(r => r["Date"] || r["date"])
    .map(r => ({
      date:     String(r["Date"]     || r["date"]     || ""),
      category: String(r["Category"]|| r["category"] || ""),
      desc:     String(r["Description"] || r["desc"] || r["Desc"] || ""),
      amount:   num(r["Amount"]      || r["amount"]),
      mode:     String(r["Mode"]     || r["mode"]     || ""),
      tag:      String(r["Tag"]      || r["tag"]      || ""),
    }));

  // Tax Log
  const taxLog = (taxSheet || [])
    .filter(r => r["FY"] || r["fy"])
    .map(r => ({
      fy:             String(r["FY"]               || r["fy"]              || ""),
      age:            num(r["Age"]                 || r["age"]),
      grossIncome:    num(r["Gross Income"]        || r["gross_income"]),
      deductions:     num(r["Deductions"]          || r["deductions"]),
      taxableIncome:  num(r["Taxable Income"]      || r["taxable_income"]),
      taxLiability:   num(r["Tax Liability"]       || r["tax_liability"]),
      tds:            num(r["TDS"]                 || r["tds"]),
      selfAssessment: num(r["Self Assessment"]     || r["self_assessment"]),
      effectiveRate:  num(r["Effective Rate"]      || r["effective_rate"]),
      regime:         String(r["Regime"]           || r["regime"]          || "New"),
    }));

  // Salary History — all rows with salary > 0
  const salaryHistory = incomeRows.map(r => {
    const salary     = num(r["Salary"]       || r["salary"]);
    const tutoring   = num(r["DevOps Tutoring"] || r["Tutoring"] || r["tutoring"]);
    const lending    = num(r["Personal Lending Interest"] || r["Lending Interest"]);
    const other      = num(r["Other Income"] || r["other_income"]);
    const grossTotal = num(r["Gross Total"]  || r["gross_total"]);
    const inHand     = num(r["In Hand"]      || r["in_hand"]);
    const hdfcEmi    = num(r["HDFC EMI"]     || r["hdfc_emi"]);
    const idfcEmi    = num(r["IDFC EMI"]     || r["idfc_emi"]);
    const sbiEmi     = num(r["SBI EMI"]      || r["sbi_emi"]);
    const ccBills    = num(r["CreditCard Bills"] || r["Credit Card Bills"]);
    const taxDed     = num(r["Tax Deducted"] || r["tax_deducted"]);
    const totalIncome= grossTotal || (salary + tutoring + lending + other);
    const expenses   = hdfcEmi + idfcEmi + sbiEmi + ccBills + taxDed;
    return {
      month: String(r["Month"] || r["month"] || ""),
      salary, tutoring, lendingInterest: lending, otherIncome: other,
      totalIncome, expenses,
      savings: inHand || Math.max(0, totalIncome - expenses),
      grossTotal, inHand, hdfcEmi, idfcEmi, sbiEmi, ccBills, taxDed,
      personalLending: num(r["Personal Lending"] || r["personal_lending"]),
      lendenClub:      num(r["LendenClub"]       || r["lenden_club"]),
      equityStocks:    num(r["Equity Stocks"]     || r["equity_stocks"]),
      mutualFunds:     num(r["Mutual Funds"]      || r["mutual_funds"]),
    };
  });

  return { income, budget, dailyExpenses, taxLog, salaryHistory };
}

function mapStocksData(raw) {
  const mfSheet      = findSheet(raw?.stocks, ["Mutual Fund", "MF"]);
  const eqSheet      = findSheet(raw?.stocks, ["Equity", "Stock"]);
  const foSheet      = findSheet(raw?.stocks, ["Option", "F&O", "FO", "Derivative"]);
  const cryptoSheet  = findSheet(raw?.stocks, ["Crypto", "Bitcoin", "₿"]);

  const mf = (mfSheet || []).filter(r => hasField(r, "Fund Name", "Name")).map(r => {
    const inv = num(getField(r, "Invested", "Amount Invested", "Investment"));
    const cur = num(getField(r, "Current", "Current Value", "Market Value"));
    return { name:String(getField(r, "Fund Name", "Name") || ""), amc:String(getField(r, "AMC") || ""), type:String(getField(r, "Type") || ""),
      mode:String(getField(r, "Mode") || "SIP"), startDate:String(getField(r, "Start Date") || ""), invested:inv, current:cur,
      units:num(getField(r, "Units")), nav:num(getField(r, "NAV")),
      returns:num(getField(r, "Returns"))||(cur-inv), returnsP:num(getField(r, "Returns%"))||(inv>0?+((cur-inv)/inv*100).toFixed(2):0),
      xirr:getField(r, "XIRR") || null, status:String(getField(r, "Status") || "Active") };
  });

  const equity = (eqSheet || []).filter(r => hasField(r, "Symbol", "Ticker")).map(r => {
    const inv = num(getField(r, "Invested", "Amount Invested"));
    const cur = num(getField(r, "Current", "Current Value", "Market Value"));
    return { symbol:String(getField(r, "Symbol", "Ticker") || ""), company:String(getField(r, "Company", "Stock Name", "Name") || ""),
      exchange:String(getField(r, "Exchange") || "NSE"), buyDate:String(getField(r, "Buy Date") || ""),
      qty:num(getField(r, "Qty", "Quantity")), avgBuy:num(getField(r, "Avg Buy", "Buy Price", "Average Buy")),
      invested:inv, cmp:num(getField(r, "CMP", "Current Price")), current:cur,
      pl:num(getField(r, "P&L"))||(cur-inv), plP:num(getField(r, "P&L%"))||(inv>0?+((cur-inv)/inv*100).toFixed(2):0),
      sector:String(getField(r, "Sector") || "") };
  });

  const options = (foSheet || []).filter(r => hasField(r, "Index", "Underlying")).map(r => ({
    date:String(getField(r, "Date") || ""), index:String(getField(r, "Index", "Underlying") || ""), type:String(getField(r, "Type") || ""),
    strike:num(getField(r, "Strike", "Strike Price")), expiry:String(getField(r, "Expiry") || ""),
    lots:num(getField(r, "Lots")), buyPremium:num(getField(r, "Buy Premium")), sellPremium:num(getField(r, "Sell Premium")),
    lotSize:num(getField(r, "Lot Size")), grossPL:num(getField(r, "Gross P&L", "Gross PL")),
    brokerage:num(getField(r, "Brokerage")), netPL:num(getField(r, "Net P&L", "Net PL")),
    status:String(getField(r, "Status") || ""), notes:String(getField(r, "Notes") || "") }));

  const crypto = (cryptoSheet || []).filter(r => hasField(r, "Coin", "Symbol", "Token")).map(r => {
    const inv = num(getField(r, "Invested", "Amount Invested"));
    const cur = num(getField(r, "Current", "Current Value", "Market Value"));
    return { coin:String(getField(r, "Coin", "Name", "Token") || ""), symbol:String(getField(r, "Symbol") || ""),
      exchange:String(getField(r, "Exchange") || ""), buyDate:String(getField(r, "Buy Date") || ""),
      qty:num(getField(r, "Qty", "Quantity")), buyPrice:num(getField(r, "Buy Price", "Avg Buy Price", "Average Buy")),
      invested:inv, currentPrice:num(getField(r, "Current Price", "CMP")), current:cur,
      pl:num(getField(r, "P&L"))||(cur-inv), plP:num(getField(r, "P&L%"))||(inv>0?+((cur-inv)/inv*100).toFixed(2):0),
      wallet:String(getField(r, "Wallet", "Exchange") || "") };
  });

  const s = (arr, k) => arr.reduce((t, x) => t + (x[k]||0), 0);
  const summary = {
    mf:      { invested:s(mf,"invested"),     current:s(mf,"current"),     pl:s(mf,"returns")  },
    equity:  { invested:s(equity,"invested"), current:s(equity,"current"), pl:s(equity,"pl")   },
    options: { invested:0, current:0,                                       pl:s(options,"netPL")},
    crypto:  { invested:s(crypto,"invested"), current:s(crypto,"current"), pl:s(crypto,"pl")   },
    total: {
      invested: s(mf,"invested")+s(equity,"invested")+s(crypto,"invested"),
      current:  s(mf,"current") +s(equity,"current") +s(crypto,"current"),
      pl:       s(mf,"returns") +s(equity,"pl")       +s(options,"netPL") +s(crypto,"pl"),
    }
  };
  return { mutualFunds:mf, equity, options, crypto, summary };
}

function mapLoansData(raw) {
  function readLoan(sheetsObj, candidates) {
    const rows = findSheet(sheetsObj, candidates);
    if (!rows || rows.length === 0) return null;
    const meta = rows[0];
    const hasMeta = hasField(meta, "Outstanding", "EMI", "Loan Name", "Loan Amount");
    const schedule = (hasMeta ? rows.slice(1) : rows)
      .filter(r => hasField(r, "#", "no", "Date", "Due Date"))
      .map(r => ({
        no:        num(getField(r, "#", "no", "EMI No.")),
        date:      String(getField(r, "Date", "Due Date") || ""),
        emi:       num(getField(r, "EMI", "EMI Amount", "Instalment Amt")),
        principal: num(getField(r, "Principal")),
        interest:  num(getField(r, "Interest")),
        balance:   num(getField(r, "Balance", "Closing Balance", "Outstanding")),
        status:    String(getField(r, "Status") || ""),
      }));
    const paidEmis = schedule.filter(e => /paid|done|completed/i.test(e.status));
    const calcPrincipalPaid = paidEmis.reduce((s, e) => s + e.principal, 0);
    const calcInterestPaid  = paidEmis.reduce((s, e) => s + e.interest, 0);
    const sheetInterestPaid   = num(getField(meta, "Total Interest Paid"));
    const sheetPrincipalPaid  = num(getField(meta, "Total Principal Paid"));
    const lastPaid = paidEmis.length > 0 ? paidEmis[paidEmis.length - 1] : null;
    const currentOutstanding = lastPaid
      ? lastPaid.balance
      : (schedule.length > 0 ? num(getField(schedule[0], "Opening Balance", "Opening Principal")) || num(getField(meta, "Outstanding", "Balance Outstanding", "Loan Amount", "Original Loan")) : 0);
    return {
      name:                String(getField(meta, "Loan Name", "Name") || ""),
      emi:                 num(getField(meta, "EMI", "Monthly EMI")),
      outstanding:         currentOutstanding || num(getField(meta, "Outstanding", "Balance Outstanding")),
      paid:                num(getField(meta, "EMIs Paid")) || paidEmis.length,
      total:               num(getField(meta, "Total EMIs", "Tenure")),
      originalLoan:        num(getField(meta, "Original Loan", "Loan Amount")),
      interestRate:        num(getField(meta, "Interest Rate", "Rate")),
      totalPrincipalPaid:  calcPrincipalPaid > 0 ? calcPrincipalPaid : sheetPrincipalPaid,
      totalInterestPaid:   calcInterestPaid > 0 ? calcInterestPaid : sheetInterestPaid,
      totalInterestOnLoan: num(getField(meta, "Total Interest on Loan")),
      schedule,
    };
  }
  return {
    hdfc: readLoan(raw?.loans, ["HDFC"]),
    idfc: readLoan(raw?.loans, ["IDFC"]),
    sbi:  readLoan(raw?.loans, ["SBI"]),
  };
}

function mapLendenClubData(raw) {
  const sheets       = raw?.lendenClub || {};
  const sumSheet     = findSheet(sheets, ["LC Summary","LendenClub Summary","Summary","Month Summary","Monthly Summary","Pool","Overview"]);
  const tabSheet     = findSheet(sheets, ["Tab Summary","LC Tab","Batch","Monthly Breakdown","Performance"]);
  const txSheet      = findSheet(sheets, ["Transaction","Transactions","Investment Log","Pool Growth","Cashflow","Reinvestment"]);
  const loanSheet    = findSheet(sheets, ["Loan Sample","Loan Samples","LC Loan","Loans","Loan Account","Loan Details","Loan Book"]);
  const monthTabPattern = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- /\d]+$/i;
  const oldCols = {
    id:1, rate:2, tenure:3, score:5, disburseDate:6, amount:7, status:8, totalRepay:9, repayStart:10,
    principalRecv:11, interestRecv:12, fee:13, totalRecv:14, pl:15, dpd:16, npa:17, closureDate:18,
  };

  let summaryMeta = {};
  if (sumSheet && sumSheet.length > 0) {
    const first = sumSheet[0];
    const keys = Object.keys(first);
    if (keys.length === 2 && (keys[0].toLowerCase().includes("field") || keys[0] === "")) {
      sumSheet.forEach(r => {
        if (r[keys[0]]) summaryMeta[String(r[keys[0]]).trim()] = r[keys[1]];
      });
    } else {
      sumSheet.forEach(r => {
        const rowHasTimelineField = hasField(r, "Month", "Tab", "Batch", "Date");
        if (rowHasTimelineField) return;
        Object.entries(r || {}).forEach(([key, value]) => {
          if (value === "" || value == null) return;
          const normalizedKey = normalizeLookupKey(key);
          if (!normalizedKey || /month|date|tab|batch/.test(normalizedKey)) return;
          summaryMeta[key] = value;
        });
      });
    }
  }

  const monthSummary = (sumSheet||[]).filter(r=>hasField(r, "Month", "Tab", "Batch", "Date")).map(r=>({
    month:       String(getField(r, "Month", "Tab", "Batch", "Date") || ""),
    netInvested: num(getField(r, "Net Invested", "Invested", "Added", "Net Added", "Amount")),
    closingPool: num(getField(r, "Closing Pool", "Pool", "Total Pool", "Current Pool", "Pool Size", "Outstanding")),
  }));

  const tabSummary = (tabSheet||[]).filter(r=>
    hasField(r, "Tab", "Month", "Batch", "Disbursed", "Received", "Interest", "Outstanding", "Loans")
  ).map(r=>({
    tab:         String(getField(r, "Tab", "Month", "Batch", "Date") || ""),
    disbursed:   num(getField(r, "Disbursed", "Amount", "Disbursed Amount", "Invested")),
    received:    num(getField(r, "Received", "Total Received", "Collection", "Collections")),
    principal:   num(getField(r, "Principal", "Principal Received", "Principal Collected")),
    interest:    num(getField(r, "Interest", "Interest Received", "Interest Earned", "Yield")),
    fee:         num(getField(r, "Fee", "Fees", "Platform Fee")),
    outstanding: num(getField(r, "Outstanding", "Pending", "Closing Pool", "Pool", "Current Pool")),
    npa:         num(getField(r, "NPA", "Overdue", "Default")),
    loans:       num(getField(r, "Loans", "No. of Loans", "Count", "Active Loans", "Total Loans")),
  }));

  const transactions = (txSheet||[])
    .filter(r=>hasField(r, "Date", "Month", "Tab", "Batch"))
    .map(r=>({
      date: String(getField(r, "Date", "Month", "Tab", "Batch") || ""),
      rawInvested: num(getField(r, "Invested", "Amount", "Added", "Net Invested", "Reinvested")),
      pool: num(getField(r, "Pool", "Closing Pool", "Total Pool", "Current Pool", "Pool Size", "Outstanding")),
      remark: String(getField(r, "Remark", "Remarks", "Note", "Description") || ""),
    }))
    .map((row, idx, arr) => {
      const prevPool = idx > 0 ? n(arr[idx - 1].pool) : 0;
      const poolDelta = idx > 0 ? n(row.pool) - prevPool : n(row.rawInvested);
      const isWithdrawal = /withdr|withdrawal|withdrawn|redeem|redeemed|payout/i.test(row.remark);
      const normalizedInvested = row.rawInvested !== 0
        ? (isWithdrawal ? -Math.abs(row.rawInvested) : row.rawInvested)
        : poolDelta;
      return {
        date: row.date,
        invested: normalizedInvested,
        pool: row.pool,
        remark: row.remark,
      };
    });

  const parseMonthlySheetRows = (rows, tabName) => {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const inferTabFromDate = (value) => {
      const parsed = parseDateValue(value);
      if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return "";
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${monthNames[parsed.getMonth()]}-${String(parsed.getFullYear()).slice(-2)}`;
    };

    // Old HTML dashboard format: raw 2D arrays with fixed columns.
    if (Array.isArray(rows[0])) {
      let headerIndex = -1;
      for (let i = 0; i < Math.min(rows.length, 35); i += 1) {
        const row = rows[i] || [];
        const headerCell = String(row[oldCols.id] || "").trim().toLowerCase();
        if (headerCell === "loan id") {
          headerIndex = i;
          break;
        }
      }
      if (headerIndex < 0) return [];

      return rows.slice(headerIndex + 1).map(row => {
        if (!Array.isArray(row) || row.length < 10) return null;
        const rawId = String(row[oldCols.id] || "").trim().toUpperCase();
        if (!rawId.includes("LOA")) return null;
        const numAt = key => parseFloat(String(row[oldCols[key]] || "").replace(/[₹,\s]/g, "")) || 0;
        const strAt = key => String(row[oldCols[key]] || "").trim();
        return {
          tab: tabName,
          id: rawId,
          rate: numAt("rate"),
          tenure: parseInt(String(row[oldCols.tenure] || ""), 10) || 0,
          score: parseInt(String(row[oldCols.score] || ""), 10) || 0,
          disbDate: strAt("disburseDate"),
          amount: numAt("amount"),
          status: strAt("status").toUpperCase(),
          totalRepay: numAt("totalRepay"),
          repayStart: strAt("repayStart"),
          principalRecv: numAt("principalRecv"),
          interestRecv: numAt("interestRecv"),
          fee: numAt("fee"),
          totalRecv: numAt("totalRecv"),
          pl: numAt("pl"),
          dpd: numAt("dpd"),
          npa: numAt("npa"),
          closure: strAt("closureDate") || "-",
          expectedClose: "",
        };
      }).filter(Boolean);
    }

    // Fallback for normalized object rows.
    return rows
      .filter(r => hasField(r, "Loan ID", "ID", "Loan Account", "Loan Account No", "Account"))
      .map(r => {
        const inv = num(getField(r, "Amount", "Invested Amount", "Principal", "Loan Amount"));
        const recv = num(getField(r, "Total Recv", "Total Received", "Received"));
        const explicitTab = String(getField(r, "Tab", "Batch", "Month") || "").trim();
        const disbDate = String(getField(r, "Disb Date", "Disbursement Date", "Date") || "");
        const normalizedTabName = String(tabName || "").trim();
        const inferredTab = explicitTab
          || (monthTabPattern.test(normalizedTabName) ? normalizedTabName : "")
          || inferTabFromDate(disbDate);
        return {
          tab: inferredTab,
          id:String(getField(r, "Loan ID", "ID", "Loan Account", "Loan Account No", "Account") || "").toUpperCase(),
          rate:num(getField(r, "Rate", "Rate%", "Interest Rate")),
          tenure:num(getField(r, "Tenure", "Duration", "Months")),
          score:num(getField(r, "Score", "Credit Score", "CIBIL")),
          disbDate,
          amount:inv,
          status:String(getField(r, "Status", "Loan Status") || "").toUpperCase(),
          totalRepay:num(getField(r, "Total Repay", "Total Repayment", "Repayment Amount", "Maturity Amount", "Total Due")),
          repayStart:String(getField(r, "Repay Start", "Repayment Start", "EMI Start", "Start Date") || ""),
          principalRecv:num(getField(r, "Principal Recv", "Principal Received", "Principal Collected")),
          interestRecv:num(getField(r, "Interest Recv", "Interest Received", "Interest Earned")),
          fee:num(getField(r, "Fee", "Fees")),
          totalRecv:recv,
          pl:num(getField(r, "P&L", "Profit", "Net P&L")) || (recv-inv),
          dpd:num(getField(r, "DPD", "Days Past Due")),
          npa:num(getField(r, "NPA")),
          closure:String(getField(r, "Closure", "Closure Date", "Closed On") || "-"),
          expectedClose:String(getField(r, "Expected Close", "Expected Closure", "Due Date", "Maturity Date", "End Date") || ""),
        };
      });
  };

  const monthLoanSources = Object.entries(sheets)
    .filter(([name, rows]) => Array.isArray(rows) && rows.length > 0 && monthTabPattern.test(String(name || "").trim()))
    .sort((a, b) => lendenTabKey(a[0]) - lendenTabKey(b[0]));

  const monthlyLoans = monthLoanSources.flatMap(([name, rows]) => parseMonthlySheetRows(rows, name));
  const sampleLoans = loanSheet?.length ? parseMonthlySheetRows(loanSheet, Object.keys(sheets).find(k => sheets[k] === loanSheet) || "Loan Samples") : [];
  const allRawLoans = [...monthlyLoans, ...sampleLoans];

  const dedupedLoanMap = new Map();
  const sourceLoans = allRawLoans.length > 0 ? allRawLoans : sampleLoans;
  sourceLoans
    .sort((a, b) => lendenTabKey(a.tab) - lendenTabKey(b.tab))
    .forEach(loan => {
      const key = normalizeLookupKey(loan.id);
      if (key) dedupedLoanMap.set(key, loan);
    });
  const loanSamples = [...dedupedLoanMap.values()];

  const totalPooledFromSummary = num(getField(summaryMeta,
    "Closing Pool",
    "Total Pool",
    "Current Pool",
    "Pool",
    "Outstanding"
  ));

  const lastClosingPool = monthSummary.length > 0 ? monthSummary[monthSummary.length-1].closingPool : 0;
  const txPool = transactions.length > 0 ? n(transactions[transactions.length-1].pool) : 0;
  const tabOutstanding = tabSummary.reduce((s,t)=>s+t.outstanding,0);
  const totalPooled = lastClosingPool || totalPooledFromSummary || txPool || tabOutstanding;

  const reportedTotalLoans = num(getField(summaryMeta, "Total Loans", "Loans", "Loan Count", "Total Loan Count"));
  const reportedClosedLoans = num(getField(summaryMeta, "Closed Loans", "Loans Closed", "Total Closed", "Closed Count"));
  const reportedActiveLoans = num(getField(summaryMeta, "Active Loans", "Open Loans", "Live Loans"));
  const reportedPendingLoans = num(getField(summaryMeta, "Pending Loans", "Ongoing Loans", "Loans Pending"));
  const reportedOverdueLoans = num(getField(summaryMeta, "Overdue Loans", "NPA Loans", "Default Loans"));

  return {
    totalPooled,
    monthSummary,
    tabSummary,
    transactions,
    monthlyLoanRows: allRawLoans,
    loanSamples,
    reportedTotalLoans,
    reportedClosedLoans,
    reportedActiveLoans,
    reportedPendingLoans,
    reportedOverdueLoans,
  };
}

/** Principal lent for dashboard totals — must NOT use loose getField(..., "Amount") (matches "Amount Paid", "Principal Received", etc.). */
function getBorrowerPrincipalLent(row) {
  if (!row || typeof row !== "object") return 0;
  const nk = (k) => normalizeLookupKey(k);
  const rejectKey = (keyNorm) =>
    /received|repayment|repaid|paid|payment|refund|emi|interest\s*accrued|interest\s*received|pending|cumulative|total\s*received|principal\s*received|amount\s*paid|total\s*paid|balance\s*remaining|outstanding|closing|opening/i.test(
      keyNorm
    );
  const entries = Object.entries(row).filter(([, v]) => v !== "" && v != null);

  const tryPatterns = (patterns) => {
    for (const re of patterns) {
      for (const [k, v] of entries) {
        const keyNorm = nk(k);
        if (!keyNorm || rejectKey(keyNorm)) continue;
        if (re.test(keyNorm)) return num(v);
      }
    }
    return null;
  };

  let v =
    tryPatterns([/^amount\s*lent/, /^loan\s*amount/, /^principal\s*lent/, /^principal$/]) ??
    tryPatterns([/amount\s*lent/, /loan\s*amount/]);
  if (v != null && v > 0) return v;

  for (const [k, val] of entries) {
    const keyNorm = nk(k);
    if (keyNorm === "amount" && !rejectKey(keyNorm)) return num(val);
  }

  return num(getField(row, "Amount Lent", "Loan Amount", "Principal Lent"));
}

/** Repayment log payment column — avoid getField(..., "Payment") matching "Mode of Payment" first (→ UPI → 0 → wrong monthly fallback). */
function getRepaymentPaymentAmount(row) {
  if (!row || typeof row !== "object") return 0;
  const nk = (k) => normalizeLookupKey(k);
  const skipKey = (kn) =>
    /date|borrower|name|type|notes|month|balance|remaining|outstanding|status|^id$|loan|lent|principal|interest\s*accrued|pending/i.test(kn) ||
    /mode\s*of\s*payment|payment\s*mode/i.test(kn);
  const entries = Object.entries(row).filter(([, v]) => v !== "" && v != null);

  const tryRes = (patterns) => {
    for (const re of patterns) {
      for (const [k, v] of entries) {
        const kn = nk(k);
        if (!kn || skipKey(kn)) continue;
        if (re.test(kn)) return num(v);
      }
    }
    return null;
  };

  let v = tryRes([/^payment\s*amount/, /^amount\s*paid/, /^paid\s*amount/, /^received\s*amount/, /^credit\s*amount/]);
  if (v != null && v > 0) return v;

  // Canonical "Amount" only if numeric (Apps Script used to map "Mode of Payment" → Amount → "UPI" overwrote ₹).
  for (const [k, val] of entries) {
    const kn = nk(k);
    if (skipKey(kn)) continue;
    if (kn === "amount" && num(val) > 0) return num(val);
  }

  for (const [k, val] of entries) {
    const kn = nk(k);
    if (skipKey(kn)) continue;
    if (kn === "payment" && !/mode/i.test(k)) return num(val);
  }

  return num(getField(row, "Payment Amount", "Amount Paid", "Payment Amount (₹)"));
}

function mapPersonalLendingData(raw) {
  const sheets    = raw?.personalLending || {};
  const bSheet    = findSheet(sheets, ["Borrower","Personal Lending","Lending"]);
  const repSheet  = findSheet(sheets, ["Repayment Log", "Repayment", "Payment"]);

  const rawBorrowers = (bSheet||[])
    .filter((r) => {
      if (!hasField(r, "Name", "Borrower Name")) return false;
      const name = String(getField(r, "Name", "Borrower Name") || "").trim();
      if (!name) return false;
      if (/^(total|totals|grand|sum|subtotal)\b/i.test(name)) return false;
      if (/^how\s+to|^step\s*\d|^borrower\s*quick/i.test(name)) return false;
      return true;
    })
    .map((r) => {
    const name    = String(getField(r, "Name", "Borrower Name") || "");
    const amount  = getBorrowerPrincipalLent(r);
    let   rate    = num(getField(r, "Rate", "Rate/Mo"));
    if (rate > 0 && rate <= 1) rate = +(rate*100).toFixed(2);
    const rateD   = rate/100;
    const monthly = num(getField(r, "Monthly Int", "Monthly Interest")) || +(amount*rateD).toFixed(2);
    const rawLoanStatus = String(getField(r, "Loan Status", "Status") || "Active").trim();
    const loanStatus = rawLoanStatus || "Active";
    return {
      id:num(getField(r, "ID", "#")),
      name,
      phone:String(getField(r, "Phone") || ""),
      amount,
      rate,
      dateLent:String(getField(r, "Date Lent", "Date") || ""),
      duration:num(getField(r, "Duration", "Tenure")) || 12,
      monthlyInt:monthly,
      monthsElapsed:num(getField(r, "Months Elapsed", "Elapsed")),
      interestAccrued:num(getField(r, "Interest Accrued", "Accrued")),
      interestReceived:num(getField(r, "Interest Received", "Received")),
      pendingInt:num(getField(r, "Pending Int", "Pending")),
      status:String(getField(r, "Status") || ""),
      loanStatus,
      notes:String(getField(r, "Notes") || ""),
      isActiveLoan: !/closed|inactive|completed|settled|returned|done/i.test(loanStatus),
    };
  });

  const borrowerMonthlyMap = rawBorrowers.reduce((acc, borrower) => {
    acc[normalizeLookupKey(borrower.name)] = borrower.monthlyInt;
    return acc;
  }, {});

  const repaymentLog = (repSheet||[]).filter(r=>hasRepaymentLogDateCell(r)).map(r=>{
    const borrower = String(getField(r, "Borrower", "Name", "Borrower Name") || "");
    const type = String(getField(r, "Type", "Payment Type") || "Interest");
    let amount = getRepaymentPaymentAmount(r);
    if (amount <= 0 && /interest/i.test(type || "Interest")) {
      amount = num(borrowerMonthlyMap[normalizeLookupKey(borrower)]);
    }
    return {
      date:String(getField(r, "Date") || ""), borrower,
      amount,
      type,
      balance:num(getField(r, "Balance", "Balance Remaining")),
      monthsPaid:num(getField(r, "Months Paid", "Month No.")),
      notes:String(getField(r, "Notes") || ""), mode:String(getField(r, "Mode", "Payment Mode") || "UPI"),
    };
  });

  const repaymentStats = repaymentLog.reduce((acc, entry) => {
    const borrowerKey = normalizeLookupKey(entry.borrower);
    if (!borrowerKey) return acc;

    const bucket = acc[borrowerKey] || { interestReceived:0, repaymentCount:0, monthsPaidMax:0 };
    if (/interest/i.test(entry.type || "Interest")) {
      bucket.interestReceived += num(entry.amount);
      bucket.repaymentCount += 1;
      bucket.monthsPaidMax = Math.max(bucket.monthsPaidMax, num(entry.monthsPaid));
    }
    acc[borrowerKey] = bucket;
    return acc;
  }, {});

  const borrowers = rawBorrowers.map(b=>{
    const borrowerStats = repaymentStats[normalizeLookupKey(b.name)] || {};
    const elapsed = Math.max(
      num(b.monthsElapsed),
      num(borrowerStats.monthsPaidMax),
      num(borrowerStats.repaymentCount)
    );
    const accrued = num(b.interestAccrued) || +(b.monthlyInt*elapsed).toFixed(2);
    const recv    = Math.max(
      num(b.interestReceived),
      num(borrowerStats.interestReceived)
    );
    return { ...b,
      monthsElapsed:elapsed,
      interestAccrued:accrued, interestReceived:recv,
      pendingInt:num(b.pendingInt)||Math.max(0,accrued-recv),
    };
  });

  const datedRepayments = repaymentLog
    .map(entry => ({ ...entry, parsedDate: parseDateValue(entry.date) }))
    .filter(entry => entry.parsedDate);

  let receivedThisMonth = 0;
  let receivedMonthLabel = "";
  if (datedRepayments.length > 0) {
    const latestDate = datedRepayments.reduce((max, entry) => entry.parsedDate > max ? entry.parsedDate : max, datedRepayments[0].parsedDate);
    receivedMonthLabel = latestDate.toLocaleDateString("en-IN", { month:"short", year:"numeric" });
    receivedThisMonth = datedRepayments
      .filter(entry =>
        entry.parsedDate.getMonth() === latestDate.getMonth() &&
        entry.parsedDate.getFullYear() === latestDate.getFullYear() &&
        /interest/i.test(entry.type || "Interest")
      )
      .reduce((sum, entry) => sum + entry.amount, 0);
  }

  const alerts = [];
  borrowers.forEach(b => {
    if (/not paying|no pay/i.test(b.status) && b.pendingInt>0)
      alerts.push("⚠ "+b.name+" has paid ₹0 so far — follow up immediately");
    if (/irregular/i.test(b.status) && b.pendingInt>0)
      alerts.push("⚠ "+b.name+" is irregular — ₹"+b.pendingInt.toLocaleString("en-IN")+" pending");
  });

  return {
    totalCapital:    borrowers.reduce((s,b)=>s+b.amount,0),
    monthlyInterest: borrowers.filter(b=>b.isActiveLoan).reduce((s,b)=>s+b.monthlyInt,0),
    annualInterest:  borrowers.filter(b=>b.isActiveLoan).reduce((s,b)=>s+b.monthlyInt,0)*12,
    receivedTillNow: borrowers.reduce((s,b)=>s+b.interestReceived,0),
    pendingInterest: borrowers.reduce((s,b)=>s+b.pendingInt,0),
    totalBorrowers:  borrowers.length,
    activeBorrowers: borrowers.filter(b=>b.isActiveLoan).length,
    regularPayers:   borrowers.filter(b=>/regular/i.test(b.status)).length,
    irregularPayers: borrowers.filter(b=>/irregular/i.test(b.status)).length,
    notPaying:       borrowers.filter(b=>/not paying|no pay/i.test(b.status)).length,
    receivedThisMonth,
    receivedMonthLabel,
    borrowers, repaymentLog, alerts,
  };
}

function reconcileIncomeWithPersonalLending(incomeData, personalLendingData) {
  if (!incomeData || !personalLendingData) return incomeData;

  const fallbackLending = num(personalLendingData.receivedThisMonth);
  if (num(incomeData.income?.lendingInterest) > 0 || fallbackLending <= 0) return incomeData;

  const nextIncome = {
    ...incomeData.income,
    lendingInterest: fallbackLending,
  };
  const recomputedGross = num(nextIncome.salary) + num(nextIncome.tutoring) + num(nextIncome.lendingInterest) + num(nextIncome.otherIncome);
  if (recomputedGross > num(nextIncome.grossTotal)) nextIncome.grossTotal = recomputedGross;

  const nextHistory = [...(incomeData.salaryHistory || [])];
  if (nextHistory.length > 0) {
    const targetMonth = normalizeLookupKey(nextIncome.month);
    let targetIndex = nextHistory.length - 1;
    if (targetMonth) {
      for (let i = nextHistory.length - 1; i >= 0; i -= 1) {
        if (normalizeLookupKey(nextHistory[i].month) === targetMonth) {
          targetIndex = i;
          break;
        }
      }
    }
    if (targetIndex >= 0 && num(nextHistory[targetIndex].lendingInterest) <= 0) {
      const updatedRow = {
        ...nextHistory[targetIndex],
        lendingInterest: fallbackLending,
      };
      const recomputedTotal = num(updatedRow.salary) + num(updatedRow.tutoring) + num(updatedRow.lendingInterest) + num(updatedRow.otherIncome);
      if (recomputedTotal > num(updatedRow.totalIncome)) updatedRow.totalIncome = recomputedTotal;
      nextHistory[targetIndex] = updatedRow;
    }
  }

  return {
    ...incomeData,
    income: nextIncome,
    salaryHistory: nextHistory,
  };
}

function mapRealEstateData(raw) {
  const sheets   = raw?.realEstate || {};
  const propSheet= findSheet(sheets, ["Property Detail","Real Estate","Property","Land"]);
  const emiSheet = findSheet(sheets, ["EMI Schedule","EMI","Payment Schedule"]);
  const valSheet = findSheet(sheets, ["Valuation","RE Valuation"]);

  // Try key-value layout first, then row layout
  let re = {};
  if (propSheet && propSheet.length > 0) {
    const first = propSheet[0];
    const keys  = Object.keys(first);
    // Key-value: first column is label, second is value
    if (keys.length === 2 && (keys[0].toLowerCase().includes("field") || keys[0] === "")) {
      const kv = {};
      propSheet.forEach(r => { if (r[keys[0]]) kv[String(r[keys[0]]).trim()] = r[keys[1]]; });
      re = {
        name:             String(kv["Name"]||kv["Property Name"]||""),
        location:         String(kv["Location"]||kv["Address"]||""),
        size:             String(kv["Size"]||kv["Area"]||""),
        totalCost:        num(kv["Total Cost"]||kv["Cost"]),
        paid:             num(kv["Amount Paid"]||kv["Paid"]),
        remaining:        num(kv["Balance"]||kv["Remaining"]||kv["Balance Remaining"]),
        totalInvestment:  num(kv["Total Investment"]||kv["Investment"]),
        status:           String(kv["Status"]||""),
        purchaseDate:     String(kv["Purchase Date"]||kv["Date"]||""),
        builder:          String(kv["Builder"]||""),
        docStatus:        String(kv["Doc Status"]||kv["Documents"]||""),
        emisPaid:         num(kv["EMIs Paid"]||0),
        emisPending:      num(kv["EMIs Pending"]||kv["Pending EMIs"]||0),
        appreciationRate: num(kv["Appreciation Rate"]||kv["Appreciation"]||8),
        registrationCharges: num(kv["Registration Charges"]||kv["Reg Charges"]||0),
      };
    } else {
      // Row layout
      re = {
        name:             String(first["Name"]||first["Property Name"]||""),
        location:         String(first["Location"]||first["Address"]||""),
        size:             String(first["Size"]||first["Area"]||""),
        totalCost:        num(first["Total Cost"]||first["Cost"]),
        paid:             num(first["Amount Paid"]||first["Paid"]),
        remaining:        num(first["Balance"]||first["Remaining"]),
        totalInvestment:  num(first["Total Investment"]||first["Investment"]),
        status:           String(first["Status"]||""),
        purchaseDate:     String(first["Purchase Date"]||first["Date"]||""),
        builder:          String(first["Builder"]||""),
        docStatus:        String(first["Doc Status"]||first["Documents"]||""),
        emisPaid:         num(first["EMIs Paid"]||0),
        emisPending:      num(first["EMIs Pending"]||first["Pending EMIs"]||0),
        appreciationRate: num(first["Appreciation Rate"]||first["Appreciation"]||8),
        registrationCharges: num(first["Registration Charges"]||0),
      };
    }
  }

  re.emiSchedule = (emiSheet||[]).filter(r=>hasField(r, "Due Date", "#", "Date")).map(r=>({
    no:      num(getField(r, "#", "no", "EMI No.")),
    dueDate: String(getField(r, "Due Date", "Date") || ""),
    emiAmt:  num(getField(r, "EMI Amount", "EMI")),
    paid:    num(getField(r, "Amount Paid", "Paid")),
    balance: num(getField(r, "Outstanding Balance", "Balance", "Outstanding")),
    status:  String(getField(r, "Status") || "⏳ Pending"),
    daysLate:String(getField(r, "Days Late/Early") || "—"),
    receipt: String(getField(r, "Receipt No.") || "—"),
  }));

  re.valuation = (valSheet||[]).filter(r=>hasField(r, "Year")).map(r=>({
    year:          num(getField(r, "Year")),
    marketValue:   num(getField(r, "Market Value", "market_value"))||null,
    totalInvested: num(getField(r, "Total Invested", "Invested")),
    unrealisedGain:num(getField(r, "Unrealised Gain", "unrealised_gain"))||null,
    gainP:         num(getField(r, "Gain%", "Gain %", "gain_pct"))||null,
  }));

  return re;
}

// Master mapper — converts central API response → dashboard data shape
function mapApiResponse(raw) {
  try {
    const payload = unwrapCentralPayload(raw);
    const personalLendingData = mapPersonalLendingData(payload);
    const incomeData = reconcileIncomeWithPersonalLending(mapIncomeData(payload), personalLendingData);
    const mapped = {
      income:          incomeData.income,
      budget:          incomeData.budget,
      dailyExpenses:   incomeData.dailyExpenses,
      taxLog:          incomeData.taxLog,
      salaryHistory:   incomeData.salaryHistory,
      stocks:          mapStocksData(payload),
      loans:           mapLoansData(payload),
      lendenClub:      mapLendenClubData(payload),
      personalLending: personalLendingData,
      realEstate:      mapRealEstateData(payload),
      settings:        SEED.settings,
    };
    return hasUsableMappedData(mapped) ? mapped : null;
  } catch(err) {
    console.error("mapApiResponse error:", err);
    return null;
  }
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────
const SEED = {
  income: {
    month:"Mar-26", year:2026, age:30,
    salary:95651, tutoring:0, lendingInterest:0, otherIncome:0, taxRefunded:0,
    grossTotal:95651, taxDeducted:0, netIncome:95651,
    creditCardBills:24478, hdfcEmi:42318, idfcEmi:7572, sbiEmi:2500,
    totalEmi:52390, inHand:18643,
    personalLending:0, lendenClub:140, equityStocks:0, mutualFunds:0,
  },
  budget: {
    food:6000, transport:3000, utilities:2000, medical:2000,
    entertainment:1500, shopping:2000, education:2000, fuel:1500, grooming:1000, misc:2000,
    actual:{ food:5000, transport:120, utilities:1800, medical:3000,
             entertainment:299, shopping:0, education:0, fuel:1200, grooming:0, misc:0 }
  },
  dailyExpenses: [
    { date:"01-Mar-26", category:"Food",          desc:"Morning chai + breakfast", amount:0,     mode:"UPI",           tag:"Essential" },
    { date:"02-Mar-26", category:"Transport",     desc:"Ola to office",            amount:120,   mode:"UPI",           tag:"Lifestyle" },
    { date:"03-Mar-26", category:"Food",          desc:"Lunch",                    amount:0,     mode:"Cash",          tag:"Essential" },
    { date:"04-Mar-26", category:"Entertainment", desc:"Netflix monthly",          amount:299,   mode:"Auto-Debit",    tag:"Lifestyle" },
    { date:"05-Mar-26", category:"Utilities",     desc:"Electricity bill",         amount:1800,  mode:"Bank Transfer", tag:"Fixed"     },
    { date:"06-Mar-26", category:"Food",          desc:"Weekly groceries",         amount:5000,  mode:"UPI",           tag:"Essential" },
    { date:"07-Mar-26", category:"Fuel",          desc:"Petrol",                   amount:1200,  mode:"UPI",           tag:"Essential" },
    { date:"08-Mar-26", category:"EMI/Loan",      desc:"Land EMI — Tricolour",     amount:12000, mode:"Auto-Debit",    tag:"Fixed"     },
    { date:"09-Mar-26", category:"Medical",       desc:"Health insurance premium", amount:3000,  mode:"Auto-Debit",    tag:"Fixed"     },
  ],
  taxLog: [
    { fy:"FY26-27", age:30, grossIncome:95651, deductions:0, taxableIncome:95651, taxLiability:0, tds:0, selfAssessment:0, effectiveRate:0, regime:"New" },
  ],
  settings: {
    name:"Naresh Sagar", birthYear:1996, city:"Hyderabad", currency:"INR (₹)",
    salaryGrowth:10, foodInflation:7, medicalInflation:10, fuelInflation:6,
    portfolioCAGR:12, realEstateAppreciation:8, personalLendingReturn:24, lendenNetReturn:10,
  },
  salaryHistory: [
    { month:"Apr-25", salary:82000, tutoring:0, lendingInterest:0, otherIncome:0, totalIncome:82000, expenses:62000, savings:20000 },
    { month:"May-25", salary:82000, tutoring:2000, lendingInterest:0, otherIncome:0, totalIncome:84000, expenses:65000, savings:19000 },
    { month:"Jun-25", salary:82000, tutoring:2000, lendingInterest:0, otherIncome:0, totalIncome:84000, expenses:58000, savings:26000 },
    { month:"Jul-25", salary:85000, tutoring:0, lendingInterest:0, otherIncome:5000, totalIncome:90000, expenses:70000, savings:20000 },
    { month:"Aug-25", salary:85000, tutoring:3000, lendingInterest:0, otherIncome:0, totalIncome:88000, expenses:66000, savings:22000 },
    { month:"Sep-25", salary:85000, tutoring:3000, lendingInterest:0, otherIncome:0, totalIncome:88000, expenses:68000, savings:20000 },
    { month:"Oct-25", salary:88000, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:101000, expenses:72000, savings:29000 },
    { month:"Nov-25", salary:88000, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:101000, expenses:75000, savings:26000 },
    { month:"Dec-25", salary:88000, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:101000, expenses:80000, savings:21000 },
    { month:"Jan-26", salary:92000, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:105000, expenses:78000, savings:27000 },
    { month:"Feb-26", salary:92000, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:105000, expenses:76000, savings:29000 },
    { month:"Mar-26", salary:95651, tutoring:0, lendingInterest:13000, otherIncome:0, totalIncome:108651, expenses:74000, savings:34651 },
  ],
  stocks: {
    mutualFunds: [
      { name:"Nifty 50 Index Fund",   amc:"UTI/HDFC", type:"Index",   mode:"SIP", startDate:"01-Jan-25", invested:5000,  current:5200,  units:80,  nav:65,  returns:200,  returnsP:4.0,  xirr:null, status:"Active" },
      { name:"Mid Cap Momentum Fund", amc:"Motilal",  type:"Mid Cap", mode:"SIP", startDate:"01-Feb-25", invested:5000,  current:5400,  units:50,  nav:108, returns:400,  returnsP:8.0,  xirr:null, status:"Active" },
      { name:"ELSS Tax Saver",        amc:"Axis",     type:"ELSS",    mode:"SIP", startDate:"01-Jan-24", invested:12000, current:14000, units:120, nav:116, returns:2000, returnsP:16.67,xirr:null, status:"Active" },
    ],
    equity: [
      { symbol:"RELIANCE", company:"Reliance Industries", exchange:"NSE", buyDate:"01-Jan-25", qty:10, avgBuy:2800, invested:28000, cmp:3000, current:30000, pl:2000, plP:7.14, sector:"Energy"  },
      { symbol:"TCS",      company:"Tata Consultancy",   exchange:"NSE", buyDate:"01-Feb-25", qty:5,  avgBuy:3800, invested:19000, cmp:4100, current:20500, pl:1500, plP:7.89, sector:"IT"      },
      { symbol:"HDFCBANK", company:"HDFC Bank",           exchange:"NSE", buyDate:"15-Mar-25", qty:20, avgBuy:1700, invested:34000, cmp:1800, current:36000, pl:2000, plP:5.88, sector:"Banking" },
    ],
    options: [
      { date:"01-Mar-26", index:"NIFTY",     type:"CE", strike:22500, expiry:"27-Mar-26", lots:1, buyPremium:80,  sellPremium:150, lotSize:50, grossPL:3500,  brokerage:40, netPL:3460,  status:"Closed", notes:"Trend trade" },
      { date:"05-Mar-26", index:"BANKNIFTY", type:"PE", strike:48000, expiry:"27-Mar-26", lots:1, buyPremium:120, sellPremium:80,  lotSize:15, grossPL:-600,  brokerage:40, netPL:-640,  status:"Closed", notes:"Hedge"       },
    ],
    crypto: [
      { coin:"Bitcoin",  symbol:"BTC", exchange:"WazirX",  buyDate:"01-Jan-25", qty:0.01, buyPrice:5500000, invested:55000, currentPrice:6000000, current:60000, pl:5000, plP:9.09,  wallet:"WazirX"  },
      { coin:"Ethereum", symbol:"ETH", exchange:"CoinDCX", buyDate:"15-Feb-25", qty:0.1,  buyPrice:250000,  invested:25000, currentPrice:280000,  current:28000, pl:3000, plP:12.00, wallet:"CoinDCX" },
    ],
    summary:{ mf:{invested:22000,current:24600,pl:2600}, equity:{invested:81000,current:86500,pl:5500}, options:{invested:200,current:2820,pl:2620}, crypto:{invested:80000,current:88000,pl:8000}, total:{invested:183200,current:201920,pl:18720} },
  },
  loans: {
    hdfc:{ name:"HDFC", emi:42318, outstanding:2170237.49, paid:4, total:72, originalLoan:2262634, interestRate:10.5,
      schedule:[
        { no:1, date:"07-Nov-25", emi:42318, principal:22802.42, interest:19515.22, balance:2239831.58, status:"paid" },
        { no:2, date:"07-Dec-25", emi:42318, principal:22999.09, interest:19318.55, balance:2216832.49, status:"paid" },
        { no:3, date:"07-Jan-26", emi:42318, principal:23197.46, interest:19120.18, balance:2193635.03, status:"paid" },
        { no:4, date:"07-Feb-26", emi:42318, principal:23397.54, interest:18920.10, balance:2170237.49, status:"paid" },
        { no:5, date:"07-Mar-26", emi:42318, principal:23599.34, interest:18718.30, balance:2146638.15, status:""     },
        { no:6, date:"07-Apr-26", emi:42318, principal:23802.89, interest:18514.75, balance:2122835.26, status:""     },
      ],
      totalPrincipalPaid:92396.51, totalInterestPaid:76874.05 },
    idfc:{ name:"IDFC", emi:7572, outstanding:263000.38, paid:18, total:60, originalLoan:345565, interestRate:13.5,
      schedule:[
        { no:16, date:"12-Mar-25", emi:7572, principal:4976.17, interest:2595.83, balance:278204.27, status:"Paid" },
        { no:17, date:"01-Mar-26", emi:7572, principal:5021.79, interest:2550.21, balance:273182.48, status:"Paid" },
        { no:18, date:"02-Mar-26", emi:7572, principal:5067.82, interest:2504.18, balance:268114.66, status:"Paid" },
        { no:19, date:"03-Mar-26", emi:7572, principal:5114.28, interest:2457.72, balance:263000.38, status:"Paid" },
        { no:20, date:"04-Mar-26", emi:7572, principal:5161.16, interest:2410.84, balance:257839.22, status:""     },
        { no:21, date:"05-Mar-26", emi:7572, principal:5208.47, interest:2363.53, balance:252630.75, status:""     },
      ],
      totalPrincipalPaid:82564.62, totalInterestPaid:53771.38 },
    sbi:{ name:"SBI", emi:2500, outstanding:54809, paid:0, total:25, originalLoan:54809, interestRate:9.35,
      schedule:[
        { no:1,  date:"16-Apr-26", emi:2500,   principal:2075.23, interest:424.77, balance:52733.77, status:"" },
        { no:2,  date:"16-May-26", emi:2500,   principal:2091.31, interest:408.69, balance:50642.46, status:"" },
        { no:3,  date:"16-Jun-26", emi:2500,   principal:2107.52, interest:392.48, balance:48534.94, status:"" },
        { no:25, date:"16-Apr-28", emi:304.05, principal:301.71,  interest:2.34,   balance:0,        status:"" },
      ],
      totalInterestOnLoan:5495.05 },
  },
  personalLending: {
    totalCapital:750000, monthlyInterest:15000, annualInterest:180000,
    receivedTillNow:52000, pendingInterest:4000, totalBorrowers:2, activeBorrowers:2,
    regularPayers:1, irregularPayers:0, notPaying:1,
    borrowers:[
      { id:1, name:"Yadagiri",  phone:"9XXXXXXXXX", amount:650000, rate:2, dateLent:"14-Oct-25", duration:12, monthlyInt:13000, monthsElapsed:4, interestAccrued:52000, interestReceived:52000, pendingInt:0,    status:"✅ Regular",    loanStatus:"Active", notes:"Trusted friend" },
      { id:2, name:"KishanRao", phone:"9XXXXXXXXX", amount:100000, rate:2, dateLent:"12-Dec-25", duration:12, monthlyInt:2000,  monthsElapsed:2, interestAccrued:4000,  interestReceived:0,     pendingInt:4000, status:"⛔ Not Paying", loanStatus:"Active", notes:"Colleague"     },
    ],
    repaymentLog:[
      { date:"28-Nov-25", borrower:"Yadagiri", amount:13000, type:"Interest", balance:650000, monthsPaid:1, notes:"Month 1 interest", mode:"UPI" },
      { date:"25-Dec-25", borrower:"Yadagiri", amount:13000, type:"Interest", balance:650000, monthsPaid:2, notes:"Month 2 interest", mode:"UPI" },
      { date:"25-Jan-26", borrower:"Yadagiri", amount:13000, type:"Interest", balance:650000, monthsPaid:3, notes:"Month 3 interest", mode:"UPI" },
      { date:"27-Feb-26", borrower:"Yadagiri", amount:13000, type:"Interest", balance:650000, monthsPaid:4, notes:"Month 4 interest", mode:"UPI" },
    ],
    alerts:["⚠ KishanRao has paid ₹0 so far — follow up immediately","📅 Yadagiri's next payment is due around 27-Apr-26"],
  },
  lendenClub: {
    totalPooled:86028,
    monthSummary:[
      { month:"Dec-25", netInvested:3100,  closingPool:3100  },
      { month:"Jan-26", netInvested:13000, closingPool:16100 },
      { month:"Feb-26", netInvested:69928, closingPool:86028 },
      { month:"Mar-26", netInvested:0,     closingPool:86028 },
    ],
    tabSummary:[
      { tab:"Dec-25", disbursed:3000,  received:1206.11, principal:1055.90, interest:150.20, fee:20.37,  outstanding:1944.07,  npa:0, loans:12  },
      { tab:"Jan-26", disbursed:13750, received:4479.76, principal:3964.22, interest:516.61, fee:90.14,  outstanding:9785.79,  npa:0, loans:55  },
      { tab:"Feb-26", disbursed:73000, received:8642.71, principal:7828.81, interest:814.06, fee:161.80, outstanding:65171.29, npa:0, loans:290 },
      { tab:"Mar-26", disbursed:1250,  received:0.01,    principal:0.02,    interest:0,      fee:0,      outstanding:1249.99,  npa:0, loans:5   },
    ],
    transactions:[
      { date:"25-Dec-25", invested:3100,  pool:3100,  remark:"From Salary"            },
      { date:"25-Jan-26", invested:13000, pool:16100, remark:"Interest from Yadagiri" },
      { date:"01-Feb-26", invested:4000,  pool:20100, remark:"From salary"            },
      { date:"02-Feb-26", invested:7000,  pool:27100, remark:"From Ravi"              },
      { date:"06-Feb-26", invested:8940,  pool:36040, remark:"Insurance cancellation" },
      { date:"06-Feb-26", invested:-5000, pool:31040, remark:"Withdrawn"              },
      { date:"07-Feb-26", invested:20000, pool:51040, remark:"15K EPFO + 5K added"    },
      { date:"09-Feb-26", invested:5000,  pool:56040, remark:"Salary"                 },
      { date:"10-Feb-26", invested:3672,  pool:59712, remark:"Insurance cancellation" },
      { date:"10-Feb-26", invested:2748,  pool:62460, remark:"Insurance cancellation" },
      { date:"13-Feb-26", invested:3318,  pool:65778, remark:"Insurance cancellation" },
      { date:"13-Feb-26", invested:5750,  pool:71528, remark:"Insurance cancellation" },
      { date:"22-Feb-26", invested:1500,  pool:73028, remark:"Salary"                 },
      { date:"28-Feb-26", invested:13000, pool:86028, remark:"Yadagiri interest"      },
    ],
    loanSamples:[
      { tab:"Dec-25", id:"LOA-DXSLDYRC", rate:47.4,  tenure:3, score:716, disbDate:"26/12/25", amount:250, status:"CLOSED", principalRecv:250,    interestRecv:25.51, fee:2.50, totalRecv:275.51, pl:25.51, closure:"06/01/26" },
      { tab:"Jan-26", id:"LOA-841L8A28", rate:47.4,  tenure:4, score:716, disbDate:"25/01/26", amount:250, status:"CLOSED", principalRecv:250,    interestRecv:29.04, fee:5.75, totalRecv:279.04, pl:29.04, closure:"23/02/26" },
      { tab:"Jan-26", id:"LOA-CVGVJUVC", rate:47.76, tenure:4, score:712, disbDate:"25/01/26", amount:250, status:"CLOSED", principalRecv:250,    interestRecv:31.98, fee:5.75, totalRecv:281.97, pl:31.97, closure:"27/01/26" },
      { tab:"Dec-25", id:"LOA-7MSUCZLC", rate:46.2,  tenure:3, score:724, disbDate:"26/12/25", amount:250, status:"ACTIVE", principalRecv:166.67, interestRecv:18.86, fee:1.67, totalRecv:185.53, pl:0,     closure:"-"        },
      { tab:"Jan-26", id:"LOA-7KQ7CZ1H", rate:47.76, tenure:4, score:720, disbDate:"25/01/26", amount:250, status:"ACTIVE", principalRecv:62.5,   interestRecv:9.09,  fee:1.44, totalRecv:71.59,  pl:0,     closure:"-"        },
      { tab:"Feb-26", id:"LOA-4NMT3VP7", rate:48.0,  tenure:4, score:751, disbDate:"28/02/26", amount:250, status:"ACTIVE", principalRecv:0,      interestRecv:0,     fee:0,    totalRecv:0,      pl:0,     closure:"-"        },
    ],
  },
  realEstate: {
    name:"Tricolour Properties", location:"Hyderabad, Telangana", size:"100 sq. yards",
    totalCost:857500, paid:542500, remaining:315000, registrationCharges:0,
    totalInvestment:542500, status:"EMI Based", purchaseDate:"14-Jul-24",
    builder:"Tricolour Properties", docStatus:"In Progress",
    emisPaid:0, emisPending:30, appreciationRate:8,
    emiSchedule:[
      { no:1,  dueDate:"20-Apr-26", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:2,  dueDate:"20-Jun-26", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:3,  dueDate:"20-Aug-26", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:4,  dueDate:"20-Oct-26", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:5,  dueDate:"20-Dec-26", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:6,  dueDate:"20-Feb-27", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:7,  dueDate:"20-Apr-27", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:8,  dueDate:"20-Jun-27", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:9,  dueDate:"20-Aug-27", emiAmt:25000, paid:0, balance:315000, status:"⏳ Pending" },
      { no:10, dueDate:"29-Apr-26", emiAmt:12000, paid:0, balance:315000, status:"⏳ Pending" },
    ],
    valuation:[
      { year:2024, marketValue:null, totalInvested:857000, unrealisedGain:null, gainP:null },
      { year:2025, marketValue:null, totalInvested:1050000,unrealisedGain:null, gainP:null },
      { year:2026, marketValue:null, totalInvested:1050000,unrealisedGain:null, gainP:null },
    ],
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const n   = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
const fmt  = v => { v=n(v); const neg=v<0; const s=`₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`; return neg?`-${s}`:s; };
const fmtF = v => `₹${Math.round(n(v)).toLocaleString("en-IN")}`;
const pct  = (a,b) => b>0?Math.round((a/b)*100):0;
const addMonths = (d,m) => { const r=new Date(d); r.setMonth(r.getMonth()+m); return r; };
const fmtDate  = d => d.toLocaleDateString("en-IN",{month:"short",year:"numeric"});
const JSONP_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 15000;
const AUTO_SYNC_SECONDS = 300;

function parseDateValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const monthMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

  // 1. dd-MMM-yy  (e.g. "25-Jan-2026", "01 Feb 26")
  let match = raw.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[-\/ ](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = monthMap[match[2].toLowerCase()];
    let year = Number(match[3]);
    if (month != null) {
      if (year < 100) year += 2000;
      const date = new Date(year, month, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  // 2. dd/mm/yyyy  (Indian locale — day first, BEFORE new Date() which assumes US mm/dd)
  match = raw.match(/^(\d{1,2})[-\/ ](\d{1,2})[-\/ ](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 3. Fallback for ISO ("2026-01-25"), text ("January 25, 2026"), etc.
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  return null;
}

function diffMonthsBetweenDates(start, end) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || !(end instanceof Date) || Number.isNaN(end.getTime())) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (30 * msPerDay)));
}

function lendenTabKey(tab) {
  const raw = String(tab || "").trim();
  const match = raw.match(/^([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const monthIdx = monthMap[match[1].slice(0,1).toUpperCase() + match[1].slice(1,3).toLowerCase()];
  let year = Number(match[2]);
  if (year < 100) year += 2000;
  return year * 100 + (monthIdx ?? 0);
}

// ─── COLORS ──────────────────────────────────────────────────────────────────
const P = {
  gold:"#F5C542", emerald:"#10E8A0", ruby:"#FF5C7A", sapphire:"#4FC3F7",
  violet:"#B39DFF", teal:"#26C6AC", orange:"#FF9A3C", rose:"#F48FB1",
  bg:"#050D1A", card:"#0A1628", card2:"#0F1E36", card3:"#162340",
  border:"#1C3050", border2:"#243D64",
  text:"#D8EAF8", muted:"#4E6D8C", snow:"#F0F8FF",
  glass:"rgba(15,30,60,0.7)",
};
const CC = [P.gold,P.emerald,P.sapphire,P.violet,P.orange,P.teal,P.ruby,P.rose];

// ─── CORS-SAFE FETCH (JSONP-first — skips preflight entirely) ───────────────
// All Google Apps Script /exec endpoints block CORS preflight.
// JSONP injects a <script> tag which bypasses CORS entirely.
// Requires scripts to support ?callback=xxx  (see updated doGet wrappers below).
// Falls back to plain fetch() only if JSONP fails (e.g. CSP env).
function fetchJSONP(url, timeout=JSONP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cb      = `_gsc_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    let   settled = false;
    const done    = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); delete window[cb]; s?.remove(); fn(val); };
    const timer   = setTimeout(()=> done(reject, new Error("JSONP timeout")), timeout);
    window[cb]    = data => done(resolve, data);
    const s       = document.createElement("script");
    s.onerror     = ()=> done(reject, new Error("JSONP load error"));
    s.src         = `${url}${url.includes("?")?"&":"?"}callback=${cb}&t=${Date.now()}`;
    document.head.appendChild(s);
  });
}

function isHostedSandbox() {
  try {
    return /(claude\.ai|anthropic\.com)$/i.test(window.location.hostname);
  } catch(e) {
    return false;
  }
}

function explainSyncIssue(err, key="central") {
  const raw = String(err?.message || err || "Unknown error");
  const hosted = isHostedSandbox();

  if (hosted && (raw.includes("JSONP load error") || raw.includes("JSONP timeout") || raw.includes(`CORS_BLOCKED:${key}`) || raw.includes("CORS_BLOCKED"))) {
    return {
      status: "hosted",
      logStatus: "⚠ HOST",
      message: "Hosted page blocked the Google Apps Script request. Your API may be fine, but this Claude-hosted page likely blocks external script/fetch calls. Host the dashboard on Vercel/Netlify or use a same-origin proxy."
    };
  }

  if (raw.includes("load error")) {
    return {
      status: "cors",
      logStatus: "⚠ CORS",
      message: "Redirect to Google login or external script blocked. Set Apps Script access to 'Anyone', redeploy, and if this is hosted in Claude move it to Vercel/Netlify."
    };
  }

  if (raw.includes("timeout")) {
    return {
      status: hosted ? "hosted" : "cors",
      logStatus: hosted ? "⚠ HOST" : "⚠ TIME",
      message: hosted
        ? "Timed out while loading external script from this hosted page. This usually means the host sandbox/CSP blocked the request."
        : "Apps Script timed out. Check the deployment URL, script execution time, and response size."
    };
  }

  if (raw.includes("CORS_BLOCKED")) {
    return {
      status: hosted ? "hosted" : "cors",
      logStatus: hosted ? "⚠ HOST" : "⚠ CORS",
      message: hosted
        ? "JSONP failed and browser fetch was also blocked by the hosted page. Use Vercel/Netlify hosting or a backend proxy."
        : "Browser blocked direct fetch to Apps Script after JSONP failed. Check deployment access or use a backend proxy."
    };
  }

  return { status: "error", logStatus: "❌ ERR", message: raw };
}

async function fetchScript(key, url) {
  if (isSameOriginRequest(url)) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(withCacheBust(url), { signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP_${res.status}`);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(text || "Invalid JSON from proxy");
      }
    } finally {
      clearTimeout(tid);
    }
  }

  // ① Try JSONP first — works for all Apps Script endpoints without CORS issues
  try {
    return await fetchJSONP(url);
  } catch(e1) {
    // ② JSONP failed (e.g. strict CSP) — try plain fetch as last resort
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(()=>ctrl.abort(), FETCH_TIMEOUT_MS);
      const res  = await fetch(withCacheBust(url), { signal: ctrl.signal });
      clearTimeout(tid);
      return await res.json();
    } catch(e2) {
      throw new Error(`CORS_BLOCKED:${key}`);
    }
  }
}

// ─── DEEP MERGE (handles dynamic sheet columns) ──────────────────────────────
function deepMerge(target, source) {
  if (!source || typeof source !== "object") return source ?? target;
  if (Array.isArray(source)) return source;
  const r = { ...(target||{}) };
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k]==="object" && !Array.isArray(source[k]) && r[k] && typeof r[k]==="object" && !Array.isArray(r[k]))
      r[k] = deepMerge(r[k], source[k]);
    else r[k] = source[k];
  }
  return r;
}

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
function Card({ children, style={}, accent=null }) {
  return (
    <div className="card-hover" style={{
      background:`linear-gradient(145deg,${P.card},${P.card2})`,
      border:`1px solid ${P.border}`,
      borderTop: accent ? `3px solid ${accent}` : `1px solid ${P.border}`,
      borderRadius:16, padding:20,
      backdropFilter:"blur(12px)",
      boxShadow:`0 4px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)`,
      animation:"slideUp .35s ease both",
      ...style
    }}>{children}</div>
  );
}

function KPI({ label, value, sub, color=P.gold, icon, trend }) {
  return (
    <div style={{
      background:`linear-gradient(135deg,${P.card},${P.card2})`,
      border:`1px solid ${P.border}`, borderLeft:`3px solid ${color}`,
      borderRadius:14, padding:"18px 16px", position:"relative", overflow:"hidden",
      transition:"transform .15s,box-shadow .15s",
      boxShadow:`0 2px 12px rgba(0,0,0,.3)`,
    }}
      onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 28px rgba(0,0,0,.45), 0 0 0 1px ${color}33`;}}
      onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="0 2px 12px rgba(0,0,0,.3)";}}>
      <div style={{position:"absolute",top:-12,right:-8,fontSize:44,opacity:.06}}>{icon}</div>
      <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,textTransform:"uppercase",letterSpacing:2.5,color:P.muted,marginBottom:8}}>{label}</div>
      <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color,letterSpacing:-0.5,lineHeight:1}}>{value}</div>
      {sub && <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:6}}>{sub}</div>}
      {trend && <div style={{position:"absolute",top:14,right:14,fontSize:10,color:trend>0?P.emerald:P.ruby,fontWeight:700,fontFamily:"'Fira Code',monospace"}}>{trend>0?"↑":"↓"}{Math.abs(trend)}%</div>}
    </div>
  );
}

function GlassKPI({ label, value, sub, color=P.gold, icon }) {
  return (
    <div style={{
      background:`radial-gradient(ellipse at top left, ${color}14, transparent 60%), ${P.card2}`,
      border:`1px solid ${color}30`, borderRadius:18, padding:"22px 20px",
      position:"relative", overflow:"hidden",
      boxShadow:`0 0 30px ${color}15, 0 4px 20px rgba(0,0,0,.4)`,
    }}>
      <div style={{position:"absolute",bottom:-8,right:4,fontSize:52,opacity:.08}}>{icon}</div>
      <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,textTransform:"uppercase",letterSpacing:3,color:`${color}99`,marginBottom:10}}>{label}</div>
      <div style={{fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,color,lineHeight:1}}>{value}</div>
      {sub && <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:`${color}77`,marginTop:8}}>{sub}</div>}
    </div>
  );
}

function SectionHead({ title, icon, color=P.gold }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,marginTop:4}}>
      <span style={{fontSize:16}}>{icon}</span>
      <span style={{fontFamily:"'Syne',sans-serif",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase",color:P.muted}}>{title}</span>
      <div style={{flex:1,height:1,background:`linear-gradient(90deg,${color}55,transparent)`}}/>
    </div>
  );
}

function Pill({ children, color=P.gold }) {
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 9px",borderRadius:20,fontSize:10,fontFamily:"'Fira Code',monospace",background:`${color}18`,border:`1px solid ${color}44`,color}}>{children}</span>;
}

function TH({ children, left=false }) {
  return <th style={{padding:"10px 12px",fontFamily:"'Fira Code',monospace",fontSize:9,textTransform:"uppercase",letterSpacing:1.5,color:P.muted,background:`${P.card2}ee`,borderBottom:`1px solid ${P.border}`,textAlign:left?"left":"center",whiteSpace:"nowrap"}}>{children}</th>;
}
function TD({ children, color=P.text, left=false, bold=false, colSpan }) {
  return <td colSpan={colSpan} style={{padding:"10px 12px",fontFamily:"'Fira Code',monospace",fontSize:11,color,textAlign:left?"left":"center",whiteSpace:"nowrap",fontWeight:bold?700:400,borderBottom:`1px solid ${P.border}18`}}>{children}</td>;
}

function PBar({ value, max, color=P.gold, height=6 }) {
  const p = Math.min((n(value)/Math.max(n(max),1))*100,100);
  return (
    <div style={{background:P.border,borderRadius:99,height,overflow:"hidden"}}>
      <div style={{width:`${p}%`,height:"100%",background:`linear-gradient(90deg,${color},${color}bb)`,borderRadius:99,transition:"width .6s ease"}}/>
    </div>
  );
}

function DonutRing({ pct:p, color, size=100, stroke=10, label, sub }) {
  const r=(size-stroke*2)/2, circ=2*Math.PI*r, dash=(p/100)*circ;
  return (
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={P.border} strokeWidth={stroke}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{filter:`drop-shadow(0 0 4px ${color}88)`}}/>
      </svg>
      <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",textAlign:"center"}}>
        <div style={{fontFamily:"'Syne',sans-serif",fontSize:size>80?16:12,fontWeight:800,color,lineHeight:1}}>{label||`${Math.round(p)}%`}</div>
        {sub&&<div style={{fontSize:8,color:P.muted,marginTop:2}}>{sub}</div>}
      </div>
    </div>
  );
}

const CTip = ({ active, payload, label }) => active&&payload?.length?(
  <div style={{background:P.card3,border:`1px solid ${P.border2}`,borderRadius:10,padding:"10px 14px",boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}>
    <p style={{color:P.muted,fontSize:10,margin:"0 0 4px",fontFamily:"'Fira Code',monospace"}}>{label}</p>
    {payload.map((p,i)=><p key={i} style={{color:p.color||P.text,fontSize:12,fontWeight:600,margin:"2px 0",fontFamily:"'Fira Code',monospace"}}>{p.name}: {fmt(p.value)}</p>)}
  </div>
):null;

function SyncBadge({ status, lastSync }) {
  const cfg = {syncing:{color:P.gold,label:"Syncing…",anim:true},live:{color:P.emerald,label:"Live ✓",anim:false},error:{color:P.ruby,label:lastSync?"Using last good data":"Error",anim:false},idle:{color:P.muted,label:"Ready",anim:false},cors:{color:P.orange,label:lastSync?"Using last good data":"CORS — see tip",anim:false},hosted:{color:P.orange,label:lastSync?"Using last good data":"Host blocked — see tip",anim:false}}[status]||{};
  return (
    <div style={{display:"flex",alignItems:"center",gap:7,background:"rgba(255,255,255,.03)",borderRadius:20,padding:"5px 12px",border:`1px solid ${P.border}`}}>
      <div style={{width:7,height:7,borderRadius:"50%",background:cfg.color,animation:cfg.anim?"pulse 1s infinite":"none",boxShadow:cfg.anim?`0 0 8px ${cfg.color}`:""}}/>
      <span style={{color:cfg.color,fontSize:11,fontWeight:600,fontFamily:"'Fira Code',monospace"}}>{cfg.label}</span>
      {lastSync&&<span style={{color:P.muted,fontSize:9,fontFamily:"'Fira Code',monospace"}}>· last ok {lastSync}</span>}
    </div>
  );
}


// ─── MARKDOWN RENDERER ────────────────────────────────────────────────────────
function renderMD(text) {
  if (!text) return "";
  return text
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/\*\*\*(.+?)\*\*\*/g,"<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,"<em>$1</em>")
    .replace(/`(.+?)`/g,`<code style="background:#162340;padding:1px 5px;border-radius:4px;font-family:'Fira Code',monospace;font-size:0.9em">$1</code>`)
    .replace(/^### (.+)$/gm,"<div style='font-weight:700;font-size:13px;margin:10px 0 4px'>$1</div>")
    .replace(/^## (.+)$/gm,"<div style='font-weight:800;font-size:14px;margin:12px 0 4px'>$1</div>")
    .replace(/^# (.+)$/gm,"<div style='font-weight:800;font-size:15px;margin:12px 0 6px'>$1</div>")
    .replace(/^[-*] (.+)$/gm,"<div style='padding-left:14px'>• $1</div>")
    .replace(/^\d+\. (.+)$/gm,"<div style='padding-left:14px'>$1</div>")
    .replace(/\n/g,"<br/>");
}

// ─── GROQ HELPER (Llama 3.3 70B) ─────────────────────────────────────────────
async function groqChat({ key, system="", messages=[], maxTokens=8192 }) {
  if (!key) throw new Error("Groq API key not set. Please enter your key above.");
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const allMessages = [
    ...(system ? [{ role:"system", content:system }] : []),
    ...messages
  ];
  const body = {
    model: "llama-3.3-70b-versatile",
    messages: allMessages,
    max_tokens: maxTokens
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.choices?.[0]?.message?.content || "No response received.";
}

// ─── AI HUB — COMPLETE LIVE FINANCIAL ADVISOR (18+ Features) ─────────────────
// Sections: Core Chat | Alerts | Calculators | Deep Analysis
// Replaces: AIAdviser, AIBuilder, AICodeFixer, Milestones

function AIHub({ data }) {
  const [activeSection, setActiveSection] = useState("chat");
  const [groqKey,   setGroqKey]   = useState(() => localStorage.getItem("pf_groq_key") || "");
  const [keyInput,  setKeyInput]  = useState("");
  const saveKey = () => { const k=keyInput.trim(); if(k){setGroqKey(k);localStorage.setItem("pf_groq_key",k);setKeyInput("");} };
  const clearKey = () => { setGroqKey(""); setKeyInput(""); localStorage.removeItem("pf_groq_key"); };
  const d = data;

  // ── Shared derived values ──
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const totalDebt  = n(d.loans?.hdfc?.outstanding)+n(d.loans?.idfc?.outstanding)+n(d.loans?.sbi?.outstanding);
  const totalAssets= n(d.stocks?.summary?.total?.current)+n(d.lendenClub?.totalPooled)+n(d.personalLending?.totalCapital)+n(d.realEstate?.paid);
  const netWorth   = totalAssets - totalDebt;
  const emiTotal   = n(d.income?.hdfcEmi)+n(d.income?.idfcEmi)+n(d.income?.sbiEmi);
  const salary     = n(d.income?.salary);
  const inHand     = n(d.income?.inHand);

  const SECTIONS = [
    { id:"chat",       label:"💬 Live Advisor",     sub:"Chat with Arth",        color:P.violet  },
    { id:"alerts",     label:"🚨 Smart Alerts",     sub:"Health score & alerts", color:P.ruby    },
    { id:"calculators",label:"🧮 Calculators",      sub:"Debt, FIRE & SIP",      color:P.emerald },
    { id:"analysis",   label:"🔬 Deep Analysis",    sub:"Goals, Tax & What-If",  color:P.sapphire},
  ];

  // ── System prompt — full financial context ──
  const buildSystemPrompt = () => {
    const kishanRao   = d.personalLending?.borrowers?.find(b=>b.name?.toLowerCase().includes("kishan"));
    const pendingInt  = n(d.personalLending?.pendingInterest);
    const tutoring    = n(d.income?.tutoring || d.income?.devopsTutoring);
    const lendingInt  = n(d.income?.lendingInterest || d.personalLending?.monthlyInterest);
    const grossIncome = salary + tutoring + lendingInt;
    const savingsRate = grossIncome>0 ? Math.round((inHand/grossIncome)*100) : 0;

    // Salary history — last 6 months
    const hist = (d.salaryHistory || []).slice(-6);
    const histText = hist.length>0
      ? hist.map(h=>`  ${h.month}: gross ₹${n(h.grossTotal||h.totalIncome).toLocaleString("en-IN")}, in-hand ₹${n(h.inHand||h.savings).toLocaleString("en-IN")}`).join("\n")
      : "  No history available";

    // Investment breakdown
    const equityCurr  = n(d.stocks?.summary?.equity?.current);
    const equityPL    = n(d.stocks?.summary?.equity?.pl);
    const mfCurr      = n(d.stocks?.summary?.mf?.current);
    const mfPL        = n(d.stocks?.summary?.mf?.pl);
    const optionsPL   = n(d.stocks?.summary?.options?.pl);
    const cryptoPL    = n(d.stocks?.summary?.crypto?.pl);

    // Real estate
    const rePaid      = n(d.realEstate?.paid);
    const reTotal     = n(d.realEstate?.totalCost || d.realEstate?.totalAmount);
    const rePct       = reTotal>0 ? Math.round((rePaid/reTotal)*100) : 0;

    // Goals with progress
    const idfcOut   = n(d.loans?.idfc?.outstanding);
    const sbiOut    = n(d.loans?.sbi?.outstanding);
    const lcPool    = n(d.lendenClub?.totalPooled);
    const monthlyCap= Math.max(0, inHand - 15000);
    const g1Pct     = idfcOut>0 ? Math.max(0,(1-(idfcOut/(idfcOut+n(d.loans?.idfc?.emi)*n(d.loans?.idfc?.paid||18))))*100).toFixed(0) : 100;
    const g2Pct     = sbiOut>0  ? Math.max(0,(1-(sbiOut/(sbiOut+n(d.loans?.sbi?.emi)*n(d.loans?.sbi?.paid||0))))*100).toFixed(0)  : 100;
    const g3Pct     = Math.min(100,(totalAssets/1000000)*100).toFixed(0);
    const g4Pct     = Math.min(100,(lcPool/500000)*100).toFixed(0);
    const g5Pct     = Math.min(100,Math.max(0,(netWorth/10000000)*100)).toFixed(0);

    return `You are Arth — a sharp, empathetic personal financial advisor for ${d.settings?.name || "Naresh"}, a ${d.income?.age || 30}-year-old software professional in ${d.settings?.city || "Hyderabad"}, India.

You have COMPLETE, LIVE access to their finances as of ${d.income?.month || "Mar-26"}:

INCOME SOURCES (Gross: ₹${grossIncome.toLocaleString("en-IN")}/mo):
- Primary salary: ₹${salary.toLocaleString("en-IN")}/mo
- DevOps tutoring: ₹${tutoring.toLocaleString("en-IN")}/mo
- Personal lending interest: ₹${lendingInt.toLocaleString("en-IN")}/mo
- In-hand after deductions: ₹${inHand.toLocaleString("en-IN")}/mo
- Savings rate: ${savingsRate}% of gross income
- Credit card bills: ₹${n(d.income?.creditCardBills).toLocaleString("en-IN")}/mo

SALARY HISTORY (last 6 months):
${histText}

LOANS (Total debt: ₹${Math.round(totalDebt).toLocaleString("en-IN")}):
- HDFC Home Loan: ₹${Math.round(n(d.loans?.hdfc?.outstanding)).toLocaleString("en-IN")} @ ${d.loans?.hdfc?.interestRate||10.5}% | EMI ₹${n(d.loans?.hdfc?.emi).toLocaleString("en-IN")} | ${(d.loans?.hdfc?.total||72)-(d.loans?.hdfc?.paid||4)} EMIs left
- IDFC Personal Loan: ₹${Math.round(idfcOut).toLocaleString("en-IN")} @ ${d.loans?.idfc?.interestRate||13.5}% | EMI ₹${n(d.loans?.idfc?.emi).toLocaleString("en-IN")} | ${(d.loans?.idfc?.total||60)-(d.loans?.idfc?.paid||18)} EMIs left  ← HIGHEST RATE, PRIORITY PAYOFF
- SBI Loan: ₹${Math.round(sbiOut).toLocaleString("en-IN")} @ ${d.loans?.sbi?.interestRate||9.35}% | EMI ₹${n(d.loans?.sbi?.emi).toLocaleString("en-IN")} | ${(d.loans?.sbi?.total||25)-(d.loans?.sbi?.paid||0)} EMIs left
- EMI burden: ₹${emiTotal.toLocaleString("en-IN")}/mo = ${salary>0?Math.round((emiTotal/salary)*100):0}% of salary ${emiTotal/salary>0.5?"⚠ HIGH — above 50% danger zone":"✅ manageable"}

INVESTMENT PORTFOLIO (Total assets: ₹${Math.round(totalAssets).toLocaleString("en-IN")}):
- Equity stocks: ₹${equityCurr.toLocaleString("en-IN")} | P&L ₹${equityPL.toLocaleString("en-IN")}
- Mutual funds: ₹${mfCurr.toLocaleString("en-IN")} | P&L ₹${mfPL.toLocaleString("en-IN")}
- F&O trading: P&L ₹${optionsPL.toLocaleString("en-IN")} (speculative — taxed as business income)
- Crypto: P&L ₹${cryptoPL.toLocaleString("en-IN")} (30% flat tax, no offsetting)
- Personal lending capital: ₹${n(d.personalLending?.totalCapital).toLocaleString("en-IN")} @ 24%/yr | Monthly interest ₹${lendingInt.toLocaleString("en-IN")}
- LendenClub P2P: ₹${lcPool.toLocaleString("en-IN")} | ~10% net ROI | NPA: ₹${(d.lendenClub?.tabSummary||[]).reduce((s,t)=>s+n(t.npa),0).toLocaleString("en-IN")}
- Real estate (land): ₹${rePaid.toLocaleString("en-IN")} paid of ₹${reTotal.toLocaleString("en-IN")} total (${rePct}% complete) | Balance ₹${n(d.realEstate?.remaining).toLocaleString("en-IN")}

NET WORTH: ₹${Math.round(netWorth).toLocaleString("en-IN")} (${netWorth<0?"in deficit — home loan dominates":"positive and growing"})

FINANCIAL GOALS & PROGRESS:
1. Clear IDFC loan (13.5% rate) — ${g1Pct}% paid off | Outstanding ₹${Math.round(idfcOut).toLocaleString("en-IN")}
2. Clear SBI loan — ${g2Pct}% paid off | Outstanding ₹${Math.round(sbiOut).toLocaleString("en-IN")}
3. ₹10L total investments — ${g3Pct}% reached | Current ₹${Math.round(totalAssets).toLocaleString("en-IN")}
4. ₹5L LendenClub pool — ${g4Pct}% reached | Current ₹${Math.round(lcPool).toLocaleString("en-IN")}
5. ₹1 Crore net worth — ${g5Pct}% reached | Current ₹${Math.round(netWorth).toLocaleString("en-IN")}
- Monthly savings capacity for goals: ₹${monthlyCap.toLocaleString("en-IN")}/mo

ALERTS:
${pendingInt>0?`- ⚠ CRITICAL: KishanRao has ₹${pendingInt.toLocaleString("en-IN")} overdue interest (capital at risk)`:"- ✅ No borrower defaults"}
- EMI burden: ${emiTotal/salary>0.5?"⚠ HIGH at":"✅"} ${salary>0?Math.round((emiTotal/salary)*100):0}% of salary

YOUR STYLE: Speak like a trusted CA-cum-wealth manager. Be specific with ₹ numbers. Give actionable advice referencing actual data above. Use Indian financial context (80C, 24(b), LTCG, NPS, ELSS). Be honest about risks. Reference goals by name when relevant. Keep responses under 350 words unless asked to elaborate.`;
  };

  return (
    <div className="fade">
      {/* ── Groq API Key Banner ── */}
      {!groqKey ? (
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"12px 16px",background:`linear-gradient(135deg,${P.gold}18,${P.orange}0A)`,border:`1px solid ${P.gold}44`,borderRadius:12,flexWrap:"wrap"}}>
          <span style={{fontSize:18}}>🔑</span>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,color:P.gold,marginBottom:2}}>Groq API Key Required</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>Free key from <span style={{color:P.sapphire}}>console.groq.com</span> — saved locally, never uploaded</div>
          </div>
          <input value={keyInput} onChange={e=>setKeyInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveKey()}
            placeholder="Paste your gsk_... key here"
            style={{flex:2,minWidth:220,padding:"8px 12px",background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,color:P.text,fontFamily:"'Fira Code',monospace",fontSize:11,outline:"none"}}/>
          <button onClick={saveKey} style={{padding:"8px 16px",background:`linear-gradient(135deg,${P.gold},${P.orange})`,border:"none",borderRadius:8,color:"#000",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:"'Fira Code',monospace"}}>Save Key</button>
        </div>
      ) : (
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"8px 14px",background:`${P.emerald}12`,border:`1px solid ${P.emerald}33`,borderRadius:10}}>
          <span style={{color:P.emerald,fontSize:13}}>✓</span>
          <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald}}>Groq (Llama 3.3 70B) connected · AI features active</span>
          <button onClick={clearKey} style={{marginLeft:"auto",padding:"3px 10px",background:"transparent",border:`1px solid ${P.muted}44`,borderRadius:6,color:P.muted,fontSize:9,cursor:"pointer",fontFamily:"'Fira Code',monospace"}}>Change Key</button>
        </div>
      )}

      {/* ── Section Nav ── */}
      <div style={{display:"flex",gap:8,marginBottom:20,background:P.card2,borderRadius:16,padding:8,border:`1px solid ${P.border}`}}>
        {SECTIONS.map(s=>(
          <button key={s.id} onClick={()=>setActiveSection(s.id)}
            style={{flex:1,padding:"12px 10px",borderRadius:12,border:`1px solid ${activeSection===s.id?s.color+"55":"transparent"}`,cursor:"pointer",transition:"all .2s",textAlign:"center",
              background:activeSection===s.id?`linear-gradient(135deg,${s.color}28,${s.color}10)`:"transparent",
              boxShadow:activeSection===s.id?`0 0 12px ${s.color}33`:"none"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,color:activeSection===s.id?s.color:P.muted,marginBottom:3}}>{s.label}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:activeSection===s.id?s.color+"aa":P.muted+"88"}}>{s.sub}</div>
            {activeSection===s.id&&<div style={{width:24,height:2,background:s.color,borderRadius:2,margin:"6px auto 0"}}/>}
          </button>
        ))}
      </div>

      {activeSection==="chat"        && <AIChatSection data={d} groqKey={groqKey} systemPrompt={buildSystemPrompt()} totalDebt={totalDebt} totalAssets={totalAssets} netWorth={netWorth} emiTotal={emiTotal} salary={salary} inHand={inHand}/>}
      {activeSection==="alerts"      && <AIAlertsSection data={d} groqKey={groqKey} totalDebt={totalDebt} totalAssets={totalAssets} netWorth={netWorth} emiTotal={emiTotal} salary={salary}/>}
      {activeSection==="calculators" && <AICalculatorsSection data={d} groqKey={groqKey} totalDebt={totalDebt} totalAssets={totalAssets} netWorth={netWorth} emiTotal={emiTotal} salary={salary} inHand={inHand}/>}
      {activeSection==="analysis"    && <AIAnalysisSection data={d} groqKey={groqKey} totalDebt={totalDebt} totalAssets={totalAssets} netWorth={netWorth} emiTotal={emiTotal} salary={salary} inHand={inHand}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — LIVE ADVISOR CHAT
// ═══════════════════════════════════════════════════════════════════════════════
function AIChatSection({ data, groqKey, systemPrompt, totalDebt, totalAssets, netWorth, emiTotal, salary, inHand }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [messages, setMessages] = useState([]);
  const [input, setInput]     = useState("");
  const [loading, setLoading] = useState(false);
  const [briefed, setBriefed] = useState(false);
  const chatRef = useRef(null);

  // ── Auto morning brief on first load ──
  useEffect(()=>{
    if (!briefed) {
      const kishanPending = n(d.personalLending?.pendingInterest);
      const nextEmi = d.loans?.hdfc?.schedule?.find(s=>!s.status||s.status==="");
      const brief = `🌅 **Good morning, ${d.settings?.name?.split(" ")[0] || "Naresh"}! Here's your daily financial brief:**

**💰 Cash position:** In-hand ₹${n(inHand).toLocaleString("en-IN")} this month — ${n(inHand)<20000?"⚠ tight, watch spending":"✅ looks okay"}

**🏦 EMI this week:** ${nextEmi?`HDFC EMI of ₹${n(d.loans?.hdfc?.emi).toLocaleString("en-IN")} due ${nextEmi.date}`:"Check your EMI schedule"}

**📊 Budget standing:** EMI load is ${salary>0?Math.round((emiTotal/salary)*100):0}% of salary ${emiTotal/salary>0.5?"— ⚠ above 50% danger zone":"— within range"}

**🚨 Active alert:** ${kishanPending>0?`KishanRao owes ₹${kishanPending.toLocaleString("en-IN")} in unpaid interest — ${Math.round(n(d.personalLending?.borrowers?.find(b=>b.name?.toLowerCase().includes("kishan"))?.monthsElapsed||2))} months overdue`:"No borrower defaults 👍"}

**🎯 Priority action:** ${totalDebt>2000000?"Consider prepaying IDFC loan (highest rate at 13.5%) when you get extra cash":"Keep building your investment portfolio — debt is manageable"}

Ask me anything — I know your complete financial picture!`;
      setMessages([{ role:"assistant", content:brief }]);
      setBriefed(true);
    }
  }, []);

  const QUICK_CHIPS = [
    "What's my fastest path to clearing IDFC loan?",
    "How much monthly SIP gets me to ₹1 Crore in 7 years?",
    "Am I on track for FIRE by age 45?",
    "Should I prepay loans or increase SIP this month?",
    "How can I grow my tutoring income faster?",
    "What tax deductions am I missing this FY?",
    "Is it safe to invest more in LendenClub this month?",
    "What's my savings rate vs recommended 20%?",
  ];

  const sendMessage = async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    const history = [...messages, { role:"user", content:msg }];
    setMessages(history);
    setLoading(true);
    try {
      const reply = await groqChat({ key:groqKey, system:systemPrompt, messages:history.slice(-10) });
      setMessages(prev=>[...prev,{ role:"assistant", content:reply }]);
    } catch(e) {
      setMessages(prev=>[...prev,{ role:"assistant", content:`⚠ Connection error: ${e.message}` }]);
    } finally {
      setLoading(false);
      setTimeout(()=>chatRef.current?.scrollTo({top:99999,behavior:"smooth"}),100);
    }
  };

  const clearChat = () => { setMessages([]); setBriefed(false); };

  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:16,height:"calc(100vh - 240px)",minHeight:560}}>

      {/* ── Chat Window ── */}
      <Card accent={P.violet} style={{display:"flex",flexDirection:"column",padding:0,overflow:"hidden"}}>
        {/* Header */}
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,background:`linear-gradient(135deg,${P.violet}18,transparent)`,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:`0 0 16px ${P.violet}55`,flexShrink:0}}>🪙</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:P.text}}>Arth — Your Financial Advisor</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>Knows your salary, loans, investments, lending & real estate · Session memory: last 10 turns</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:loading?P.gold:P.emerald,animation:loading?"pulse 1s infinite":"none"}}/>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:loading?P.gold:P.emerald}}>{loading?"Thinking…":"Ready"}</span>
            <button onClick={clearChat} style={{background:"none",border:`1px solid ${P.border}`,color:P.muted,borderRadius:8,padding:"3px 10px",cursor:"pointer",fontFamily:"'Fira Code',monospace",fontSize:9,marginLeft:8}}>↺ Reset</button>
          </div>
        </div>

        {/* Messages */}
        <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:20,display:"flex",flexDirection:"column",gap:14}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:"flex",flexDirection:m.role==="user"?"row-reverse":"row",gap:10,alignItems:"flex-start"}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:m.role==="user"?`linear-gradient(135deg,${P.gold},${P.orange})`:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
                {m.role==="user"?"👤":"🪙"}
              </div>
              <div style={{maxWidth:"78%",padding:"12px 16px",borderRadius:m.role==="user"?"16px 4px 16px 16px":"4px 16px 16px 16px",background:m.role==="user"?`linear-gradient(135deg,${P.gold}22,${P.orange}15)`:P.card3,border:`1px solid ${m.role==="user"?P.gold+"33":P.border}`,fontFamily:"'Outfit',sans-serif",fontSize:13,color:P.text,lineHeight:1.75}}
                dangerouslySetInnerHTML={{__html: m.role==="assistant" ? renderMD(m.content) : m.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>")}}/>

            </div>
          ))}
          {loading&&(
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🪙</div>
              <div style={{padding:"12px 16px",background:P.card3,border:`1px solid ${P.border}`,borderRadius:"4px 16px 16px 16px",display:"flex",gap:5,alignItems:"center"}}>
                {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:P.violet,animation:`pulse 1.2s ${i*0.2}s infinite`}}/>)}
              </div>
            </div>
          )}
          {messages.length===0&&!loading&&(
            <div style={{textAlign:"center",padding:"40px 20px",color:P.muted}}>
              <div style={{fontSize:48,marginBottom:12}}>🪙</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:700,color:P.violet,marginBottom:6}}>Arth is ready</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:11}}>Your live financial advisor — ask anything</div>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{padding:"14px 20px",borderTop:`1px solid ${P.border}`,background:P.card2,display:"flex",gap:10}}>
          <input value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMessage()}
            placeholder="Ask Arth anything… (Enter to send)"
            style={{flex:1,background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"11px 14px",color:P.text,fontFamily:"'Outfit',sans-serif",fontSize:13,outline:"none"}}
          />
          <button onClick={()=>sendMessage()} disabled={loading||!input.trim()}
            style={{background:loading||!input.trim()?P.border:`linear-gradient(135deg,${P.violet},${P.sapphire})`,border:"none",borderRadius:10,padding:"11px 20px",color:"#fff",cursor:loading||!input.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:12,fontWeight:700,transition:"all .15s",whiteSpace:"nowrap"}}>
            Send ↗
          </button>
        </div>
      </Card>

      {/* ── Right Panel ── */}
      <div style={{display:"flex",flexDirection:"column",gap:12,overflowY:"auto"}}>
        {/* Quick context */}
        <Card accent={P.gold} style={{padding:16}}>
          <SectionHead title="Your Snapshot" icon="📊" color={P.gold}/>
          {[
            {label:"Net Worth",    v:fmt(netWorth),   color:netWorth>0?P.emerald:P.ruby,  bar:Math.min(100,Math.max(0,(netWorth/10000000)*100))},
            {label:"Total Debt",   v:fmt(totalDebt),  color:P.ruby,                        bar:Math.min(100,(totalDebt/5000000)*100)},
            {label:"Investments",  v:fmt(totalAssets),color:P.sapphire,                    bar:Math.min(100,(totalAssets/1000000)*100)},
            {label:"In-Hand/mo",   v:fmt(inHand),     color:P.gold,                        bar:Math.min(100,(inHand/100000)*100)},
            {label:"EMI/mo",       v:fmt(emiTotal),   color:P.orange,                      bar:Math.min(100,(emiTotal/salary||0)*100)},
            {label:"EMI % Salary", v:`${salary>0?Math.round((emiTotal/salary)*100):0}%`,  color:emiTotal/salary>0.5?P.ruby:P.emerald, bar:Math.min(100,(emiTotal/salary||0)*100)},
          ].map((r,i)=>(
            <div key={i} style={{padding:"8px 0",borderBottom:`1px solid ${P.border}22`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>{r.label}</span>
                <span style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,color:r.color}}>{r.v}</span>
              </div>
              <div style={{height:3,background:P.border,borderRadius:2}}>
                <div style={{height:3,width:`${r.bar}%`,background:r.color,borderRadius:2,transition:"width .4s"}}/>
              </div>
            </div>
          ))}
        </Card>

        {/* Quick chips */}
        <Card accent={P.violet} style={{padding:16}}>
          <SectionHead title="Suggested Questions" icon="⚡" color={P.violet}/>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {QUICK_CHIPS.map((q,i)=>(
              <button key={i} onClick={()=>sendMessage(q)} disabled={loading}
                style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",color:P.muted,cursor:loading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:9.5,textAlign:"left",transition:"all .15s",lineHeight:1.5}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=P.violet+"66";e.currentTarget.style.color=P.text;}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=P.border;e.currentTarget.style.color=P.muted;}}>
                {q}
              </button>
            ))}
          </div>
        </Card>

        {/* Brief me button */}
        <button onClick={()=>sendMessage("Give me a detailed morning financial brief — 5 key points about my finances today, what needs attention, and one priority action I should take.")}
          disabled={loading}
          style={{background:`linear-gradient(135deg,${P.gold},${P.orange})`,border:"none",borderRadius:12,padding:"16px 0",color:"#050D1A",cursor:loading?"not-allowed":"pointer",fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:800,transition:"all .2s",
            boxShadow:loading?`0 0 10px ${P.gold}22`:`0 0 24px ${P.gold}66, 0 0 48px ${P.gold}22`,
            animation:loading?"none":"pulse-glow 2s ease-in-out infinite"}}>
          ☀️ Brief Me Today
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SMART ALERTS
// ═══════════════════════════════════════════════════════════════════════════════
function AIAlertsSection({ data, groqKey, totalDebt, totalAssets, netWorth, emiTotal, salary }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [reportLoading, setReportLoading] = useState(false);
  const [report, setReport]               = useState(null);
  const [whatsapp, setWhatsapp]           = useState(null);
  const [wpLoading, setWpLoading]         = useState(false);

  // ── 05: Proactive Alert Engine ──
  const alerts = [];
  const kishanRao = d.personalLending?.borrowers?.find(b=>b.name?.toLowerCase().includes("kishan"));
  if (kishanRao && n(kishanRao.pendingInt)>0) {
    alerts.push({ level:"critical", icon:"🔴", title:"Borrower Default Alert", msg:`KishanRao has ₹${n(kishanRao.pendingInt).toLocaleString("en-IN")} unpaid interest — ${kishanRao.monthsElapsed||2} months overdue. Capital at risk: ₹${n(kishanRao.amount).toLocaleString("en-IN")}`, color:P.ruby });
  }
  const nextHdfc = d.loans?.hdfc?.schedule?.find(s=>!s.status||s.status==="");
  if (nextHdfc) {
    const dueDate = new Date(nextHdfc.date);
    const today   = new Date();
    const daysLeft= Math.ceil((dueDate-today)/(1000*60*60*24));
    if (daysLeft<=10) alerts.push({ level:"warning", icon:"🟡", title:`HDFC EMI Due in ${daysLeft} days`, msg:`₹${n(nextHdfc.emi).toLocaleString("en-IN")} due ${nextHdfc.date}. Ensure funds in account.`, color:P.orange });
  }
  if (emiTotal/salary>0.5) {
    alerts.push({ level:"warning", icon:"🟠", title:"High EMI Burden", msg:`EMIs consume ${Math.round((emiTotal/salary)*100)}% of your salary — above safe 40% threshold. Risk of cash crunch if any unexpected expense hits.`, color:P.orange });
  }
  const totalBudget = Object.entries(d.budget||{}).filter(([k])=>k!=="actual").reduce((s,[,v])=>s+n(v),0);
  const totalActual = Object.values(d.budget?.actual||{}).reduce((s,v)=>s+n(v),0);
  if (totalActual>totalBudget) {
    alerts.push({ level:"warning", icon:"🟡", title:"Budget Overspend", msg:`Actual spend ₹${totalActual.toLocaleString("en-IN")} exceeds budget ₹${totalBudget.toLocaleString("en-IN")} by ₹${(totalActual-totalBudget).toLocaleString("en-IN")} this month.`, color:P.gold });
  }
  const lcNPA = (d.lendenClub?.tabSummary||[]).reduce((s,t)=>s+n(t.npa),0);
  if (lcNPA>0) alerts.push({ level:"info", icon:"🔵", title:"LendenClub NPA Alert", msg:`₹${lcNPA.toLocaleString("en-IN")} in NPA loans. Monitor recovery.`, color:P.sapphire });
  if (alerts.length===0) alerts.push({ level:"good", icon:"✅", title:"All Clear!", msg:"No critical alerts today. Your finances are on track.", color:P.emerald });

  // ── 06: Financial Health Score ──
  const savingsRate  = salary>0 ? n(d.income?.inHand)/salary : 0;
  const emiBurden    = salary>0 ? emiTotal/salary : 0;
  const investPct    = (n(d.income?.grossTotal)||salary)>0 ? totalAssets/(((n(d.income?.grossTotal)||salary))*12) : 0;
  const debtCoverage = totalAssets>0 ? Math.min(1, totalDebt/totalAssets) : 1;

  const scores = {
    savings:     Math.round(Math.min(100, savingsRate * 300)),
    emiBurden:   Math.round(Math.max(0, 100 - emiBurden * 150)),
    investment:  Math.round(Math.min(100, investPct * 100)),
    debtControl: Math.round(Math.max(0, 100 - debtCoverage * 80)),
  };
  const healthScore = Math.round((scores.savings*0.3 + scores.emiBurden*0.3 + scores.investment*0.2 + scores.debtControl*0.2));
  const healthColor = healthScore>=70?P.emerald:healthScore>=50?P.gold:P.ruby;
  const healthLabel = healthScore>=70?"Healthy 💚":healthScore>=50?"Fair ⚠":"Needs Work 🔴";

  // ── 07: Monthly Review Report ──
  const generateReport = async () => {
    setReportLoading(true);
    try {
      const hist6 = (d.salaryHistory||[]).slice(-6);
      const tutoringInc = n(d.income?.tutoring||d.income?.devopsTutoring);
      const lendingInc  = n(d.personalLending?.monthlyInterest||d.income?.lendingInterest);
      const reply = await groqChat({ key:groqKey, messages:[{role:"user",content:`Generate a detailed month-end financial review for ${d.settings?.name||"Naresh"} (${d.income?.month||"Mar-26"}).

INCOME THIS MONTH:
- Primary salary: ₹${n(d.income?.salary).toLocaleString("en-IN")} | DevOps tutoring: ₹${tutoringInc.toLocaleString("en-IN")} | Lending interest: ₹${lendingInc.toLocaleString("en-IN")}
- In-hand after deductions: ₹${n(d.income?.inHand).toLocaleString("en-IN")}
- Savings rate: ${salary>0?Math.round((n(d.income?.inHand)/salary)*100):0}%

SALARY HISTORY TREND (last 6 months):
${hist6.map(h=>`  ${h.month}: gross ₹${n(h.grossTotal||h.totalIncome).toLocaleString("en-IN")}, in-hand ₹${n(h.inHand||h.savings).toLocaleString("en-IN")}`).join("\n")||"  No history"}

BALANCE SHEET:
- Net worth: ₹${Math.round(netWorth).toLocaleString("en-IN")}
- Total investments: ₹${Math.round(totalAssets).toLocaleString("en-IN")} | Total debt: ₹${Math.round(totalDebt).toLocaleString("en-IN")}
- EMI burden: ₹${emiTotal.toLocaleString("en-IN")} = ${salary>0?Math.round((emiTotal/salary)*100):0}% of salary
- LendenClub pool: ₹${n(d.lendenClub?.totalPooled).toLocaleString("en-IN")} | Lending interest received: ₹${n(d.personalLending?.receivedTillNow).toLocaleString("en-IN")}
- KishanRao overdue: ₹${n(d.personalLending?.pendingInterest).toLocaleString("en-IN")}
- Budget spent: ₹${totalActual.toLocaleString("en-IN")} vs budget ₹${totalBudget.toLocaleString("en-IN")} (${totalActual>totalBudget?"OVER":"within"} budget)
- Health score: ${healthScore}/100

GOALS STATUS:
- IDFC loan: ₹${Math.round(n(d.loans?.idfc?.outstanding)).toLocaleString("en-IN")} remaining @ 13.5% (priority payoff)
- ₹1Cr net worth: ${Math.min(100,Math.max(0,Math.round((netWorth/10000000)*100)))}% reached
- ₹10L investments: ${Math.min(100,Math.round((totalAssets/1000000)*100))}% reached

Format: 6 bullet points — (1) income vs spend with savings rate comment (2) income trend from history (3) net worth & investment change (4) debt status & goal progress (5) one risk to watch (6) ONE specific priority action for next month tied to a named goal. Use ₹ numbers throughout.`}] });
      setReport(reply);
    } catch(e) { setReport("Error generating report: "+e.message); }
    setReportLoading(false);
  };

  // ── 08: WhatsApp draft for KishanRao ──
  const generateWhatsApp = async () => {
    setWpLoading(true);
    try {
      const reply = await groqChat({ key:groqKey, messages:[{role:"user",content:`Write a firm but professional WhatsApp message from ${d.settings?.name||"Naresh"} to KishanRao following up on ₹${n(d.personalLending?.pendingInterest).toLocaleString("en-IN")} overdue interest (${n(d.personalLending?.borrowers?.find(b=>b.name?.toLowerCase().includes("kishan"))?.monthsElapsed||2)} months). Loan amount: ₹${n(kishanRao?.amount||100000).toLocaleString("en-IN")} @ 2%/month. Keep it polite but clear about urgency. Under 100 words. No emojis spam.`}], maxTokens:512 });
      setWhatsapp(reply);
    } catch(e) { setWhatsapp("Error: "+e.message); }
    setWpLoading(false);
  };

  return (
    <div className="fade" style={{display:"grid",gap:14}}>

      {/* Health Score */}
      <div style={{background:`linear-gradient(135deg,${healthColor}14,transparent)`,border:`1px solid ${healthColor}44`,borderRadius:16,padding:"24px"}}>
        <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:24,alignItems:"center",marginBottom:16}}>
          <DonutRing pct={healthScore} color={healthColor} size={160} stroke={14} label={`${healthScore}`} sub="/ 100"/>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:800,color:healthColor,marginBottom:6}}>Financial Health: {healthLabel}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.8}}>
              {scores.emiBurden<50 ? "⚠ EMI burden is the main drag — reducing it adds the most points" :
               scores.savings<50  ? "⚠ Low savings rate — increasing in-hand savings boosts this score" :
               scores.investment<50? "📈 Grow investments to push score above 70" :
               "✅ Portfolio is balanced — keep growing investments"}
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[
            {label:"Savings Rate",  score:scores.savings,     hint:"≥20% of salary",  icon:scores.savings>=70?"✅":scores.savings>=40?"⚠":"🔴"},
            {label:"EMI Control",   score:scores.emiBurden,   hint:"≤40% of salary",  icon:scores.emiBurden>=70?"✅":scores.emiBurden>=40?"⚠":"🔴"},
            {label:"Investment %",  score:scores.investment,  hint:"Build wealth",     icon:scores.investment>=70?"✅":scores.investment>=40?"⚠":"🔴"},
            {label:"Debt Coverage", score:scores.debtControl, hint:"Assets > Debt",   icon:scores.debtControl>=70?"✅":scores.debtControl>=40?"⚠":"🔴"},
          ].map((s,i)=>{
            const sc = s.score>=70?P.emerald:s.score>=40?P.gold:P.ruby;
            return (
              <div key={i} style={{background:P.card3,border:`1px solid ${sc}22`,borderRadius:12,padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.text}}>{s.icon} {s.label}</span>
                  <span style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:sc}}>{s.score}</span>
                </div>
                <PBar value={s.score} max={100} color={sc} height={6}/>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginTop:5}}>{s.hint}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Alert Cards */}
      <div style={{display:"grid",gap:10}}>
        <SectionHead title="Proactive Alerts — Auto-detected" icon="🚨" color={P.ruby}/>
        {alerts.map((a,i)=>{
          const badgeLabel = a.level==="critical"?"CRITICAL":a.level==="warning"?"WARNING":a.level==="info"?"INFO":"ALL CLEAR";
          const actionQ    = a.level==="critical"?"What should I do about the KishanRao default risk?":
                             a.level==="warning" ?"How do I reduce my EMI burden quickly?":null;
          return (
            <div key={i} style={{background:`${a.color}0A`,border:`1px solid ${a.color}44`,borderRadius:14,padding:"16px 18px",
              borderLeft:a.level==="critical"?`4px solid ${a.color}`:`1px solid ${a.color}44`}}>
              <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                <span style={{fontSize:28,flexShrink:0}}>{a.icon}</span>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:700,color:a.color}}>{a.title}</div>
                    <span style={{background:`${a.color}22`,border:`1px solid ${a.color}44`,borderRadius:20,padding:"2px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,fontWeight:700,color:a.color,letterSpacing:.5}}>{badgeLabel}</span>
                  </div>
                  <div style={{fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.muted,lineHeight:1.8}}>{a.msg}</div>
                </div>
              </div>
              {actionQ&&(
                <button onClick={()=>{ document.querySelector("[data-section='chat']")?.click?.(); }}
                  style={{marginTop:10,marginLeft:42,background:`${a.color}18`,border:`1px solid ${a.color}44`,borderRadius:8,padding:"5px 14px",color:a.color,fontFamily:"'Fira Code',monospace",fontSize:9,fontWeight:700,cursor:"pointer"}}>
                  → Ask Arth: Fix This
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        {/* Monthly Report */}
        <Card accent={P.sapphire}>
          <SectionHead title="Monthly Review Report" icon="📋" color={P.sapphire}/>
          <button onClick={generateReport} disabled={reportLoading}
            style={{width:"100%",background:reportLoading?P.border:`linear-gradient(135deg,${P.sapphire},${P.teal})`,border:"none",borderRadius:10,padding:"11px 0",color:"#050D1A",cursor:reportLoading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,marginBottom:12}}>
            {reportLoading?"🔄 Generating…":"📊 Generate Report"}
          </button>
          {report && (
            <div style={{background:P.card3,borderRadius:10,padding:"14px 16px",fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.8,maxHeight:300,overflowY:"auto"}}
              dangerouslySetInnerHTML={{__html:renderMD(report)}}/>
          )}
          {!report && <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.8}}>AI-generated month-end summary: income vs budget, overspend categories, net worth change, and one key observation.</div>}
        </Card>

        {/* KishanRao Tracker */}
        <Card accent={P.ruby}>
          <SectionHead title="Default Risk — KishanRao" icon="⚠️" color={P.ruby}/>
          {kishanRao ? (
            <div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                {[
                  {label:"Loan Amount", v:`₹${n(kishanRao.amount).toLocaleString("en-IN")}`, color:P.gold},
                  {label:"Monthly Int", v:`₹${n(kishanRao.monthlyInt).toLocaleString("en-IN")}`, color:P.teal},
                  {label:"Months Overdue", v:`${kishanRao.monthsElapsed||2} mo`, color:P.ruby},
                  {label:"Interest Lost", v:`₹${n(kishanRao.pendingInt).toLocaleString("en-IN")}`, color:P.ruby},
                ].map((r,i)=>(
                  <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}22`,borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:3}}>{r.label}</div>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:800,color:r.color}}>{r.v}</div>
                  </div>
                ))}
              </div>
              <button onClick={generateWhatsApp} disabled={wpLoading}
                style={{width:"100%",background:wpLoading?P.border:`linear-gradient(135deg,${P.ruby},${P.orange})`,border:"none",borderRadius:10,padding:"10px 0",color:"#fff",cursor:wpLoading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,marginBottom:whatsapp?12:0}}>
                {wpLoading?"🔄 Drafting…":"💬 Draft WhatsApp Message"}
              </button>
              {whatsapp && (
                <div style={{background:P.card3,border:`1px solid ${P.ruby}33`,borderRadius:10,padding:"12px 14px",fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.75}}>
                  <div dangerouslySetInnerHTML={{__html:renderMD(whatsapp)}}/>
                  <button onClick={()=>navigator.clipboard?.writeText(whatsapp)} style={{display:"block",marginTop:8,background:"none",border:`1px solid ${P.emerald}44`,color:P.emerald,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:10,fontFamily:"'Fira Code',monospace"}}>📋 Copy</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.emerald,textAlign:"center",padding:"20px 0"}}>✅ No defaulting borrowers</div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — SMART CALCULATORS
// ═══════════════════════════════════════════════════════════════════════════════
function AICalculatorsSection({ data, groqKey, totalDebt, totalAssets, netWorth, emiTotal, salary, inHand }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [calcTab, setCalcTab] = useState("debt");

  const CALCS = [
    {id:"debt",     label:"Debt-Free",      icon:"⏱"},
    {id:"networth", label:"₹1Cr Countdown", icon:"💎"},
    {id:"passive",  label:"Passive Income", icon:"💸"},
    {id:"fire",     label:"FIRE",           icon:"🔥"},
    {id:"avalanche",label:"Loan Optimizer", icon:"🏔"},
    {id:"realestate",label:"RE Break-even", icon:"🏡"},
    {id:"sip",      label:"SIP Step-up",    icon:"📈"},
    {id:"emergency",label:"Emergency Fund", icon:"🛡"},
  ];

  return (
    <div className="fade">
      {/* Calc sub-tabs */}
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        {CALCS.map(c=>(
          <button key={c.id} onClick={()=>setCalcTab(c.id)}
            style={{padding:"9px 16px",borderRadius:22,border:`1px solid ${calcTab===c.id?P.emerald+"88":P.border}`,
              background:calcTab===c.id?`linear-gradient(135deg,${P.emerald}33,${P.emerald}18)`:"transparent",
              color:calcTab===c.id?P.emerald:P.muted,cursor:"pointer",fontFamily:"'Fira Code',monospace",
              fontSize:10,fontWeight:calcTab===c.id?700:400,transition:"all .15s",
              boxShadow:calcTab===c.id?`0 0 10px ${P.emerald}33`:"none",
              display:"flex",alignItems:"center",gap:5}}>
            <span>{c.icon}</span><span>{c.label}</span>
          </button>
        ))}
      </div>

      {calcTab==="debt"      && <DebtFreeCalc data={d} emiTotal={emiTotal} salary={salary}/>}
      {calcTab==="networth"  && <NetWorthCalc data={d} netWorth={netWorth} totalAssets={totalAssets} totalDebt={totalDebt} inHand={inHand} emiTotal={emiTotal}/>}
      {calcTab==="passive"   && <PassiveIncomeCalc data={d}/>}
      {calcTab==="fire"      && <FIRECalc data={d} netWorth={netWorth} totalAssets={totalAssets} salary={salary} inHand={inHand}/>}
      {calcTab==="avalanche" && <LoanOptimizerCalc data={d} emiTotal={emiTotal} salary={salary} inHand={inHand}/>}
      {calcTab==="realestate"&& <RealEstateBreakEven data={d}/>}
      {calcTab==="sip"       && <SIPStepUpCalc data={d} salary={salary}/>}
      {calcTab==="emergency" && <EmergencyFundCalc data={d} emiTotal={emiTotal} salary={salary} inHand={inHand}/>}
    </div>
  );
}

// ── 09: Debt-Free Timeline ──
function DebtFreeCalc({ data, emiTotal, salary }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [extra, setExtra] = useState(0);

  const loans = [
    { name:"IDFC", outstanding:n(d.loans?.idfc?.outstanding), emi:n(d.loans?.idfc?.emi), rate:n(d.loans?.idfc?.interestRate||13.5)/100/12 },
    { name:"SBI",  outstanding:n(d.loans?.sbi?.outstanding),  emi:n(d.loans?.sbi?.emi),  rate:n(d.loans?.sbi?.interestRate||9.35)/100/12  },
    { name:"HDFC", outstanding:n(d.loans?.hdfc?.outstanding), emi:n(d.loans?.hdfc?.emi), rate:n(d.loans?.hdfc?.interestRate||10.5)/100/12 },
  ];

  const calcMonths = (outstanding, emi, rate) => {
    if (emi <= outstanding * rate) return 999;
    let bal = outstanding, m = 0;
    while (bal > 0 && m < 600) {
      bal = bal * (1 + rate) - emi;
      m++;
    }
    return m;
  };

  const calcInterestSaved = (outstanding, emi, rate, extraPmt) => {
    let bal = outstanding, total = 0, m = 0;
    while (bal > 0 && m < 600) { const int = bal*rate; bal = bal+int-(emi+extraPmt); total+=int; m++; }
    let bal2 = outstanding, total2 = 0, m2 = 0;
    while (bal2 > 0 && m2 < 600) { const int2 = bal2*rate; bal2 = bal2+int2-emi; total2+=int2; m2++; }
    return { saved: Math.max(0, total2-total), monthsCut: Math.max(0, m2-m) };
  };

  return (
    <Card accent={P.emerald}>
      <SectionHead title="Debt-Free Timeline + Prepayment Simulator" icon="⏱" color={P.emerald}/>
      <div style={{marginBottom:16}}>
        <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:6}}>Extra monthly prepayment: ₹{extra.toLocaleString("en-IN")}</label>
        <input type="range" min={0} max={50000} step={1000} value={extra} onChange={e=>setExtra(Number(e.target.value))}
          style={{width:"100%",accentColor:P.emerald}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:3}}>
          <span>₹0</span><span>₹25K</span><span>₹50K</span>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
        {loans.map(l=>{
          const m0 = calcMonths(l.outstanding, l.emi, l.rate);
          const mNew = calcMonths(l.outstanding, l.emi+extra/3, l.rate);
          const {saved, monthsCut} = calcInterestSaved(l.outstanding, l.emi, l.rate, extra/3);
          const colors = {IDFC:P.sapphire, SBI:P.orange, HDFC:P.ruby};
          const origAmt = l.outstanding + (l.emi * (l.name==="HDFC"?n(d.loans?.hdfc?.paid||4):l.name==="IDFC"?n(d.loans?.idfc?.paid||18):n(d.loans?.sbi?.paid||0)));
          const paidPct  = origAmt>0 ? Math.min(100,((origAmt-l.outstanding)/origAmt)*100) : 0;
          return (
            <div key={l.name} style={{background:`${colors[l.name]}0F`,border:`1px solid ${colors[l.name]}44`,borderRadius:14,padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:colors[l.name]}}>{l.name} Loan</div>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:colors[l.name]}}>{paidPct.toFixed(0)}% paid</span>
              </div>
              <PBar value={paidPct} max={100} color={colors[l.name]} height={6}/>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:2,marginTop:10}}>
                <div>Outstanding: <span style={{color:P.text,fontWeight:600}}>₹{Math.round(l.outstanding).toLocaleString("en-IN")}</span></div>
                <div>Normal payoff: <span style={{color:P.gold}}>{m0>=999?"N/A":`${Math.floor(m0/12)}y ${m0%12}m`}</span></div>
                {extra>0&&<><div>With extra: <span style={{color:P.emerald}}>{mNew>=999?"N/A":`${Math.floor(mNew/12)}y ${mNew%12}m`}</span></div>
                <div>Months saved: <span style={{color:P.emerald,fontWeight:700}}>−{monthsCut} mo</span></div>
                <div>Interest saved: <span style={{color:P.emerald,fontWeight:700}}>₹{Math.round(saved).toLocaleString("en-IN")}</span></div></>}
              </div>
            </div>
          );
        })}
      </div>
      {extra>0&&<div style={{marginTop:12,padding:"10px 14px",background:`${P.emerald}0A`,border:`1px solid ${P.emerald}22`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald}}>
        💡 Paying ₹{extra.toLocaleString("en-IN")} extra/month saves significant interest. Prioritize IDFC first (highest rate at 13.5%).
      </div>}
    </Card>
  );
}

// ── 10: Net Worth ₹1Cr Countdown ──
function NetWorthCalc({ data, netWorth, totalAssets, totalDebt, inHand, emiTotal }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [growth, setGrowth] = useState(12);
  const [savings, setSavings] = useState(Math.max(0, Math.round(n(inHand)-15000)));

  const target = 10000000;
  const now    = new Date(2026, 2, 1);

  const project = () => {
    let nw = netWorth, assets = totalAssets, debt = totalDebt;
    const months = [];
    for (let m = 0; m <= 120; m++) {
      months.push({ m, nw:Math.round(nw), date:new Date(now.getFullYear(), now.getMonth()+m, 1).toLocaleDateString("en-IN",{month:"short",year:"numeric"}) });
      assets = assets * (1 + growth/100/12) + savings;
      const debtReduction = emiTotal * 0.4;
      debt = Math.max(0, debt - debtReduction);
      nw = assets - debt;
    }
    return months;
  };

  const months  = project();
  const hitMonth= months.find(m=>m.nw>=target);
  const crProgress = Math.min(100, Math.max(0, (netWorth/target)*100));

  return (
    <Card accent={P.gold}>
      <SectionHead title="Net Worth → ₹1 Crore Countdown" icon="💎" color={P.gold}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Portfolio Growth Rate: {growth}%/yr</label>
          <input type="range" min={6} max={20} step={1} value={growth} onChange={e=>setGrowth(Number(e.target.value))} style={{width:"100%",accentColor:P.gold}}/>
        </div>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Monthly Savings: ₹{savings.toLocaleString("en-IN")}</label>
          <input type="range" min={0} max={50000} step={1000} value={savings} onChange={e=>setSavings(Number(e.target.value))} style={{width:"100%",accentColor:P.gold}}/>
        </div>
      </div>
      <div style={{background:`linear-gradient(135deg,${P.gold}14,transparent)`,border:`1px solid ${P.gold}33`,borderRadius:12,padding:"16px 20px",marginBottom:14,display:"flex",gap:24,alignItems:"center",flexWrap:"wrap"}}>
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginBottom:4}}>Current Net Worth</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,color:netWorth<0?P.ruby:P.emerald}}>{fmt(netWorth)}</div>
        </div>
        <div style={{flex:1}}>
          <PBar value={Math.max(0,netWorth)} max={target} color={P.gold} height={10}/>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:4}}>{Math.max(0,Math.round(crProgress))}% of ₹1Cr goal</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginBottom:4}}>Estimated ₹1Cr date</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,color:P.gold}}>{hitMonth?hitMonth.date:"50yr+"}</div>
          {hitMonth&&<div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>{hitMonth.m} months away</div>}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={months.filter((_,i)=>i%3===0)} margin={{top:5,right:10,left:0,bottom:0}}>
          <defs>
            <linearGradient id="nwG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={P.gold} stopOpacity={.4}/><stop offset="100%" stopColor={P.gold} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false} interval={3}/>
          <YAxis tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false} tickFormatter={v=>v>=10000000?`₹${Math.round(v/10000000)}Cr`:v>=100000?`₹${Math.round(v/100000)}L`:`₹${Math.round(v/1000)}K`}/>
          <Tooltip content={({active,payload,label})=>active&&payload?.length?(<div style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px"}}><p style={{color:P.muted,fontSize:9,margin:"0 0 2px",fontFamily:"'Fira Code',monospace"}}>{label}</p><p style={{color:P.gold,fontSize:12,fontWeight:700,margin:0,fontFamily:"'Fira Code',monospace"}}>{fmt(payload[0].value)}</p></div>):null}/>
          <Area type="monotone" dataKey="nw" stroke={P.gold} fill="url(#nwG)" strokeWidth={2} dot={false}/>
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ── 11: Passive Income Dashboard ──
function PassiveIncomeCalc({ data }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [target, setTarget] = useState(500000);

  const sources = [
    { label:"Personal Lending Interest", monthly:n(d.personalLending?.monthlyInterest), color:P.teal,    icon:"🤝", pool:n(d.personalLending?.totalCapital), rate:24 },
    { label:"LendenClub Returns",        monthly:Math.round(n(d.lendenClub?.totalPooled)*0.10/12), color:P.rose,    icon:"🏛", pool:n(d.lendenClub?.totalPooled), rate:10 },
    { label:"Stock Dividends",           monthly:Math.round(n(d.stocks?.summary?.total?.current)*0.015/12), color:P.violet,  icon:"📈", pool:n(d.stocks?.summary?.total?.current), rate:1.5 },
    { label:"MF Returns (XIRR)",         monthly:Math.round(n(d.stocks?.summary?.mf?.current)*0.12/12), color:P.sapphire, icon:"📦", pool:n(d.stocks?.summary?.mf?.current), rate:12 },
  ];
  const totalMonthly = sources.reduce((s,r)=>s+r.monthly,0);
  const monthsToTarget = totalMonthly > 0 ? Math.ceil((target/12 - totalMonthly)/(totalMonthly*0.05)) : 999;

  return (
    <Card accent={P.teal}>
      <SectionHead title="Passive Income Dashboard" icon="💸" color={P.teal}/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:16}}>
        {sources.map((s,i)=>(
          <div key={i} style={{background:`${s.color}0F`,border:`1px solid ${s.color}33`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{fontSize:20,marginBottom:6}}>{s.icon}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{s.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:s.color}}>{fmt(s.monthly)}<span style={{fontSize:11,fontWeight:400}}>/mo</span></div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:4}}>Pool: {fmt(s.pool)} @ {s.rate}%/yr</div>
          </div>
        ))}
      </div>
      <div style={{background:`${P.teal}14`,border:`1px solid ${P.teal}33`,borderRadius:12,padding:"16px 20px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginBottom:4}}>Total Monthly Passive Income</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:32,fontWeight:800,color:P.teal}}>{fmt(totalMonthly)}<span style={{fontSize:14,color:P.muted}}>/mo</span></div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>{fmt(totalMonthly*12)}/year</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginBottom:4}}>Target: ₹{(target/1000).toFixed(0)}K/yr</div>
          <input type="range" min={100000} max={2000000} step={50000} value={target} onChange={e=>setTarget(Number(e.target.value))} style={{accentColor:P.teal,width:160}}/>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:700,color:totalMonthly*12>=target?P.emerald:P.gold,marginTop:4}}>
            {totalMonthly*12>=target?"🎉 Target achieved!`":`${Math.round((totalMonthly*12/target)*100)}% of goal`}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 12: FIRE Calculator ──
function FIRECalc({ data, netWorth, totalAssets, salary, inHand }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [monthlyExpense, setMonthlyExpense] = useState(60000);
  const [returnRate, setReturnRate] = useState(8);

  const annualExpense  = monthlyExpense * 12;
  const fireCorpus     = annualExpense * 25;   // 4% rule
  const coastFireCorpus= fireCorpus / Math.pow(1 + returnRate/100, 30);
  const currentAge     = 30;
  const targetAge      = 45;
  const yearsToFIRE   = Math.log(fireCorpus/Math.max(1,totalAssets)) / Math.log(1+returnRate/100);
  const fireDate       = new Date(2026 + Math.max(0,Math.ceil(yearsToFIRE)), 2, 1);
  const sipNeeded      = fireCorpus>totalAssets ? (fireCorpus-totalAssets)*((returnRate/100/12)/( Math.pow(1+returnRate/100/12,yearsToFIRE*12)-1)) : 0;

  return (
    <Card accent={P.ruby}>
      <SectionHead title="FIRE + Coast FIRE Calculator" icon="🔥" color={P.ruby}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Monthly Expenses: ₹{monthlyExpense.toLocaleString("en-IN")}</label>
          <input type="range" min={20000} max={200000} step={5000} value={monthlyExpense} onChange={e=>setMonthlyExpense(Number(e.target.value))} style={{width:"100%",accentColor:P.ruby}}/>
        </div>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Return Rate: {returnRate}%/yr</label>
          <input type="range" min={6} max={15} step={0.5} value={returnRate} onChange={e=>setReturnRate(Number(e.target.value))} style={{width:"100%",accentColor:P.ruby}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:14}}>
        {[
          {label:"FIRE Corpus (25x rule)",    v:fmt(fireCorpus),      color:P.ruby,    sub:"4% safe withdrawal rate"},
          {label:"Coast FIRE Corpus",          v:fmt(coastFireCorpus), color:P.orange,  sub:"Stop investing & coast to 60"},
          {label:"Current Investments",        v:fmt(totalAssets),     color:netWorth>0?P.emerald:P.ruby, sub:`${Math.round(totalAssets/fireCorpus*100)}% of FIRE corpus`},
          {label:"Monthly SIP Needed",         v:fmt(Math.max(0,sipNeeded)), color:P.sapphire, sub:`To FIRE by ${fireDate.getFullYear()}`},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:r.color}}>{r.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:3}}>{r.sub}</div>
          </div>
        ))}
      </div>
      <div style={{background:`${P.ruby}0A`,border:`1px solid ${P.ruby}22`,borderRadius:10,padding:"12px 16px",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.9}}>
        <div>🎯 FIRE target: <span style={{color:P.ruby,fontWeight:700}}>{fireDate.toLocaleDateString("en-IN",{month:"long",year:"numeric"})}</span> {yearsToFIRE>0?`(${Math.ceil(yearsToFIRE)} years away)`:""}</div>
        <div>🏄 Coast FIRE check: {totalAssets>=coastFireCorpus?<span style={{color:P.emerald,fontWeight:700}}>✅ You can stop investing & coast!</span>:<span style={{color:P.gold}}>Need ₹{fmt(Math.max(0,coastFireCorpus-totalAssets))} more to coast</span>}</div>
      </div>
    </Card>
  );
}

// ── 13: Loan Optimizer (Avalanche vs Snowball) ──
function LoanOptimizerCalc({ data, emiTotal, salary, inHand }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [extra, setExtra] = useState(5000);

  const loans = [
    { name:"IDFC", outstanding:n(d.loans?.idfc?.outstanding), minEmi:n(d.loans?.idfc?.emi), rate:n(d.loans?.idfc?.interestRate||13.5)/100/12, color:P.sapphire },
    { name:"SBI",  outstanding:n(d.loans?.sbi?.outstanding),  minEmi:n(d.loans?.sbi?.emi),  rate:n(d.loans?.sbi?.interestRate||9.35)/100/12,  color:P.orange  },
    { name:"HDFC", outstanding:n(d.loans?.hdfc?.outstanding), minEmi:n(d.loans?.hdfc?.emi), rate:n(d.loans?.hdfc?.interestRate||10.5)/100/12, color:P.ruby    },
  ];

  const simulate = (order) => {
    let loansCopy = order.map(l=>({...l, bal:l.outstanding, paid:0, interest:0}));
    let totalInterest = 0, month = 0;
    while (loansCopy.some(l=>l.bal>0.01) && month < 600) {
      let extraLeft = extra;
      for (let l of loansCopy) {
        if (l.bal <= 0) continue;
        const int = l.bal * l.rate;
        l.interest += int;
        totalInterest += int;
        l.bal = l.bal + int - l.minEmi;
        if (l.bal < 0) l.bal = 0;
      }
      // Apply extra to first non-zero loan
      const target = loansCopy.find(l=>l.bal>0);
      if (target) { target.bal = Math.max(0, target.bal - extraLeft); }
      month++;
    }
    return { months: month, totalInterest: Math.round(totalInterest) };
  };

  const avalanche = simulate([...loans].sort((a,b)=>b.rate-a.rate));
  const snowball  = simulate([...loans].sort((a,b)=>a.outstanding-b.outstanding));

  return (
    <Card accent={P.violet}>
      <SectionHead title="Loan Payoff Optimizer — Avalanche vs Snowball" icon="🏔" color={P.violet}/>
      <div style={{marginBottom:16}}>
        <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:6}}>Extra monthly payment: ₹{extra.toLocaleString("en-IN")}</label>
        <input type="range" min={0} max={30000} step={1000} value={extra} onChange={e=>setExtra(Number(e.target.value))} style={{width:"100%",accentColor:P.violet}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        {[
          {label:"🏔 Avalanche Method", sub:"Highest rate first (IDFC→HDFC→SBI)", result:avalanche, color:P.emerald, detail:"Saves most interest — mathematically optimal"},
          {label:"❄ Snowball Method",  sub:"Smallest balance first (SBI→IDFC→HDFC)", result:snowball, color:P.sapphire, detail:"Psychologically motivating — quick wins"},
        ].map((m,i)=>(
          <div key={i} style={{background:`${m.color}0F`,border:`1px solid ${m.color}33`,borderRadius:12,padding:"16px 18px"}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:800,color:m.color,marginBottom:4}}>{m.label}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:10}}>{m.sub}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.text,lineHeight:2}}>
              <div>Debt-free in: <span style={{color:m.color,fontWeight:700}}>{Math.floor(m.result.months/12)}y {m.result.months%12}m</span></div>
              <div>Total interest: <span style={{color:m.color,fontWeight:700}}>{fmt(m.result.totalInterest)}</span></div>
            </div>
            <div style={{fontFamily:"'Outfit',sans-serif",fontSize:11,color:P.muted,marginTop:8,lineHeight:1.6}}>{m.detail}</div>
          </div>
        ))}
      </div>
      <div style={{background:`${P.violet}0A`,border:`1px solid ${P.violet}22`,borderRadius:10,padding:"10px 14px",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.violet}}>
        💡 Avalanche saves <span style={{fontWeight:700}}>{fmt(Math.abs(snowball.totalInterest-avalanche.totalInterest))}</span> more interest than Snowball. Recommended: use Avalanche — pay IDFC first.
      </div>
    </Card>
  );
}

// ── 14: Real Estate Break-even ──
function RealEstateBreakEven({ data }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [appreciation, setAppreciation] = useState(8);
  const [rentalYield, setRentalYield]   = useState(3);

  const totalInvested = n(d.realEstate?.totalCost);
  const paid          = n(d.realEstate?.paid);
  const remaining     = n(d.realEstate?.remaining);

  const chartData = [];
  for (let yr = 0; yr <= 15; yr++) {
    const marketValue = totalInvested * Math.pow(1 + appreciation/100, yr);
    const rentalIncome= totalInvested * (rentalYield/100) * yr;
    chartData.push({ year:`${2024+yr}`, marketValue:Math.round(marketValue), invested:totalInvested, rentalIncome:Math.round(rentalIncome), gain:Math.round(marketValue+rentalIncome-totalInvested) });
  }
  const breakEven = chartData.find(r=>r.gain>=0);

  return (
    <Card accent={P.gold}>
      <SectionHead title="Real Estate Break-even Analysis" icon="🏡" color={P.gold}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Appreciation Rate: {appreciation}%/yr</label>
          <input type="range" min={3} max={15} step={0.5} value={appreciation} onChange={e=>setAppreciation(Number(e.target.value))} style={{width:"100%",accentColor:P.gold}}/>
        </div>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Rental Yield: {rentalYield}%/yr</label>
          <input type="range" min={1} max={8} step={0.5} value={rentalYield} onChange={e=>setRentalYield(Number(e.target.value))} style={{width:"100%",accentColor:P.gold}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"Total Cost",      v:fmt(totalInvested), color:P.text},
          {label:"2031 Value (5yr)",v:fmt(chartData[7]?.marketValue||0), color:P.gold},
          {label:"Break-even Year", v:breakEven?breakEven.year:"Never", color:P.emerald},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}22`,borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:r.color}}>{r.v}</div>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData} margin={{top:5,right:10,left:0,bottom:0}}>
          <defs>
            <linearGradient id="mvGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={P.gold} stopOpacity={.4}/><stop offset="100%" stopColor={P.gold} stopOpacity={0}/></linearGradient>
          </defs>
          <XAxis dataKey="year" tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false}/>
          <YAxis tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false} tickFormatter={v=>fmt(v)}/>
          <Tooltip content={({active,payload,label})=>active&&payload?.length?(<div style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px"}}><p style={{color:P.muted,fontSize:9,margin:"0 0 2px"}}>{label}</p>{payload.map((p,i)=><p key={i} style={{color:p.color,fontSize:11,fontWeight:600,margin:"1px 0",fontFamily:"'Fira Code',monospace"}}>{p.name}: {fmt(p.value)}</p>)}</div>):null}/>
          <Area type="monotone" dataKey="marketValue" name="Market Value" stroke={P.gold} fill="url(#mvGrad)" strokeWidth={2} dot={false}/>
          <Line type="monotone" dataKey="invested" name="Total Invested" stroke={P.muted} strokeDasharray="4 4" strokeWidth={1.5} dot={false}/>
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ── 18: SIP Step-up Calculator ──
function SIPStepUpCalc({ data, salary }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const currentMF = n(data.stocks?.summary?.mf?.current);
  const [sipAmount, setSipAmount] = useState(5000);
  const [stepUp, setStepUp]       = useState(10);
  const [returnRate, setReturnRate]= useState(12);

  const calcCorpus = (sip, stepUpPct, rate, years) => {
    let corpus = currentMF, monthly = sip;
    for (let y = 0; y < years; y++) {
      for (let m = 0; m < 12; m++) {
        corpus = corpus * (1 + rate/100/12) + monthly;
      }
      monthly = monthly * (1 + stepUpPct/100);
    }
    return Math.round(corpus);
  };

  const flat5  = calcCorpus(sipAmount, 0, returnRate, 5);
  const flat10 = calcCorpus(sipAmount, 0, returnRate, 10);
  const step5  = calcCorpus(sipAmount, stepUp, returnRate, 5);
  const step10 = calcCorpus(sipAmount, stepUp, returnRate, 10);

  const chartData = [];
  for (let y = 0; y <= 10; y++) {
    chartData.push({ year:`Y${y}`, flat:calcCorpus(sipAmount,0,returnRate,y), stepup:calcCorpus(sipAmount,stepUp,returnRate,y) });
  }
  const crDateFlat  = chartData.find(r=>r.flat>=10000000);
  const crDateStep  = chartData.find(r=>r.stepup>=10000000);

  return (
    <Card accent={P.sapphire}>
      <SectionHead title="SIP Step-up Calculator" icon="📈" color={P.sapphire}/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Monthly SIP: ₹{sipAmount.toLocaleString("en-IN")}</label>
          <input type="range" min={1000} max={50000} step={500} value={sipAmount} onChange={e=>setSipAmount(Number(e.target.value))} style={{width:"100%",accentColor:P.sapphire}}/>
        </div>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Annual Step-up: {stepUp}%</label>
          <input type="range" min={0} max={25} step={5} value={stepUp} onChange={e=>setStepUp(Number(e.target.value))} style={{width:"100%",accentColor:P.sapphire}}/>
        </div>
        <div>
          <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:4}}>Expected Return: {returnRate}%</label>
          <input type="range" min={8} max={18} step={1} value={returnRate} onChange={e=>setReturnRate(Number(e.target.value))} style={{width:"100%",accentColor:P.sapphire}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"Flat SIP — 5 Yrs",    v:fmt(flat5),  color:P.muted},
          {label:`${stepUp}% Step-up — 5 Yrs`,  v:fmt(step5),  color:P.sapphire},
          {label:"Flat SIP — 10 Yrs",   v:fmt(flat10), color:P.muted},
          {label:`${stepUp}% Step-up — 10 Yrs`, v:fmt(step10), color:P.emerald},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:800,color:r.color}}>{r.v}</div>
          </div>
        ))}
      </div>
      <div style={{marginBottom:12,padding:"10px 14px",background:`${P.sapphire}0A`,border:`1px solid ${P.sapphire}22`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.sapphire}}>
        💡 Step-up grows corpus by <span style={{fontWeight:700}}>{fmt(step10-flat10)}</span> extra over 10 years. ₹1Cr: Flat in {crDateFlat?crDateFlat.year:"10yr+"} vs Step-up in {crDateStep?crDateStep.year:"sooner"}.
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={chartData}>
          <XAxis dataKey="year" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false}/>
          <YAxis tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false} tickFormatter={v=>v>=10000000?`${Math.round(v/10000000)}Cr`:v>=100000?`${Math.round(v/100000)}L`:`${Math.round(v/1000)}K`}/>
          <Tooltip content={({active,payload,label})=>active&&payload?.length?(<div style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px"}}><p style={{color:P.muted,fontSize:9,margin:"0 0 3px"}}>{label}</p>{payload.map((p,i)=><p key={i} style={{color:p.color,fontSize:11,fontWeight:600,margin:"1px 0",fontFamily:"'Fira Code',monospace"}}>{p.name}: {fmt(p.value)}</p>)}</div>):null}/>
          <Legend wrapperStyle={{fontSize:10,fontFamily:"'Fira Code',monospace"}}/>
          <Line type="monotone" dataKey="flat"   name="Flat SIP"    stroke={P.muted}    strokeWidth={2} dot={false}/>
          <Line type="monotone" dataKey="stepup" name="Step-up SIP" stroke={P.sapphire} strokeWidth={2.5} dot={false}/>
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ── Emergency Fund Runway ──
function EmergencyFundCalc({ data, emiTotal, salary, inHand }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [emergencyFund, setEmergencyFund] = useState(50000);
  const monthlyFixed = emiTotal + n(data.income?.creditCardBills);
  const monthlyTotal = monthlyFixed + 25000; // living expenses estimate
  const runwayMonths = monthlyTotal>0 ? Math.round(emergencyFund/monthlyTotal) : 0;
  const recommended  = monthlyTotal * 6;
  const gap          = Math.max(0, recommended - emergencyFund);

  return (
    <Card accent={P.orange}>
      <SectionHead title="Emergency Fund Runway" icon="🛡" color={P.orange}/>
      <div style={{marginBottom:14}}>
        <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:6}}>Current Emergency Fund: ₹{emergencyFund.toLocaleString("en-IN")}</label>
        <input type="range" min={0} max={500000} step={5000} value={emergencyFund} onChange={e=>setEmergencyFund(Number(e.target.value))} style={{width:"100%",accentColor:P.orange}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"Monthly Burn Rate",  v:fmt(monthlyTotal), color:P.ruby,    sub:"EMIs + CC + Living"},
          {label:"Runway",             v:`${runwayMonths} mo`, color:parseFloat(runwayMonths)>=6?P.emerald:P.ruby, sub:"Months you can survive"},
          {label:"Recommended (6mo)",  v:fmt(recommended), color:P.orange,  sub:"Safe emergency buffer"},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:r.color}}>{r.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:3}}>{r.sub}</div>
          </div>
        ))}
      </div>
      {gap>0&&<div style={{background:`${P.orange}0F`,border:`1px solid ${P.orange}33`,borderRadius:10,padding:"12px 14px",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.orange,lineHeight:1.9}}>
        ⚠ You're short by <span style={{fontWeight:700}}>₹{gap.toLocaleString("en-IN")}</span> from the 6-month safety net. With current in-hand of ₹{n(inHand).toLocaleString("en-IN")}, it will take ~{Math.ceil(gap/Math.max(1,n(inHand)-monthlyTotal))} months to build it.
      </div>}
      {gap===0&&<div style={{background:`${P.emerald}0F`,border:`1px solid ${P.emerald}33`,borderRadius:10,padding:"12px 14px",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald}}>✅ Emergency fund covers 6+ months. You're protected!</div>}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — DEEP ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════
function AIAnalysisSection({ data, groqKey, totalDebt, totalAssets, netWorth, emiTotal, salary, inHand }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [analysisTab, setAnalysisTab] = useState("whatif");

  const TOOLS = [
    {id:"milestones",label:"🏁 Milestones"},
    {id:"whatif",    label:"🔮 What-If"},
    {id:"tax",       label:"🧾 Tax Planner"},
    {id:"spend",     label:"🔍 Spend Audit"},
    {id:"salaryup",  label:"💼 Salary Impact"},
    {id:"goals",     label:"🎯 Goal Tracker"},
    {id:"stress",    label:"📉 Stress Test"},
  ];

  return (
    <div className="fade">
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        {TOOLS.map(t=>(
          <button key={t.id} onClick={()=>setAnalysisTab(t.id)}
            style={{padding:"9px 16px",borderRadius:22,border:`1px solid ${analysisTab===t.id?P.sapphire+"88":P.border}`,
              background:analysisTab===t.id?`linear-gradient(135deg,${P.sapphire}33,${P.sapphire}18)`:"transparent",
              color:analysisTab===t.id?P.sapphire:P.muted,cursor:"pointer",fontFamily:"'Fira Code',monospace",
              fontSize:10,fontWeight:analysisTab===t.id?700:400,transition:"all .15s",
              boxShadow:analysisTab===t.id?`0 0 10px ${P.sapphire}33`:"none"}}>
            {t.label}
          </button>
        ))}
      </div>
      {analysisTab==="milestones"&& <MilestoneTracker data={d} groqKey={groqKey} netWorth={netWorth} totalAssets={totalAssets} totalDebt={totalDebt} inHand={inHand} emiTotal={emiTotal} salary={salary}/>}
      {analysisTab==="whatif"   && <WhatIfEngine data={d} groqKey={groqKey} systemPrompt={`You are a financial scenario analyst. Analyze what-if scenarios for ${d.settings?.name||"Naresh"} using their real data: Salary ₹${n(d.income?.salary).toLocaleString("en-IN")}, in-hand ₹${n(d.income?.inHand).toLocaleString("en-IN")}, HDFC loan ₹${Math.round(n(d.loans?.hdfc?.outstanding)).toLocaleString("en-IN")} @10.5%, IDFC ₹${Math.round(n(d.loans?.idfc?.outstanding)).toLocaleString("en-IN")} @13.5%, net worth ₹${Math.round(netWorth).toLocaleString("en-IN")}, investments ₹${Math.round(totalAssets).toLocaleString("en-IN")}. Show side-by-side current vs scenario with specific numbers. Be precise and actionable.`}/>}
      {analysisTab==="tax"      && <TaxPlanner data={d} groqKey={groqKey} salary={salary}/>}
      {analysisTab==="spend"    && <SpendAudit data={d} groqKey={groqKey}/>}
      {analysisTab==="salaryup" && <SalaryImpact data={d} salary={salary} emiTotal={emiTotal} inHand={inHand} netWorth={netWorth} totalAssets={totalAssets}/>}
      {analysisTab==="goals"    && <GoalTracker data={d} groqKey={groqKey} netWorth={netWorth} totalAssets={totalAssets} totalDebt={totalDebt} inHand={inHand} emiTotal={emiTotal}/>}
      {analysisTab==="stress"   && <DebtStressTest data={d} salary={salary} emiTotal={emiTotal} inHand={inHand} totalDebt={totalDebt}/>}
    </div>
  );
}

// ── MILESTONE TRACKER ──
function MilestoneTracker({ data, groqKey, netWorth, totalAssets, totalDebt, inHand, emiTotal, salary }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [loading, setLoading] = useState(false);
  const [roadmap, setRoadmap] = useState(null);
  const d = data;

  const monthlyCap = Math.max(1, n(inHand) - 15000);
  const now = new Date(2026, 2, 1);
  const projDate = (months) => months <= 0 ? "Done ✅" : months > 600 ? "50yr+" :
    new Date(now.getFullYear(), now.getMonth() + months, 1).toLocaleDateString("en-IN", {month:"short", year:"numeric"});

  const idfcOut = n(d.loans?.idfc?.outstanding);
  const sbiOut  = n(d.loans?.sbi?.outstanding);
  const lcPool  = n(d.lendenClub?.totalPooled);

  const milestones = [
    {
      id:1, icon:"🏦", label:"Clear IDFC Loan", sub:"Highest interest — 13.5%",
      color:P.ruby,
      current: idfcOut > 0 ? Math.max(0, 1 - idfcOut / (idfcOut + n(d.loans?.idfc?.emi) * Math.max(1, n(d.loans?.idfc?.paid||18)))) * 100 : 100,
      gap: idfcOut,
      monthsLeft: idfcOut > 0 ? Math.ceil(idfcOut / n(d.loans?.idfc?.emi||1)) : 0,
      priority: 1,
    },
    {
      id:2, icon:"🏦", label:"Clear SBI Loan", sub:"9.35% — second priority",
      color:P.orange,
      current: sbiOut > 0 ? Math.max(0, 1 - sbiOut / (sbiOut + n(d.loans?.sbi?.emi) * Math.max(1, n(d.loans?.sbi?.paid||1)))) * 100 : 100,
      gap: sbiOut,
      monthsLeft: sbiOut > 0 ? Math.ceil(sbiOut / n(d.loans?.sbi?.emi||1)) : 0,
      priority: 2,
    },
    {
      id:3, icon:"📊", label:"₹10L Total Investments", sub:"Equity + MF + P2P",
      color:P.sapphire,
      current: Math.min(100, (totalAssets / 1000000) * 100),
      gap: Math.max(0, 1000000 - totalAssets),
      monthsLeft: Math.max(0, 1000000 - totalAssets) > 0 ? Math.ceil(Math.max(0, 1000000 - totalAssets) / monthlyCap) : 0,
      priority: 3,
    },
    {
      id:4, icon:"🏛", label:"₹5L LendenClub Pool", sub:"~10% annual returns",
      color:P.rose,
      current: Math.min(100, (lcPool / 500000) * 100),
      gap: Math.max(0, 500000 - lcPool),
      monthsLeft: Math.max(0, 500000 - lcPool) > 0 ? Math.ceil(Math.max(0, 500000 - lcPool) / (monthlyCap * 0.3)) : 0,
      priority: 4,
    },
    {
      id:5, icon:"💎", label:"₹1 Crore Net Worth", sub:"The big milestone",
      color:P.gold,
      current: Math.min(100, Math.max(0, (netWorth / 10000000) * 100)),
      gap: Math.max(0, 10000000 - netWorth),
      monthsLeft: Math.max(0, 10000000 - netWorth) > 0 ? Math.ceil(Math.max(0, 10000000 - netWorth) / monthlyCap) : 0,
      priority: 5,
    },
  ];

  const runRoadmap = async () => {
    setLoading(true); setRoadmap(null);
    try {
      const reply = await groqChat({ key:groqKey, messages:[{role:"user", content:`Create a prioritized financial roadmap for ${d.settings?.name||"Naresh"} to achieve all 5 milestones:

Current status:
1. IDFC Loan: ₹${Math.round(idfcOut).toLocaleString("en-IN")} outstanding @ 13.5% — ${milestones[0].monthsLeft} months to clear at current EMI
2. SBI Loan: ₹${Math.round(sbiOut).toLocaleString("en-IN")} outstanding @ 9.35% — ${milestones[1].monthsLeft} months to clear
3. ₹10L Investments: ${milestones[2].current.toFixed(0)}% reached — gap ₹${Math.round(milestones[2].gap).toLocaleString("en-IN")}
4. ₹5L LendenClub: ${milestones[3].current.toFixed(0)}% reached — gap ₹${Math.round(milestones[3].gap).toLocaleString("en-IN")}
5. ₹1Cr Net Worth: ${milestones[4].current.toFixed(0)}% reached — gap ₹${Math.round(milestones[4].gap).toLocaleString("en-IN")}

Monthly savings capacity: ₹${monthlyCap.toLocaleString("en-IN")}
Monthly salary: ₹${salary.toLocaleString("en-IN")} | In-hand: ₹${n(inHand).toLocaleString("en-IN")}

Provide: (1) Recommended order to tackle milestones and why (2) Specific monthly allocation across goals (3) Quick win that improves multiple milestones at once (4) Realistic timeline for hitting all 5. Be specific with ₹ numbers and dates.`}] });
      setRoadmap(reply);
    } catch(e) { setRoadmap("Error: "+e.message); }
    setLoading(false);
  };

  return (
    <Card accent={P.gold}>
      <SectionHead title="Milestone Tracker — Your Financial Journey" icon="🏁" color={P.gold}/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:14,marginBottom:16}}>
        {milestones.map(m=>{
          const pct = Math.min(100, Math.max(0, m.current));
          const done = pct >= 100;
          return (
            <div key={m.id} style={{background:`${m.color}0A`,border:`1px solid ${m.color}${done?"66":"33"}`,borderRadius:14,padding:"16px 14px",textAlign:"center",position:"relative"}}>
              {done && <div style={{position:"absolute",top:8,right:10,background:`${P.emerald}22`,border:`1px solid ${P.emerald}44`,borderRadius:20,padding:"2px 7px",fontFamily:"'Fira Code',monospace",fontSize:8,fontWeight:700,color:P.emerald}}>DONE ✅</div>}
              {!done && <div style={{position:"absolute",top:8,right:10,background:`${m.color}18`,border:`1px solid ${m.color}33`,borderRadius:20,padding:"2px 7px",fontFamily:"'Fira Code',monospace",fontSize:8,fontWeight:700,color:m.color}}>#{m.priority}</div>}
              <div style={{display:"flex",justifyContent:"center",marginBottom:10}}>
                <DonutRing pct={pct} color={done?P.emerald:m.color} size={90} stroke={8} label={done?"✓":`${pct.toFixed(0)}%`} sub={done?"":"done"}/>
              </div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700,color:done?P.emerald:m.color,marginBottom:3}}>{m.icon} {m.label}</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:8}}>{m.sub}</div>
              {!done && (
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,lineHeight:1.9}}>
                  <div>Gap: <span style={{color:P.text,fontWeight:600}}>₹{Math.round(m.gap).toLocaleString("en-IN")}</span></div>
                  <div>Est: <span style={{color:m.monthsLeft<=36?P.emerald:P.ruby,fontWeight:600}}>{projDate(m.monthsLeft)}</span></div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Timeline connector */}
      <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:16,overflowX:"auto",padding:"8px 0"}}>
        {milestones.map((m,i)=>{
          const pct = Math.min(100,Math.max(0,m.current));
          const done = pct>=100;
          return (
            <React.Fragment key={m.id}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",minWidth:80}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:done?P.emerald:pct>0?m.color:P.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,border:`2px solid ${done?P.emerald:m.color}`,boxShadow:done?`0 0 10px ${P.emerald}55`:pct>0?`0 0 8px ${m.color}44`:"none"}}>{done?"✓":m.icon}</div>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:done?P.emerald:P.muted,marginTop:4,textAlign:"center",maxWidth:70}}>{m.label}</div>
              </div>
              {i<milestones.length-1 && <div style={{flex:1,height:2,background:`linear-gradient(90deg,${milestones[i].current>=100?P.emerald:milestones[i].color}44,${P.border})`,minWidth:20}}/>}
            </React.Fragment>
          );
        })}
      </div>

      <button onClick={runRoadmap} disabled={loading}
        style={{width:"100%",background:loading?P.border:`linear-gradient(135deg,${P.gold},${P.violet})`,border:"none",borderRadius:12,padding:"13px 0",color:"#050D1A",cursor:loading?"not-allowed":"pointer",fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,marginBottom:roadmap?14:0,
          boxShadow:loading?"none":`0 0 20px ${P.gold}44`}}>
        {loading?"🔄 Arth is building your roadmap…":"🗺 Arth: Build My Priority Roadmap"}
      </button>
      {roadmap&&(
        <div style={{background:P.card3,border:`1px solid ${P.gold}33`,borderRadius:12,padding:"16px 18px",fontFamily:"'Outfit',sans-serif",fontSize:13,color:P.text,lineHeight:1.85,maxHeight:400,overflowY:"auto"}}
          dangerouslySetInnerHTML={{__html:renderMD(roadmap)}}/>
      )}
    </Card>
  );
}

// ── 15: What-If Scenario Engine ──
function WhatIfEngine({ data, groqKey, systemPrompt }) {
  const [scenario, setScenario] = useState("");
  const [result, setResult]     = useState(null);
  const [loading, setLoading]   = useState(false);

  const SCENARIOS = [
    "What if I prepay ₹5 lakh on HDFC loan right now?",
    "What if I increase my SIP from ₹5K to ₹15K per month?",
    "What if I exit my personal lending and invest in index funds?",
    "What if I lose my job for 6 months?",
    "What if real estate appreciates 15%/yr for next 5 years?",
    "What if I take ₹10 lakh additional loan to invest in LendenClub?",
  ];

  const runScenario = async (sc) => {
    const s = sc || scenario.trim();
    if (!s || loading) return;
    setLoading(true); setResult(null);
    try {
      const reply = await groqChat({ key:groqKey, system:systemPrompt, messages:[{role:"user",content:`Analyze this scenario with real numbers: "${s}"\n\nProvide:\n1. CURRENT SITUATION (with actual numbers)\n2. SCENARIO OUTCOME (what changes, what doesn't)\n3. NET IMPACT (better or worse, by how much ₹)\n4. RECOMMENDATION (should they do it?)\n\nBe specific. Use ₹ amounts. Keep it under 250 words.`}] });
      setResult(reply);
    } catch(e) { setResult("Error: "+e.message); }
    setLoading(false);
  };

  return (
    <Card accent={P.sapphire}>
      <SectionHead title="What-If Scenario Engine" icon="🔮" color={P.sapphire}/>
      <div style={{display:"flex",gap:10,marginBottom:12}}>
        <input value={scenario} onChange={e=>setScenario(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&runScenario()}
          placeholder='Type any scenario… e.g. "What if I prepay ₹3L on IDFC loan?"'
          style={{flex:1,background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"11px 14px",color:P.text,fontFamily:"'Outfit',sans-serif",fontSize:13,outline:"none"}}
        />
        <button onClick={()=>runScenario()} disabled={loading||!scenario.trim()}
          style={{background:loading||!scenario.trim()?P.border:`linear-gradient(135deg,${P.sapphire},${P.teal})`,border:"none",borderRadius:10,padding:"11px 20px",color:"#050D1A",cursor:loading||!scenario.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
          {loading?"⏳ Analyzing…":"🔮 Run"}
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:14}}>
        {SCENARIOS.map((s,i)=>(
          <button key={i} onClick={()=>runScenario(s)} disabled={loading}
            style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",color:P.muted,cursor:loading?"not-allowed":"pointer",fontFamily:"'Outfit',sans-serif",fontSize:11,textAlign:"left",transition:"all .15s",lineHeight:1.4}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=P.sapphire+"66";e.currentTarget.style.color=P.text;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=P.border;e.currentTarget.style.color=P.muted;}}>
            {s}
          </button>
        ))}
      </div>
      {loading&&<div style={{textAlign:"center",padding:"20px",fontFamily:"'Fira Code',monospace",fontSize:11,color:P.sapphire}}>🔮 Arth is running your scenario with real numbers…</div>}
      {result&&(
        <div style={{background:P.card3,border:`1px solid ${P.sapphire}33`,borderRadius:12,padding:"16px 18px",fontFamily:"'Outfit',sans-serif",fontSize:13,color:P.text,lineHeight:1.8}}
          dangerouslySetInnerHTML={{__html:renderMD(result)}}/>
      )}
    </Card>
  );
}

// ── 16: Tax Planner ──
function TaxPlanner({ data, groqKey, salary }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);

  const grossAnnual = n(d.income?.grossTotal||salary) * 12;
  const optionspl   = n(d.stocks?.summary?.options?.pl);
  const cryptoGain  = n(d.stocks?.summary?.crypto?.pl);
  const used80c     = n(d.income?.taxDeducted)>0 ? 150000 : 0;
  const homeInterest= n(d.loans?.hdfc?.outstanding)*0.105;

  const calcOldRegime = () => {
    let taxable = grossAnnual;
    taxable -= 50000; // standard deduction
    taxable -= Math.min(150000, used80c);
    taxable -= Math.min(200000, homeInterest);
    taxable = Math.max(0, taxable);
    if (taxable<=250000) return 0;
    let tax = 0;
    if (taxable>1000000) { tax += (taxable-1000000)*0.30; taxable=1000000; }
    if (taxable>500000)  { tax += (taxable-500000)*0.20;  taxable=500000;  }
    if (taxable>250000)  { tax += (taxable-250000)*0.05;  }
    return Math.round(tax * 1.04); // +4% cess
  };

  const calcNewRegime = () => {
    let taxable = Math.max(0, grossAnnual - 75000); // std deduction new regime
    if (taxable<=300000) return 0;
    let tax = 0;
    const slabs = [[300000,600000,0.05],[600000,900000,0.10],[900000,1200000,0.15],[1200000,1500000,0.20],[1500000,Infinity,0.30]];
    for (const [lo,hi,rate] of slabs) {
      if (taxable>lo) tax += (Math.min(taxable,hi)-lo)*rate;
    }
    return Math.round(tax * 1.04);
  };

  const oldTax = calcOldRegime();
  const newTax = calcNewRegime();
  const saving = Math.abs(oldTax-newTax);
  const better = oldTax<newTax?"Old":"New";

  const runFullAnalysis = async () => {
    setLoading(true);
    try {
      const reply = await groqChat({ key:groqKey, messages:[{role:"user",content:`Do a complete tax analysis for ${d.settings?.name||"Naresh"} FY 2025-26:

Gross annual income: ₹${grossAnnual.toLocaleString("en-IN")}
Home loan interest paid: ₹${Math.round(homeInterest).toLocaleString("en-IN")} (Section 24(b) — max ₹2L deduction)
80C used: ₹${used80c.toLocaleString("en-IN")} (limit ₹1.5L)
F&O P&L: ₹${optionspl.toLocaleString("en-IN")} (speculative income)
Crypto gains: ₹${cryptoGain.toLocaleString("en-IN")} (30% flat tax, no offsetting)
Old regime tax: ₹${oldTax.toLocaleString("en-IN")}
New regime tax: ₹${newTax.toLocaleString("en-IN")}

Cover: (1) Which regime is better and by how much (2) Unused 80C opportunity (3) NPS 80CCD(1B) deduction available (4) F&O loss implications (5) Crypto tax obligation (6) Advance tax deadlines. Be specific with ₹ amounts.`}] });
      setAnalysis(reply);
    } catch(e) { setAnalysis("Error: "+e.message); }
    setLoading(false);
  };

  return (
    <Card accent={P.gold}>
      <SectionHead title="Tax Planner — FY 2025-26" icon="🧾" color={P.gold}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        {[
          {label:"Old Regime Tax",       v:`₹${oldTax.toLocaleString("en-IN")}`,       color:oldTax<newTax?P.emerald:P.ruby, sub:`${Math.round((oldTax/grossAnnual)*100)}% effective rate`},
          {label:"New Regime Tax",       v:`₹${newTax.toLocaleString("en-IN")}`,       color:newTax<oldTax?P.emerald:P.ruby, sub:`${Math.round((newTax/grossAnnual)*100)}% effective rate`},
          {label:"Better Regime",        v:`${better} Regime`,                          color:P.emerald, sub:`Saves ₹${saving.toLocaleString("en-IN")}`},
          {label:"Crypto Tax Due (30%)", v:`₹${Math.round(cryptoGain*0.3).toLocaleString("en-IN")}`, color:P.ruby, sub:"No offsetting allowed"},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:r.color}}>{r.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:3}}>{r.sub}</div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
        {[
          {label:"80C Gap",     v:`₹${Math.max(0,150000-used80c).toLocaleString("en-IN")}`, sub:"Invest in ELSS/PPF", color:P.violet},
          {label:"NPS 80CCD(1B)",v:"₹50,000",       sub:"Extra deduction available",         color:P.sapphire},
          {label:"Home Int 24(b)",v:fmt(Math.min(200000,homeInterest)), sub:"Old regime only",   color:P.teal},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0A`,border:`1px solid ${r.color}22`,borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:3}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:800,color:r.color}}>{r.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginTop:2}}>{r.sub}</div>
          </div>
        ))}
      </div>
      <button onClick={runFullAnalysis} disabled={loading}
        style={{width:"100%",background:loading?P.border:`linear-gradient(135deg,${P.gold},${P.orange})`,border:"none",borderRadius:10,padding:"11px 0",color:"#050D1A",cursor:loading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,marginBottom:analysis?12:0}}>
        {loading?"🔄 Analysing…":"🧾 Full AI Tax Analysis"}
      </button>
      {analysis&&<div style={{background:P.card3,border:`1px solid ${P.gold}33`,borderRadius:12,padding:"14px 18px",fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.8,maxHeight:320,overflowY:"auto"}} dangerouslySetInnerHTML={{__html:renderMD(analysis)}}/>}
    </Card>
  );
}

// ── 17: Spend Audit ──
function SpendAudit({ data, groqKey }) {
  const d = data;
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [loading, setLoading] = useState(false);
  const [audit, setAudit]     = useState(null);

  const expenses = d.dailyExpenses || [];
  const catTotals = expenses.reduce((acc,e)=>{ acc[e.category]=(acc[e.category]||0)+n(e.amount); return acc; },{});
  const sortedCats = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const subscriptions = expenses.filter(e=>e.mode==="Auto-Debit");

  const runAudit = async () => {
    setLoading(true);
    try {
      const reply = await groqChat({ key:groqKey, messages:[{role:"user",content:`Analyze spending patterns for ${d.settings?.name||"Naresh"} and flag issues:

Category totals this month: ${JSON.stringify(catTotals)}
Auto-debit subscriptions: ${JSON.stringify(subscriptions.map(e=>({desc:e.desc,amount:n(e.amount)})))}
Budget vs actual: ${JSON.stringify({budget:d.budget, actual:d.budget?.actual})}
Income this month: ₹${n(d.income?.inHand).toLocaleString("en-IN")}

Identify: (1) Top 3 overspend categories vs budget (2) Any forgotten/unnecessary subscriptions (3) Unusual spending patterns (4) 2 specific cuts that would free up most cash. Be direct and specific.`}] });
      setAudit(reply);
    } catch(e) { setAudit("Error: "+e.message); }
    setLoading(false);
  };

  return (
    <Card accent={P.rose}>
      <SectionHead title="Spend Audit — Pattern Analysis" icon="🔍" color={P.rose}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:8,letterSpacing:1,textTransform:"uppercase"}}>Category Breakdown</div>
          {sortedCats.map(([cat,amt],i)=>(
            <div key={i} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.text}}>{cat}</span>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:CC[i%CC.length],fontWeight:600}}>₹{amt.toLocaleString("en-IN")}</span>
              </div>
              <PBar value={amt} max={sortedCats[0]?.[1]||1} color={CC[i%CC.length]} height={4}/>
            </div>
          ))}
        </div>
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:8,letterSpacing:1,textTransform:"uppercase"}}>Auto-debit Subscriptions</div>
          {subscriptions.length===0 ? (
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>No auto-debits found this month.</div>
          ) : subscriptions.map((s,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"7px 10px",background:`${P.rose}0A`,border:`1px solid ${P.rose}22`,borderRadius:8,marginBottom:6}}>
              <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.text}}>{s.desc}</span>
              <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.rose,fontWeight:600}}>₹{n(s.amount).toLocaleString("en-IN")}</span>
            </div>
          ))}
        </div>
      </div>
      <button onClick={runAudit} disabled={loading}
        style={{width:"100%",background:loading?P.border:`linear-gradient(135deg,${P.rose},${P.violet})`,border:"none",borderRadius:10,padding:"11px 0",color:"#fff",cursor:loading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,marginBottom:audit?12:0}}>
        {loading?"🔍 Auditing…":"🔍 Run AI Spend Audit"}
      </button>
      {audit&&<div style={{background:P.card3,border:`1px solid ${P.rose}33`,borderRadius:12,padding:"14px 18px",fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.8}} dangerouslySetInnerHTML={{__html:renderMD(audit)}}/>}
    </Card>
  );
}

// ── Salary Impact Simulator ──
function SalaryImpact({ data, salary, emiTotal, inHand, netWorth, totalAssets }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [hikePct, setHikePct] = useState(15);

  const newSalary  = Math.round(salary * (1 + hikePct/100));
  const newInHand  = Math.round(newSalary * (n(inHand)/Math.max(1,salary)));
  const extraMonthly = newInHand - n(inHand);
  const extraAnnual  = extraMonthly * 12;

  return (
    <Card accent={P.violet}>
      <SectionHead title="Salary Hike Impact Simulator" icon="💼" color={P.violet}/>
      <div style={{marginBottom:16}}>
        <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:6}}>Salary hike: {hikePct}%</label>
        <input type="range" min={5} max={50} step={5} value={hikePct} onChange={e=>setHikePct(Number(e.target.value))} style={{width:"100%",accentColor:P.violet}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"New Salary",      v:fmt(newSalary),    color:P.gold,    sub:`Was ${fmt(salary)}`},
          {label:"New In-Hand",     v:fmt(newInHand),    color:P.emerald, sub:`+₹${extraMonthly.toLocaleString("en-IN")}/mo`},
          {label:"Extra/Year",      v:fmt(extraAnnual),  color:P.sapphire,sub:"Post-tax estimate"},
          {label:"EMI % New Salary",v:`${newSalary>0?Math.round((emiTotal/newSalary)*100):0}%`, color:emiTotal/newSalary<0.4?P.emerald:P.gold, sub:`Was ${salary>0?Math.round((emiTotal/salary)*100):0}%`},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:r.color}}>{r.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:3}}>{r.sub}</div>
          </div>
        ))}
      </div>
      <div style={{background:`${P.violet}0A`,border:`1px solid ${P.violet}22`,borderRadius:10,padding:"12px 16px",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:2}}>
        <div>With ₹{extraMonthly.toLocaleString("en-IN")}/mo extra: put <span style={{color:P.emerald}}>₹{Math.round(extraMonthly*0.5).toLocaleString("en-IN")}</span> toward IDFC prepayment + <span style={{color:P.sapphire}}>₹{Math.round(extraMonthly*0.3).toLocaleString("en-IN")}</span> in SIP + <span style={{color:P.gold}}>₹{Math.round(extraMonthly*0.2).toLocaleString("en-IN")}</span> emergency fund</div>
        <div>Net worth acceleration: <span style={{color:P.violet,fontWeight:700}}>+₹{fmt(extraAnnual*3)}</span> over 3 years vs current trajectory</div>
      </div>
    </Card>
  );
}

// ── Goal Tracker ──
function GoalTracker({ data, groqKey, netWorth, totalAssets, totalDebt, inHand, emiTotal }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [loading, setLoading] = useState(false);
  const [check, setCheck]     = useState(null);

  const monthlyCap = Math.max(1, n(inHand) - 15000);
  const goals = [
    { name:"Clear IDFC Loan",      target:n(data.loans?.idfc?.outstanding), current:n(data.loans?.idfc?.outstanding), unit:"outstanding", color:P.ruby,     icon:"🏦", lower:true,  monthlyPay:n(data.loans?.idfc?.emi) },
    { name:"Clear SBI Loan",       target:n(data.loans?.sbi?.outstanding),  current:n(data.loans?.sbi?.outstanding),  unit:"outstanding", color:P.orange,   icon:"🏦", lower:true,  monthlyPay:n(data.loans?.sbi?.emi)  },
    { name:"₹1 Crore Net Worth",   target:10000000,  current:Math.max(0,netWorth),            unit:"net worth",   color:P.gold,     icon:"💎", lower:false, monthlyPay:0 },
    { name:"₹5L LendenClub Pool",  target:500000,    current:n(data.lendenClub?.totalPooled), unit:"pool",        color:P.rose,     icon:"🏛", lower:false, monthlyPay:0 },
    { name:"₹10L Investments",     target:1000000,   current:totalAssets,                     unit:"investments", color:P.sapphire, icon:"📊", lower:false, monthlyPay:0 },
    { name:"6mo Emergency Fund",   target:emiTotal*6,current:50000,                           unit:"saved",       color:P.teal,     icon:"🛡", lower:false, monthlyPay:0 },
  ];

  const runCheck = async () => {
    setLoading(true);
    try {
      const reply = await groqChat({ key:groqKey, messages:[{role:"user",content:`Review goal progress for ${data.settings?.name||"Naresh"} and give an honest assessment:

Goals: ${JSON.stringify(goals.map(g=>({name:g.name, progress:`${Math.min(100,g.lower?(g.current>0?(1-g.current/Math.max(1,g.target+g.current))*100:100):(g.target>0?(g.current/g.target)*100:100)).toFixed(0)}%`, current:g.current, target:g.target})))}
Monthly savings capacity: ₹${Math.max(0,n(inHand)-15000).toLocaleString("en-IN")}
Net worth: ₹${Math.round(netWorth).toLocaleString("en-IN")}

For each goal: on-track or off-track? What's the specific action to accelerate it? Keep it to 2-3 lines per goal.`}] });
      setCheck(reply);
    } catch(e) { setCheck("Error: "+e.message); }
    setLoading(false);
  };

  return (
    <Card accent={P.gold}>
      <SectionHead title="Goal Tracker — Monthly Check-in" icon="🎯" color={P.gold}/>
      <div style={{display:"grid",gap:10,marginBottom:14}}>
        {goals.map((g,i)=>{
          const prog = g.lower
            ? (g.current>0?(1-g.current/(g.target+g.current+1))*100:100)
            : (g.target>0?(g.current/g.target)*100:100);
          const pct  = Math.min(100,Math.max(0,prog));
          const gap  = g.lower ? g.current : Math.max(0, g.target - g.current);
          const monthlyNeeded = g.lower ? g.monthlyPay : (monthlyCap > 0 ? monthlyCap : 1);
          const monthsLeft = gap > 0 ? Math.ceil(gap / monthlyNeeded) : 0;
          const projDate = monthsLeft > 0 ? new Date(2026, 2 + monthsLeft, 1).toLocaleDateString("en-IN",{month:"short",year:"numeric"}) : "Done ✅";
          const onTrack = monthsLeft <= 36;
          const badgeColor = pct>=100?P.emerald:onTrack?P.gold:P.ruby;
          const badgeLabel = pct>=100?"DONE":onTrack?"ON TRACK":"BEHIND";
          return (
            <div key={i} style={{background:P.card3,border:`1px solid ${badgeColor}22`,borderRadius:12,padding:"14px 16px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700,color:P.text}}>{g.icon} {g.name}</span>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{background:`${badgeColor}22`,border:`1px solid ${badgeColor}44`,borderRadius:20,padding:"2px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,fontWeight:700,color:badgeColor}}>{badgeLabel}</span>
                  <span style={{fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,color:g.color}}>{pct.toFixed(0)}%</span>
                </div>
              </div>
              <PBar value={pct} max={100} color={g.color} height={7}/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:8}}>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>
                  Remaining<div style={{color:P.text,fontWeight:600,fontSize:10}}>₹{Math.round(gap).toLocaleString("en-IN")}</div>
                </div>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>
                  Need/mo<div style={{color:g.color,fontWeight:600,fontSize:10}}>₹{Math.round(monthlyNeeded).toLocaleString("en-IN")}</div>
                </div>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>
                  Est. date<div style={{color:onTrack?P.emerald:P.ruby,fontWeight:600,fontSize:10}}>{projDate}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={runCheck} disabled={loading}
        style={{width:"100%",background:loading?P.border:`linear-gradient(135deg,${P.gold},${P.orange})`,border:"none",borderRadius:10,padding:"11px 0",color:"#050D1A",cursor:loading?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,marginBottom:check?12:0}}>
        {loading?"🔄 Checking…":"🎯 AI Goal Review"}
      </button>
      {check&&<div style={{background:P.card3,border:`1px solid ${P.gold}33`,borderRadius:12,padding:"14px 18px",fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.8,maxHeight:300,overflowY:"auto"}} dangerouslySetInnerHTML={{__html:renderMD(check)}}/>}
    </Card>
  );
}

// ── Debt Stress Test ──
function DebtStressTest({ data, salary, emiTotal, inHand, totalDebt }) {
  const n = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const [dropPct, setDropPct] = useState(20);

  const newSalary    = Math.round(salary * (1-dropPct/100));
  const newInHand    = Math.round(n(inHand) * (1-dropPct/100));
  const canPayEmis   = newInHand >= emiTotal;
  const shortfall    = Math.max(0, emiTotal - newInHand);
  const runwayMonths = shortfall>0 ? Math.floor(100000/shortfall) : 99; // assume ₹1L savings

  const scenarios = [
    {drop:10, label:"Minor setback", color:P.gold},
    {drop:20, label:"Job loss", color:P.orange},
    {drop:50, label:"Major crisis", color:P.ruby},
  ];

  return (
    <Card accent={P.ruby}>
      <SectionHead title="Debt Stress Test — Salary Drop Scenario" icon="📉" color={P.ruby}/>
      <div style={{marginBottom:16}}>
        <label style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"block",marginBottom:6}}>Salary drop: {dropPct}%</label>
        <input type="range" min={5} max={100} step={5} value={dropPct} onChange={e=>setDropPct(Number(e.target.value))} style={{width:"100%",accentColor:P.ruby}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"New Monthly Salary", v:fmt(newSalary), color:P.ruby},
          {label:"New In-Hand",        v:fmt(newInHand), color:newInHand>=emiTotal?P.gold:P.ruby},
          {label:"Total EMIs",         v:fmt(emiTotal),  color:P.orange},
        ].map((r,i)=>(
          <div key={i} style={{background:`${r.color}0F`,border:`1px solid ${r.color}33`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4}}>{r.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:r.color}}>{r.v}</div>
          </div>
        ))}
      </div>
      <div style={{background:canPayEmis?`${P.emerald}0A`:`${P.ruby}0A`,border:`1px solid ${canPayEmis?P.emerald:P.ruby}33`,borderRadius:12,padding:"14px 18px",marginBottom:14}}>
        <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:700,color:canPayEmis?P.emerald:P.ruby,marginBottom:6}}>
          {canPayEmis?"✅ You can still pay all EMIs":"🚨 EMI Shortfall Alert"}
        </div>
        <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.9}}>
          {canPayEmis
            ? `Buffer after EMIs: ₹${(newInHand-emiTotal).toLocaleString("en-IN")}/mo — tighten discretionary spend`
            : `Monthly shortfall: ₹${shortfall.toLocaleString("en-IN")} | Savings runway: ~${runwayMonths} months before default risk`}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
        {scenarios.map((s,i)=>{
          const sh = Math.round(n(inHand)*(1-s.drop/100));
          return (
            <div key={i} style={{background:`${s.color}0A`,border:`1px solid ${s.color}22`,borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:3}}>{s.drop}% drop — {s.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700,color:s.color}}>{sh>=emiTotal?"✅ Safe":"⚠ Risk"}</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:2}}>In-hand: {fmt(sh)}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}


// ─── LENDEN CLUB TAB ──────────────────────────────────────────────────────────
function LendenClubTab({ data }) {
  const d = data;
  const [monthlyMonthNameFilter, setMonthlyMonthNameFilter] = useState("ALL_MONTHS");
  const [monthlyYearFilter, setMonthlyYearFilter] = useState("ALL_YEARS");
  const [loanMonthNameFilter, setLoanMonthNameFilter] = useState("ALL_MONTHS");
  const [loanYearFilter, setLoanYearFilter] = useState("ALL_YEARS");
  const [loanQuery, setLoanQuery] = useState("");
  const [repayFilter, setRepayFilter] = useState("");

  const enrichLoan = (loan) => {
    const rawStatus = String(loan.status || "").trim().toUpperCase();
    const rawPrincipalRecv = n(loan.principalRecv);
    const rawInterestRecv = n(loan.interestRecv);
    const rawTotalRecv = n(loan.totalRecv);
    const principalLooksLikeTotal = rawTotalRecv > 0 && Math.abs(rawPrincipalRecv - rawTotalRecv) < 0.5 && rawInterestRecv > 0;
    const principalOverCounts = rawTotalRecv > 0 && rawPrincipalRecv + rawInterestRecv > rawTotalRecv + 0.5;
    const normalizedPrincipalRecv = (principalLooksLikeTotal || principalOverCounts)
      ? Math.max(0, rawTotalRecv - rawInterestRecv)
      : (rawPrincipalRecv || (rawTotalRecv > 0 ? Math.max(0, rawTotalRecv - rawInterestRecv) : 0));
    const disbursedOn = parseDateValue(loan.disbDate);
    const closedOn = parseDateValue(loan.closure);
    const repayStartOn = parseDateValue(loan.repayStart);
    const dueOn = parseDateValue(loan.expectedClose) || (disbursedOn && loan.tenure ? addMonths(disbursedOn, loan.tenure) : null);
    const principalFullyRecovered = n(loan.amount) > 0 && normalizedPrincipalRecv >= (n(loan.amount) - 0.5);
    const isClosed = /closed|completed|repaid|settled/i.test(rawStatus) || Boolean(closedOn) || principalFullyRecovered;
    const isExplicitPending = /pending|processing|live|ongoing/i.test(rawStatus);
    const derivedStatus = isClosed ? "CLOSED" : isExplicitPending ? "PENDING" : "ACTIVE";
    let repaymentStatus = "On Track";
    if (derivedStatus === "CLOSED") { repaymentStatus = "Closed"; }
    else if (n(loan.npa) > 0 || /npa|default|written off/i.test(rawStatus)) { repaymentStatus = "NPA"; }
    else if (n(loan.dpd) > 0 || /overdue|delayed|late/i.test(rawStatus)) { repaymentStatus = "OVERDUE"; }
    else if (repayStartOn instanceof Date && !Number.isNaN(repayStartOn.getTime())) {
      const today = new Date(); today.setHours(0,0,0,0); repayStartOn.setHours(0,0,0,0);
      const diffDays = Math.round((repayStartOn.getTime()-today.getTime())/(24*60*60*1000));
      if (diffDays===0) repaymentStatus="DUE TODAY";
      else if (diffDays>0&&diffDays<=7) repaymentStatus="DUE SOON";
    }
    const closedMonths = isClosed&&disbursedOn&&closedOn ? diffMonthsBetweenDates(disbursedOn,closedOn) : 0;
    const monthlyRateToClose = isClosed&&loan.amount>0&&closedMonths>0 ? +(((rawInterestRecv/loan.amount)/closedMonths)*100).toFixed(2) : 0;
    const outstandingAmount = Math.max(0, n(loan.amount)-normalizedPrincipalRecv);
    return { ...loan, principalRecv:normalizedPrincipalRecv, interestRecv:rawInterestRecv, totalRecv:rawTotalRecv, status:derivedStatus, rawStatus, dueDate:dueOn?fmtDate(dueOn):"-", monthsToClose:closedMonths, monthlyRateToClose, outstandingAmount, rs:repaymentStatus };
  };

  const allLoans = (d.lendenClub.loanSamples||[]).map(enrichLoan);
  const monthlyLoanRows = (d.lendenClub.monthlyLoanRows||[]).map(enrichLoan);
  const parseTabParts = (tab) => { const raw=String(tab||"").trim(); const match=raw.match(/^([A-Za-z]{3})[-/ ](\d{2,4})$/); if(!match) return {month:raw,year:""}; const year=String(match[2]).length===2?`20${match[2]}`:String(match[2]); return {month:match[1],year}; };
  const monthOrder = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const getDateParts = (value) => { const raw=String(value||"").trim(); let parsed=null; const nm=raw.match(/^(\d{1,2})[-\/ ](\d{1,2})[-\/ ](\d{2,4})$/); if(nm){const day=Number(nm[1]),month=Number(nm[2])-1;let year=Number(nm[3]);if(year<100)year+=2000;parsed=new Date(year,month,day);}else{parsed=parseDateValue(raw);} if(!(parsed instanceof Date)||Number.isNaN(parsed.getTime())) return null; return {month:monthOrder[parsed.getMonth()],year:String(parsed.getFullYear())}; };
  const allTabLabels = Array.from(new Set([...d.lendenClub.tabSummary.map(t=>String(t.tab||"").trim()).filter(Boolean),...monthlyLoanRows.map(l=>String(l.tab||"").trim()).filter(Boolean),...allLoans.map(l=>String(l.tab||"").trim()).filter(Boolean)])).sort((a,b)=>lendenTabKey(a)-lendenTabKey(b));
  const yearOptions = ["ALL_YEARS",...Array.from(new Set(allTabLabels.map(tab=>parseTabParts(tab).year).filter(Boolean))).sort()];
  const monthOptions = ["ALL_MONTHS",...monthOrder.filter(month=>allTabLabels.some(tab=>parseTabParts(tab).month===month))];
  const selectedMonthlyTabs = allTabLabels.filter(tab=>{const p=parseTabParts(tab);return(monthlyYearFilter==="ALL_YEARS"||p.year===monthlyYearFilter)&&(monthlyMonthNameFilter==="ALL_MONTHS"||p.month===monthlyMonthNameFilter);});
  const hasMonthlyTabFilter = monthlyYearFilter!=="ALL_YEARS"||monthlyMonthNameFilter!=="ALL_MONTHS";
  const selectedLoanTabs = allTabLabels.filter(tab=>{const p=parseTabParts(tab);return(loanYearFilter==="ALL_YEARS"||p.year===loanYearFilter)&&(loanMonthNameFilter==="ALL_MONTHS"||p.month===loanMonthNameFilter);});
  const hasLoanTabFilter = loanYearFilter!=="ALL_YEARS"||loanMonthNameFilter!=="ALL_MONTHS";
  const activeLoans=allLoans.filter(l=>l.status==="ACTIVE");
  const closedLoans=allLoans.filter(l=>l.status==="CLOSED");
  const pendingLoans=allLoans.filter(l=>l.status==="PENDING");
  const overdueLoans=allLoans.filter(l=>l.rs==="OVERDUE");
  const dueTodayLoans=allLoans.filter(l=>l.rs==="DUE TODAY");
  const dueSoonLoans=allLoans.filter(l=>l.rs==="DUE SOON");
  const npaLoans=allLoans.filter(l=>l.rs==="NPA");
  const totalInterestEarned=allLoans.reduce((s,l)=>s+l.interestRecv,0);
  const totalDisbursedFromLoans=allLoans.reduce((s,l)=>s+n(l.amount),0);
  const totalReceivedFromLoans=allLoans.reduce((s,l)=>s+n(l.totalRecv),0);
  const totalFees=allLoans.reduce((s,l)=>s+n(l.fee),0);
  const totalPL=closedLoans.reduce((s,l)=>s+n(l.pl),0);  // only closed loans have a finalised P&L
  const outstandingFromLoans=activeLoans.reduce((s,l)=>s+n(l.outstandingAmount),0);
  const totalDisbursed=d.lendenClub.tabSummary.reduce((s,t)=>s+t.disbursed,0);
  const totalReceived=d.lendenClub.tabSummary.reduce((s,t)=>s+t.received,0);
  const totalOutstanding=d.lendenClub.tabSummary.reduce((s,t)=>s+t.outstanding,0);
  const totalInterestFromTab=d.lendenClub.tabSummary.reduce((s,t)=>s+t.interest,0);
  const displayTotalDisbursed=totalDisbursedFromLoans||totalDisbursed;
  const displayTotalReceived=totalReceivedFromLoans||totalReceived;
  // Closed-loan-only figures for accurate Recovery % (active loans have only partial repayments)
  const closedTotalRecv=closedLoans.reduce((s,l)=>s+n(l.totalRecv),0);
  const closedTotalAmount=closedLoans.reduce((s,l)=>s+n(l.amount),0);
  const displayTotalOutstanding=outstandingFromLoans||totalOutstanding;
  const currentCapitalDeployed=allLoans.length>0?outstandingFromLoans:totalOutstanding;
  const displayTotalInterest=totalInterestEarned||totalInterestFromTab;
  const externalCapitalAdded=d.lendenClub.transactions?.length?d.lendenClub.transactions.reduce((s,t)=>s+n(t.invested),0):n(d.lendenClub.totalPooled);
  const capitalAfterEarnings=externalCapitalAdded+displayTotalInterest;
  const idleCash=capitalAfterEarnings-currentCapitalDeployed;
  const avgClosedDuration=closedLoans.length?(closedLoans.reduce((s,l)=>s+(l.monthsToClose||l.tenure||0),0)/closedLoans.length).toFixed(1):0;
  // Only include loans whose duration was actually parsed (monthsToClose > 0) to avoid inflating the rate
  const validClosedLoans=closedLoans.filter(l=>l.monthsToClose>0);
  const avgClosedMonthlyRate=validClosedLoans.length?(validClosedLoans.reduce((s,l)=>s+l.interestRecv,0)/Math.max(validClosedLoans.reduce((s,l)=>s+(n(l.amount)*l.monthsToClose),0),1)*100).toFixed(2):"N/A";
  const summaryTotalLoans=num(d.lendenClub.reportedTotalLoans)||d.lendenClub.tabSummary.reduce((s,t)=>s+t.loans,0)||allLoans.length;
  const summaryClosedLoans=num(d.lendenClub.reportedClosedLoans)||closedLoans.length;
  const summaryOverdueLoans=num(d.lendenClub.reportedOverdueLoans)||overdueLoans.length;
  const summaryPendingLoans=num(d.lendenClub.reportedPendingLoans)||pendingLoans.length;
  const summaryActiveLoans=num(d.lendenClub.reportedActiveLoans)||Math.max(0,activeLoans.length||(summaryTotalLoans-summaryClosedLoans-summaryPendingLoans-summaryOverdueLoans));
  const grossRate=totalDisbursedFromLoans>0?((totalInterestEarned/totalDisbursedFromLoans)*100):0;
  const feesDrag=totalDisbursedFromLoans>0?((totalFees/totalDisbursedFromLoans)*100):0;
  const closedDisbursed=closedLoans.reduce((s,l)=>s+n(l.amount),0);
  const closedInterest=closedLoans.reduce((s,l)=>s+n(l.interestRecv),0);
  const closedRate=closedDisbursed>0?((closedInterest/closedDisbursed)*100):0;
  const txDates=d.lendenClub.transactions.map(t=>parseDateValue(t.date)).filter(Boolean);
  const elapsedMonths=txDates.length>=2?Math.max(1,diffMonthsBetweenDates(new Date(Math.min(...txDates)),new Date(Math.max(...txDates)))):3;
  const roi=d.lendenClub.totalPooled>0?((displayTotalInterest/d.lendenClub.totalPooled)*(12/elapsedMonths)*100).toFixed(0):0;
  const avgScore=allLoans.length?Math.round(allLoans.reduce((s,l)=>s+n(l.score),0)/allLoans.length):0;
  const matchesLoanTabFilter=(loan)=>!hasLoanTabFilter||selectedLoanTabs.includes(String(loan.tab||"").trim());
  const matchesClosureFilter=(loan)=>{if(!hasLoanTabFilter)return true;const parts=getDateParts(loan.closure);if(!parts)return false;return(loanYearFilter==="ALL_YEARS"||parts.year===loanYearFilter)&&(loanMonthNameFilter==="ALL_MONTHS"||parts.month===loanMonthNameFilter);};
  const tableLoanSource=(()=>{if(repayFilter==="Closed")return closedLoans.filter(matchesClosureFilter);if(!hasLoanTabFilter)return allLoans;const tabRows=monthlyLoanRows.filter(matchesLoanTabFilter);if(tabRows.length===0)return allLoans.filter(matchesLoanTabFilter);return tabRows;})();
  const filteredLoans=tableLoanSource.filter(l=>{if(repayFilter&&l.rs!==repayFilter)return false;const query=loanQuery.trim().toLowerCase();if(!query)return true;return[l.tab,l.id,l.status,l.rs,l.rawStatus,l.disbDate,l.closure,l.repayStart].some(v=>String(v||"").toLowerCase().includes(query));});
  const visibleMonthlySummary=(hasMonthlyTabFilter?d.lendenClub.tabSummary.filter(t=>selectedMonthlyTabs.includes(String(t.tab||"").trim())):d.lendenClub.tabSummary).sort((a,b)=>lendenTabKey(a.tab)-lendenTabKey(b.tab));
  const visibleMonthlyRows=visibleMonthlySummary.map(t=>{const tabKey=String(t.tab||"").trim();const monthLoans=monthlyLoanRows.filter(l=>String(l.tab||"").trim()===tabKey);const dedupedMonthLoans=allLoans.filter(l=>String(l.tab||"").trim()===tabKey);const totalLoansCount=t.loans||dedupedMonthLoans.length;const rawMonthStatus=loan=>String(loan.rawStatus||"").trim().toUpperCase();const closed=monthLoans.filter(l=>rawMonthStatus(l)==="CLOSED");const pending=monthLoans.filter(l=>/PENDING|PROCESSING|LIVE|ONGOING/.test(rawMonthStatus(l)));const overdue=monthLoans.filter(l=>/OVERDUE|DELAYED|LATE/.test(rawMonthStatus(l)));const npa=monthLoans.filter(l=>/NPA|DEFAULT|WRITTEN OFF/.test(rawMonthStatus(l)));const dueToday=monthLoans.filter(l=>l.rs==="DUE TODAY");const dueSoon=monthLoans.filter(l=>l.rs==="DUE SOON");const activeCount=Math.max(0,totalLoansCount-closed.length-pending.length-overdue.length-npa.length);const monthDisbursed=t.disbursed||dedupedMonthLoans.reduce((s,l)=>s+n(l.amount),0);const loanInterest=dedupedMonthLoans.reduce((s,l)=>s+n(l.interestRecv),0);const loanPrincipal=dedupedMonthLoans.reduce((s,l)=>s+n(l.principalRecv),0);const loanFees=dedupedMonthLoans.reduce((s,l)=>s+n(l.fee),0);const monthInterest=dedupedMonthLoans.length>0?loanInterest:(t.interest||0);const monthPrincipal=dedupedMonthLoans.length>0?loanPrincipal:(t.principal||0);const monthFees=dedupedMonthLoans.length>0?loanFees:(t.fee||0);const monthOutstanding=t.outstanding||dedupedMonthLoans.reduce((s,l)=>s+n(l.outstandingAmount),0);const monthNetRate=monthDisbursed>0?((monthInterest/monthDisbursed)*100):0;return{...t,loans:totalLoansCount,active:activeCount,closed:closed.length,pending:pending.length,overdue:overdue.length,npa:npa.length,dueToday:dueToday.length,dueSoon:dueSoon.length,monthDisbursed,monthInterest,monthFees,monthPrincipal,monthOutstanding,monthNetRate};});
  const monthlyBreakdown=visibleMonthlyRows.map(t=>({month:t.tab,disbursed:t.monthDisbursed,interest:t.monthInterest,outstanding:t.monthOutstanding,loans:t.loans,roi:t.monthDisbursed>0?((t.monthInterest/t.monthDisbursed)*100*12).toFixed(0):0}));
  const visibleMonthlyTotals=visibleMonthlyRows.reduce((acc,row)=>({loans:acc.loans+n(row.loans),active:acc.active+n(row.active),closed:acc.closed+n(row.closed),pending:acc.pending+n(row.pending),overdue:acc.overdue+n(row.overdue),npa:acc.npa+n(row.npa),disbursed:acc.disbursed+n(row.monthDisbursed),principal:acc.principal+n(row.monthPrincipal),interest:acc.interest+n(row.monthInterest),fee:acc.fee+n(row.monthFees),outstanding:acc.outstanding+n(row.monthOutstanding),received:acc.received+n(row.received)}),{loans:0,active:0,closed:0,pending:0,overdue:0,npa:0,disbursed:0,principal:0,interest:0,fee:0,outstanding:0,received:0});
  const displayedTotalCounts={loans:visibleMonthlyTotals.loans,active:visibleMonthlyTotals.active,closed:visibleMonthlyTotals.closed,pending:visibleMonthlyTotals.pending,overdue:visibleMonthlyTotals.overdue,npa:visibleMonthlyTotals.npa};
  const REPAYMENT_OPTIONS=["","On Track","DUE TODAY","DUE SOON","OVERDUE","NPA","Closed"];
  const selStyle={background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10};
  const fmtD=v=>{const x=typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;const neg=x<0;const s=`₹${Math.abs(x).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;return neg?`-${s}`:s;};

  return (
    <div className="fade">
      {/* Banner */}
      <div style={{background:`linear-gradient(135deg,${P.rose}18,${P.violet}0A)`,border:`1px solid ${P.rose}33`,borderRadius:16,padding:"16px 22px",marginBottom:16,display:"flex",alignItems:"center",gap:16}}>
        <div style={{fontSize:40}}>🏛</div>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,color:P.rose}}>LendenClub P2P Portfolio</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>NBFC-P2P lending · {summaryTotalLoans} total loans · ≈{roi}% annualised ROI</div>
        </div>
        <div style={{marginLeft:"auto",textAlign:"right"}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>Total Pooled</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,color:P.rose}}>{fmtD(d.lendenClub.totalPooled)}</div>
        </div>
      </div>

      {/* KPI grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:14}}>
        <GlassKPI label="Capital Available"              value={fmtD(capitalAfterEarnings)}   sub="Capital added + interest received"                                  color={P.teal}     icon="💹"/>
        <GlassKPI label="Current Capital Deployed"       value={fmtD(currentCapitalDeployed)} sub="Sum of active principal outstanding"                                color={P.gold}     icon="🏦"/>
        <GlassKPI label="Portfolio Annualised ROI"       value={`${roi}%`}                    sub="Interest received annualised on pooled capital"                    color={P.emerald}  icon="📈"/>
        <GlassKPI label="Closed Loan Avg Monthly Yield"  value={avgClosedMonthlyRate==="N/A"?avgClosedMonthlyRate:`${avgClosedMonthlyRate}%`} sub={`${validClosedLoans.length} loans w/ known dates · ${avgClosedDuration} mo avg`} color={P.sapphire} icon="⏱"/>
        <GlassKPI label="Active / Closed / Pending"      value={`${summaryActiveLoans} / ${summaryClosedLoans} / ${summaryPendingLoans}`} sub={`Overdue ${summaryOverdueLoans} · Closed Recovery ${pct(closedTotalRecv,closedTotalAmount)}%`} color={P.violet} icon="🔄"/>
        <GlassKPI label="Cumulative Yield (on disbursed)" value={`${Math.round(grossRate)}%`} sub="Total interest ÷ total disbursed (not annualised)"                  color={P.rose}     icon="🧮"/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"On Track",  value:allLoans.filter(l=>l.rs==="On Track").length, color:P.emerald},
          {label:"Due Today", value:dueTodayLoans.length,  color:P.gold},
          {label:"Due Soon",  value:dueSoonLoans.length,   color:P.sapphire},
          {label:"Overdue",   value:overdueLoans.length,   color:P.ruby},
          {label:"NPA",       value:npaLoans.length,       color:P.rose},
          {label:"Avg Score", value:avgScore||0,            color:P.violet},
        ].map(item=>(
          <div key={item.label} style={{background:`${item.color}0A`,border:`1px solid ${item.color}22`,borderRadius:12,padding:"10px 12px"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:item.color}}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        <Card accent={P.teal}>
          <SectionHead title="Monthly Interest Breakdown" icon="📊" color={P.teal}/>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyBreakdown} barGap={3} barSize={20}>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`₹${Math.round(v)}`}/>
              <Tooltip content={<CTip/>}/>
              <Legend wrapperStyle={{fontSize:10,fontFamily:"'Fira Code',monospace"}}/>
              <Bar dataKey="interest"  name="Interest Earned" fill={P.teal}           radius={[4,4,0,0]}/>
              <Bar dataKey="disbursed" name="Disbursed"       fill={`${P.sapphire}66`} radius={[4,4,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card accent={P.rose}>
          <SectionHead title="Pool Growth Over Time" icon="📈" color={P.rose}/>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={d.lendenClub.transactions}>
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={P.rose} stopOpacity={.4}/>
                  <stop offset="100%" stopColor={P.rose} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>v>=100000?`₹${Math.round(v/100000)}L`:`₹${Math.round(v/1000)}K`}/>
              <Tooltip content={<CTip/>}/>
              <Area type="monotone" dataKey="pool" name="Pool ₹" stroke={P.rose} fill="url(#pg)" strokeWidth={2.5}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Interest & Fee Analysis */}
      <Card accent={P.sapphire} style={{marginBottom:14}}>
        <SectionHead title="Interest & Fee Analysis" icon="🧾" color={P.sapphire}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
          {[
            {label:"Total Disbursed",            value:fmtD(displayTotalDisbursed),  color:P.sapphire},
            {label:"Total Collected (all loans)", value:fmtD(displayTotalReceived),   color:P.emerald},
            {label:"Interest Received",           value:fmtD(displayTotalInterest),   color:P.teal},
            {label:"Fees",                        value:fmtD(totalFees),              color:P.ruby},
            {label:"Net P&L (closed loans only)", value:fmtD(totalPL),                color:totalPL>=0?P.emerald:P.ruby},
          ].map(item=>(
            <div key={item.label} style={{background:P.card3,border:`1px solid ${item.color}22`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:item.color}}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {label:"Closed-Loan Recovery %", value:`${pct(closedTotalRecv,closedTotalAmount)}%`,         color:P.emerald},
            {label:"Fee Drag",            value:`${Math.round(feesDrag)}%`,   color:P.sapphire},
            {label:"Closed Loan ROI",     value:`${Math.round(closedRate)}%`, color:P.gold},
            {label:"Avg Closed Duration", value:`${avgClosedDuration} mo`,    color:P.violet},
          ].map(item=>(
            <div key={item.label} style={{background:`${item.color}0A`,border:`1px solid ${item.color}22`,borderRadius:12,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:item.color}}>{item.value}</div>
            </div>
          ))}
        </div>
        {/* Capital Reconciliation */}
        <div style={{marginTop:12,background:P.card3,border:`1px solid ${P.border}`,borderRadius:12,padding:"12px 14px"}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,textTransform:"uppercase",letterSpacing:2,marginBottom:10}}>Capital Reconciliation</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
            {[
              {label:"Capital Added",     value:fmtD(externalCapitalAdded),    color:P.gold},
              {label:"Capital Available", value:fmtD(capitalAfterEarnings),    color:P.teal},
              {label:"Fees Deducted",     value:fmtD(totalFees),               color:P.ruby},
              {label:"Current Deployed",  value:fmtD(currentCapitalDeployed),  color:P.sapphire},
              {label:"Idle Cash",         value:fmtD(idleCash),                color:idleCash>=0?P.emerald:P.ruby},
            ].map(item=>(
              <div key={item.label} style={{background:`${item.color}0A`,border:`1px solid ${item.color}22`,borderRadius:10,padding:"10px 12px"}}>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:3}}>{item.label}</div>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:item.color}}>{item.value}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.8}}>
            Formula: <span style={{color:P.gold}}>Capital Added</span> + <span style={{color:P.teal}}>Interest Earned</span> = <span style={{color:P.text}}>Capital Available</span> {fmtD(capitalAfterEarnings)}.
            Remaining after current deployment = <span style={{color:idleCash>=0?P.emerald:P.ruby}}>{fmtD(idleCash)}</span>.
          </div>
        </div>
      </Card>

      {/* Monthly ROI table */}
      <Card accent={P.emerald} style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <SectionHead title="Monthly Interest & ROI Analysis" icon="💰" color={P.emerald}/>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Year</span>
            <select value={monthlyYearFilter} onChange={e=>setMonthlyYearFilter(e.target.value)} style={selStyle}>
              {yearOptions.map(y=><option key={y} value={y}>{y==="ALL_YEARS"?"All Years":y}</option>)}
            </select>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Month</span>
            <select value={monthlyMonthNameFilter} onChange={e=>setMonthlyMonthNameFilter(e.target.value)} style={selStyle}>
              {monthOptions.map(m=><option key={m} value={m}>{m==="ALL_MONTHS"?"All Months":m}</option>)}
            </select>
          </div>
        </div>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Month</TH><TH>Loans</TH><TH>Active</TH><TH>Closed</TH><TH>Pending</TH><TH>Overdue</TH><TH>NPA</TH><TH>Disbursed</TH><TH>Principal</TH><TH>Interest</TH><TH>Fee</TH><TH>Outstanding</TH><TH>Recovery%</TH><TH>Monthly ROI</TH></tr></thead>
            <tbody>
              {visibleMonthlyRows.map((t,i)=>(
                <tr key={i}>
                  <TD bold color={P.gold}>{t.tab}</TD>
                  <TD color={P.text}>{t.loans}</TD><TD color={P.emerald}>{t.active}</TD><TD color={P.sapphire}>{t.closed}</TD>
                  <TD color={P.gold}>{t.pending}</TD><TD color={P.ruby}>{t.overdue}</TD><TD color={P.rose}>{t.npa}</TD>
                  <TD color={P.sapphire}>{fmtD(t.monthDisbursed)}</TD><TD color={P.text}>{fmtD(t.monthPrincipal)}</TD>
                  <TD bold color={P.teal}>{fmtD(t.monthInterest)}</TD><TD color={P.muted}>{fmtD(t.monthFees)}</TD>
                  <TD color={P.ruby}>{fmtD(t.monthOutstanding)}</TD>
                  <TD color={parseFloat(pct(t.received,t.disbursed))>50?P.emerald:P.gold}>{pct(t.received,t.disbursed)}%</TD>
                  <TD bold color={P.emerald}>{Math.round(t.monthNetRate)}%</TD>
                </tr>
              ))}
              <tr style={{background:P.card2}}>
                <TD bold color={P.gold}>TOTAL</TD>
                <TD bold>{displayedTotalCounts.loans}</TD><TD bold color={P.emerald}>{displayedTotalCounts.active}</TD>
                <TD bold color={P.sapphire}>{displayedTotalCounts.closed}</TD><TD bold color={P.gold}>{displayedTotalCounts.pending}</TD>
                <TD bold color={P.ruby}>{displayedTotalCounts.overdue}</TD><TD bold color={P.rose}>{displayedTotalCounts.npa}</TD>
                <TD bold color={P.sapphire}>{fmtD(visibleMonthlyTotals.disbursed)}</TD>
                <TD bold color={P.text}>{fmtD(visibleMonthlyTotals.principal)}</TD>
                <TD bold color={P.teal}>{fmtD(visibleMonthlyTotals.interest)}</TD>
                <TD bold color={P.muted}>{fmtD(visibleMonthlyTotals.fee)}</TD>
                <TD bold color={P.ruby}>{fmtD(visibleMonthlyTotals.outstanding)}</TD>
                <TD bold color={P.emerald}>{pct(visibleMonthlyTotals.received,visibleMonthlyTotals.disbursed)}%</TD>
                <TD bold color={P.emerald}>{visibleMonthlyTotals.disbursed>0?Math.round((visibleMonthlyTotals.interest/visibleMonthlyTotals.disbursed)*100):0}%</TD>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {label:"Visible Months",        v:String(visibleMonthlyRows.length),              color:P.teal},
            {label:"Visible Closed Loans",  v:String(visibleMonthlyTotals.closed),            color:P.emerald},
            {label:"Visible Outstanding",   v:fmtD(visibleMonthlyTotals.outstanding),         color:P.rose},
            {label:"Visible Recovery",      v:`${pct(visibleMonthlyTotals.received,visibleMonthlyTotals.disbursed)}%`, color:P.violet},
          ].map((s,i)=>(
            <div key={i} style={{background:`${s.color}0A`,border:`1px solid ${s.color}22`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{s.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,color:s.color}}>{s.v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Individual Loan Accounts */}
      <Card accent={P.rose} style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <SectionHead title="Individual Loan Accounts" icon="📋" color={P.rose}/>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <input value={loanQuery} onChange={e=>setLoanQuery(e.target.value)} placeholder="Search loan id / month / status"
              style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10,minWidth:220}}/>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Status</span>
            <select value={repayFilter} onChange={e=>setRepayFilter(e.target.value)} style={selStyle}>
              {REPAYMENT_OPTIONS.map(m=><option key={m||"ALL"} value={m}>{m||"All Statuses"}</option>)}
            </select>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Year</span>
            <select value={loanYearFilter} onChange={e=>setLoanYearFilter(e.target.value)} style={selStyle}>
              {yearOptions.map(y=><option key={y} value={y}>{y==="ALL_YEARS"?"All Years":y}</option>)}
            </select>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Month</span>
            <select value={loanMonthNameFilter} onChange={e=>setLoanMonthNameFilter(e.target.value)} style={selStyle}>
              {monthOptions.map(m=><option key={m} value={m}>{m==="ALL_MONTHS"?"All Months":m}</option>)}
            </select>
          </div>
        </div>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Tab</TH><TH left>Loan ID</TH><TH>Rate%</TH><TH>Tenure</TH><TH>Score</TH><TH>Disbursed</TH><TH>Repay Start</TH><TH>Due</TH><TH>Amount</TH><TH>Status</TH><TH>Repayment</TH><TH>DPD</TH><TH>NPA</TH><TH>Principal Recv</TH><TH>Interest Earned</TH><TH>Avg/Mo</TH><TH>Fee</TH><TH>Total Recv</TH><TH>P&L</TH><TH>Months</TH><TH>Closure</TH></tr></thead>
            <tbody>
              {filteredLoans.map((l,i)=>(
                <tr key={i}>
                  <TD color={P.gold}>{l.tab}</TD><TD left color={P.muted}>{l.id}</TD>
                  <TD color={P.sapphire}>{l.rate}%</TD><TD>{l.tenure} mo</TD>
                  <TD color={l.score>=720?P.emerald:P.gold}>{l.score}</TD>
                  <TD color={P.muted}>{l.disbDate}</TD><TD color={P.text}>{l.repayStart||"-"}</TD>
                  <TD color={l.rs==="OVERDUE"?P.ruby:P.muted}>{l.dueDate}</TD>
                  <TD>{fmtD(l.amount)}</TD>
                  <TD><Pill color={l.status==="CLOSED"?P.muted:l.status==="OVERDUE"?P.ruby:l.status==="PENDING"?P.gold:P.emerald}>{l.status}</Pill></TD>
                  <TD><Pill color={l.rs==="NPA"?P.rose:l.rs==="OVERDUE"?P.ruby:l.rs==="DUE TODAY"?P.gold:l.rs==="DUE SOON"?P.sapphire:l.rs==="Closed"?P.muted:P.emerald}>{l.rs}</Pill></TD>
                  <TD color={n(l.dpd)>0?P.ruby:P.muted}>{n(l.dpd)||0}</TD>
                  <TD color={n(l.npa)>0?P.rose:P.muted}>{n(l.npa)||0}</TD>
                  <TD color={P.text}>{fmtD(l.principalRecv)}</TD>
                  <TD bold color={P.teal}>{fmtD(l.interestRecv)}</TD>
                  <TD color={l.status==="CLOSED"?P.sapphire:P.muted}>{l.status==="CLOSED"?`${l.monthlyRateToClose}%`:"—"}</TD>
                  <TD color={P.muted}>{fmtD(l.fee)}</TD>
                  <TD color={P.gold}>{fmtD(l.totalRecv)}</TD>
                  <TD color={l.pl>0?P.emerald:P.muted}>{l.pl>0?"+":""}{fmtD(l.pl)}</TD>
                  <TD color={P.text}>{l.monthsToClose||"—"}</TD>
                  <TD color={P.muted}>{l.closure}</TD>
                </tr>
              ))}
              <tr style={{background:P.card2}}>
                <TD bold colSpan={13} left color={P.gold}>SUBTOTAL ({filteredLoans.length} loans)</TD>
                <TD bold color={P.text}>{fmtD(filteredLoans.reduce((s,l)=>s+l.principalRecv,0))}</TD>
                <TD bold color={P.teal}>{fmtD(filteredLoans.reduce((s,l)=>s+l.interestRecv,0))}</TD>
                <TD bold color={P.sapphire}>{filteredLoans.filter(l=>l.status==="CLOSED").length?`${(filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s+l.interestRecv,0)/Math.max(filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s+(n(l.amount)*Math.max(1,n(l.monthsToClose))),0),1)*100).toFixed(1)}%`:"—"}</TD>
                <TD bold color={P.muted}>{fmtD(filteredLoans.reduce((s,l)=>s+l.fee,0))}</TD>
                <TD bold color={P.gold}>{fmtD(filteredLoans.reduce((s,l)=>s+l.totalRecv,0))}</TD>
                <TD bold color={P.emerald}>{fmtD(filteredLoans.reduce((s,l)=>s+l.pl,0))}</TD>
                <TD bold color={P.text}>{filteredLoans.filter(l=>l.status==="CLOSED").length?filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s+n(l.monthsToClose),0):"—"}</TD>
                <TD/>
              </tr>
            </tbody>
          </table>
          <div style={{marginTop:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>
            Showing {filteredLoans.length} loan rows · Score ≥720 = <span style={{color:P.emerald}}>good credit</span> · Repayment: <span style={{color:P.gold}}>{dueTodayLoans.length}</span> due today / <span style={{color:P.sapphire}}>{dueSoonLoans.length}</span> due soon / <span style={{color:P.ruby}}>{overdueLoans.length}</span> overdue / <span style={{color:P.rose}}>{npaLoans.length}</span> NPA
          </div>
        </div>
      </Card>

      {/* Transaction Log */}
      <Card accent={P.violet}>
        <SectionHead title="Investment Transaction Log" icon="📒" color={P.violet}/>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Date</TH><TH>Invested / Withdrawn</TH><TH>Closing Pool</TH><TH left>Remark</TH></tr></thead>
            <tbody>
              {d.lendenClub.transactions.map((t,i)=>(
                <tr key={i}>
                  <TD color={P.muted}>{t.date}</TD>
                  <TD bold color={t.invested>0?P.emerald:P.ruby}>{t.invested>0?"+":""}{fmtD(t.invested)}</TD>
                  <TD color={P.gold}>{fmtD(t.pool)}</TD>
                  <TD left color={P.text}>{t.remark}</TD>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── API SETTINGS ─────────────────────────────────────────────────────────────
function APISettings({ apiUrl, setApiUrl, onSyncNow }) {
  const [local,   setLocal]   = useState(apiUrl);
  const [saved,   setSaved]   = useState(false);
  const [testing, setTesting] = useState(false);
  const [result,  setResult]  = useState(null);

  const handleTest = async () => {
    if (!local.trim()) return;
    setTesting(true); setResult(null);
    try {
      const data = unwrapCentralPayload(await fetchScript("central", local.trim()));
      if (data?.error) {
        setResult({ ok:false, msg:"Script error: " + data.error, data:null });
      } else {
        const keys     = Object.keys(data);
        const expected = ["income","lendenClub","personalLending","realEstate","stocks","loans"];
        const found    = expected.filter(k => keys.includes(k));
        const missing  = expected.filter(k => !keys.includes(k));
        const sheetCounts = keys.map(k => `${k}: ${Object.keys(data[k]||{}).length} sheets`).join(" · ");
        if (found.length === 6) {
          setResult({ ok:true,  msg:`✅ All 6 spreadsheets found! ${sheetCounts}`, data });
        } else {
          setResult({ ok:false, msg:`⚠ Got ${found.length}/6 keys. Missing: ${missing.join(", ")}. Found keys: ${keys.join(", ")}`, data });
        }
      }
    } catch(err) {
      const issue = explainSyncIssue(err, "central");
      setResult({ ok:false, msg:"❌ " + issue.message, data:null });
    }
    setTesting(false);
  };

  const handleSave = () => {
    setApiUrl(local.trim());
    saveApiUrl(local.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    setTimeout(() => onSyncNow(), 400);
  };

  const handleClear = () => { setLocal(""); setResult(null); };

  return (
    <div className="fade">
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${P.sapphire}14,${P.teal}0A)`,border:`1px solid ${P.sapphire}33`,borderRadius:16,padding:"20px 24px",marginBottom:16,display:"flex",alignItems:"center",gap:16}}>
        <div style={{width:56,height:56,borderRadius:14,background:`linear-gradient(135deg,${P.sapphire},${P.teal})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0,boxShadow:`0 0 24px ${P.sapphire}44`}}>🔗</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color:P.text}}>Central API Settings</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:4,lineHeight:1.8}}>
            One single Apps Script URL reads all 6 spreadsheets and returns unified data. Paste your deployed URL below.
          </div>
        </div>
      </div>

      {/* Architecture diagram */}
      <Card accent={P.gold} style={{marginBottom:16}}>
        <SectionHead title="Architecture" icon="🏗" color={P.gold}/>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"center",padding:"12px 0"}}>
          {["📊 Sheet 1 (Income)","📊 Sheet 2 (LendenClub)","📊 Sheet 3 (Personal Lending)","📊 Sheet 4 (Real Estate)","📊 Sheet 5 (Stocks)","📊 Sheet 6 (Loans)"].map((s,i)=>(
            <div key={i} style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:8,padding:"5px 10px",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>{s}</div>
          ))}
          <div style={{width:"100%",textAlign:"center",fontFamily:"'Fira Code',monospace",fontSize:18,color:P.gold,margin:"4px 0"}}>↓</div>
          <div style={{background:`linear-gradient(135deg,${P.gold}22,${P.orange}11)`,border:`1px solid ${P.gold}44`,borderRadius:10,padding:"8px 20px",fontFamily:"'Fira Code',monospace",fontSize:11,color:P.gold,fontWeight:700}}>
            ⚡ Central Apps Script API (single /exec URL)
          </div>
          <div style={{width:"100%",textAlign:"center",fontFamily:"'Fira Code',monospace",fontSize:18,color:P.sapphire,margin:"4px 0"}}>↓</div>
          <div style={{background:`linear-gradient(135deg,${P.sapphire}22,${P.teal}11)`,border:`1px solid ${P.sapphire}44`,borderRadius:10,padding:"8px 20px",fontFamily:"'Fira Code',monospace",fontSize:11,color:P.sapphire,fontWeight:700}}>
            📱 This Dashboard (JSONP fetch, auto-maps all sheets)
          </div>
        </div>
      </Card>

      {/* Step-by-step */}
      <Card accent={P.teal} style={{marginBottom:16}}>
        <SectionHead title="How to deploy your Central Script" icon="📋" color={P.teal}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
          {[
            { step:"1", color:P.emerald,  text:"Open script.google.com → create a new project" },
            { step:"2", color:P.sapphire, text:"Paste the Central API script code" },
            { step:"3", color:P.gold,     text:"Click Deploy → New Deployment → Web App" },
            { step:"4", color:P.teal,     text:"Execute as: Me · Who has access: Anyone (no Google account required)" },
            { step:"5", color:P.orange,   text:"Copy the /exec URL and paste it in the field below" },
            { step:"6", color:P.ruby,     text:"Click Test → if all 6 sheets show, click Save & Sync" },
          ].map((s,i)=>(
            <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
              <div style={{width:26,height:26,borderRadius:"50%",background:`${s.color}22`,border:`1px solid ${s.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,color:s.color,flexShrink:0}}>{s.step}</div>
              <div style={{fontFamily:"'Outfit',sans-serif",fontSize:11,color:P.muted,lineHeight:1.7,paddingTop:4}}>{s.text}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:12,padding:"8px 12px",background:`#FF5C7A0A`,border:`1px solid #FF5C7A22`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:"#FF5C7Acc"}}>
          ⚠ "Anyone with Google account" will NOT work — causes CORS/login redirect. Must be <strong style={{color:"#FF5C7A"}}>Anyone</strong>.
        </div>
      </Card>

      {/* URL input */}
      <Card accent={result?.ok===true ? P.emerald : result?.ok===false ? P.ruby : P.sapphire} style={{marginBottom:16}}>
        <SectionHead title="Your Central API URL" icon="📡" color={P.sapphire}/>
        <div style={{display:"flex",gap:10,marginBottom:result?10:0}}>
          <input
            value={local}
            onChange={e => { setLocal(e.target.value); setResult(null); }}
            placeholder="https://script.google.com/macros/s/.../exec"
            style={{flex:1,background:P.card3,border:`1px solid ${result?.ok===true?P.emerald:result?.ok===false?P.ruby:P.border}`,borderRadius:10,padding:"11px 14px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:11,outline:"none"}}
          />
          <button onClick={handleTest} disabled={testing||!local.trim()} style={{background:testing?P.border:`${P.sapphire}22`,border:`1px solid ${testing?P.border:P.sapphire}55`,borderRadius:10,padding:"11px 20px",color:testing?P.muted:P.sapphire,cursor:testing||!local.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
            {testing ? "⏳ Testing..." : "🔬 Test"}
          </button>
          <button onClick={handleSave} disabled={!local.trim()} style={{background:saved?`${P.emerald}22`:`linear-gradient(135deg,${P.sapphire},${P.teal})`,border:saved?`1px solid ${P.emerald}44`:"none",borderRadius:10,padding:"11px 22px",color:saved?P.emerald:"#050D1A",cursor:!local.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
            {saved ? "✅ Saved!" : "💾 Save & Sync"}
          </button>
          {local && <button onClick={handleClear} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:10,padding:"11px 14px",color:P.muted,cursor:"pointer",fontFamily:"'Fira Code',monospace",fontSize:11}}>✕</button>}
        </div>
        {result && (
          <div style={{padding:"10px 14px",borderRadius:8,background:result.ok?`${P.emerald}0A`:`${P.ruby}0A`,border:`1px solid ${result.ok?P.emerald:P.ruby}33`,fontFamily:"'Fira Code',monospace",fontSize:10,color:result.ok?P.emerald:P.orange,lineHeight:1.8}}>
            {result.msg}
            {result.data && (
              <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap"}}>
                {Object.keys(result.data).map(k => (
                  <div key={k} style={{background:`${P.emerald}15`,border:`1px solid ${P.emerald}33`,borderRadius:6,padding:"2px 10px",fontSize:9,color:P.emerald}}>
                    {k}: {Object.keys(result.data[k]||{}).length} sheets · {Object.values(result.data[k]||{}).reduce((s,rows)=>s+(Array.isArray(rows)?rows.length:0),0)} rows
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{marginTop:12,padding:"8px 12px",background:P.card3,borderRadius:8,display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,flexShrink:0}}>ACTIVE URL</span>
          <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:apiUrl?P.sapphire:P.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {apiUrl || "— not configured —"}
          </span>
          {apiUrl && <span style={{background:`${P.emerald}15`,border:`1px solid ${P.emerald}33`,borderRadius:6,padding:"1px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.emerald,flexShrink:0}}>live</span>}
        </div>
      </Card>

      {/* Data mapping info */}
      <Card accent={P.muted}>
        <SectionHead title="How data is mapped" icon="🗺" color={P.muted}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:10}}>
          {[
            { key:"income",          icon:"💰", label:"Income (sheet1)",          sheets:"Income Tracker, Monthly Budget, Daily Expenses, Tax Log" },
            { key:"lendenClub",      icon:"🏛", label:"LendenClub (sheet2)",       sheets:"LC Summary, Tab Summary, LC Transactions, Loan Samples" },
            { key:"personalLending", icon:"🤝", label:"Personal Lending (sheet3)", sheets:"Borrowers, Repayment Log" },
            { key:"realEstate",      icon:"🏡", label:"Real Estate (sheet4)",      sheets:"Property Details, EMI Schedule, Valuation" },
            { key:"stocks",          icon:"📈", label:"Stocks (sheet5)",           sheets:"Mutual Funds, Equity, Options, Crypto" },
            { key:"loans",           icon:"🏦", label:"Loans (sheet6)",            sheets:"HDFC Schedule, IDFC Schedule, SBI Schedule" },
          ].map((m,i) => (
            <div key={i} style={{background:P.card3,borderRadius:8,padding:"10px 12px",border:`1px solid ${P.border}`}}>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:12,fontWeight:700,color:P.text,marginBottom:4}}>{m.icon} {m.label}</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,lineHeight:1.7}}>Looks for tabs: {m.sheets}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,lineHeight:1.8}}>
          Tab name matching is fuzzy — "LC Summary", "LendenClub Summary", "Summary" all work. Column headers are also flexible.
        </div>
      </Card>
    </div>
  );
}

// ─── SALARY TRACKER ───────────────────────────────────────────────────────────
function SalaryTracker({ data }) {
  const d   = data;
  const n   = v => typeof v==="number"?v:parseFloat(String(v||0).replace(/[₹,\s]/g,""))||0;
  const abs = v => `₹${Math.round(Math.abs(n(v))).toLocaleString("en-IN")}`;
  const hist = d.salaryHistory || [];

  const [filterYear, setFilterYear] = useState("ALL");
  const parseM = m => {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const [mon, yr] = String(m||"").split("-");
    return { name: mon, yr: yr ? "20"+yr : "", idx: months.indexOf(mon) };
  };

  const years = ["ALL", ...Array.from(new Set(hist.map(h => parseM(h.month).yr).filter(Boolean))).sort()];
  const filtered = filterYear==="ALL" ? hist : hist.filter(h => parseM(h.month).yr === filterYear);

  // Aggregate KPIs
  const totalSalary   = filtered.reduce((s,h) => s+n(h.salary) - n(h.taxDed), 0);
  const totalTutoring = filtered.reduce((s,h) => s+n(h.tutoring), 0);
  const totalLending  = filtered.reduce((s,h) => s+n(h.lendingInterest), 0);
  const totalGross    = filtered.reduce((s,h) => s+n(h.grossTotal||h.totalIncome), 0);
  const totalInHand   = filtered.reduce((s,h) => s+n(h.inHand||h.savings), 0);
  const avgSavingsRate = totalGross>0 ? ((totalInHand/totalGross)*100).toFixed(0) : 0;

  // Trend: compare last month vs prev month
  const last  = filtered[filtered.length-1];
  const prev  = filtered[filtered.length-2];
  const trend = last && prev ? n(last.inHand||last.savings) - n(prev.inHand||prev.savings) : 0;

  // Chart data
  const chartData = filtered.map(h => ({
    month:  h.month,
    Salary: Math.round(n(h.salary)/1000),
    Tutoring: Math.round(n(h.tutoring)/1000),
    Lending: Math.round(n(h.lendingInterest)/1000),
    Gross:  Math.round(n(h.grossTotal||h.totalIncome)/1000),
    InHand: Math.round(n(h.inHand||h.savings)/1000),
    EMI:    Math.round((n(h.hdfcEmi)+n(h.idfcEmi)+n(h.sbiEmi))/1000),
  }));

  const selStyle = { background:P.card3, border:`1px solid ${P.border}`, borderRadius:8, color:P.text, fontFamily:"'Fira Code',monospace", fontSize:10, padding:"5px 10px", outline:"none", cursor:"pointer" };

  return (
    <div className="fade">
      {/* Header + Year Filter */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color:P.text}}>📊 Salary Tracker</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Month-wise income, savings & growth analysis</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Year</span>
          <select value={filterYear} onChange={e=>setFilterYear(e.target.value)} style={selStyle}>
            {years.map(y=><option key={y} value={y}>{y==="ALL"?"All Years":y}</option>)}
          </select>
        </div>
      </div>

      {/* KPI Row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
        {[
          {label:"In-Hand Salary",   v:abs(totalSalary),   color:P.gold,     icon:"💼", sub:"Salary received"},
          {label:"DevOps Tutoring", v:abs(totalTutoring), color:P.emerald,  icon:"🎓", sub:"Side income"},
          {label:"Lending Interest",v:abs(totalLending),  color:P.teal,     icon:"🤝", sub:"Personal lending"},
          {label:"Total Gross",     v:abs(totalGross),    color:P.sapphire, icon:"💰", sub:"All income combined"},
          {label:"Net Balance",      v:abs(totalInHand),   color:P.violet,   icon:"💵", sub:"After EMIs & investments"},
          {label:"Avg Savings Rate",v:`${avgSavingsRate}%`,color:avgSavingsRate>=20?P.emerald:avgSavingsRate>=10?P.gold:P.ruby, icon:"📈", sub:trend>=0?`↑ ₹${Math.round(trend).toLocaleString("en-IN")} vs last`:`↓ ₹${Math.round(Math.abs(trend)).toLocaleString("en-IN")} vs last`},
        ].map((k,i)=>(
          <div key={i} style={{background:`${k.color}0A`,border:`1px solid ${k.color}33`,borderRadius:14,padding:"14px 16px",transition:"transform .2s,box-shadow .2s",cursor:"default"}}
            onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow=`0 8px 20px ${k.color}33`;}}
            onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
            <div style={{fontSize:20,marginBottom:6}}>{k.icon}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:k.color}}>{k.v}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:2}}>{k.label}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:k.color+"99",marginTop:1}}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
        <Card accent={P.sapphire}>
          <SectionHead title="Income Trend (₹K)" icon="📈" color={P.sapphire}/>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{top:5,right:10,left:-10,bottom:0}}>
              <defs>
                <linearGradient id="grossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={P.sapphire} stopOpacity={0.3}/><stop offset="95%" stopColor={P.sapphire} stopOpacity={0}/></linearGradient>
                <linearGradient id="inhandGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={P.emerald} stopOpacity={0.3}/><stop offset="95%" stopColor={P.emerald} stopOpacity={0}/></linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:8}} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:8}} tickLine={false} axisLine={false}/>
              <Tooltip contentStyle={{background:P.card2,border:`1px solid ${P.border}`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10}} formatter={v=>`₹${v}K`}/>
              <Area type="monotone" dataKey="Gross"  stroke={P.sapphire} fill="url(#grossGrad)"  strokeWidth={2} dot={false} name="Gross"/>
              <Area type="monotone" dataKey="InHand" stroke={P.emerald}  fill="url(#inhandGrad)" strokeWidth={2} dot={false} name="In-Hand"/>
            </AreaChart>
          </ResponsiveContainer>
          <div style={{display:"flex",gap:14,justifyContent:"center",marginTop:8}}>
            {[{c:P.sapphire,l:"Gross"},{c:P.emerald,l:"In-Hand"}].map((x,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4,fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>
                <div style={{width:12,height:3,background:x.c,borderRadius:2}}/>{x.l}
              </div>
            ))}
          </div>
        </Card>

        <Card accent={P.gold}>
          <SectionHead title="Monthly Breakdown (₹K)" icon="📊" color={P.gold}/>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{top:5,right:10,left:-10,bottom:0}}>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:8}} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:8}} tickLine={false} axisLine={false}/>
              <Tooltip contentStyle={{background:P.card2,border:`1px solid ${P.border}`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10}} formatter={v=>`₹${v}K`}/>
              <Bar dataKey="Salary"   fill={P.gold}     radius={[3,3,0,0]} name="Salary"/>
              <Bar dataKey="Tutoring" fill={P.emerald}  radius={[3,3,0,0]} name="Tutoring"/>
              <Bar dataKey="Lending"  fill={P.teal}     radius={[3,3,0,0]} name="Lending Int."/>
            </BarChart>
          </ResponsiveContainer>
          <div style={{display:"flex",gap:14,justifyContent:"center",marginTop:8}}>
            {[{c:P.gold,l:"Salary"},{c:P.emerald,l:"Tutoring"},{c:P.teal,l:"Lending"}].map((x,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4,fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>
                <div style={{width:10,height:10,background:x.c,borderRadius:2}}/>{x.l}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Detail Table */}
      <Card accent={P.teal}>
        <SectionHead title="Month-wise Salary Flow" icon="🗂" color={P.teal}/>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover" style={{minWidth:900,width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{borderBottom:`2px solid ${P.border}`}}>
                {["Month","Salary","Tutoring","Lending Int.","Gross Income","HDFC EMI","IDFC EMI","SBI EMI","In-Hand","Savings Rate"].map((h,i)=>(
                  <th key={i} style={{fontFamily:"'Fira Code',monospace",fontSize:9,fontWeight:700,color:P.muted,padding:"8px 12px",textAlign:i===0?"left":"right",letterSpacing:.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r,i)=>{
                const gross  = n(r.grossTotal||r.totalIncome);
                const ih     = n(r.inHand||r.savings);
                const rate   = gross>0 ? Math.round((ih/gross)*100) : 0;
                const isLast = i===filtered.length-1;
                return (
                  <tr key={i} style={{borderBottom:`1px solid ${P.border}22`,background:isLast?`${P.gold}08`:"transparent",transition:"background .15s"}}>
                    <td style={{fontFamily:"'Syne',sans-serif",fontSize:11,fontWeight:700,color:isLast?P.gold:P.text,padding:"9px 12px",whiteSpace:"nowrap"}}>{r.month}{isLast?" ★":""}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.gold,padding:"9px 12px",textAlign:"right"}}>{abs(r.salary)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald,padding:"9px 12px",textAlign:"right"}}>{abs(r.tutoring)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.teal,padding:"9px 12px",textAlign:"right"}}>{abs(r.lendingInterest)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.sapphire,padding:"9px 12px",textAlign:"right"}}>{abs(gross)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.ruby,padding:"9px 12px",textAlign:"right"}}>{abs(r.hdfcEmi)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.ruby,padding:"9px 12px",textAlign:"right"}}>{abs(r.idfcEmi)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.ruby,padding:"9px 12px",textAlign:"right"}}>{abs(r.sbiEmi)}</td>
                    <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:ih>20000?P.emerald:P.orange,padding:"9px 12px",textAlign:"right"}}>{abs(ih)}</td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}>
                      <span style={{background:`${rate>=20?P.emerald:rate>=10?P.gold:P.ruby}22`,border:`1px solid ${rate>=20?P.emerald:rate>=10?P.gold:P.ruby}44`,borderRadius:20,padding:"2px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,fontWeight:700,color:rate>=20?P.emerald:rate>=10?P.gold:P.ruby}}>{rate}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{borderTop:`2px solid ${P.border}`,background:P.card2}}>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.gold,padding:"10px 12px"}}>TOTAL</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.gold,padding:"10px 12px",textAlign:"right"}}>{abs(totalSalary)}</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.emerald,padding:"10px 12px",textAlign:"right"}}>{abs(totalTutoring)}</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.teal,padding:"10px 12px",textAlign:"right"}}>{abs(totalLending)}</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.sapphire,padding:"10px 12px",textAlign:"right"}}>{abs(totalGross)}</td>
                <td colSpan={3} style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,padding:"10px 12px",textAlign:"right"}}>—</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:P.emerald,padding:"10px 12px",textAlign:"right"}}>{abs(totalInHand)}</td>
                <td style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:avgSavingsRate>=20?P.emerald:P.gold,padding:"10px 12px",textAlign:"right"}}>{avgSavingsRate}% avg</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

const TABS = [
  { id:"overview",    label:"Overview",         icon:"🏠" },
  { id:"income",      label:"Income & Budget",  icon:"💰" },
  { id:"salary",      label:"Salary Tracker",   icon:"📊" },
  { id:"expenses",    label:"Daily Expenses",   icon:"🧾" },
  { id:"stocks",      label:"Stocks & Crypto",  icon:"📈" },
  { id:"loans",       label:"Loans / EMIs",     icon:"🏦" },
  { id:"lending",     label:"Personal Lending", icon:"🤝" },
  { id:"lenden",      label:"LendenClub",       icon:"🏛" },
  { id:"realestate",  label:"Real Estate",      icon:"🏡" },
  { id:"aihub",       label:"🪙 Arth — Advisor", icon:"🧠" },
  { id:"urlsettings", label:"⚙ API Settings",   icon:"🔗" },
];

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data,     setData]     = useState(SEED);
  const [tab,      setTab]      = useState("overview");
  const [loanFilter, setLoanFilter] = useState("ALL");
  const [syncSt,   setSyncSt]   = useState("idle");
  const [lastSync, setLastSync] = useState(null);
  const [syncLog,  setSyncLog]  = useState([]);  // [{ts,key,status,duration,summary,error}]
  const [syncLogOpen, setSyncLogOpen] = useState(false);
  const [cd,       setCd]       = useState(AUTO_SYNC_SECONDS);
  const [corsWarn, setCorsWarn] = useState(false);
  const [syncHint, setSyncHint] = useState("");
  const [apiUrl,   setApiUrl]   = useState(loadApiUrl);  // ← single central API URL
  const [ovMonth,  setOvMonth]  = useState("ALL");
  const [ovYear,   setOvYear]   = useState("ALL");
  const timerRef   = useRef(null);
  const syncFnRef  = useRef(null);

  const applyData = useCallback((key, json) => {
    if (!json || json.error) return; // skip error payloads
    setData(prev => {
      const next = { ...prev };

      if (key === "income") {
        // Script 1 returns { income, budget, dailyExpenses, taxLog, salaryHistory }
        if (json.income)               next.income        = deepMerge(prev.income, json.income);
        if (json.budget)               next.budget        = deepMerge(prev.budget, json.budget);
        if (json.taxLog?.length)       next.taxLog        = json.taxLog;
        if (json.dailyExpenses?.length) next.dailyExpenses = json.dailyExpenses;
        if (json.salaryHistory?.length) next.salaryHistory = json.salaryHistory;
        if (typeof json.salary === "number") next.income = deepMerge(prev.income, json);
      }

      if (key === "stocks" && json.stocks) {
        next.stocks = deepMerge(prev.stocks, json.stocks);
      }

      if (key === "loans" && json.loans) {
        const ls = json.loans;
        next.loans = {
          hdfc: ls.hdfc ? deepMerge(prev.loans.hdfc, ls.hdfc) : prev.loans.hdfc,
          idfc: ls.idfc ? deepMerge(prev.loans.idfc, ls.idfc) : prev.loans.idfc,
          sbi:  ls.sbi  ? deepMerge(prev.loans.sbi,  ls.sbi)  : prev.loans.sbi,
        };
      }

      if (key === "lendenClub" && json.lendenClub) {
        next.lendenClub = deepMerge(prev.lendenClub, json.lendenClub);
      }

      if (key === "personalLending" && json.personalLending) {
        const pl = { ...json.personalLending };
        // Script returns rate as decimal (0.02) — normalise to percentage (2) for display
        if (pl.borrowers) {
          pl.borrowers = pl.borrowers.map(b => ({
            ...b,
            rate: b.rate <= 1 ? +(b.rate * 100).toFixed(2) : b.rate,
          }));
        }
        next.personalLending = deepMerge(prev.personalLending, pl);
      }

      if (key === "realEstate" && json.realEstate) {
        next.realEstate = deepMerge(prev.realEstate, json.realEstate);
      }

      return next;
    });
  }, []);

  const syncAll = useCallback(async () => {
    if (!apiUrl) {
      setSyncLog(prev => [{ts:"--:--:--", key:"central", status:"⚠ NO URL", dur:"0ms", summary:null, error:"No API URL set — go to ⚙ API Settings tab"}, ...prev].slice(0,80));
      setSyncSt("error");
      return;
    }
    setSyncSt("syncing");
    const batchTs    = new Date();
    const batchLabel = `${String(batchTs.getHours()).padStart(2,"0")}:${String(batchTs.getMinutes()).padStart(2,"0")}:${String(batchTs.getSeconds()).padStart(2,"0")}`;
    const t0 = Date.now();
    try {
      const raw = unwrapCentralPayload(await fetchScript("central", apiUrl));
      const dur = Date.now() - t0;

      if (raw?.error) throw new Error("Script error: " + raw.error);

      // Map raw central API response → dashboard data
      const mapped = mapApiResponse(raw);
      if (!mapped) throw new Error("Central API returned no usable rows. Check sheet names, header rows, and Apps Script normalization.");

      // Apply mapped sections, but do not wipe a working section with an empty payload.
      setData(prev => ({
        ...prev,
        income: mapped.income?.salary > 0 ? mapped.income : prev.income,
        budget: mapped.budget ? deepMerge(prev.budget, mapped.budget) : prev.budget,
        dailyExpenses: mapped.dailyExpenses?.length ? mapped.dailyExpenses : prev.dailyExpenses,
        taxLog: mapped.taxLog?.length ? mapped.taxLog : prev.taxLog,
        salaryHistory: mapped.salaryHistory?.length ? mapped.salaryHistory : prev.salaryHistory,
        stocks: mapped.stocks ? deepMerge(prev.stocks, mapped.stocks) : prev.stocks,
        loans: mapped.loans ? deepMerge(prev.loans, mapped.loans) : prev.loans,
        lendenClub: hasUsableLendenClubData(mapped.lendenClub) ? deepMerge(prev.lendenClub, mapped.lendenClub) : prev.lendenClub,
        personalLending: hasUsablePersonalLendingData(mapped.personalLending) ? deepMerge(prev.personalLending, mapped.personalLending) : prev.personalLending,
        realEstate: mapped.realEstate ? deepMerge(prev.realEstate, mapped.realEstate) : prev.realEstate,
        settings: mapped.settings || prev.settings,
      }));

      // Build sync log entries per section
      const sections = ["income","stocks","loans","lendenClub","personalLending","realEstate"];
      sections.forEach(key => {
        let summary = "mapped";
        if (key==="income"          && mapped.income)          summary = `salary ₹${(mapped.income.salary||0).toLocaleString("en-IN")}, in-hand ₹${(mapped.income.inHand||0).toLocaleString("en-IN")}`;
        if (key==="stocks"          && mapped.stocks?.summary) summary = `portfolio ₹${(mapped.stocks.summary.total?.current||0).toLocaleString("en-IN")}`;
        if (key==="loans"           && mapped.loans)           summary = `HDFC ₹${Math.round(mapped.loans.hdfc?.outstanding||0).toLocaleString("en-IN")}`;
        if (key==="lendenClub"      && mapped.lendenClub)      summary = `pool ₹${(mapped.lendenClub.totalPooled||0).toLocaleString("en-IN")}`;
        if (key==="personalLending" && mapped.personalLending) summary = `${mapped.personalLending.activeBorrowers||0} borrowers`;
        if (key==="realEstate"      && mapped.realEstate)      summary = `paid ₹${(mapped.realEstate.paid||0).toLocaleString("en-IN")}`;
        setSyncLog(prev => [{ts:batchLabel, key, status:"✅ OK", dur:`${dur}ms`, summary, error:null}, ...prev].slice(0,80));
      });

      const now = new Date();
      setLastSync(`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`);
      setSyncSt("live");
      setCorsWarn(false);
      setSyncHint("");
    } catch(e) {
      const dur = Date.now() - t0;
      const issue = explainSyncIssue(e, "central");
      setSyncLog(prev => [{ts:batchLabel, key:"central", status:issue.logStatus, dur:`${dur}ms`, summary:null, error:issue.message}, ...prev].slice(0,80));
      setSyncSt(issue.status);
      if (issue.status === "cors" || issue.status === "hosted") {
        setCorsWarn(true);
        setSyncHint(lastSync ? `${issue.message} Showing last successful sync from ${lastSync}.` : issue.message);
      } else if (lastSync) {
        setSyncHint(`${issue.message} Showing last successful sync from ${lastSync}.`);
      }
    }
  }, [apiUrl, lastSync]);

  // Keep syncFnRef always pointing to latest syncAll
  useEffect(() => { syncFnRef.current = syncAll; }, [syncAll]);

  // Single stable interval — fixes auto-sync drift bug
  useEffect(() => {
    let ticks = AUTO_SYNC_SECONDS;
    syncFnRef.current(); // immediate first sync
    timerRef.current = setInterval(() => {
      ticks -= 1;
      setCd(ticks);
      if (ticks <= 0) {
        syncFnRef.current();
        ticks = AUTO_SYNC_SECONDS;
        setCd(AUTO_SYNC_SECONDS);
      }
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []); // runs once only

  // ── Derived values ──
  const d          = data;
  const totalDebt  = n(d.loans.hdfc.outstanding)+n(d.loans.idfc.outstanding)+n(d.loans.sbi.outstanding);
  const totalInv   = n(d.stocks.summary.total.current)+n(d.lendenClub.totalPooled)+n(d.personalLending.totalCapital)+n(d.realEstate.paid);
  const netWorth   = totalInv - totalDebt;
  const emiTotal   = n(d.income.hdfcEmi)+n(d.income.idfcEmi)+n(d.income.sbiEmi);
  const emiPct     = pct(emiTotal, d.income.salary);
  const savingsRate= pct(Math.max(0,d.income.inHand), d.income.grossTotal);

  const allocData = [
    {name:"Stocks & MF",     value:n(d.stocks.summary.total.current)},
    {name:"Personal Lending",value:n(d.personalLending.totalCapital)},
    {name:"LendenClub",      value:n(d.lendenClub.totalPooled)},
    {name:"Real Estate",     value:n(d.realEstate.paid)},
  ];

  return (
    <div style={{background:P.bg,minHeight:"100vh",fontFamily:"'Outfit',sans-serif",color:P.text}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Outfit:wght@300;400;500;600&family=Fira+Code:wght@400;500&display=swap');
        @keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:none} }
        @keyframes pulse      { 0%,100%{opacity:1} 50%{opacity:.25} }
        @keyframes pulse-glow { 0%,100%{box-shadow:0 0 24px #F5A62366,0 0 48px #F5A62322} 50%{box-shadow:0 0 36px #F5A623aa,0 0 72px #F5A62344} }
        @keyframes slideUp    { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:none} }
        @keyframes shimmer    { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        .kpi-card { transition:transform .2s ease,box-shadow .2s ease; }
        .kpi-card:hover { transform:translateY(-4px) !important; }
        .card-hover { transition:border-color .2s,box-shadow .2s; }
        .card-hover:hover { box-shadow:0 4px 24px rgba(0,0,0,.25) !important; }
        .btn-hover { transition:transform .15s,box-shadow .15s,opacity .15s; }
        .btn-hover:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,.2); }
        .btn-hover:active:not(:disabled) { transform:translateY(0); }
        @keyframes marquee{ from{transform:translateX(0)} to{transform:translateX(-50%)} }
        * { box-sizing:border-box }
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${P.bg}}
        ::-webkit-scrollbar-thumb{background:${P.border2};border-radius:4px}
        .tbtn{background:none;border:none;cursor:pointer;transition:all .2s;border-radius:8px 8px 0 0}
        .tbtn:hover{background:rgba(245,197,66,.06)!important}
        table{border-collapse:collapse;width:100%}
        .row-hover tbody tr:hover{background:rgba(245,197,66,.03)}
        .fade{animation:fadeUp .35s ease forwards}
        input{transition:border-color .2s}
        input:focus{border-color:${P.violet}!important;outline:none!important}
      `}</style>

      {/* ── TICKER ── */}
      <div style={{background:P.card,borderBottom:`1px solid ${P.border}`,height:30,overflow:"hidden",display:"flex",alignItems:"center"}}>
        <div style={{display:"flex",gap:48,whiteSpace:"nowrap",animation:"marquee 35s linear infinite",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,padding:"0 24px"}}>
          {[`NET WORTH ${fmt(netWorth)}`,`SALARY ${fmt(d.income.salary)}`,`IN-HAND ${fmt(d.income.inHand)}`,`EMI LOAD ${emiPct}%`,`STOCKS ${fmt(d.stocks.summary.total.current)}`,`P&L +${fmt(d.stocks.summary.total.pl)}`,`P.LENDING ${fmt(d.personalLending.totalCapital)}`,`LENDEN ${fmt(d.lendenClub.totalPooled)}`,`HDFC ${fmt(d.loans.hdfc.outstanding)}`,`IDFC ${fmt(d.loans.idfc.outstanding)}`,`LAND PAID ${fmt(d.realEstate.paid)}`].map((t,i)=>(
            <span key={i}><span style={{color:P.gold}}>◈</span> {t}</span>
          ))}
          {[`NET WORTH ${fmt(netWorth)}`,`SALARY ₹${(d.income.salary/1000).toFixed(0)}K`,`IN-HAND ${fmt(d.income.inHand)}`].map((t,i)=>(
            <span key={`r${i}`}><span style={{color:P.gold}}>◈</span> {t}</span>
          ))}
        </div>
      </div>

      {/* ── HEADER ── */}
      <div style={{background:`linear-gradient(135deg,${P.card},${P.card2})`,borderBottom:`1px solid ${P.border}`,padding:"12px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:100,backdropFilter:"blur(16px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <div style={{width:38,height:38,borderRadius:12,background:`linear-gradient(135deg,${P.gold},${P.orange})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:`0 0 14px ${P.gold}55`}}>₹</div>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:P.text,letterSpacing:-0.5}}>
              {d.settings.name}
            </div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,letterSpacing:2,textTransform:"uppercase"}}>Personal Finance · {d.settings.city} · Auto-Sync 5m</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <SyncBadge status={syncSt} lastSync={lastSync}/>
          {/* Countdown ring */}
          <div style={{position:"relative",width:34,height:34,cursor:"pointer"}} onClick={()=>syncFnRef.current()}>
            <svg viewBox="0 0 34 34" style={{transform:"rotate(-90deg)"}}>
              <circle cx="17" cy="17" r="13" fill="none" stroke={P.border} strokeWidth="2.5"/>
              <circle cx="17" cy="17" r="13" fill="none" stroke={P.gold} strokeWidth="2.5"
                strokeDasharray={`${(cd/30)*81.7} 81.7`} strokeLinecap="round" style={{transition:"stroke-dasharray .9s linear"}}/>
            </svg>
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",color:P.gold,fontSize:9,fontWeight:700,fontFamily:"'Fira Code',monospace"}}>{cd}</div>
          </div>
          <div style={{textAlign:"right",borderLeft:`1px solid ${P.border}`,paddingLeft:14}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,textTransform:"uppercase",letterSpacing:1.5}}>Net Worth</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:netWorth>0?P.emerald:P.ruby}}>{fmt(netWorth)}</div>
          </div>
        </div>
      </div>

      {/* ── CORS WARNING BANNER ── */}
      {corsWarn && (
        <div style={{background:`${P.orange}14`,borderBottom:`1px solid ${P.orange}33`,padding:"10px 24px"}}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <span style={{color:P.orange,fontSize:14,marginTop:1}}>⚠</span>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:12,fontWeight:700,color:P.orange,marginBottom:4}}>
                {syncSt==="hosted" ? "Hosted Page Blocked External Script Load" : "CORS Error — Apps Script Connection Blocked"}
              </div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:`${P.orange}cc`,lineHeight:1.9}}>
                {syncSt==="hosted"
                  ? <><span style={{color:P.gold}}>Apps Script looks reachable, but this host likely blocks Google script injection/fetch.</span> Move the dashboard to <span style={{color:P.gold}}>Vercel</span> or <span style={{color:P.gold}}>Netlify</span>, or call Apps Script through a same-origin backend proxy. {syncHint && <>Latest detail: <code style={{background:"#ffffff0A",padding:"1px 5px",borderRadius:4}}>{syncHint}</code></>}</>
                  : <><span style={{color:P.gold}}>Fix in your Google Apps Script:</span> (1) In <code>doGet(e)</code>, return: <code style={{background:"#ffffff0A",padding:"1px 5px",borderRadius:4}}>ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)</code> · (2) Redeploy → <span style={{color:P.gold}}>Execute as: Me</span> · <span style={{color:P.gold}}>Who has access: Anyone</span> · (3) Copy new URL and update SCRIPTS constant. {syncHint && <>Latest detail: <code style={{background:"#ffffff0A",padding:"1px 5px",borderRadius:4}}>{syncHint}</code></>}</>}
              </div>
            </div>
            <button onClick={()=>setCorsWarn(false)} style={{marginLeft:"auto",background:"none",border:`1px solid ${P.orange}44`,color:P.orange,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:10,fontFamily:"'Fira Code',monospace",flexShrink:0}}>✕ Dismiss</button>
          </div>
        </div>
      )}

      {/* ── SYNC LOG BAR + TERMINAL ── */}
      {syncLog.length > 0 && (
        <div style={{background:"#040912",borderBottom:`1px solid ${P.border}`}}>
          {/* Compact summary bar */}
          <div style={{padding:"5px 24px",display:"flex",gap:14,flexWrap:"wrap",alignItems:"center",cursor:"pointer"}} onClick={()=>setSyncLogOpen(o=>!o)}>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginRight:4}}>📋 SYNC LOG</span>
            {/* Latest batch summary - last 6 unique keys */}
            {[...new Map(syncLog.map(l=>[l.key,l])).values()].slice(0,6).map(l=>(
              <span key={l.key} style={{fontFamily:"'Fira Code',monospace",fontSize:10,
                color:l.status==="✅ OK"?P.emerald:l.status.includes("CORS")?P.orange:P.ruby}}>
                {l.status==="✅ OK"?"✅":l.status.includes("CORS")?"⚠":"❌"} {l.key}
              </span>
            ))}
            <span style={{marginLeft:"auto",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,display:"flex",gap:12,alignItems:"center"}}>
              next <span style={{color:P.gold}}>{cd}s</span>
              <span style={{color:P.gold,cursor:"pointer"}} onClick={e=>{e.stopPropagation();syncFnRef.current();}}>↻ now</span>
              <span style={{color:P.muted}}>{syncLogOpen?"▲ hide":"▼ logs"}</span>
            </span>
          </div>
          {/* Expanded terminal */}
          {syncLogOpen && (
            <div style={{maxHeight:220,overflowY:"auto",padding:"8px 24px 12px",borderTop:`1px solid ${P.border}22`,
              background:"#020810",fontFamily:"'Fira Code',monospace",fontSize:10,lineHeight:1.85}}>
              <div style={{color:P.muted,marginBottom:6,fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>
                ── terminal · last {syncLog.length} entries ──
              </div>
              {syncLog.map((l,i)=>(
                <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"1px 0",
                  borderBottom:i<syncLog.length-1?`1px solid ${P.border}0A`:"none"}}>
                  <span style={{color:P.muted,flexShrink:0,fontSize:9}}>[{l.ts}]</span>
                  <span style={{flexShrink:0,minWidth:52,
                    color:l.status==="✅ OK"?P.emerald:l.status.includes("CORS")?P.orange:P.ruby}}>
                    {l.status}
                  </span>
                  <span style={{color:P.sapphire,flexShrink:0,minWidth:90}}>{l.key}</span>
                  <span style={{color:P.muted,flexShrink:0,fontSize:9,minWidth:40}}>{l.dur}</span>
                  {l.summary && <span style={{color:P.text,flex:1,fontSize:9}}>{l.summary}</span>}
                  {l.error   && <span style={{color:P.ruby,flex:1,fontSize:9}}>{l.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TABS ── */}
      <div style={{background:P.card,borderBottom:`1px solid ${P.border}`,display:"flex",overflowX:"auto",padding:"0 16px",gap:2}}>
        {TABS.map(t=>(
          <button key={t.id} className="tbtn" onClick={()=>setTab(t.id)}
            style={{padding:"11px 14px",color:tab===t.id?P.gold:P.muted,borderBottom:tab===t.id?`2px solid ${P.gold}`:"2px solid transparent",fontSize:11.5,fontWeight:tab===t.id?600:400,whiteSpace:"nowrap",marginBottom:-1,background:tab===t.id?`${P.gold}08`:"none"}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── CONTENT ── */}
      <div style={{padding:"20px 24px",maxWidth:1560,margin:"0 auto"}}>

        {/* ═══ AI HUB — LIVE ADVISOR ═══ */}
        {tab==="aihub" && <AIHub data={data}/>}

        {/* ═══ API SETTINGS ═══ */}
        {tab==="urlsettings" && (
          <APISettings
            apiUrl={apiUrl}
            setApiUrl={setApiUrl}
            onSyncNow={()=>syncFnRef.current()}
          />
        )}

        {/* ═══ SALARY TRACKER ═══ */}
        {tab==="salary" && <SalaryTracker data={data}/>}

        {/* ═══ OVERVIEW ═══ */}
        {tab==="overview" && (
          <div className="fade">
            {(() => {
              const sh = data.salaryHistory || [];
              const last2 = sh.slice(-2);
              const salTrend = last2.length===2 ? Math.round(((last2[1].salary-last2[0].salary)/Math.max(1,last2[0].salary))*100) : null;
              const ihTrend  = last2.length===2 ? Math.round((((last2[1].inHand||last2[1].savings)-(last2[0].inHand||last2[0].savings))/Math.max(1,(last2[0].inHand||last2[0].savings)))*100) : null;
              return (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:10,marginBottom:16}}>
              <KPI label="Monthly Salary"    value={fmt(d.income.salary)}               sub={`Age ${d.income.age} · ${d.income.year}`}  color={P.gold}     icon="💼" trend={salTrend}/>
              <KPI label="In-Hand Income"    value={fmt(d.income.inHand)}               sub={`Savings rate ${savingsRate}%`}            color={P.emerald}  icon="💵" trend={ihTrend}/>
              <KPI label="Total Investments" value={fmt(totalInv)}                      sub="All assets"                               color={P.sapphire} icon="📊"/>
              <KPI label="Total Debt"        value={fmt(totalDebt)}                     sub="3 active loans"                           color={P.ruby}     icon="🏦"/>
              <KPI label="Stock Portfolio"   value={fmt(d.stocks.summary.total.current)}sub={`P&L ${fmt(d.stocks.summary.total.pl)}`}  color={P.violet}   icon="📈"/>
              <KPI label="EMI Burden"        value={`${emiPct}%`}                       sub={`${fmt(emiTotal)}/month`}                  color={emiPct>50?P.ruby:P.orange} icon="💳"/>
              <KPI label="Lending Received" value={fmt(d.income.lendingInterest || d.personalLending.receivedThisMonth || 0)} sub={d.income.month ? `Actual in ${d.income.month}` : (d.personalLending.receivedMonthLabel ? `Interest in ${d.personalLending.receivedMonthLabel}` : "Latest received month")} color={P.teal} icon="🤝"/>
              <KPI label="LendenClub Pool"   value={fmt(d.lendenClub.totalPooled)}      sub="P2P portfolio"                            color={P.rose}     icon="🏛"/>
            </div>
              );
            })()}

            <div style={{display:"grid",gridTemplateColumns:"1.2fr 1fr 1fr",gap:14,marginBottom:14}}>
              <Card accent={P.gold}>
                <SectionHead title="Investment Allocation" icon="🥧"/>
                <div style={{display:"flex",alignItems:"center",gap:16}}>
                  <ResponsiveContainer width="45%" height={180}>
                    <PieChart>
                      <Pie data={allocData} cx="50%" cy="50%" innerRadius={44} outerRadius={72} dataKey="value" paddingAngle={4}>
                        {allocData.map((_,i)=><Cell key={i} fill={CC[i]}/>)}
                      </Pie>
                      <Tooltip content={<CTip/>}/>
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{flex:1}}>
                    {allocData.map((item,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:i<allocData.length-1?`1px solid ${P.border}22`:"none"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{width:8,height:8,borderRadius:"50%",background:CC[i],boxShadow:`0 0 6px ${CC[i]}88`}}/>
                          <span style={{fontSize:10,color:P.muted,fontFamily:"'Fira Code',monospace"}}>{item.name}</span>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:11,fontWeight:600,color:P.text,fontFamily:"'Fira Code',monospace"}}>{fmt(item.value)}</div>
                          <div style={{fontSize:9,color:P.muted,fontFamily:"'Fira Code',monospace"}}>{pct(item.value,totalInv)}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card accent={P.emerald}>
                <SectionHead title="Income Flow" icon="⚖️" color={P.emerald}/>
                <ResponsiveContainer width="100%" height={175}>
                  <BarChart barSize={22} data={[
                    {name:"Gross", v:d.income.grossTotal},
                    {name:"Tax",   v:d.income.taxDeducted},
                    {name:"EMIs",  v:emiTotal},
                    {name:"CC",    v:d.income.creditCardBills},
                    {name:"InHand",v:d.income.inHand},
                  ]}>
                    <XAxis dataKey="name" tick={{fill:P.muted,fontSize:10,fontFamily:"Fira Code"}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <Bar dataKey="v" name="₹" radius={[5,5,0,0]}>
                      {[P.gold,P.ruby,P.ruby,P.orange,P.emerald].map((c,i)=><Cell key={i} fill={c}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card accent={P.ruby}>
                <SectionHead title="Assets vs Liabilities" icon="⚡" color={P.ruby}/>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {[
                    {label:"Stocks & MF",     v:d.stocks.summary.total.current, color:P.violet},
                    {label:"Personal Lending",v:d.personalLending.totalCapital,  color:P.teal  },
                    {label:"LendenClub",      v:d.lendenClub.totalPooled,         color:P.rose  },
                    {label:"Land (paid)",     v:d.realEstate.paid,                color:P.gold  },
                    {label:"HDFC Loan",       v:d.loans.hdfc.outstanding,         color:P.ruby  },
                    {label:"IDFC Loan",       v:d.loans.idfc.outstanding,         color:P.ruby  },
                    {label:"SBI Loan",        v:d.loans.sbi.outstanding,          color:P.orange},
                  ].map((row,i)=>(
                    <div key={i}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontSize:10,color:P.muted,fontFamily:"'Fira Code',monospace"}}>{row.label}</span>
                        <span style={{fontSize:10,color:row.color,fontWeight:600,fontFamily:"'Fira Code',monospace"}}>{fmt(row.v)}</span>
                      </div>
                      <PBar value={row.v} max={totalInv} color={row.color} height={4}/>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card accent={P.sapphire}>
              <SectionHead title="Loan Repayment Progress" icon="🏦" color={P.sapphire}/>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:24}}>
                {[
                  {...d.loans.hdfc,color:P.ruby},
                  {...d.loans.idfc,color:P.sapphire},
                  {...d.loans.sbi, color:P.orange},
                ].map(l=>(
                  <div key={l.name} style={{display:"flex",gap:16,alignItems:"center",padding:16,background:P.card3,borderRadius:12,border:`1px solid ${P.border}`}}>
                    <DonutRing pct={(l.paid/l.total)*100} color={l.color} size={90} stroke={8} label={`${Math.round((l.paid/l.total)*100)}%`} sub="paid"/>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:700,color:P.text,marginBottom:4}}>{l.name} Loan</div>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.9}}>
                        <div>EMI <span style={{color:l.color}}>{fmt(l.emi)}/mo</span></div>
                        <div>Outstanding <span style={{color:P.ruby}}>{fmt(l.outstanding)}</span></div>
                        <div>EMIs {l.paid}/{l.total} · {l.total-l.paid} left</div>
                        {l.interestRate&&<div>Rate <span style={{color:P.gold}}>{l.interestRate}% p.a.</span></div>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* ── Monthly Salary Flow Table ── */}
            {(()=>{
              const hist = d.salaryHistory || [];
              const parseM = m => { const p = String(m).match(/^([A-Za-z]+)-(\d{2,4})$/); return p ? { name:p[1], yr: p[2].length===2 ? "20"+p[2] : p[2] } : { name:m, yr:"" }; };
              const yrs = ["ALL", ...Array.from(new Set(hist.map(h=>parseM(h.month).yr).filter(Boolean)))];
              const mos = ["ALL", ...Array.from(new Set(hist.map(h=>parseM(h.month).name).filter(Boolean)))];
              const filtered = hist.filter(h => {
                const p = parseM(h.month);
                return (ovYear==="ALL" || p.yr===ovYear) && (ovMonth==="ALL" || p.name===ovMonth);
              });

              const curDebt = n(d.loans.hdfc.outstanding)+n(d.loans.idfc.outstanding)+n(d.loans.sbi.outstanding);
              const abs = v => `₹${Math.round(n(v)).toLocaleString("en-IN")}`;

              const enriched = filtered.map(r => {
                const emi     = n(r.hdfcEmi)+n(r.idfcEmi)+n(r.sbiEmi);
                const invest  = n(r.personalLending)+n(r.lendenClub)+n(r.equityStocks)+n(r.mutualFunds);
                const expense = n(r.ccBills)+n(r.taxDed);
                const gross   = n(r.grossTotal)||n(r.totalIncome);
                const ih      = n(r.inHand)||n(r.savings);
                const nw      = totalInv - curDebt;
                return { ...r, emi, invest, expense, debt: curDebt, nw, gross, ih };
              });

              const sm = (arr,k) => arr.reduce((s,r)=>s+n(r[k]),0);
              const selStyle = {background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10};

              return (
                <Card accent={P.teal} style={{marginTop:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
                    <SectionHead title="Monthly Salary Flow" icon="📊" color={P.teal}/>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
                      <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Year</span>
                      <select value={ovYear} onChange={e=>setOvYear(e.target.value)} style={selStyle}>
                        {yrs.map(y=><option key={y} value={y}>{y==="ALL"?"All Years":y}</option>)}
                      </select>
                      <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Month</span>
                      <select value={ovMonth} onChange={e=>setOvMonth(e.target.value)} style={selStyle}>
                        {mos.map(m=><option key={m} value={m}>{m==="ALL"?"All Months":m}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <table className="row-hover" style={{minWidth:1100}}>
                      <thead>
                        <tr>
                          <TH left>Month</TH><TH>Salary</TH><TH>Tutoring</TH><TH>Lending Int.</TH>
                          <TH>Gross Income</TH><TH>Expenses</TH><TH>Loan EMIs</TH>
                          <TH>Investments</TH><TH>In Hand</TH><TH>Total Debts</TH><TH>Net Worth</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {enriched.map((r,i)=>(
                          <tr key={i}>
                            <TD left bold color={P.text}>{r.month}</TD>
                            <TD color={P.gold}>{abs(r.salary)}</TD>
                            <TD color={P.emerald}>{abs(r.tutoring)}</TD>
                            <TD color={P.teal}>{abs(r.lendingInterest)}</TD>
                            <TD bold color={P.gold}>{abs(r.gross)}</TD>
                            <TD color={P.ruby}>{abs(r.expense)}</TD>
                            <TD color={P.ruby}>{abs(r.emi)}</TD>
                            <TD color={P.sapphire}>{abs(r.invest)}</TD>
                            <TD bold color={P.emerald}>{abs(r.ih)}</TD>
                            <TD color={P.ruby}>{abs(r.debt)}</TD>
                            <TD bold color={r.nw>=0?P.emerald:P.ruby}>{abs(r.nw)}</TD>
                          </tr>
                        ))}
                        {enriched.length>1&&(
                          <tr style={{background:P.card2,borderTop:`2px solid ${P.border}`}}>
                            <TD left bold color={P.gold}>TOTAL</TD>
                            <TD bold color={P.gold}>{abs(sm(enriched,"salary"))}</TD>
                            <TD bold color={P.emerald}>{abs(sm(enriched,"tutoring"))}</TD>
                            <TD bold color={P.teal}>{abs(sm(enriched,"lendingInterest"))}</TD>
                            <TD bold color={P.gold}>{abs(sm(enriched,"gross"))}</TD>
                            <TD bold color={P.ruby}>{abs(sm(enriched,"expense"))}</TD>
                            <TD bold color={P.ruby}>{abs(sm(enriched,"emi"))}</TD>
                            <TD bold color={P.sapphire}>{abs(sm(enriched,"invest"))}</TD>
                            <TD bold color={P.emerald}>{abs(sm(enriched,"ih"))}</TD>
                            <TD bold color={P.ruby}>{abs(sm(enriched,"debt"))}</TD>
                            <TD bold color={sm(enriched,"nw")>=0?P.emerald:P.ruby}>{abs(sm(enriched,"nw"))}</TD>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {enriched.length===0&&<div style={{textAlign:"center",padding:20,color:P.muted,fontFamily:"'Fira Code',monospace",fontSize:11}}>No data for selected period</div>}
                </Card>
              );
            })()}

          </div>
        )}

        {/* ═══ INCOME & BUDGET ═══ */}
        {tab==="income" && (
          <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <Card accent={P.gold}>
              <SectionHead title={`Income Sources — ${d.income.month || "Current Month"}`} icon="💰"/>
              <table className="row-hover">
                <thead><tr><TH left>Source</TH><TH>Monthly (₹)</TH><TH>Annual (₹)</TH><TH>Share</TH></tr></thead>
                <tbody>
                  {[
                    {label:"Salary",                   v:d.income.salary,          color:P.gold   },
                    {label:"DevOps Tutoring",          v:d.income.tutoring,        color:P.emerald},
                    {label:"Personal Lending Interest",v:d.income.lendingInterest, color:P.teal},
                    {label:"Other Income",             v:d.income.otherIncome,     color:P.violet },
                    {label:"Tax Refunded",             v:d.income.taxRefunded,     color:P.sapphire},
                  ].map((r,i)=>(
                    <tr key={i}><TD left bold color={P.text}>{r.label}</TD><TD color={r.color}>{fmtF(r.v)}</TD><TD color={r.color}>{fmtF(r.v*12)}</TD><TD>{pct(r.v,d.income.grossTotal)}%</TD></tr>
                  ))}
                  <tr style={{background:P.card2}}><TD left bold color={P.gold}>Gross Total</TD><TD bold color={P.gold}>{fmtF(d.income.grossTotal)}</TD><TD bold color={P.gold}>{fmtF(d.income.grossTotal*12)}</TD><TD bold color={P.gold}>100%</TD></tr>
                </tbody>
              </table>
            </Card>

            <Card accent={P.ruby}>
              <SectionHead title="Outflows Breakdown" icon="💸" color={P.ruby}/>
              <table className="row-hover">
                <thead><tr><TH left>Item</TH><TH>Monthly</TH><TH>Annual</TH><TH>% of Gross</TH></tr></thead>
                <tbody>
                  {[
                    {label:"Tax Deducted",  v:d.income.taxDeducted,    color:P.ruby  },
                    {label:"HDFC EMI",      v:d.income.hdfcEmi,        color:P.ruby  },
                    {label:"IDFC EMI",      v:d.income.idfcEmi,        color:P.ruby  },
                    {label:"SBI EMI",       v:d.income.sbiEmi,         color:P.orange},
                    {label:"Credit Card",   v:d.income.creditCardBills, color:P.orange},
                  ].map((r,i)=>(
                    <tr key={i}><TD left color={P.text}>{r.label}</TD><TD color={r.color}>−{fmtF(r.v)}</TD><TD color={r.color}>−{fmtF(r.v*12)}</TD><TD>{pct(r.v,d.income.grossTotal)}%</TD></tr>
                  ))}
                  <tr style={{background:P.card2}}><TD left bold color={P.emerald}>💵 In-Hand</TD><TD bold color={P.emerald}>{fmtF(d.income.inHand)}</TD><TD bold color={P.emerald}>{fmtF(d.income.inHand*12)}</TD><TD bold color={P.emerald}>{savingsRate}%</TD></tr>
                </tbody>
              </table>
              <div style={{marginTop:12,padding:"10px 12px",background:P.card2,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.8}}>
                💡 EMI burden: <span style={{color:emiPct>50?P.ruby:P.gold}}>{emiPct}%</span> of salary · Savings rate: <span style={{color:P.emerald}}>{savingsRate}%</span>
              </div>
            </Card>

            <Card accent={P.sapphire} style={{gridColumn:"1/-1"}}>
              <SectionHead title="Monthly Budget vs Actual Spend" icon="📋" color={P.sapphire}/>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:20}}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart barGap={3} barSize={14} data={Object.entries({
                    Food:{budget:d.budget.food,actual:d.budget.actual.food},
                    Transport:{budget:d.budget.transport,actual:d.budget.actual.transport},
                    Utilities:{budget:d.budget.utilities,actual:d.budget.actual.utilities},
                    Medical:{budget:d.budget.medical,actual:d.budget.actual.medical},
                    Entertainment:{budget:d.budget.entertainment,actual:d.budget.actual.entertainment},
                    Shopping:{budget:d.budget.shopping,actual:d.budget.actual.shopping},
                    Fuel:{budget:d.budget.fuel,actual:d.budget.actual.fuel},
                    Grooming:{budget:d.budget.grooming,actual:d.budget.actual.grooming},
                    Misc:{budget:d.budget.misc,actual:d.budget.actual.misc},
                  }).map(([k,v])=>({name:k,...v}))}>
                    <XAxis dataKey="name" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${v/1000}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:10,fontFamily:"Fira Code",color:P.muted}}/>
                    <Bar dataKey="budget" name="Budget" fill={`${P.sapphire}88`} radius={[3,3,0,0]}/>
                    <Bar dataKey="actual" name="Actual" fill={P.gold} radius={[3,3,0,0]}/>
                  </BarChart>
                </ResponsiveContainer>
                <table>
                  <thead><tr><TH left>Category</TH><TH>Budget</TH><TH>Actual</TH></tr></thead>
                  <tbody>
                    {Object.entries(d.budget).filter(([k])=>k!=="actual").map(([k,v])=>{
                      const act=d.budget.actual[k]||0;
                      return <tr key={k}><TD left color={P.text}>{k.charAt(0).toUpperCase()+k.slice(1)}</TD><TD>{fmtF(v)}</TD><TD color={act>v?P.ruby:P.emerald}>{fmtF(act)}</TD></tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card accent={P.teal} style={{gridColumn:"1/-1"}}>
              <SectionHead title="Annual Tax Log" icon="🧾" color={P.teal}/>
              <table className="row-hover">
                <thead><tr><TH>FY</TH><TH>Age</TH><TH>Gross Income</TH><TH>Deductions</TH><TH>Taxable Income</TH><TH>Tax Liability</TH><TH>TDS Cut</TH><TH>Self-Assessment</TH><TH>Eff. Rate</TH><TH>Regime</TH></tr></thead>
                <tbody>
                  {d.taxLog.map((t,i)=>(
                    <tr key={i}><TD color={P.gold}>{t.fy}</TD><TD>{t.age}</TD><TD color={P.text}>{fmtF(t.grossIncome)}</TD><TD color={P.emerald}>{fmtF(t.deductions)}</TD><TD>{fmtF(t.taxableIncome)}</TD><TD color={P.ruby}>{fmtF(t.taxLiability)}</TD><TD>{fmtF(t.tds)}</TD><TD>{fmtF(t.selfAssessment)}</TD><TD>{t.effectiveRate}%</TD><TD><Pill color={P.sapphire}>{t.regime}</Pill></TD></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* ═══ DAILY EXPENSES ═══ */}
        {tab==="expenses" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              {["Essential","Fixed","Lifestyle","Others"].map((tag,i)=>{
                const total=d.dailyExpenses.filter(e=>e.tag===tag||(!["Essential","Fixed","Lifestyle"].includes(e.tag)&&tag==="Others")).reduce((s,e)=>s+n(e.amount),0);
                return <KPI key={i} label={tag} value={fmtF(total)} color={[P.gold,P.ruby,P.violet,P.muted][i]} icon={["🥗","📌","🎭","❓"][i]}/>;
              })}
            </div>
            <Card accent={P.gold}>
              <SectionHead title="Daily Expense Log — Mar 2026" icon="🧾"/>
              <div style={{overflowX:"auto"}}>
                <table className="row-hover">
                  <thead><tr><TH>Date</TH><TH>Day</TH><TH>Category</TH><TH left>Description</TH><TH>Amount</TH><TH>Mode</TH><TH>Tag</TH></tr></thead>
                  <tbody>
                    {d.dailyExpenses.map((e,i)=>{
                      const tagColor=e.tag==="Essential"?P.gold:e.tag==="Fixed"?P.ruby:e.tag==="Lifestyle"?P.violet:P.muted;
                      return (
                        <tr key={i}>
                          <TD color={P.muted}>{e.date}</TD>
                          <TD color={P.muted}>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(2026,2,parseInt(e.date))||0]||""}</TD>
                          <TD color={P.sapphire}>{e.category}</TD>
                          <TD left color={P.text}>{e.desc}</TD>
                          <TD bold color={e.amount>0?P.text:P.muted}>{e.amount>0?fmtF(e.amount):"—"}</TD>
                          <TD><Pill color={P.sapphire}>{e.mode}</Pill></TD>
                          <TD><Pill color={tagColor}>{e.tag}</Pill></TD>
                        </tr>
                      );
                    })}
                    <tr style={{background:P.card2}}>
                      <TD bold color={P.gold} left>TOTAL</TD><TD/><TD/><TD/>
                      <TD bold color={P.gold}>{fmtF(d.dailyExpenses.reduce((s,e)=>s+n(e.amount),0))}</TD><TD/><TD/>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{marginTop:16}}>
                <SectionHead title="Spend by Category" icon="📊"/>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart barSize={28} data={Object.entries(d.dailyExpenses.reduce((acc,e)=>{acc[e.category]=(acc[e.category]||0)+n(e.amount);return acc},{})).map(([k,v])=>({name:k,v}))}>
                    <XAxis dataKey="name" tick={{fill:P.muted,fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <Bar dataKey="v" name="Spent" radius={[4,4,0,0]}>
                      {Object.keys(d.dailyExpenses.reduce((a,e)=>{a[e.category]=1;return a},{})).map((_,i)=><Cell key={i} fill={CC[i%CC.length]}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
        )}

        {/* ═══ STOCKS & CRYPTO ═══ */}
        {tab==="stocks" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              <KPI label="Total Invested"  value={fmt(d.stocks.summary.total.invested)} color={P.sapphire} icon="💰"/>
              <KPI label="Current Value"   value={fmt(d.stocks.summary.total.current)}  color={P.gold}     icon="📊"/>
              <KPI label="Total P&L"       value={`+${fmt(d.stocks.summary.total.pl)}`} sub={`+${pct(d.stocks.summary.total.pl,d.stocks.summary.total.invested)}%`} color={P.emerald} icon="📈"/>
              <KPI label="Options Net P&L" value={`+${fmt(d.stocks.summary.options.pl)}`} sub="F&O trading" color={P.violet} icon="⚡"/>
            </div>

            <Card accent={P.sapphire} style={{marginBottom:14}}>
              <SectionHead title="Mutual Funds" icon="📦" color={P.sapphire}/>
              <table className="row-hover">
                <thead><tr><TH left>Fund Name</TH><TH>AMC</TH><TH>Type</TH><TH>Mode</TH><TH>Invested</TH><TH>Current</TH><TH>Returns</TH><TH>Returns%</TH><TH>Status</TH></tr></thead>
                <tbody>
                  {d.stocks.mutualFunds.map((f,i)=>(
                    <tr key={i}>
                      <TD left bold color={P.text}>{f.name}</TD><TD color={P.muted}>{f.amc}</TD>
                      <TD><Pill color={P.sapphire}>{f.type}</Pill></TD>
                      <TD><Pill color={P.teal}>{f.mode}</Pill></TD>
                      <TD>{fmtF(f.invested)}</TD><TD color={P.gold}>{fmtF(f.current)}</TD>
                      <TD color={P.emerald}>+{fmtF(f.returns)}</TD>
                      <TD color={P.emerald}>+{Math.round(f.returnsP)}%</TD>
                      <TD><Pill color={P.emerald}>{f.status}</Pill></TD>
                    </tr>
                  ))}
                  <tr style={{background:P.card2}}>
                    <TD bold colSpan={4} left color={P.gold}>MF TOTAL</TD>
                    <TD bold>{fmtF(d.stocks.summary.mf.invested)}</TD>
                    <TD bold color={P.gold}>{fmtF(d.stocks.summary.mf.current)}</TD>
                    <TD bold color={P.emerald}>+{fmtF(d.stocks.summary.mf.pl)}</TD><TD/><TD/>
                  </tr>
                </tbody>
              </table>
            </Card>

            <Card accent={P.violet} style={{marginBottom:14}}>
              <SectionHead title="Equity Holdings" icon="📉" color={P.violet}/>
              <table className="row-hover">
                <thead><tr><TH>Symbol</TH><TH left>Company</TH><TH>Exchange</TH><TH>Qty</TH><TH>Avg Buy</TH><TH>Invested</TH><TH>CMP</TH><TH>Current</TH><TH>P&L</TH><TH>P&L%</TH><TH>Sector</TH></tr></thead>
                <tbody>
                  {d.stocks.equity.map((e,i)=>(
                    <tr key={i}>
                      <TD bold color={P.gold}>{e.symbol}</TD><TD left color={P.text}>{e.company}</TD>
                      <TD><Pill color={P.sapphire}>{e.exchange}</Pill></TD>
                      <TD>{e.qty}</TD><TD>{fmtF(e.avgBuy)}</TD><TD>{fmtF(e.invested)}</TD>
                      <TD color={P.gold}>{fmtF(e.cmp)}</TD><TD color={P.gold}>{fmtF(e.current)}</TD>
                      <TD color={P.emerald}>+{fmtF(e.pl)}</TD>
                      <TD color={P.emerald}>+{Math.round(e.plP)}%</TD>
                      <TD><Pill color={P.violet}>{e.sector}</Pill></TD>
                    </tr>
                  ))}
                  <tr style={{background:P.card2}}>
                    <TD bold colSpan={5} left color={P.gold}>EQUITY TOTAL</TD>
                    <TD bold>{fmtF(d.stocks.summary.equity.invested)}</TD><TD/><TD bold color={P.gold}>{fmtF(d.stocks.summary.equity.current)}</TD>
                    <TD bold color={P.emerald}>+{fmtF(d.stocks.summary.equity.pl)}</TD><TD/><TD/>
                  </tr>
                </tbody>
              </table>
            </Card>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <Card accent={P.orange}>
                <SectionHead title="F&O Options" icon="⚡" color={P.orange}/>
                <table className="row-hover">
                  <thead><tr><TH>Date</TH><TH>Index</TH><TH>Type</TH><TH>Strike</TH><TH>Lots</TH><TH>Buy</TH><TH>Sell</TH><TH>Gross P&L</TH><TH>Net P&L</TH><TH>Status</TH></tr></thead>
                  <tbody>
                    {d.stocks.options.map((o,i)=>(
                      <tr key={i}>
                        <TD color={P.muted}>{o.date}</TD><TD bold color={P.gold}>{o.index}</TD>
                        <TD><Pill color={o.type==="CE"?P.emerald:P.ruby}>{o.type}</Pill></TD>
                        <TD>{o.strike.toLocaleString("en-IN")}</TD><TD>{o.lots}</TD>
                        <TD>{o.buyPremium}</TD><TD>{o.sellPremium}</TD>
                        <TD color={o.grossPL>=0?P.emerald:P.ruby}>{o.grossPL>=0?"+":""}{fmtF(o.grossPL)}</TD>
                        <TD bold color={o.netPL>=0?P.emerald:P.ruby}>{o.netPL>=0?"+":""}{fmtF(o.netPL)}</TD>
                        <TD><Pill color={P.muted}>{o.status}</Pill></TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card accent={P.gold}>
                <SectionHead title="Crypto Holdings" icon="₿"/>
                <table className="row-hover">
                  <thead><tr><TH>Coin</TH><TH>Symbol</TH><TH>Exchange</TH><TH>Qty</TH><TH>Buy Price ₹</TH><TH>Invested</TH><TH>Current</TH><TH>P&L</TH><TH>P&L%</TH></tr></thead>
                  <tbody>
                    {d.stocks.crypto.map((c,i)=>(
                      <tr key={i}>
                        <TD bold color={P.gold}>{c.coin}</TD><TD color={P.muted}>{c.symbol}</TD>
                        <TD><Pill color={P.violet}>{c.exchange}</Pill></TD>
                        <TD>{c.qty}</TD><TD>₹{Math.round(c.buyPrice).toLocaleString("en-IN")}</TD>
                        <TD>{fmtF(c.invested)}</TD><TD color={P.gold}>{fmtF(c.current)}</TD>
                        <TD color={P.emerald}>+{fmtF(c.pl)}</TD>
                        <TD color={P.emerald}>+{Math.round(c.plP)}%</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{marginTop:10,padding:"8px 10px",background:`${P.ruby}0F`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.ruby}}>
                  ⚠ Crypto gains taxed at flat 30% in India. File ITR with Schedule VDA.
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ═══ LOANS ═══ */}
        {tab==="loans" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
              <KPI label="Total Loan Amount" value={`₹${Math.round(n(d.loans.hdfc.originalLoan)+n(d.loans.idfc.originalLoan)+n(d.loans.sbi.originalLoan)).toLocaleString("en-IN")}`} sub="Across all 3 loans" color={P.sapphire} icon="📋"/>
              <KPI label="Total Outstanding" value={`₹${Math.round(totalDebt).toLocaleString("en-IN")}`} sub="Remaining balance" color={P.ruby} icon="🏦"/>
              <KPI label="Monthly EMI Total" value={`₹${Math.round(emiTotal).toLocaleString("en-IN")}`} sub={`${emiPct}% of salary`} color={P.orange} icon="💳"/>
            </div>

            {/* ── Bank Filter ── */}
            <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,letterSpacing:1,marginRight:4}}>FILTER BY BANK:</span>
              {[
                {id:"ALL",  label:"All Banks", color:P.gold},
                {id:"HDFC", label:"HDFC",      color:P.ruby},
                {id:"IDFC", label:"IDFC",      color:P.sapphire},
                {id:"SBI",  label:"SBI",       color:P.orange},
              ].map(f=>(
                <button key={f.id} onClick={()=>setLoanFilter(f.id)} style={{
                  background: loanFilter===f.id ? `${f.color}22` : "transparent",
                  border: `1.5px solid ${loanFilter===f.id ? f.color : P.border2}`,
                  borderRadius: 8,
                  color: loanFilter===f.id ? f.color : P.muted,
                  fontFamily:"'Fira Code',monospace",
                  fontSize: 11,
                  fontWeight: loanFilter===f.id ? 700 : 400,
                  padding: "6px 16px",
                  cursor: "pointer",
                  transition: "all .2s",
                  letterSpacing: 0.5,
                }}>{f.label}</button>
              ))}
            </div>

            {/* ── HDFC ── */}
            {(loanFilter==="ALL" || loanFilter==="HDFC") && (
            <Card accent={P.ruby} style={{marginBottom:14}}>
              {/* Header banner */}
              <div style={{background:`linear-gradient(135deg,${P.ruby}28,${P.ruby}08)`,border:`1px solid ${P.ruby}40`,borderRadius:14,padding:"16px 20px",marginBottom:18,display:"flex",alignItems:"center",gap:16}}>
                <div style={{width:52,height:52,borderRadius:14,background:`${P.ruby}22`,border:`1.5px solid ${P.ruby}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>🏦</div>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,color:P.ruby,letterSpacing:-0.5}}>HDFC Home Loan</div>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:3}}>Home Loan · Amortisation Schedule · {d.loans.hdfc.total} EMIs</div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                  <DonutRing pct={d.loans.hdfc.total>0?(d.loans.hdfc.paid/d.loans.hdfc.total)*100:0} color={P.ruby} size={80} stroke={7} label={`${d.loans.hdfc.total>0?Math.round((d.loans.hdfc.paid/d.loans.hdfc.total)*100):0}%`} sub="done"/>
                </div>
              </div>
              {/* Stats grid */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
                {[
                  {label:"Loan Amount",    v:`₹${Math.round(n(d.loans.hdfc.originalLoan)).toLocaleString("en-IN")}`, color:P.sapphire},
                  {label:"Monthly EMI",    v:`₹${Math.round(n(d.loans.hdfc.emi)).toLocaleString("en-IN")}`,          color:P.ruby},
                  {label:"Outstanding",    v:`₹${Math.round(n(d.loans.hdfc.outstanding)).toLocaleString("en-IN")}`,  color:P.ruby},
                  {label:"Interest Rate",  v:`${d.loans.hdfc.interestRate}% p.a.`,               color:P.gold},
                  {label:"EMIs Remaining", v:`${d.loans.hdfc.total - d.loans.hdfc.paid} of ${d.loans.hdfc.total}`, color:P.text},
                  {label:"Principal Paid", v:`₹${Math.round(n(d.loans.hdfc.totalPrincipalPaid)).toLocaleString("en-IN")}`, color:P.emerald},
                  {label:"Interest Paid",  v:`₹${Math.round(n(d.loans.hdfc.totalInterestPaid)).toLocaleString("en-IN")}`,  color:P.ruby},
                ].map((s,i)=>(
                  <div key={i} style={{background:`linear-gradient(135deg,${P.card3},${P.card2})`,borderRadius:10,padding:"11px 13px",border:`1px solid ${s.color}22`,boxShadow:`inset 0 1px 0 ${s.color}11`}}>
                    <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:5}}>{s.label}</div>
                    <div style={{fontFamily:"'Fira Code',monospace",fontSize:13,fontWeight:700,color:s.color}}>{s.v}</div>
                  </div>
                ))}
              </div>
              {/* Progress */}
              <div style={{marginBottom:16,padding:"10px 14px",background:P.card3,borderRadius:10,border:`1px solid ${P.border}33`}}>
                <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:6}}>
                  <span>{d.loans.hdfc.paid} EMIs paid</span><span>{d.loans.hdfc.total - d.loans.hdfc.paid} remaining</span>
                </div>
                <PBar value={d.loans.hdfc.paid} max={d.loans.hdfc.total} color={P.ruby} height={7}/>
              </div>
              {/* Table */}
              <div style={{overflowX:"auto"}}>
                <table className="row-hover">
                  <thead><tr><TH>#</TH><TH>Due Date</TH><TH>EMI</TH><TH>Principal</TH><TH>Interest</TH><TH>Balance</TH><TH>Status</TH></tr></thead>
                  <tbody>
                    {d.loans.hdfc.schedule.map((s,i)=>(
                      <tr key={i}>
                        <TD color={P.muted}>{s.no}</TD><TD color={P.muted}>{s.date}</TD>
                        <TD>{fmtF(s.emi)}</TD><TD color={P.emerald}>{fmtF(s.principal)}</TD>
                        <TD color={P.ruby}>{fmtF(s.interest)}</TD><TD color={P.sapphire}>{fmtF(s.balance)}</TD>
                        <TD><Pill color={s.status==="paid"?P.emerald:P.muted}>{s.status||"Pending"}</Pill></TD>
                      </tr>
                    ))}
                    <tr style={{background:P.card2,fontStyle:"italic"}}><TD colSpan={7} color={P.muted} left>… 6 of 72 EMIs shown · 68 remaining</TD></tr>
                  </tbody>
                </table>
              </div>
            </Card>
            )}

            <div style={{display:"grid",gridTemplateColumns: loanFilter==="ALL" ? "1fr 1fr" : "1fr",gap:14}}>
              {/* ── IDFC ── */}
              {(loanFilter==="ALL" || loanFilter==="IDFC") && (
              <Card accent={P.sapphire}>
                {/* Header banner */}
                <div style={{background:`linear-gradient(135deg,${P.sapphire}28,${P.sapphire}08)`,border:`1px solid ${P.sapphire}40`,borderRadius:14,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:14}}>
                  <div style={{width:46,height:46,borderRadius:12,background:`${P.sapphire}22`,border:`1.5px solid ${P.sapphire}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🏦</div>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:17,fontWeight:800,color:P.sapphire,letterSpacing:-0.3}}>IDFC Personal Loan</div>
                    <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>Personal Loan · {d.loans.idfc.total} EMIs total</div>
                  </div>
                  <DonutRing pct={d.loans.idfc.total>0?(d.loans.idfc.paid/d.loans.idfc.total)*100:0} color={P.sapphire} size={70} stroke={6} label={`${d.loans.idfc.total>0?Math.round((d.loans.idfc.paid/d.loans.idfc.total)*100):0}%`} sub="done"/>
                </div>
                {/* Stats grid */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:14}}>
                  {[
                    {label:"Loan Amount",   v:`₹${Math.round(n(d.loans.idfc.originalLoan)).toLocaleString("en-IN")}`, color:P.sapphire},
                    {label:"Monthly EMI",   v:`₹${Math.round(n(d.loans.idfc.emi)).toLocaleString("en-IN")}`,          color:P.sapphire},
                    {label:"Outstanding",   v:`₹${Math.round(n(d.loans.idfc.outstanding)).toLocaleString("en-IN")}`,  color:P.ruby},
                    {label:"Interest Rate", v:`${d.loans.idfc.interestRate}% p.a.`, color:P.gold},
                    {label:"EMIs Paid",     v:`${d.loans.idfc.paid} of ${d.loans.idfc.total}`, color:P.emerald},
                    {label:"Interest Paid", v:`₹${Math.round(n(d.loans.idfc.totalInterestPaid)).toLocaleString("en-IN")}`, color:P.ruby},
                  ].map((s,i)=>(
                    <div key={i} style={{background:`linear-gradient(135deg,${P.card3},${P.card2})`,borderRadius:9,padding:"10px 12px",border:`1px solid ${s.color}22`}}>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:4}}>{s.label}</div>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:13,fontWeight:700,color:s.color}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                {/* Progress */}
                <div style={{marginBottom:14,padding:"9px 12px",background:P.card3,borderRadius:9,border:`1px solid ${P.border}33`}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:5}}>
                    <span>{d.loans.idfc.paid} paid</span><span>{d.loans.idfc.total - d.loans.idfc.paid} left</span>
                  </div>
                  <PBar value={d.loans.idfc.paid} max={d.loans.idfc.total} color={P.sapphire} height={6}/>
                </div>
                {/* Table */}
                <div style={{overflowX:"auto"}}>
                  <table className="row-hover">
                    <thead><tr><TH>#</TH><TH>Date</TH><TH>EMI</TH><TH>Principal</TH><TH>Interest</TH><TH>Balance</TH><TH>Status</TH></tr></thead>
                    <tbody>
                      {d.loans.idfc.schedule.map((s,i)=>(
                        <tr key={i}><TD color={P.muted}>{s.no}</TD><TD color={P.muted}>{s.date}</TD><TD>{fmtF(s.emi)}</TD><TD color={P.emerald}>{fmtF(s.principal)}</TD><TD color={P.ruby}>{fmtF(s.interest)}</TD><TD color={P.sapphire}>{fmtF(s.balance)}</TD><TD><Pill color={s.status==="Paid"?P.emerald:P.muted}>{s.status||"Pending"}</Pill></TD></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              )}

              {/* ── SBI ── */}
              {(loanFilter==="ALL" || loanFilter==="SBI") && (
              <Card accent={P.orange}>
                {/* Header banner */}
                <div style={{background:`linear-gradient(135deg,${P.orange}28,${P.orange}08)`,border:`1px solid ${P.orange}40`,borderRadius:14,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:14}}>
                  <div style={{width:46,height:46,borderRadius:12,background:`${P.orange}22`,border:`1.5px solid ${P.orange}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🏦</div>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"'Syne',sans-serif",fontSize:17,fontWeight:800,color:P.orange,letterSpacing:-0.3}}>SBI Personal Loan</div>
                    <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>Personal Loan · 25 EMIs total · Ends Apr 2028</div>
                  </div>
                  <DonutRing pct={(d.loans.sbi.paid/d.loans.sbi.total)*100||0} color={P.orange} size={70} stroke={6} label={`${Math.round((d.loans.sbi.paid/d.loans.sbi.total)*100)||0}%`} sub="done"/>
                </div>
                {/* Stats grid */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:14}}>
                  {[
                    {label:"Loan Amount",    v:`₹${Math.round(n(d.loans.sbi.originalLoan)).toLocaleString("en-IN")}`, color:P.orange},
                    {label:"Monthly EMI",    v:`₹${Math.round(n(d.loans.sbi.emi)).toLocaleString("en-IN")}`,          color:P.orange},
                    {label:"Outstanding",    v:`₹${Math.round(n(d.loans.sbi.outstanding)).toLocaleString("en-IN")}`,  color:P.ruby},
                    {label:"Interest Rate",  v:`${d.loans.sbi.interestRate}% p.a.`,         color:P.gold},
                    {label:"EMIs Paid",      v:`${d.loans.sbi.paid||0} of ${d.loans.sbi.total||25}`, color:P.emerald},
                    {label:"Total Interest", v:`₹${Math.round(n(d.loans.sbi.totalInterestOnLoan)).toLocaleString("en-IN")}`, color:P.ruby},
                  ].map((s,i)=>(
                    <div key={i} style={{background:`linear-gradient(135deg,${P.card3},${P.card2})`,borderRadius:9,padding:"10px 12px",border:`1px solid ${s.color}22`}}>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:4}}>{s.label}</div>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:13,fontWeight:700,color:s.color}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                {/* Progress */}
                <div style={{marginBottom:14,padding:"9px 12px",background:P.card3,borderRadius:9,border:`1px solid ${P.border}33`}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:5}}>
                    <span>{d.loans.sbi.paid||0} paid</span><span>{(d.loans.sbi.total||25) - (d.loans.sbi.paid||0)} left</span>
                  </div>
                  <PBar value={d.loans.sbi.paid||0} max={d.loans.sbi.total||25} color={P.orange} height={6}/>
                </div>
                {/* Table */}
                <div style={{overflowX:"auto"}}>
                  <table className="row-hover">
                    <thead><tr><TH>#</TH><TH>Date</TH><TH>EMI</TH><TH>Principal</TH><TH>Interest</TH><TH>Closing Bal</TH></tr></thead>
                    <tbody>
                      {d.loans.sbi.schedule.slice(0,4).map((s,i)=>(
                        <tr key={i}><TD color={P.muted}>{s.no}</TD><TD color={P.muted}>{s.date}</TD><TD>{fmtF(s.emi)}</TD><TD color={P.emerald}>{fmtF(s.principal)}</TD><TD color={P.ruby}>{fmtF(s.interest)}</TD><TD color={P.sapphire}>{fmtF(s.balance)}</TD></tr>
                      ))}
                      <tr style={{background:P.card2,fontStyle:"italic"}}><TD colSpan={6} color={P.muted} left>25 EMIs total · Ends Apr 2028</TD></tr>
                    </tbody>
                  </table>
                </div>
              </Card>
              )}
            </div>
          </div>
        )}

        {/* ═══ PERSONAL LENDING (separate dashboard) ═══ */}
        {tab==="lending" && (
          <div className="fade">
            {/* Dashboard banner */}
            <div style={{background:`linear-gradient(135deg,${P.teal}18,${P.emerald}0A)`,border:`1px solid ${P.teal}33`,borderRadius:16,padding:"16px 22px",marginBottom:16,display:"flex",alignItems:"center",gap:16}}>
              <div style={{fontSize:40}}>🤝</div>
              <div>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,color:P.teal}}>Personal Lending Portfolio</div>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>Direct peer lending · 24% annual yield · {d.personalLending.totalBorrowers} borrowers</div>
              </div>
              <div style={{marginLeft:"auto",display:"flex",gap:10}}>
                {d.personalLending.alerts.map((a,i)=>(
                  <div key={i} style={{padding:"8px 12px",background:`${i===0?P.ruby:P.gold}11`,border:`1px solid ${i===0?P.ruby:P.gold}44`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:i===0?P.ruby:P.gold,maxWidth:260}}>{a}</div>
                ))}
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              <GlassKPI label="Total Capital Deployed" value={fmt(d.personalLending.totalCapital)}   sub="As direct loans"        color={P.teal}     icon="💰"/>
              <GlassKPI label="Monthly Interest"        value={fmt(d.personalLending.monthlyInterest)}sub="Expected every month"   color={P.emerald}  icon="📅"/>
              <GlassKPI label="Received Latest Month"   value={fmt(d.income.lendingInterest || d.personalLending.receivedThisMonth || 0)}sub={d.income.month || d.personalLending.receivedMonthLabel || "No repayment log month found"} color={P.sapphire} icon="✅"/>
              <GlassKPI label="Annual Interest Yield"   value={fmt(d.personalLending.annualInterest)} sub="24%/year return"        color={P.gold}     icon="📈"/>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              <Card accent={P.teal}>
                <SectionHead title="Borrower Details" icon="🤝" color={P.teal}/>
                <div style={{overflowX:"auto"}}>
                  <table className="row-hover">
                    <thead><tr><TH>#</TH><TH left>Name</TH><TH>Amount Lent</TH><TH>Rate/Mo</TH><TH>Date Lent</TH><TH>Monthly Int</TH><TH>Elapsed</TH><TH>Accrued</TH><TH>Received</TH><TH>Pending</TH><TH>Status</TH></tr></thead>
                    <tbody>
                      {d.personalLending.borrowers.map((b,i)=>(
                        <tr key={i}>
                          <TD color={P.muted}>{b.id}</TD><TD left bold color={P.text}>{b.name}</TD>
                          <TD color={P.gold}>{fmtF(b.amount)}</TD><TD color={P.sapphire}>{n(b.rate)}%</TD>
                          <TD color={P.muted}>{b.dateLent}</TD>
                          <TD color={P.emerald}>{fmtF(b.monthlyInt)}</TD><TD>{b.monthsElapsed} mo</TD>
                          <TD color={P.text}>{fmtF(b.interestAccrued)}</TD>
                          <TD color={P.emerald}>{fmtF(b.interestReceived)}</TD>
                          <TD color={b.pendingInt>0?P.ruby:P.muted}>{fmtF(b.pendingInt)}</TD>
                          <TD><Pill color={b.status.includes("Regular")?P.emerald:P.ruby}>{b.status}</Pill></TD>
                        </tr>
                      ))}
                      <tr style={{background:P.card2}}>
                        <TD bold colSpan={2} left color={P.teal}>TOTALS</TD>
                        <TD bold color={P.gold}>{fmtF(d.personalLending.totalCapital)}</TD><TD/><TD/>
                        <TD bold color={P.emerald}>{fmtF(d.personalLending.monthlyInterest)}</TD><TD/>
                        <TD bold>{fmtF(d.personalLending.borrowers.reduce((s,b)=>s+b.interestAccrued,0))}</TD>
                        <TD bold color={P.emerald}>{fmtF(d.personalLending.receivedTillNow)}</TD>
                        <TD bold color={P.ruby}>{fmtF(d.personalLending.pendingInterest)}</TD><TD/>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card accent={P.emerald}>
                <SectionHead title="Borrower Health Board" icon="🔍" color={P.emerald}/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
                  {[
                    {label:"Total Borrowers",v:d.personalLending.totalBorrowers, color:P.gold   },
                    {label:"Active",          v:d.personalLending.activeBorrowers,color:P.emerald},
                    {label:"Regular Payers", v:d.personalLending.regularPayers,  color:P.teal   },
                    {label:"Irregular",      v:d.personalLending.irregularPayers,color:P.orange },
                    {label:"Not Paying",     v:d.personalLending.notPaying,      color:P.ruby   },
                    {label:"Annual Yield",   v:"24%",                            color:P.sapphire},
                  ].map((c,i)=>(
                    <div key={i} style={{background:P.card3,borderRadius:10,padding:"12px 10px",textAlign:"center",border:`1px solid ${c.color}22`}}>
                      <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4,letterSpacing:1}}>{c.label}</div>
                      <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color:c.color}}>{c.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{height:1,background:P.border,margin:"0 0 14px"}}/>
                <SectionHead title="Borrower P&L Chart" icon="📊" color={P.emerald}/>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={d.personalLending.borrowers.map(b=>({name:b.name,accrued:b.interestAccrued,received:b.interestReceived,pending:b.pendingInt}))}>
                    <XAxis dataKey="name" tick={{fill:P.muted,fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${v/1000}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <Bar dataKey="received" name="Received" fill={P.emerald} radius={[4,4,0,0]} stackId="a"/>
                    <Bar dataKey="pending"  name="Pending"  fill={P.ruby}    radius={[4,4,0,0]} stackId="a"/>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <Card accent={P.gold}>
              <SectionHead title="Repayment Transaction Log" icon="💸"/>
              <table className="row-hover">
                <thead><tr><TH>Date</TH><TH left>Borrower</TH><TH>Amount</TH><TH>Type</TH><TH>Balance Remaining</TH><TH>Months Paid</TH><TH>Mode</TH><TH left>Notes</TH></tr></thead>
                <tbody>
                  {d.personalLending.repaymentLog.map((r,i)=>(
                    <tr key={i}>
                      <TD color={P.muted}>{r.date}</TD><TD left bold color={P.text}>{r.borrower}</TD>
                      <TD color={P.emerald} bold>{fmtF(r.amount)}</TD>
                      <TD><Pill color={P.sapphire}>{r.type}</Pill></TD>
                      <TD color={P.muted}>{fmtF(r.balance)}</TD><TD>{r.monthsPaid}</TD>
                      <TD><Pill color={P.teal}>{r.mode}</Pill></TD>
                      <TD left color={P.muted}>{r.notes}</TD>
                    </tr>
                  ))}
                  <tr style={{background:P.card2}}>
                    <TD bold colSpan={2} left color={P.gold}>TOTAL RECEIVED</TD>
                    <TD bold color={P.emerald}>{fmtF(d.personalLending.repaymentLog.reduce((s,r)=>s+r.amount,0))}</TD>
                    <TD colSpan={5}/>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* ═══ LENDEN CLUB (separate dashboard) ═══ */}
        {tab==="lenden" && (
          <LendenClubTab data={data}/>
        )}

        {/* ═══ REAL ESTATE ═══ */}
        {tab==="realestate" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              <GlassKPI label="Total Cost"   value={fmtF(d.realEstate.totalCost)}  color={P.gold}    icon="🏡"/>
              <GlassKPI label="Amount Paid"  value={fmtF(d.realEstate.paid)}       sub={`${pct(d.realEstate.paid,d.realEstate.totalCost)}% complete`} color={P.emerald} icon="✅"/>
              <GlassKPI label="Balance Left" value={fmtF(d.realEstate.remaining)}  sub={`${d.realEstate.emisPending} EMIs pending`} color={P.ruby}    icon="⏳"/>
              <GlassKPI label="Next EMI"     value={fmtF(25000)}                   sub="20-Apr-2026" color={P.orange}  icon="📅"/>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              <Card accent={P.gold}>
                <SectionHead title="Property Details" icon="🏡"/>
                <div style={{background:`linear-gradient(135deg,${P.gold}0F,${P.gold}04)`,border:`1px solid ${P.gold}22`,borderRadius:12,padding:16,marginBottom:14}}>
                  <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:P.gold}}>{d.realEstate.name}</div>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted,lineHeight:2.1,marginTop:6}}>
                    <div>📍 {d.realEstate.location}</div>
                    <div>📐 {d.realEstate.size}</div>
                    <div>📅 Purchased {d.realEstate.purchaseDate}</div>
                    <div>🏗 Builder: {d.realEstate.builder}</div>
                    <div>📄 Documents: <span style={{color:P.orange}}>{d.realEstate.docStatus}</span></div>
                    <div>📊 Status: <Pill color={P.gold}>{d.realEstate.status}</Pill></div>
                  </div>
                </div>
                {[
                  {label:"Total Cost",          v:fmtF(d.realEstate.totalCost),         color:P.text   },
                  {label:"Total Investment",     v:fmtF(d.realEstate.totalInvestment),   color:P.gold   },
                  {label:"Amount Paid",          v:fmtF(d.realEstate.paid),              color:P.emerald},
                  {label:"Balance Remaining",    v:fmtF(d.realEstate.remaining),         color:P.ruby   },
                  {label:"Registration Charges", v:fmtF(d.realEstate.registrationCharges),color:P.muted},
                  {label:"EMIs Paid",            v:d.realEstate.emisPaid,                color:P.emerald},
                  {label:"EMIs Pending",         v:d.realEstate.emisPending,             color:P.ruby   },
                  {label:"Appreciation Rate",    v:`${d.realEstate.appreciationRate}% p.a.`,color:P.teal},
                ].map((r,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${P.border}22`}}>
                    <span style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted}}>{r.label}</span>
                    <span style={{fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:600,color:r.color}}>{r.v}</span>
                  </div>
                ))}
              </Card>

              <Card accent={P.emerald}>
                <SectionHead title="Payment Progress" icon="📊" color={P.emerald}/>
                <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
                  <DonutRing pct={+pct(d.realEstate.paid,d.realEstate.totalCost)} color={P.gold} size={150} stroke={14} label={`${Math.round(+pct(d.realEstate.paid,d.realEstate.totalCost))}%`} sub="Paid"/>
                </div>
                <PBar value={d.realEstate.paid} max={d.realEstate.totalCost} color={P.gold} height={8}/>
                <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:4}}>
                  <span>{fmtF(d.realEstate.paid)} paid</span>
                  <span>{fmtF(d.realEstate.remaining)} remaining</span>
                </div>
                <div style={{marginTop:20}}>
                  <SectionHead title="Valuation Track" icon="📈" color={P.emerald}/>
                  <table>
                    <thead><tr><TH>Year</TH><TH>Market Value</TH><TH>Total Invested</TH><TH>Unrealised Gain</TH><TH>Gain%</TH></tr></thead>
                    <tbody>
                      {d.realEstate.valuation.map((v,i)=>{
                        const purchasePrice = n(d.realEstate.totalCost);
                        const gain = v.unrealisedGain != null ? v.unrealisedGain : (v.marketValue && purchasePrice > 0 ? v.marketValue - purchasePrice : null);
                        const gainPct = v.gainP != null ? v.gainP : (gain != null && purchasePrice > 0 ? +((gain / purchasePrice) * 100).toFixed(2) : null);
                        return (
                          <tr key={i}>
                            <TD color={P.gold}>{v.year}</TD>
                            <TD color={P.muted}>{v.marketValue?fmtF(v.marketValue):"—"}</TD>
                            <TD color={P.text}>{fmtF(v.totalInvested)}</TD>
                            <TD color={gain!=null&&gain>=0?P.emerald:P.ruby}>{gain!=null?fmtF(gain):"—"}</TD>
                            <TD color={gainPct!=null&&gainPct>=0?P.emerald:P.ruby}>{gainPct!=null?`${Math.round(gainPct)}%`:"—"}</TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:10,lineHeight:1.8}}>
                    💡 Update Market Value annually. Hyderabad RE appreciates ~8% p.a. LTCG applies after 2 years.
                  </div>
                </div>
              </Card>
            </div>

            <Card accent={P.orange}>
              <SectionHead title="EMI Schedule — Tricolour Properties" icon="📅" color={P.orange}/>
              <div style={{overflowX:"auto"}}>
                <table className="row-hover">
                  <thead><tr><TH>#</TH><TH>Due Date</TH><TH>EMI Amount</TH><TH>Amount Paid</TH><TH>Outstanding Balance</TH><TH>Status</TH><TH>Days Late/Early</TH><TH>Receipt No.</TH></tr></thead>
                  <tbody>
                    {d.realEstate.emiSchedule.map((e,i)=>(
                      <tr key={i}>
                        <TD color={P.muted}>{e.no}</TD><TD color={P.gold}>{e.dueDate}</TD>
                        <TD bold>{fmtF(e.emiAmt)}</TD>
                        <TD color={e.paid>0?P.emerald:P.muted}>{e.paid>0?fmtF(e.paid):"—"}</TD>
                        <TD color={P.sapphire}>{fmtF(e.balance)}</TD>
                        <TD><Pill color={P.orange}>{e.status}</Pill></TD>
                        <TD color={P.muted}>—</TD><TD color={P.muted}>—</TD>
                      </tr>
                    ))}
                    <tr style={{background:P.card2,fontStyle:"italic"}}><TD colSpan={8} color={P.muted} left>30 EMIs total · ₹4,77,000 total EMI outflow remaining · Balance clears ~2028</TD></tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

      </div>
    </div>
  );
}
