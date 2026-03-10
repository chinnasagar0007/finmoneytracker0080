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
    if (wants.some(want => normalizedKey === want || normalizedKey.includes(want) || want.includes(normalizedKey))) {
      return value;
    }
  }

  return undefined;
}

function hasField(row, ...candidates) {
  const value = getField(row, ...candidates);
  return value !== undefined && String(value).trim() !== "";
}

function unwrapCentralPayload(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const expected = ["income", "lendenClub", "personalLending", "realEstate", "stocks", "loans"];
  if (expected.some(key => key in raw)) return raw;
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
    return {
      name:                String(getField(meta, "Loan Name", "Name") || ""),
      emi:                 num(getField(meta, "EMI", "Monthly EMI")),
      outstanding:         num(getField(meta, "Outstanding", "Balance Outstanding")),
      paid:                num(getField(meta, "EMIs Paid")),
      total:               num(getField(meta, "Total EMIs", "Tenure")),
      originalLoan:        num(getField(meta, "Original Loan", "Loan Amount")),
      interestRate:        num(getField(meta, "Interest Rate", "Rate")),
      totalPrincipalPaid:  num(getField(meta, "Total Principal Paid")),
      totalInterestPaid:   num(getField(meta, "Total Interest Paid")),
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
    id:1, rate:2, tenure:3, score:5, disburseDate:6, amount:7, status:8, repayStart:10,
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

  const transactions = (txSheet||[]).filter(r=>hasField(r, "Date", "Month", "Tab", "Batch")).map(r=>({
    date:     String(getField(r, "Date", "Month", "Tab", "Batch") || ""),
    invested: num(getField(r, "Invested", "Amount", "Added", "Net Invested", "Reinvested")),
    pool:     num(getField(r, "Pool", "Closing Pool", "Total Pool", "Current Pool", "Pool Size", "Outstanding")),
    remark:   String(getField(r, "Remark", "Remarks", "Note", "Description") || ""),
  }));

  const parseMonthlySheetRows = (rows, tabName) => {
    if (!Array.isArray(rows) || rows.length === 0) return [];

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
        return {
          tab:String(getField(r, "Tab", "Batch", "Month") || tabName || ""),
          id:String(getField(r, "Loan ID", "ID", "Loan Account", "Loan Account No", "Account") || "").toUpperCase(),
          rate:num(getField(r, "Rate", "Rate%", "Interest Rate")),
          tenure:num(getField(r, "Tenure", "Duration", "Months")),
          score:num(getField(r, "Score", "Credit Score", "CIBIL")),
          disbDate:String(getField(r, "Disb Date", "Disbursement Date", "Date") || ""),
          amount:inv,
          status:String(getField(r, "Status", "Loan Status") || "").toUpperCase(),
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

  const dedupedLoanMap = new Map();
  const sourceLoans = monthlyLoans.length > 0 ? monthlyLoans : sampleLoans;
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

  const totalPooled = monthSummary.length > 0
    ? monthSummary[monthSummary.length-1].closingPool
    : totalPooledFromSummary || (transactions.length > 0 ? n(transactions[transactions.length-1].pool) : tabSummary.reduce((s,t)=>s+t.outstanding,0));

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
    loanSamples,
    reportedTotalLoans,
    reportedClosedLoans,
    reportedActiveLoans,
    reportedPendingLoans,
    reportedOverdueLoans,
  };
}

function mapPersonalLendingData(raw) {
  const sheets    = raw?.personalLending || {};
  const bSheet    = findSheet(sheets, ["Borrower","Personal Lending","Lending"]);
  const repSheet  = findSheet(sheets, ["Repayment","Payment"]);

  const rawBorrowers = (bSheet||[]).filter(r=>hasField(r, "Name", "Borrower Name")).map(r=>{
    const name    = String(getField(r, "Name", "Borrower Name") || "");
    const amount  = num(getField(r, "Amount", "Loan Amount", "Amount Lent"));
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

  const repaymentLog = (repSheet||[]).filter(r=>hasField(r, "Date")).map(r=>{
    const borrower = String(getField(r, "Borrower", "Name", "Borrower Name") || "");
    const type = String(getField(r, "Type", "Payment Type") || "Interest");
    let amount = num(getField(r, "Amount", "Payment", "Payment Amount", "Amount Paid", "Paid", "Interest", "Interest Amount", "Interest Paid", "Interest Received", "Received"));
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
const fmt  = v => { v=n(v); return v>=10000000?`₹${(v/10000000).toFixed(2)}Cr`:v>=100000?`₹${(v/100000).toFixed(2)}L`:v>=1000?`₹${(v/1000).toFixed(1)}K`:`₹${v.toLocaleString("en-IN")}`; };
const fmtF = v => `₹${n(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const pct  = (a,b) => b>0?((a/b)*100).toFixed(1):0;
const addMonths = (d,m) => { const r=new Date(d); r.setMonth(r.getMonth()+m); return r; };
const fmtDate  = d => d.toLocaleDateString("en-IN",{month:"short",year:"numeric"});
const JSONP_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 15000;
const AUTO_SYNC_SECONDS = 300;

function parseDateValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const monthMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
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

  match = raw.match(/^(\d{1,2})[-\/ ](\d{1,2})[-\/ ](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

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
    <div style={{
      background:`linear-gradient(145deg,${P.card},${P.card2})`,
      border:`1px solid ${P.border}`,
      borderTop: accent ? `2px solid ${accent}` : `1px solid ${P.border}`,
      borderRadius:16, padding:20,
      backdropFilter:"blur(12px)",
      boxShadow:`0 4px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)`,
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

// ─── AI ADVISER COMPONENT ─────────────────────────────────────────────────────
function AIAdviser({ data }) {
  const [messages, setMessages] = useState([
    { role:"assistant", content:"👋 Namaste Naresh! I'm your personal financial AI adviser. I have full context of your finances — salary, loans, investments, lending, and more. Ask me anything: debt payoff strategy, investment advice, tax planning, or milestone projections. How can I help you today?" }
  ]);
  const [input, setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);

  const d = data;
  const totalDebt = n(d.loans.hdfc.outstanding)+n(d.loans.idfc.outstanding)+n(d.loans.sbi.outstanding);
  const totalInv  = n(d.stocks.summary.total.current)+n(d.lendenClub.totalPooled)+n(d.personalLending.totalCapital)+n(d.realEstate.paid);

  const QUICK = [
    "How should I pay off my loans fastest?",
    "When will I be debt-free at current pace?",
    "Is my EMI burden too high?",
    "How to grow my net worth to ₹1 Crore?",
    "Should I prepay HDFC loan or invest more?",
    "Tax saving tips for FY26-27?",
  ];

  const systemPrompt = `You are an expert personal financial adviser for ${d.settings.name}, a ${d.income.age}-year-old software professional in ${d.settings.city}, India.

CURRENT FINANCIAL SNAPSHOT (March 2026):
- Monthly Salary: ₹${d.income.salary.toLocaleString("en-IN")} (gross) | In-Hand: ₹${d.income.inHand.toLocaleString("en-IN")}
- EMI Burden: HDFC ₹42,318 + IDFC ₹7,572 + SBI ₹2,500 = ₹52,390/mo (54.8% of salary)
- Credit Card Bills: ₹24,478/mo

DEBTS:
- HDFC Home Loan: ₹${Math.round(d.loans.hdfc.outstanding).toLocaleString("en-IN")} outstanding @ 10.5% p.a. | 68 EMIs left
- IDFC Personal Loan: ₹${Math.round(d.loans.idfc.outstanding).toLocaleString("en-IN")} outstanding @ 13.5% p.a. | 42 EMIs left
- SBI Loan: ₹${Math.round(d.loans.sbi.outstanding).toLocaleString("en-IN")} outstanding @ 9.35% p.a. | 25 EMIs left
- Total Debt: ₹${Math.round(totalDebt).toLocaleString("en-IN")}

INVESTMENTS:
- Stocks & MF: ₹${d.stocks.summary.total.current.toLocaleString("en-IN")} (CAGR target 12%)
- Personal Lending: ₹7,50,000 deployed @ 24% p.a. yield (₹15,000/mo interest)
- LendenClub P2P: ₹${d.lendenClub.totalPooled.toLocaleString("en-IN")} @ ~10% net return
- Real Estate (Land): ₹${d.realEstate.paid.toLocaleString("en-IN")} paid (Hyderabad, 100 sq.yd)
- Total Investments: ₹${Math.round(totalInv).toLocaleString("en-IN")}
- Net Worth: ₹${Math.round(totalInv - totalDebt).toLocaleString("en-IN")} (currently negative due to home loan)

SETTINGS: Salary Growth ${d.settings.salaryGrowth}%/yr | Portfolio CAGR ${d.settings.portfolioCAGR}% | RE Appreciation ${d.settings.realEstateAppreciation}%

Provide actionable, specific advice tailored to ${d.settings.name}'s exact situation. Use ₹ amounts and realistic timelines. Consider Indian tax laws (IT Act, Section 80C, 24(b), capital gains). Be honest about risks. Keep responses concise but insightful.`;

  const sendMessage = async (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput("");
    const userMsg = { role:"user", content:msg };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:1000,
          system: systemPrompt,
          messages: newMsgs.map(m=>({role:m.role,content:m.content}))
        })
      });
      const data = await res.json();
      const reply = data.content?.map(c=>c.text||"").join("") || "Sorry, I couldn't generate a response.";
      setMessages(prev=>[...prev,{role:"assistant",content:reply}]);
    } catch(e) {
      setMessages(prev=>[...prev,{role:"assistant",content:`⚠ Error: ${e.message}`}]);
    } finally {
      setLoading(false);
      setTimeout(()=>chatRef.current?.scrollTo({top:9999,behavior:"smooth"}),100);
    }
  };

  useEffect(()=>{ chatRef.current?.scrollTo({top:9999,behavior:"smooth"}); },[messages]);

  return (
    <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,height:"calc(100vh - 220px)",minHeight:520}}>
      {/* Chat panel */}
      <Card accent={P.violet} style={{display:"flex",flexDirection:"column",padding:0,overflow:"hidden"}}>
        {/* Header */}
        <div style={{padding:"16px 20px",borderBottom:`1px solid ${P.border}`,background:`linear-gradient(135deg,${P.violet}18,transparent)`,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:42,height:42,borderRadius:"50%",background:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:`0 0 16px ${P.violet}55`}}>🤖</div>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:15,fontWeight:700,color:P.text}}>Financial AI Adviser</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Powered by Claude · Your data is context</div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:loading?P.gold:P.emerald,animation:loading?"pulse 1s infinite":"none"}}/>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:loading?P.gold:P.emerald}}>{loading?"Thinking…":"Ready"}</span>
          </div>
        </div>

        {/* Messages */}
        <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:20,display:"flex",flexDirection:"column",gap:14}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:"flex",flexDirection:m.role==="user"?"row-reverse":"row",gap:10,alignItems:"flex-start"}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:m.role==="user"?`linear-gradient(135deg,${P.gold},${P.orange})`:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>
                {m.role==="user"?"👩":"🤖"}
              </div>
              <div style={{maxWidth:"75%",padding:"12px 16px",borderRadius:m.role==="user"?"16px 4px 16px 16px":"4px 16px 16px 16px",background:m.role==="user"?`linear-gradient(135deg,${P.gold}22,${P.orange}18)`:P.card3,border:`1px solid ${m.role==="user"?P.gold+"33":P.border}`,fontFamily:"'Outfit',sans-serif",fontSize:13,color:P.text,lineHeight:1.7,whiteSpace:"pre-wrap"}}>
                {m.content}
              </div>
            </div>
          ))}
          {loading&&(
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${P.violet},${P.sapphire})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🤖</div>
              <div style={{padding:"12px 16px",background:P.card3,border:`1px solid ${P.border}`,borderRadius:"4px 16px 16px 16px",display:"flex",gap:5,alignItems:"center"}}>
                {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:P.violet,animation:`pulse 1.2s ${i*0.2}s infinite`}}/>)}
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{padding:"14px 20px",borderTop:`1px solid ${P.border}`,background:P.card2,display:"flex",gap:10}}>
          <input
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendMessage()}
            placeholder="Ask about your finances… (Enter to send)"
            style={{flex:1,background:`${P.card3}`,border:`1px solid ${P.border}`,borderRadius:10,padding:"10px 14px",color:P.text,fontFamily:"'Outfit',sans-serif",fontSize:13,outline:"none"}}
          />
          <button
            onClick={()=>sendMessage()}
            disabled={loading||!input.trim()}
            style={{background:loading||!input.trim()?P.border:`linear-gradient(135deg,${P.violet},${P.sapphire})`,border:"none",borderRadius:10,padding:"10px 18px",color:P.text,cursor:loading||!input.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:12,fontWeight:600,transition:"all .15s"}}>
            Send ↗
          </button>
        </div>
      </Card>

      {/* Quick prompts + context panel */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Card accent={P.gold}>
          <SectionHead title="Quick Questions" icon="⚡" color={P.gold}/>
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {QUICK.map((q,i)=>(
              <button key={i} onClick={()=>sendMessage(q)}
                style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:9,padding:"10px 13px",color:P.muted,cursor:"pointer",fontFamily:"'Fira Code',monospace",fontSize:10,textAlign:"left",transition:"all .15s"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=P.gold+"66";e.currentTarget.style.color=P.text;}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=P.border;e.currentTarget.style.color=P.muted;}}>
                {q}
              </button>
            ))}
          </div>
        </Card>
        <Card accent={P.sapphire} style={{flex:1}}>
          <SectionHead title="Your Context" icon="📊" color={P.sapphire}/>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[
              {label:"Net Worth",    v:fmt(totalInv-totalDebt), color:(totalInv-totalDebt)>0?P.emerald:P.ruby},
              {label:"Total Debt",   v:fmt(totalDebt),          color:P.ruby   },
              {label:"Investments",  v:fmt(totalInv),           color:P.sapphire},
              {label:"In-Hand/mo",   v:fmt(d.income.inHand),    color:P.gold   },
              {label:"EMI/mo",       v:fmt(n(d.income.hdfcEmi)+n(d.income.idfcEmi)+n(d.income.sbiEmi)), color:P.orange},
              {label:"Lending Yield",v:"24% p.a.",              color:P.teal   },
            ].map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${P.border}22`}}>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>{r.label}</span>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:r.color}}>{r.v}</span>
              </div>
            ))}
          </div>
          <div style={{marginTop:12,padding:"8px 10px",background:`${P.sapphire}0F`,border:`1px solid ${P.sapphire}22`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:9,color:`${P.sapphire}aa`,lineHeight:1.8}}>
            💡 The AI has full visibility into your salary, EMIs, loans, investments, lending, and real estate.
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── MILESTONES COMPONENT ─────────────────────────────────────────────────────
function Milestones({ data }) {
  const d = data;
  const totalDebt  = n(d.loans.hdfc.outstanding)+n(d.loans.idfc.outstanding)+n(d.loans.sbi.outstanding);
  const totalAssets= n(d.stocks.summary.total.current)+n(d.lendenClub.totalPooled)+n(d.personalLending.totalCapital)+n(d.realEstate.paid);
  const startNW    = totalAssets - totalDebt;

  // Monthly net-worth accretion estimate
  const emiTotal      = n(d.income.hdfcEmi)+n(d.income.idfcEmi)+n(d.income.sbiEmi);
  const debtInterest  = (n(d.loans.hdfc.outstanding)*0.105 + n(d.loans.idfc.outstanding)*0.135 + n(d.loans.sbi.outstanding)*0.0935) / 12;
  const netDebtReducn = emiTotal - debtInterest;
  const investReturn  = totalAssets * 0.12 / 12;
  const monthlySavings= Math.max(0, n(d.income.inHand) - 12000); // rough living expense
  const monthlyNWGain = netDebtReducn + investReturn + monthlySavings;

  // Project month-by-month
  const projections = [];
  let nw = startNW;
  let assets = totalAssets;
  const now = new Date(2026, 2, 1);
  for (let m = 0; m <= 360; m++) {
    projections.push({ month:m, nw:Math.round(nw), assets:Math.round(assets), date:fmtDate(addMonths(now,m)) });
    assets += assets * 0.01 + monthlySavings;
    const debt = Math.max(0, -nw + assets - assets);
    nw += monthlyNWGain * (1 + m * 0.00083); // slight salary growth
  }

  const TARGETS = [
    { label:"Break Even (₹0)",  value:0,          icon:"⚖️",  color:P.muted    },
    { label:"₹1 Lakh",          value:100000,      icon:"💰",  color:P.emerald  },
    { label:"₹10 Lakh",         value:1000000,     icon:"💵",  color:P.sapphire },
    { label:"₹25 Lakh",         value:2500000,     icon:"📈",  color:P.teal     },
    { label:"₹1 Crore 🎯",      value:10000000,    icon:"🏆",  color:P.gold     },
    { label:"₹10 Crore 🚀",     value:100000000,   icon:"🚀",  color:P.violet   },
    { label:"₹100 Crore 👑",    value:1000000000,  icon:"👑",  color:P.ruby     },
  ];

  const milestones = TARGETS.map(t => {
    const hit = projections.find(p => p.nw >= t.value);
    return { ...t, monthsAway: hit?.month ?? null, date: hit ? fmtDate(addMonths(now, hit.month)) : "50yr+" };
  });

  const chartData = projections.filter((_,i)=>i%6===0).slice(0,61).map(p=>({
    date:p.date, nw:Math.max(p.nw,-2000000), nwM:+(p.nw/10000000).toFixed(3)
  }));

  const milestoneLines = milestones.filter(m=>m.monthsAway&&m.monthsAway<=360).map(m=>({
    value: +(m.value/10000000).toFixed(3), label:m.label, color:m.color
  }));

  return (
    <div className="fade">
      {/* Current net worth banner */}
      <div style={{background:`linear-gradient(135deg,${startNW<0?P.ruby:P.emerald}18,transparent)`,border:`1px solid ${startNW<0?P.ruby:P.emerald}33`,borderRadius:16,padding:"20px 24px",marginBottom:16,display:"flex",gap:40,alignItems:"center"}}>
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,textTransform:"uppercase",letterSpacing:2.5,color:P.muted,marginBottom:6}}>Current Net Worth</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:36,fontWeight:800,color:startNW<0?P.ruby:P.emerald}}>{fmt(startNW)}</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted,marginTop:4}}>Assets {fmt(totalAssets)} − Debt {fmt(totalDebt)}</div>
        </div>
        <div style={{borderLeft:`1px solid ${P.border}`,paddingLeft:40}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,textTransform:"uppercase",letterSpacing:2,color:P.muted,marginBottom:6}}>Monthly NW Growth (est.)</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:700,color:P.gold}}>+{fmt(monthlyNWGain)}/mo</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:4}}>
            Debt reduction {fmt(netDebtReducn)} + Returns {fmt(investReturn)} + Savings {fmt(monthlySavings)}
          </div>
        </div>
        <div style={{marginLeft:"auto",borderLeft:`1px solid ${P.border}`,paddingLeft:40}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginBottom:4}}>Assumptions</div>
          {[`Portfolio CAGR: ${d.settings.portfolioCAGR}%`, `Salary Growth: ${d.settings.salaryGrowth}%/yr`, `Personal Lending: ${d.settings.personalLendingReturn}%/yr`, `RE Appreciation: ${d.settings.realEstateAppreciation}%/yr`].map((a,i)=>(
            <div key={i} style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.text,marginBottom:2}}>• {a}</div>
          ))}
        </div>
      </div>

      {/* Milestone cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10,marginBottom:16}}>
        {milestones.map((m,i)=>(
          <div key={i} style={{background:`linear-gradient(145deg,${P.card},${P.card2})`,border:`1px solid ${m.monthsAway===0?m.color:P.border}`,borderTop:`2px solid ${m.color}`,borderRadius:14,padding:"14px 12px",textAlign:"center",
            boxShadow:m.monthsAway===0?`0 0 16px ${m.color}33`:"none"}}>
            <div style={{fontSize:24,marginBottom:6}}>{m.icon}</div>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:4,letterSpacing:1}}>{m.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,color:m.color,lineHeight:1.2}}>{m.date}</div>
            {m.monthsAway!==null && m.monthsAway>0 && (
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginTop:4}}>
                {m.monthsAway<12?`${m.monthsAway} mo`:m.monthsAway<120?`${Math.floor(m.monthsAway/12)}y ${m.monthsAway%12}m`:`${Math.floor(m.monthsAway/12)} yrs`} away
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Projection chart */}
      <Card accent={P.gold} style={{marginBottom:14}}>
        <SectionHead title="Net Worth Trajectory (30-Year Projection)" icon="📈" color={P.gold}/>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={chartData} margin={{top:10,right:20,left:0,bottom:0}}>
            <defs>
              <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={P.gold} stopOpacity={.45}/>
                <stop offset="100%" stopColor={P.gold} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} interval={7}/>
            <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${v.toFixed(1)}Cr`}/>
            <Tooltip content={({active,payload,label})=>active&&payload?.length?(
              <div style={{background:P.card3,border:`1px solid ${P.border2}`,borderRadius:10,padding:"10px 14px"}}>
                <p style={{color:P.muted,fontSize:10,margin:"0 0 4px",fontFamily:"'Fira Code',monospace"}}>{label}</p>
                <p style={{color:P.gold,fontSize:13,fontWeight:700,margin:0,fontFamily:"'Fira Code',monospace"}}>₹{(payload[0].value*10000000/10000000*100).toFixed(0)}L → {payload[0].value>=1?`₹${payload[0].value.toFixed(2)}Cr`:fmt(payload[0].value*10000000)}</p>
              </div>
            ):null}/>
            <Area type="monotone" dataKey="nwM" name="Net Worth (Cr)" stroke={P.gold} fill="url(#nwGrad)" strokeWidth={2.5} dot={false}/>
          </AreaChart>
        </ResponsiveContainer>
        <div style={{marginTop:8,display:"flex",gap:16,flexWrap:"wrap"}}>
          {milestones.filter(m=>m.monthsAway&&m.monthsAway<=360).map((m,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:5}}>
              <div style={{width:10,height:10,borderRadius:2,background:m.color}}/>
              <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:m.color}}>{m.label} — {m.date}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Milestone table */}
      <Card accent={P.sapphire}>
        <SectionHead title="Detailed Milestone Analysis" icon="🎯" color={P.sapphire}/>
        <table>
          <thead>
            <tr>
              <TH left>Milestone</TH><TH>Target Net Worth</TH><TH>Estimated Date</TH><TH>Time Away</TH><TH>Key Lever</TH>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m,i)=>{
              const levers = ["Clear IDFC & SBI loans","Grow Personal Lending book","Increase SIP contributions","Deploy LendenClub reinvestments","HDFC principal reduction","Diversify equity allocation","Scale lending operations"];
              return (
                <tr key={i} style={{background:i%2===0?"transparent":`${P.card2}44`}}>
                  <TD left bold color={m.color}>{m.icon} {m.label}</TD>
                  <TD color={P.text}>{m.value>=10000000?`₹${(m.value/10000000).toFixed(0)}Cr`:m.value>=100000?`₹${(m.value/100000).toFixed(0)}L`:`₹${m.value.toLocaleString("en-IN")}`}</TD>
                  <TD bold color={m.color}>{m.date}</TD>
                  <TD color={P.muted}>{m.monthsAway===0?"Already here!":m.monthsAway===null?"50+ years":m.monthsAway<12?`${m.monthsAway} months`:m.monthsAway<24?`${Math.floor(m.monthsAway/12)}y ${m.monthsAway%12}m`:`${Math.floor(m.monthsAway/12)} years`}</TD>
                  <TD left color={P.muted}>{levers[i]||"—"}</TD>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{marginTop:12,padding:"10px 14px",background:`${P.sapphire}0E`,border:`1px solid ${P.sapphire}22`,borderRadius:10,fontFamily:"'Fira Code',monospace",fontSize:10,color:`${P.sapphire}99`,lineHeight:1.9}}>
          ⚠ Projections assume current salary growth, portfolio CAGR, and consistent savings. Aggressive loan prepayment can accelerate milestones by 2-4 years. Consult a SEBI-registered adviser for formal planning.
        </div>
      </Card>
    </div>
  );
}

// ─── AI CODE FIXER COMPONENT ─────────────────────────────────────────────────
function AICodeFixer({ syncLog }) {
  const [issue,    setIssue]    = useState("");
  const [fixing,   setFixing]   = useState(false);
  const [result,   setResult]   = useState(null);   // {diagnosis, fix, explanation}
  const [copied,   setCopied]   = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const prevErrorRef = useRef("");

  // Errors from last sync round
  const recentErrors = [...new Map((syncLog||[]).filter(l=>l.status!=="✅ OK").map(l=>[l.key,l])).values()];
  const hasErrors    = recentErrors.length > 0;

  const runFixer = async (overrideIssue) => {
    const desc = overrideIssue || issue.trim();
    if (!desc && !hasErrors) return;
    setFixing(true); setResult(null);

    const errorContext = recentErrors.map(e=>`• ${e.key}: ${e.status} — ${e.error||"unknown"} (${e.dur})`).join("\n");
    const allLogs = (syncLog||[]).slice(0,20).map(l=>`[${l.ts}] ${l.status} ${l.key} ${l.dur} ${l.summary||l.error||""}`).join("\n");

    const prompt = `You are a Google Apps Script + React debugging expert.
The user has a Personal Finance Dashboard that syncs with 6 Google Apps Script endpoints.

SYNC ERRORS DETECTED:
${errorContext || "(none — user reported a problem manually)"}

RECENT SYNC LOG (last 20 entries):
${allLogs}

SCRIPT URLS:
- income:          https://script.google.com/macros/s/AKfycbzJSJzBIP8XV_nnQhQBWBNO-bE5fXQfcdfse7oAPclzcs3ms-v2GkPalm2j1TcyUHkt/exec
- stocks:          https://script.google.com/macros/s/AKfycbwwf47ett1RyYcBPzVnix0vNfjPMQthpk_NF0DnLXR3CaA0x1BmJf9T3T8TUbRHvU-joQ/exec
- lendenClub:      https://script.google.com/macros/s/AKfycbwMH0irJgr26onzupc5uWJ4_7Dg3oTnIj_iuH2UymLvDS_v56l0XyLUtcI2Y-paQWCe/exec
- personalLending: https://script.google.com/macros/s/AKfycbz-R7ADfgx6Ey6cKGIhf1v1cKSzyyJNNpI5RNXFfrLPrnACSd_TnIyfdmQ0p8x-q2OclQ/exec
- realEstate:      https://script.google.com/macros/s/AKfycbwSyb-rjOqqRXUJ5pDTK_HS9N0K38PuiljpRRiV_OjpJ-FJXn1ZJ9lGL-Tqd09CWJPN/exec
- loans:           https://script.google.com/macros/s/AKfycbxhiRe4WeL6D4sACteYVXJ4JJIFDBGEgq19o6491tP3Ajw3vLsQGCtYcCf1jg4OMTSm1Q/exec

USER DESCRIPTION: ${desc || "(none — diagnosing from sync errors above)"}

Respond ONLY as valid JSON (no markdown, no backticks):
{
  "diagnosis": "One-sentence root cause",
  "severity": "critical|warning|info",
  "fix_type": "apps_script|react_code|network|data|config",
  "steps": ["step 1", "step 2"],
  "code_fix": "If a code change is needed, paste the exact corrected snippet here. Otherwise empty string.",
  "code_context": "Brief comment on where this code goes (e.g., 'In your doGet function, replace the return line')",
  "explanation": "2-3 sentence plain-English explanation of what went wrong and why this fix works."
}`;

    try {
      const res  = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:1000,
          messages:[{role:"user",content:prompt}]
        })
      });
      const data = await res.json();
      const raw  = data.content?.map(c=>c.text||"").join("") || "{}";
      const clean= raw.replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
    } catch(e) {
      setResult({ diagnosis:"Could not parse AI response", severity:"warning", steps:[], code_fix:"", explanation: String(e.message) });
    } finally {
      setFixing(false);
    }
  };

  // Auto-trigger when new errors appear
  useEffect(() => {
    if (!autoMode || !hasErrors) return;
    const key = recentErrors.map(e=>e.key+e.status).join("|");
    if (key !== prevErrorRef.current) {
      prevErrorRef.current = key;
      runFixer("Auto-detected sync errors");
    }
  }, [syncLog, autoMode]);

  const copyFix = () => {
    navigator.clipboard.writeText(result?.code_fix||"").then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); });
  };

  const sevColor = { critical:P.ruby, warning:P.orange, info:P.sapphire }[result?.severity] || P.muted;

  return (
    <div className="fade">
      {/* Header banner */}
      <div style={{background:`linear-gradient(135deg,${P.violet}14,${P.sapphire}0A)`,border:`1px solid ${P.violet}33`,borderRadius:16,padding:"18px 24px",marginBottom:16,display:"flex",gap:20,alignItems:"center"}}>
        <div style={{fontSize:36}}>🔧</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:17,fontWeight:800,color:P.text,marginBottom:4}}>Dynamic AI Code Fixer</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,lineHeight:1.8}}>
            Describe any sync issue, data mismatch, or error — Claude will diagnose it and generate the exact fix code for your Apps Script or dashboard. No need to visit Claude.ai manually.
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"6px 14px",background:autoMode?`${P.emerald}18`:P.card3,border:`1px solid ${autoMode?P.emerald:P.border}`,borderRadius:20}} onClick={()=>setAutoMode(o=>!o)}>
            <div style={{width:7,height:7,borderRadius:"50%",background:autoMode?P.emerald:P.muted,boxShadow:autoMode?`0 0 8px ${P.emerald}`:""}}/>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:autoMode?P.emerald:P.muted}}>Auto-fix on error</span>
          </div>
          {hasErrors&&<div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.orange}}>⚠ {recentErrors.length} active error{recentErrors.length>1?"s":""} detected</div>}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        {/* Error panel */}
        <Card accent={hasErrors?P.ruby:P.emerald}>
          <SectionHead title="Current Sync Status" icon="📡" color={hasErrors?P.ruby:P.emerald}/>
          {recentErrors.length===0 ? (
            <div style={{textAlign:"center",padding:"24px 0",fontFamily:"'Fira Code',monospace",fontSize:11,color:P.emerald}}>
              ✅ All 6 endpoints syncing OK
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {recentErrors.map((e,i)=>(
                <div key={i} style={{background:`${P.ruby}0A`,border:`1px solid ${P.ruby}22`,borderRadius:10,padding:"10px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.ruby,fontWeight:700}}>{e.key}</span>
                    <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>{e.ts} · {e.dur}</span>
                  </div>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.orange}}>{e.error}</div>
                </div>
              ))}
            </div>
          )}
          {/* Recent successes */}
          <div style={{marginTop:12}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:6,letterSpacing:1,textTransform:"uppercase"}}>Last successful syncs</div>
            {[...new Map((syncLog||[]).filter(l=>l.status==="✅ OK").map(l=>[l.key,l])).values()].slice(0,6).map((l,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${P.border}18`}}>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald}}>✅ {l.key}</span>
                <span style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>{l.summary||"ok"} · {l.ts}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Input panel */}
        <Card accent={P.violet}>
          <SectionHead title="Describe Your Issue" icon="💬" color={P.violet}/>
          <textarea
            value={issue}
            onChange={e=>setIssue(e.target.value)}
            placeholder={`Describe what's broken, e.g.:\n• "Stocks tab shows seed data even after sync"\n• "CORS error on realEstate but script is deployed"\n• "Income data not updating from sheet"\n• "Sync shows ✅ but values unchanged"`}
            style={{width:"100%",minHeight:130,background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"12px 14px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:11,resize:"vertical",lineHeight:1.7,outline:"none",boxSizing:"border-box"}}
          />
          <div style={{display:"flex",gap:10,marginTop:12}}>
            <button
              onClick={()=>runFixer()}
              disabled={fixing||(!issue.trim()&&!hasErrors)}
              style={{flex:1,background:fixing||(!issue.trim()&&!hasErrors)?P.border:`linear-gradient(135deg,${P.violet},${P.sapphire})`,border:"none",borderRadius:10,padding:"11px 18px",color:P.text,cursor:fixing||(!issue.trim()&&!hasErrors)?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:12,fontWeight:600}}>
              {fixing?"🔍 Diagnosing…":"🔧 Diagnose & Fix"}
            </button>
            {hasErrors&&(
              <button
                onClick={()=>runFixer("Auto-diagnose sync errors")}
                disabled={fixing}
                style={{background:fixing?P.border:`${P.ruby}22`,border:`1px solid ${P.ruby}44`,borderRadius:10,padding:"11px 16px",color:P.ruby,cursor:fixing?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:600}}>
                Fix Errors
              </button>
            )}
          </div>
          {fixing&&(
            <div style={{marginTop:12,display:"flex",gap:8,alignItems:"center",fontFamily:"'Fira Code',monospace",fontSize:10,color:P.violet}}>
              {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:P.violet,animation:`pulse 1.2s ${i*0.2}s infinite`}}/>)}
              Analyzing error patterns and generating targeted fix…
            </div>
          )}
        </Card>
      </div>

      {/* Result panel */}
      {result && (
        <Card accent={sevColor} style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
            <SectionHead title="Diagnosis & Fix" icon="🩺" color={sevColor}/>
            <Pill color={sevColor}>{result.severity?.toUpperCase()||"INFO"}</Pill>
          </div>

          {/* Diagnosis */}
          <div style={{background:`${sevColor}0E`,border:`1px solid ${sevColor}22`,borderRadius:12,padding:"14px 16px",marginBottom:14}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:sevColor,marginBottom:6,letterSpacing:1.5,textTransform:"uppercase"}}>Root Cause</div>
            <div style={{fontFamily:"'Outfit',sans-serif",fontSize:14,fontWeight:600,color:P.text,marginBottom:8}}>{result.diagnosis}</div>
            <div style={{fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.muted,lineHeight:1.7}}>{result.explanation}</div>
          </div>

          {/* Steps */}
          {result.steps?.length>0 && (
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:8,letterSpacing:1.5,textTransform:"uppercase"}}>Fix Steps</div>
              {result.steps.map((s,i)=>(
                <div key={i} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:`1px solid ${P.border}22`,alignItems:"flex-start"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:`${sevColor}22`,border:`1px solid ${sevColor}44`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Fira Code',monospace",fontSize:10,color:sevColor,flexShrink:0}}>{i+1}</div>
                  <span style={{fontFamily:"'Outfit',sans-serif",fontSize:12,color:P.text,lineHeight:1.6,paddingTop:2}}>{s}</span>
                </div>
              ))}
            </div>
          )}

          {/* Code fix */}
          {result.code_fix && (
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,letterSpacing:1.5,textTransform:"uppercase"}}>
                  Generated Fix · <span style={{color:P.sapphire}}>{result.fix_type}</span>
                  {result.code_context&&<span style={{color:P.muted}}> · {result.code_context}</span>}
                </div>
                <button onClick={copyFix} style={{background:copied?`${P.emerald}22`:`${P.sapphire}18`,border:`1px solid ${copied?P.emerald:P.sapphire}44`,borderRadius:8,padding:"4px 14px",color:copied?P.emerald:P.sapphire,cursor:"pointer",fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:600,transition:"all .2s"}}>
                  {copied?"✅ Copied!":"📋 Copy Code"}
                </button>
              </div>
              <div style={{background:"#020810",border:`1px solid ${P.border}`,borderRadius:10,padding:"14px 16px",overflowX:"auto",maxHeight:300,overflowY:"auto"}}>
                <pre style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.emerald,margin:0,lineHeight:1.75,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{result.code_fix}</pre>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Tips */}
      <Card accent={P.gold}>
        <SectionHead title="Common Issues & Quick Fixes" icon="💡"/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {[
            { issue:"CORS blocked",      tip:"In Apps Script doGet(), wrap response with ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON). Redeploy as 'Anyone'.",  color:P.orange },
            { issue:"Data not updating", tip:"Make sure your Apps Script reads from the correct sheet name. Add Logger.log(JSON.stringify(data)) to debug what's returned. Check sheet permissions.",               color:P.sapphire },
            { issue:"Script timeout",    tip:"The 8s fetch timeout may be too short for large sheets. Try reducing data sent — only return current month data, not full history.",                                  color:P.violet },
            { issue:"JSON parse error",  tip:"Your Apps Script may be returning HTML (error page) instead of JSON. Always wrap in try/catch and return {error: e.message} on failure.",                           color:P.ruby },
            { issue:"Old data shown",    tip:"Clear browser cache or force reload with Ctrl+Shift+R. The dashboard adds ?t= timestamp to bust cache — check if your proxy is caching requests.",                  color:P.teal },
            { issue:"Partial sync",      tip:"If only some endpoints fail, check if those specific scripts have been re-deployed after your last edit. Each script needs its own deployment.",                     color:P.emerald },
          ].map((t,i)=>(
            <div key={i} style={{background:`${t.color}08`,border:`1px solid ${t.color}20`,borderRadius:10,padding:"12px 14px"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,fontWeight:700,color:t.color,marginBottom:6}}>⚡ {t.issue}</div>
              <div style={{fontFamily:"'Outfit',sans-serif",fontSize:11,color:P.muted,lineHeight:1.6}}>{t.tip}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── LENDENCLUB TAB COMPONENT ─────────────────────────────────────────────────
function LendenClubTab({ data }) {
  const d = data;
  const [loanFilter, setLoanFilter] = useState("ALL");
  const [monthFilter, setMonthFilter] = useState("ALL_MONTHS");
  const [loanQuery, setLoanQuery] = useState("");
  const [repayFilter, setRepayFilter] = useState("");

  // ── Analytics calculations ──
  const allLoans = (d.lendenClub.loanSamples || []).map(loan => {
    const rawStatus = String(loan.status || "").trim().toUpperCase();
    const disbursedOn = parseDateValue(loan.disbDate);
    const closedOn = parseDateValue(loan.closure);
    const repayStartOn = parseDateValue(loan.repayStart);
    const dueOn = parseDateValue(loan.expectedClose) || (disbursedOn && loan.tenure ? addMonths(disbursedOn, loan.tenure) : null);
    const isClosed = /closed|completed|repaid|settled/i.test(rawStatus) || Boolean(closedOn);
    const isExplicitPending = /pending|processing|live|ongoing/i.test(rawStatus);
    const derivedStatus = isClosed
      ? "CLOSED"
      : isExplicitPending
        ? "PENDING"
        : "ACTIVE";
    let repaymentStatus = "On Track";
    if (derivedStatus === "CLOSED") {
      repaymentStatus = "Closed";
    } else if (n(loan.dpd) > 0 || n(loan.npa) > 0) {
      repaymentStatus = "NPA";
    } else if (dueOn instanceof Date && !Number.isNaN(dueOn.getTime()) && dueOn < new Date()) {
      repaymentStatus = "OVERDUE";
    } else if (repayStartOn instanceof Date && !Number.isNaN(repayStartOn.getTime())) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      repayStartOn.setHours(0, 0, 0, 0);
      const diffDays = Math.round((repayStartOn.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      if (diffDays === 0) repaymentStatus = "DUE TODAY";
      else if (diffDays > 0 && diffDays <= 7) repaymentStatus = "DUE SOON";
    }
    const closedMonths = isClosed && disbursedOn && closedOn ? diffMonthsBetweenDates(disbursedOn, closedOn) : 0;
    const monthlyRateToClose = isClosed && loan.amount > 0 && closedMonths > 0
      ? +(((loan.interestRecv / loan.amount) / closedMonths) * 100).toFixed(2)
      : 0;
    return {
      ...loan,
      status: derivedStatus,
      rawStatus,
      dueDate: dueOn ? fmtDate(dueOn) : "-",
      monthsToClose: closedMonths,
      monthlyRateToClose,
      rs: repaymentStatus,
    };
  });
  const activeLoans = allLoans.filter(l=>l.status==="ACTIVE");
  const closedLoans = allLoans.filter(l=>l.status==="CLOSED");
  const pendingLoans = allLoans.filter(l=>l.status==="PENDING");
  const overdueLoans = allLoans.filter(l=>l.rs==="OVERDUE");
  const dueTodayLoans = allLoans.filter(l=>l.rs==="DUE TODAY");
  const dueSoonLoans = allLoans.filter(l=>l.rs==="DUE SOON");
  const npaLoans = allLoans.filter(l=>l.rs==="NPA");

  // Interest earned per closed loan: interestRecv is actual earned interest
  const totalInterestEarned  = allLoans.reduce((s,l)=>s+l.interestRecv,0);
  const totalDisbursedFromLoans = allLoans.reduce((s,l)=>s+n(l.amount),0);
  const totalReceivedFromLoans  = allLoans.reduce((s,l)=>s+n(l.totalRecv),0);
  const totalFees               = allLoans.reduce((s,l)=>s+n(l.fee),0);
  const totalPL                 = allLoans.reduce((s,l)=>s+n(l.pl),0);
  const outstandingFromLoans    = activeLoans.reduce((s,l)=>s+Math.max(0,n(l.amount)-n(l.principalRecv)),0);
  const totalDisbursed       = d.lendenClub.tabSummary.reduce((s,t)=>s+t.disbursed,0);
  const totalReceived        = d.lendenClub.tabSummary.reduce((s,t)=>s+t.received,0);
  const totalOutstanding     = d.lendenClub.tabSummary.reduce((s,t)=>s+t.outstanding,0);
  const totalInterestFromTab = d.lendenClub.tabSummary.reduce((s,t)=>s+t.interest,0);
  const avgLoanDuration      = allLoans.length ? (allLoans.reduce((s,l)=>s+l.tenure,0)/allLoans.length).toFixed(1) : 0;
  const avgRate              = allLoans.length ? (allLoans.reduce((s,l)=>s+l.rate,0)/allLoans.length).toFixed(2) : 0;
  const avgClosedDuration    = closedLoans.length ? (closedLoans.reduce((s,l)=>s+(l.monthsToClose || l.tenure || 0),0)/closedLoans.length).toFixed(1) : 0;
  const avgClosedMonthlyRate = closedLoans.length
    ? (
        closedLoans.reduce((s,l)=>s+l.interestRecv,0) /
        Math.max(closedLoans.reduce((s,l)=>s + (n(l.amount) * Math.max(1, n(l.monthsToClose))),0), 1)
      * 100
      ).toFixed(2)
    : "0.00";
  const summaryTotalLoans    = num(d.lendenClub.reportedTotalLoans) || d.lendenClub.tabSummary.reduce((s,t)=>s+t.loans,0) || allLoans.length;
  const summaryClosedLoans   = num(d.lendenClub.reportedClosedLoans) || closedLoans.length;
  const summaryOverdueLoans  = num(d.lendenClub.reportedOverdueLoans) || overdueLoans.length;
  const summaryPendingLoans  = num(d.lendenClub.reportedPendingLoans) || pendingLoans.length;
  const summaryActiveLoans   = num(d.lendenClub.reportedActiveLoans) || Math.max(0, activeLoans.length || (summaryTotalLoans - summaryClosedLoans - summaryPendingLoans - summaryOverdueLoans));
  const weightedAvgRate      = allLoans.length ? (allLoans.reduce((s,l)=>s+n(l.rate),0)/allLoans.length) : 0;
  const avgScore             = allLoans.length ? Math.round(allLoans.reduce((s,l)=>s+n(l.score),0)/allLoans.length) : 0;
  const grossRate            = totalDisbursedFromLoans>0 ? ((totalInterestEarned/totalDisbursedFromLoans)*100) : 0;
  const feesDrag             = totalDisbursedFromLoans>0 ? ((totalFees/totalDisbursedFromLoans)*100) : 0;
  const netRate              = totalDisbursedFromLoans>0 ? (((totalInterestEarned-totalFees)/totalDisbursedFromLoans)*100) : 0;
  const closedDisbursed      = closedLoans.reduce((s,l)=>s+n(l.amount),0);
  const closedInterest       = closedLoans.reduce((s,l)=>s+n(l.interestRecv),0);
  const closedRate           = closedDisbursed>0 ? ((closedInterest/closedDisbursed)*100) : 0;
  const simpleAvgMonthlyRate = closedLoans.length ? (closedLoans.reduce((s,l)=>s+n(l.monthlyRateToClose),0)/closedLoans.length) : 0;
  const poolLevelMonthlyRate = closedLoans.length && closedDisbursed>0
    ? (closedInterest/closedDisbursed/(closedLoans.reduce((s,l)=>s+Math.max(1,n(l.monthsToClose||l.tenure)),0)/closedLoans.length)*100)
    : 0;

  // ROI = annualised return on invested capital
  const roi = d.lendenClub.totalPooled>0 
    ? ((totalInterestFromTab / d.lendenClub.totalPooled) * (12 / 3) * 100).toFixed(2)  // 3 months of data
    : 0;

  // Monthly interest breakdown from tabSummary
  const monthlyBreakdown = d.lendenClub.tabSummary.map(t=>({
    month: t.tab, disbursed:t.disbursed, interest:t.interest, outstanding:t.outstanding, loans:t.loans,
    roi: t.disbursed>0 ? ((t.interest/t.disbursed)*100*12).toFixed(1) : 0
  }));
  const monthOptions = ["ALL_MONTHS", ...Array.from(new Set([
    ...d.lendenClub.tabSummary.map(t => String(t.tab || "").trim()).filter(Boolean),
    ...allLoans.map(l => String(l.tab || "").trim()).filter(Boolean),
  ]))];

  // Filter loans based on selected filter
  const baseFilteredLoans = loanFilter==="ALL" ? allLoans
    : loanFilter==="ACTIVE" ? activeLoans
    : loanFilter==="PENDING" ? pendingLoans
    : loanFilter==="OVERDUE" ? overdueLoans
    : loanFilter==="CLOSED" ? closedLoans
    : allLoans; // MONTHLY handled separately
  const filteredByMonth = monthFilter==="ALL_MONTHS"
    ? baseFilteredLoans
    : baseFilteredLoans.filter(l => String(l.tab || "").trim() === monthFilter);
  const filteredLoans = filteredByMonth.filter((l) => {
    const query = loanQuery.trim().toLowerCase();
    const queryMatch = !query || [
      l.id,
      l.tab,
      l.status,
      l.rs,
      l.rawStatus,
      l.disbDate,
      l.closure,
    ].some((value) => String(value || "").toLowerCase().includes(query));
    const repayMatch = !repayFilter || l.rs === repayFilter;
    return queryMatch && repayMatch;
  });
  const visibleMonthlySummary = monthFilter==="ALL_MONTHS"
    ? d.lendenClub.tabSummary
    : d.lendenClub.tabSummary.filter(t => String(t.tab || "").trim() === monthFilter);
  const visibleMonthlyRows = visibleMonthlySummary.map((t) => {
    const monthLoans = allLoans.filter((l) => String(l.tab || "").trim() === String(t.tab || "").trim());
    const closed = monthLoans.filter((l) => l.status === "CLOSED");
    const active = monthLoans.filter((l) => l.status === "ACTIVE");
    const pending = monthLoans.filter((l) => l.status === "PENDING");
    const overdue = monthLoans.filter((l) => l.rs === "OVERDUE");
    const npa = monthLoans.filter((l) => l.rs === "NPA");
    const dueToday = monthLoans.filter((l) => l.rs === "DUE TODAY");
    const dueSoon = monthLoans.filter((l) => l.rs === "DUE SOON");
    const monthDisbursed = monthLoans.reduce((s, l) => s + n(l.amount), 0) || t.disbursed;
    const monthInterest = monthLoans.reduce((s, l) => s + n(l.interestRecv), 0) || t.interest;
    const monthFees = monthLoans.reduce((s, l) => s + n(l.fee), 0) || t.fee;
    const monthPrincipal = monthLoans.reduce((s, l) => s + n(l.principalRecv), 0);
    const monthOutstanding = monthLoans.reduce((s, l) => s + Math.max(0, n(l.amount) - n(l.principalRecv)), 0) || t.outstanding;
    const monthNetRate = monthDisbursed > 0 ? (((monthInterest - monthFees) / monthDisbursed) * 100) : 0;
    return {
      ...t,
      active: active.length,
      closed: closed.length,
      pending: pending.length,
      overdue: overdue.length,
      npa: npa.length,
      dueToday: dueToday.length,
      dueSoon: dueSoon.length,
      monthDisbursed,
      monthInterest,
      monthFees,
      monthPrincipal,
      monthOutstanding,
      monthNetRate,
    };
  });

  const FILTER_OPTIONS = [
    {id:"ALL",    label:"All Loans",    count:summaryTotalLoans || allLoans.length, color:P.muted   },
    {id:"ACTIVE", label:"Active",       count:summaryActiveLoans,                    color:P.emerald },
    {id:"PENDING",label:"Pending",      count:summaryPendingLoans,                   color:P.gold    },
    {id:"OVERDUE",label:"Overdue",      count:summaryOverdueLoans,                   color:P.ruby    },
    {id:"CLOSED", label:"Closed",       count:summaryClosedLoans,                    color:P.sapphire},
    {id:"MONTHLY",label:"By Month",     count:d.lendenClub.tabSummary.length, color:P.gold},
  ];
  const REPAYMENT_OPTIONS = ["", "On Track", "DUE TODAY", "DUE SOON", "OVERDUE", "NPA", "Closed"];

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
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:28,fontWeight:800,color:P.rose}}>{fmt(d.lendenClub.totalPooled)}</div>
        </div>
      </div>

      {/* KPI grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:14}}>
        <GlassKPI label="Total Interest Earned"  value={fmtF(totalInterestFromTab)} sub={`Across ${summaryTotalLoans} loans`} color={P.teal}     icon="💹"/>
        <GlassKPI label="Annualised ROI"          value={`${roi}%`}                  sub="On invested capital"            color={P.emerald}  icon="📈"/>
        <GlassKPI label="Avg Monthly Yield"       value={`${avgClosedMonthlyRate}%`} sub={`Closed in ${avgClosedDuration} mo avg · ${avgRate}% p.a.`} color={P.sapphire} icon="⏱"/>
        <GlassKPI label="Active / Closed / Pending" value={`${summaryActiveLoans} / ${summaryClosedLoans} / ${summaryPendingLoans}`} sub={`Overdue ${summaryOverdueLoans} · Recovery ${pct(totalReceived,totalDisbursed)}%`} color={P.violet} icon="🔄"/>
        <GlassKPI label="Net Rate Of Interest" value={`${netRate.toFixed(2)}%`} sub={`Gross ${grossRate.toFixed(2)}% · Fee drag ${feesDrag.toFixed(2)}%`} color={P.rose} icon="🧮"/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"On Track", value:allLoans.filter(l => l.rs === "On Track").length, color:P.emerald},
          {label:"Due Today", value:dueTodayLoans.length, color:P.gold},
          {label:"Due Soon", value:dueSoonLoans.length, color:P.sapphire},
          {label:"Overdue", value:overdueLoans.length, color:P.ruby},
          {label:"NPA", value:npaLoans.length, color:P.rose},
          {label:"Avg Score", value:avgScore || 0, color:P.violet},
        ].map((item) => (
          <div key={item.label} style={{background:`${item.color}0A`,border:`1px solid ${item.color}22`,borderRadius:12,padding:"10px 12px"}}>
            <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:item.color}}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Financial Analytics */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        <Card accent={P.teal}>
          <SectionHead title="Monthly Interest Breakdown" icon="📊" color={P.teal}/>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyBreakdown} barGap={3} barSize={20}>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`₹${v.toFixed(0)}`}/>
              <Tooltip content={<CTip/>}/>
              <Legend wrapperStyle={{fontSize:10,fontFamily:"'Fira Code',monospace"}}/>
              <Bar dataKey="interest"  name="Interest Earned" fill={P.teal}    radius={[4,4,0,0]}/>
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
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
              <Tooltip content={<CTip/>}/>
              <Area type="monotone" dataKey="pool" name="Pool ₹" stroke={P.rose} fill="url(#pg)" strokeWidth={2.5}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card accent={P.sapphire} style={{marginBottom:14}}>
        <SectionHead title="Net Rate Of Interest" icon="🧾" color={P.sapphire}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
          {[
            {label:"Disbursed", value:fmtF(totalDisbursedFromLoans || totalDisbursed), color:P.sapphire},
            {label:"Received", value:fmtF(totalReceivedFromLoans || totalReceived), color:P.emerald},
            {label:"Interest", value:fmtF(totalInterestEarned || totalInterestFromTab), color:P.teal},
            {label:"Fees", value:fmtF(totalFees), color:P.ruby},
            {label:"Net P&L", value:fmtF(totalPL), color:totalPL >= 0 ? P.emerald : P.ruby},
          ].map((item) => (
            <div key={item.label} style={{background:P.card3,border:`1px solid ${item.color}22`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:item.color}}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {label:"Gross Rate", value:`${grossRate.toFixed(2)}%`, color:P.emerald},
            {label:"Net Rate", value:`${netRate.toFixed(2)}%`, color:P.sapphire},
            {label:"Closed Loan ROI", value:`${closedRate.toFixed(2)}%`, color:P.gold},
            {label:"Simple Avg Monthly", value:`${simpleAvgMonthlyRate.toFixed(2)}%`, color:P.violet},
          ].map((item) => (
            <div key={item.label} style={{background:`${item.color}0A`,border:`1px solid ${item.color}22`,borderRadius:12,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{item.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:item.color}}>{item.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Monthly ROI table */}
      <Card accent={P.emerald} style={{marginBottom:14}}>
        <SectionHead title="Monthly Interest & ROI Analysis" icon="💰" color={P.emerald}/>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Month</TH><TH>Loans</TH><TH>Active</TH><TH>Closed</TH><TH>Pending</TH><TH>Overdue</TH><TH>NPA</TH><TH>Disbursed</TH><TH>Principal</TH><TH>Interest</TH><TH>Fee</TH><TH>Outstanding</TH><TH>Recovery%</TH><TH>Net ROI</TH></tr></thead>
            <tbody>
              {visibleMonthlyRows.map((t,i)=>(
                <tr key={i}>
                  <TD bold color={P.gold}>{t.tab}</TD>
                  <TD color={P.text}>{t.loans}</TD>
                  <TD color={P.emerald}>{t.active}</TD>
                  <TD color={P.sapphire}>{t.closed}</TD>
                  <TD color={P.gold}>{t.pending}</TD>
                  <TD color={P.ruby}>{t.overdue}</TD>
                  <TD color={P.rose}>{t.npa}</TD>
                  <TD color={P.sapphire}>{fmtF(t.monthDisbursed)}</TD>
                  <TD color={P.text}>{fmtF(t.monthPrincipal)}</TD>
                  <TD bold color={P.teal}>{fmtF(t.monthInterest)}</TD>
                  <TD color={P.muted}>{fmtF(t.monthFees)}</TD>
                  <TD color={P.ruby}>{fmtF(t.monthOutstanding)}</TD>
                  <TD color={parseFloat(pct(t.received,t.disbursed))>50?P.emerald:P.gold}>{pct(t.received,t.disbursed)}%</TD>
                  <TD bold color={P.emerald}>{t.monthNetRate.toFixed(2)}%</TD>
                </tr>
              ))}
              <tr style={{background:P.card2}}>
                <TD bold color={P.gold}>TOTAL</TD>
                <TD bold>{summaryTotalLoans}</TD>
                <TD bold color={P.emerald}>{summaryActiveLoans}</TD>
                <TD bold color={P.sapphire}>{summaryClosedLoans}</TD>
                <TD bold color={P.gold}>{summaryPendingLoans}</TD>
                <TD bold color={P.ruby}>{summaryOverdueLoans}</TD>
                <TD bold color={P.rose}>{npaLoans.length}</TD>
                <TD bold color={P.sapphire}>{fmtF(totalDisbursed)}</TD>
                <TD bold color={P.text}>{fmtF(allLoans.reduce((s,l)=>s+n(l.principalRecv),0))}</TD>
                <TD bold color={P.teal}>{fmtF(totalInterestFromTab)}</TD>
                <TD bold color={P.muted}>{fmtF(d.lendenClub.tabSummary.reduce((s,t)=>s+t.fee,0) || totalFees)}</TD>
                <TD bold color={P.ruby}>{fmtF(totalOutstanding || outstandingFromLoans)}</TD>
                <TD bold color={P.emerald}>{pct(totalReceived,totalDisbursed)}%</TD>
                <TD bold color={P.emerald}>{netRate.toFixed(2)}%</TD>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {label:"Total Interest",       v:fmtF(totalInterestFromTab), color:P.teal   },
            {label:"Avg Monthly Yield",    v:`${avgClosedMonthlyRate}%`, color:P.emerald},
            {label:"Interest on Sample",   v:fmtF(totalInterestEarned),  color:P.rose   },
            {label:"Active / Closed / Pending", v:`${summaryActiveLoans} / ${summaryClosedLoans} / ${summaryPendingLoans}`, color:P.violet},
          ].map((s,i)=>(
            <div key={i} style={{background:`${s.color}0A`,border:`1px solid ${s.color}22`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4}}>{s.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,color:s.color}}>{s.v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Loan filter + table */}
      <Card accent={P.rose} style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <SectionHead title="Individual Loan Accounts" icon="📋" color={P.rose}/>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <input
              value={loanQuery}
              onChange={e=>setLoanQuery(e.target.value)}
              placeholder="Search loan id / month / status"
              style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10,minWidth:220}}
            />
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>Filter</span>
            <select
              value={loanFilter}
              onChange={e=>setLoanFilter(e.target.value)}
              style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10}}
            >
              {FILTER_OPTIONS.map(f=>(
                <option key={f.id} value={f.id}>{f.label} ({f.count})</option>
              ))}
            </select>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginLeft:4}}>Repayment</span>
            <select
              value={repayFilter}
              onChange={e=>setRepayFilter(e.target.value)}
              style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10}}
            >
              {REPAYMENT_OPTIONS.map(m=>(
                <option key={m || "ALL"} value={m}>{m || "All Statuses"}</option>
              ))}
            </select>
            <span style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginLeft:4}}>Month</span>
            <select
              value={monthFilter}
              onChange={e=>setMonthFilter(e.target.value)}
              style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"7px 10px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:10}}
            >
              {monthOptions.map(m=>(
                <option key={m} value={m}>{m==="ALL_MONTHS" ? "All Months" : m}</option>
              ))}
            </select>
          </div>
        </div>

        {loanFilter==="MONTHLY" ? (
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
            {visibleMonthlyRows.map((t,i)=>{
              const tabLoans = allLoans.filter(l=>l.tab===t.tab);
              return (
                <div key={i} style={{background:P.card3,borderRadius:12,padding:14,border:`1px solid ${CC[i]}22`}}>
                  <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:700,color:CC[i],marginBottom:8}}>{t.tab} · {t.loans} loans</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
                    {[
                      {label:"Disbursed",   v:fmtF(t.monthDisbursed),   color:P.sapphire},
                      {label:"Interest",    v:fmtF(t.monthInterest),    color:P.teal    },
                      {label:"Outstanding", v:fmtF(t.monthOutstanding), color:P.ruby    },
                      {label:"Net ROI",     v:`${t.monthNetRate.toFixed(2)}%`, color:P.emerald},
                      {label:"Closed",      v:t.closed, color:P.sapphire},
                      {label:"Overdue / NPA", v:`${t.overdue} / ${t.npa}`, color:P.rose},
                    ].map((s,j)=>(
                      <div key={j} style={{background:`${P.card2}`,borderRadius:8,padding:"8px 10px"}}>
                        <div style={{fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,marginBottom:2}}>{s.label}</div>
                        <div style={{fontFamily:"'Fira Code',monospace",fontSize:12,fontWeight:700,color:s.color}}>{s.v}</div>
                      </div>
                    ))}
                  </div>
                  {tabLoans.length>0 && (
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr><th style={{padding:"6px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted,textAlign:"left"}}>Loan ID</th><th style={{padding:"6px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted}}>Rate</th><th style={{padding:"6px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted}}>Status</th><th style={{padding:"6px 8px",fontFamily:"'Fira Code',monospace",fontSize:8,color:P.muted}}>Interest</th></tr></thead>
                      <tbody>{tabLoans.map((l,j)=>(
                        <tr key={j}><td style={{padding:"5px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>{l.id.slice(-8)}</td><td style={{padding:"5px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.sapphire,textAlign:"center"}}>{l.rate}%</td><td style={{padding:"5px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,textAlign:"center"}}><span style={{padding:"2px 7px",borderRadius:10,background:`${l.status==="CLOSED"?P.muted:P.emerald}22`,color:l.status==="CLOSED"?P.muted:P.emerald,fontSize:8}}>{l.status}</span></td><td style={{padding:"5px 8px",fontFamily:"'Fira Code',monospace",fontSize:9,color:P.teal,textAlign:"center"}}>{fmtF(l.interestRecv)}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{overflowX:"auto"}}>
            <table className="row-hover">
              <thead><tr><TH>Tab</TH><TH left>Loan ID</TH><TH>Rate%</TH><TH>Tenure</TH><TH>Score</TH><TH>Disbursed</TH><TH>Repay Start</TH><TH>Due</TH><TH>Amount</TH><TH>Status</TH><TH>Repayment</TH><TH>DPD</TH><TH>NPA</TH><TH>Principal Recv</TH><TH>Interest Earned</TH><TH>Avg/Mo</TH><TH>Fee</TH><TH>Total Recv</TH><TH>P&L</TH><TH>Months</TH><TH>Closure</TH></tr></thead>
              <tbody>
                {filteredLoans.map((l,i)=>(
                  <tr key={i}>
                    <TD color={P.gold}>{l.tab}</TD><TD left color={P.muted}>{l.id}</TD>
                    <TD color={P.sapphire}>{l.rate}%</TD><TD>{l.tenure} mo</TD>
                    <TD color={l.score>=720?P.emerald:P.gold}>{l.score}</TD>
                    <TD color={P.muted}>{l.disbDate}</TD>
                    <TD color={P.text}>{l.repayStart || "-"}</TD>
                    <TD color={l.rs==="OVERDUE"?P.ruby:P.muted}>{l.dueDate}</TD>
                    <TD>{fmtF(l.amount)}</TD>
                    <TD><Pill color={l.status==="CLOSED"?P.muted:l.status==="OVERDUE"?P.ruby:l.status==="PENDING"?P.gold:P.emerald}>{l.status}</Pill></TD>
                    <TD><Pill color={l.rs==="NPA"?P.rose:l.rs==="OVERDUE"?P.ruby:l.rs==="DUE TODAY"?P.gold:l.rs==="DUE SOON"?P.sapphire:l.rs==="Closed"?P.muted:P.emerald}>{l.rs}</Pill></TD>
                    <TD color={n(l.dpd)>0?P.ruby:P.muted}>{n(l.dpd)||0}</TD>
                    <TD color={n(l.npa)>0?P.rose:P.muted}>{n(l.npa)||0}</TD>
                    <TD color={P.text}>{fmtF(l.principalRecv)}</TD>
                    <TD bold color={P.teal}>{fmtF(l.interestRecv)}</TD>
                    <TD color={l.status==="CLOSED"?P.sapphire:P.muted}>{l.status==="CLOSED"?`${l.monthlyRateToClose}%`:"—"}</TD>
                    <TD color={P.muted}>{fmtF(l.fee)}</TD>
                    <TD color={P.gold}>{fmtF(l.totalRecv)}</TD>
                    <TD color={l.pl>0?P.emerald:P.muted}>{l.pl>0?"+":""}{fmtF(l.pl)}</TD>
                    <TD color={P.text}>{l.monthsToClose || "—"}</TD>
                    <TD color={P.muted}>{l.closure}</TD>
                  </tr>
                ))}
                <tr style={{background:P.card2}}>
                  <TD bold colSpan={13} left color={P.gold}>SUBTOTAL ({filteredLoans.length} loans)</TD>
                  <TD bold color={P.text}>{fmtF(filteredLoans.reduce((s,l)=>s+l.principalRecv,0))}</TD>
                  <TD bold color={P.teal}>{fmtF(filteredLoans.reduce((s,l)=>s+l.interestRecv,0))}</TD>
                  <TD bold color={P.sapphire}>{filteredLoans.filter(l=>l.status==="CLOSED").length?`${(
                    filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s+l.interestRecv,0) /
                    Math.max(filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s + (n(l.amount) * Math.max(1, n(l.monthsToClose))),0), 1)
                  * 100).toFixed(2)}%`:"—"}</TD>
                  <TD bold color={P.muted}>{fmtF(filteredLoans.reduce((s,l)=>s+l.fee,0))}</TD>
                  <TD bold color={P.gold}>{fmtF(filteredLoans.reduce((s,l)=>s+l.totalRecv,0))}</TD>
                  <TD bold color={P.emerald}>{fmtF(filteredLoans.reduce((s,l)=>s+l.pl,0))}</TD>
                  <TD bold color={P.text}>{filteredLoans.filter(l => l.status === "CLOSED").length ? filteredLoans.filter(l => l.status === "CLOSED").reduce((s,l)=>s+n(l.monthsToClose),0).toFixed(0) : "—"}</TD>
                  <TD/>
                </tr>
              </tbody>
            </table>
            <div style={{marginTop:8,fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>
              Showing {filteredLoans.length} loan rows · Score ≥720 = <span style={{color:P.emerald}}>good credit</span> · Closed-loan avg monthly yield: <span style={{color:P.sapphire}}>{filteredLoans.filter(l=>l.status==="CLOSED").length?`${(
                filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s+l.interestRecv,0) /
                Math.max(filteredLoans.filter(l=>l.status==="CLOSED").reduce((s,l)=>s + (n(l.amount) * Math.max(1, n(l.monthsToClose))),0), 1)
              * 100).toFixed(2)}%`:"0.00%"}</span> · Repayment split: <span style={{color:P.gold}}>{dueTodayLoans.length}</span> due today / <span style={{color:P.sapphire}}>{dueSoonLoans.length}</span> due soon / <span style={{color:P.ruby}}>{overdueLoans.length}</span> overdue / <span style={{color:P.rose}}>{npaLoans.length}</span> NPA
            </div>
          </div>
        )}
      </Card>

      <Card accent={P.violet}>
        <SectionHead title="Investment Transaction Log" icon="📒" color={P.violet}/>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Date</TH><TH>Invested / Withdrawn</TH><TH>Closing Pool</TH><TH left>Remark</TH></tr></thead>
            <tbody>
              {d.lendenClub.transactions.map((t,i)=>(
                <tr key={i}>
                  <TD color={P.muted}>{t.date}</TD>
                  <TD bold color={t.invested>0?P.emerald:P.ruby}>{t.invested>0?"+":""}{fmtF(t.invested)}</TD>
                  <TD color={P.gold}>{fmtF(t.pool)}</TD>
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

// ─── SALARY TRACKER COMPONENT ────────────────────────────────────────────────
function SalaryTracker({ data }) {
  const d = data;
  const hist = d.salaryHistory || [];
  const totalSalary   = hist.reduce((s,m)=>s+m.salary,0);
  const totalIncome   = hist.reduce((s,m)=>s+m.totalIncome,0);
  const totalExpenses = hist.reduce((s,m)=>s+m.expenses,0);
  const totalSavings  = hist.reduce((s,m)=>s+m.savings,0);
  const avgSalary     = hist.length ? Math.round(totalSalary/hist.length) : 0;
  const avgSavings    = hist.length ? Math.round(totalSavings/hist.length) : 0;
  const savingsRate   = totalIncome>0 ? ((totalSavings/totalIncome)*100).toFixed(1) : 0;
  const salaryGrowth  = hist.length>1 ? (((hist[hist.length-1].salary - hist[0].salary)/hist[0].salary)*100).toFixed(1) : 0;

  return (
    <div className="fade">
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        <GlassKPI label="FY Total Salary"   value={fmt(totalSalary)}  sub={`Avg ${fmt(avgSalary)}/mo`} color={P.gold}    icon="💰"/>
        <GlassKPI label="Total Income"      value={fmt(totalIncome)}  sub={`All sources incl. lending`} color={P.emerald} icon="📈"/>
        <GlassKPI label="Total Savings"     value={fmt(totalSavings)} sub={`${savingsRate}% savings rate`} color={P.teal} icon="🏦"/>
        <GlassKPI label="Salary Growth"     value={`+${salaryGrowth}%`} sub={`${hist[0]?.month} → ${hist[hist.length-1]?.month}`} color={P.violet} icon="🚀"/>
      </div>

      <Card accent={P.gold} style={{marginBottom:14}}>
        <SectionHead title="Salary & Income Trend (FY 2025-26)" icon="📈"/>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={hist} margin={{top:10,right:20,left:0,bottom:0}}>
            <defs>
              <linearGradient id="salGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={P.gold} stopOpacity={.45}/>
                <stop offset="100%" stopColor={P.gold} stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="incGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={P.emerald} stopOpacity={.35}/>
                <stop offset="100%" stopColor={P.emerald} stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="savGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={P.teal} stopOpacity={.35}/>
                <stop offset="100%" stopColor={P.teal} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="month" tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false}/>
            <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
            <Tooltip content={<CTip/>}/>
            <Legend wrapperStyle={{fontSize:10,fontFamily:"'Fira Code',monospace",color:P.muted}}/>
            <Area type="monotone" dataKey="salary"      name="Salary"      stroke={P.gold}    fill="url(#salGrad)" strokeWidth={2.5} dot={{fill:P.gold,r:3}}/>
            <Area type="monotone" dataKey="totalIncome" name="Total Income" stroke={P.emerald} fill="url(#incGrad)" strokeWidth={2}   dot={false}/>
            <Area type="monotone" dataKey="savings"     name="Savings"     stroke={P.teal}    fill="url(#savGrad)" strokeWidth={2}   dot={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        <Card accent={P.sapphire}>
          <SectionHead title="Income vs Expenses" icon="📊" color={P.sapphire}/>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hist} barGap={3} barSize={14}>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
              <Tooltip content={<CTip/>}/>
              <Legend wrapperStyle={{fontSize:10,fontFamily:"'Fira Code',monospace"}}/>
              <Bar dataKey="totalIncome" name="Income"   fill={P.emerald} radius={[3,3,0,0]}/>
              <Bar dataKey="expenses"    name="Expenses" fill={P.ruby}    radius={[3,3,0,0]}/>
              <Bar dataKey="savings"     name="Savings"  fill={P.gold}    radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card accent={P.violet}>
          <SectionHead title="Monthly Savings Rate" icon="💹" color={P.violet}/>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={hist.map(m=>({...m, savRate: m.totalIncome>0 ? +((m.savings/m.totalIncome)*100).toFixed(1) : 0}))}>
              <XAxis dataKey="month" tick={{fill:P.muted,fontSize:8}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:P.muted,fontSize:9}} axisLine={false} tickLine={false} tickFormatter={v=>`${v}%`} domain={[0,50]}/>
              <Tooltip content={({active,payload,label})=>active&&payload?.length?(<div style={{background:P.card3,border:`1px solid ${P.border2}`,borderRadius:10,padding:"10px 14px"}}><p style={{color:P.muted,fontSize:10,margin:"0 0 4px",fontFamily:"'Fira Code',monospace"}}>{label}</p><p style={{color:P.violet,fontSize:12,fontWeight:600,margin:0,fontFamily:"'Fira Code',monospace"}}>Savings Rate: {payload[0].value}%</p></div>):null}/>
              <Line type="monotone" dataKey="savRate" stroke={P.violet} strokeWidth={2.5} dot={{fill:P.violet,r:4}} name="Savings Rate %"/>
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card accent={P.teal}>
        <SectionHead title="Month-wise Salary Summary" icon="📋" color={P.teal}/>
        <div style={{overflowX:"auto"}}>
          <table className="row-hover">
            <thead><tr><TH>Month</TH><TH>Salary</TH><TH>Tutoring</TH><TH>Lending Int.</TH><TH>Other</TH><TH>Total Income</TH><TH>Expenses</TH><TH>Savings</TH><TH>Sav Rate%</TH><TH>MoM Growth</TH></tr></thead>
            <tbody>
              {hist.map((m,i)=>{
                const savR = m.totalIncome>0 ? ((m.savings/m.totalIncome)*100).toFixed(1) : "0.0";
                const prev = hist[i-1];
                const growth = prev && prev.salary>0 ? (((m.salary-prev.salary)/prev.salary)*100).toFixed(1) : null;
                return (
                  <tr key={i}>
                    <TD bold color={P.gold}>{m.month}</TD>
                    <TD color={P.text}>{fmtF(m.salary)}</TD>
                    <TD color={m.tutoring>0?P.emerald:P.muted}>{m.tutoring>0?fmtF(m.tutoring):"—"}</TD>
                    <TD color={m.lendingInterest>0?P.teal:P.muted}>{m.lendingInterest>0?fmtF(m.lendingInterest):"—"}</TD>
                    <TD color={m.otherIncome>0?P.violet:P.muted}>{m.otherIncome>0?fmtF(m.otherIncome):"—"}</TD>
                    <TD bold color={P.emerald}>{fmtF(m.totalIncome)}</TD>
                    <TD color={P.ruby}>{fmtF(m.expenses)}</TD>
                    <TD bold color={P.gold}>{fmtF(m.savings)}</TD>
                    <TD color={parseFloat(savR)>=25?P.emerald:parseFloat(savR)>=15?P.gold:P.ruby}>{savR}%</TD>
                    <TD color={growth===null?P.muted:parseFloat(growth)>0?P.emerald:P.ruby}>{growth===null?"—":`${growth>0?"+":""}${growth}%`}</TD>
                  </tr>
                );
              })}
              <tr style={{background:P.card2}}>
                <TD bold color={P.gold}>FY TOTAL</TD>
                <TD bold color={P.gold}>{fmtF(totalSalary)}</TD>
                <TD bold color={P.emerald}>{fmtF(hist.reduce((s,m)=>s+m.tutoring,0))}</TD>
                <TD bold color={P.teal}>{fmtF(hist.reduce((s,m)=>s+m.lendingInterest,0))}</TD>
                <TD bold color={P.violet}>{fmtF(hist.reduce((s,m)=>s+m.otherIncome,0))}</TD>
                <TD bold color={P.emerald}>{fmtF(totalIncome)}</TD>
                <TD bold color={P.ruby}>{fmtF(totalExpenses)}</TD>
                <TD bold color={P.gold}>{fmtF(totalSavings)}</TD>
                <TD bold color={P.teal}>{savingsRate}%</TD>
                <TD bold color={P.violet}>Avg ₹{Math.round(avgSalary/1000)}K/mo</TD>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{marginTop:10,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {label:"Best Savings Month",  v:hist.length?hist.reduce((a,b)=>b.savings>a.savings?b:a).month:"—",  color:P.emerald},
            {label:"Highest Salary",      v:fmt(hist.length?Math.max(...hist.map(m=>m.salary)):0),              color:P.gold   },
            {label:"Avg Monthly Savings", v:fmt(avgSavings),                                                     color:P.teal   },
            {label:"Savings Rate",        v:`${savingsRate}%`,                                                    color:P.violet },
          ].map((s,i)=>(
            <div key={i} style={{background:`${s.color}0A`,border:`1px solid ${s.color}22`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:4,letterSpacing:1}}>{s.label}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:s.color}}>{s.v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── AI BUILDER COMPONENT ─────────────────────────────────────────────────────
function AIBuilder({ data }) {
  const [prompt,   setPrompt]   = useState("");
  const [building, setBuilding] = useState(false);
  const [widgets,  setWidgets]  = useState([]);
  const [error,    setError]    = useState(null);
  const d = data;

  const EXAMPLES = [
    "Add profit analysis for all loans showing total interest paid vs principal",
    "Show a donut chart of my investment allocation by asset class",
    "Create a debt payoff timeline showing when each loan clears",
    "Show monthly cash flow: salary in, EMIs out, savings left",
    "Build a LendenClub ROI calculator with annualised returns",
    "Show my net worth breakdown: assets vs liabilities comparison",
    "Create an emergency fund tracker — how many months can I survive?",
    "Show salary hike impact: what if salary grows 15% next year?",
  ];

  const buildWidget = async (overridePrompt) => {
    const req = overridePrompt || prompt.trim();
    if (!req || building) return;
    setPrompt("");
    setBuilding(true);
    setError(null);

    const ctx = `FINANCIAL DATA CONTEXT:
- Monthly Salary: ₹${d.income.salary.toLocaleString("en-IN")} | In-Hand: ₹${d.income.inHand.toLocaleString("en-IN")}
- HDFC Loan: ₹${Math.round(d.loans.hdfc.outstanding).toLocaleString("en-IN")} @ 10.5% | EMI: ₹42,318
- IDFC Loan: ₹${Math.round(d.loans.idfc.outstanding).toLocaleString("en-IN")} @ 13.5% | EMI: ₹7,572
- SBI Loan: ₹${Math.round(d.loans.sbi.outstanding).toLocaleString("en-IN")} @ 9.35% | EMI: ₹2,500
- Stocks & MF: ₹${d.stocks.summary.total.current.toLocaleString("en-IN")} | P&L: ₹${d.stocks.summary.total.pl.toLocaleString("en-IN")}
- Personal Lending: ₹7,50,000 @ 24% p.a. | Monthly Interest: ₹15,000
- LendenClub Pool: ₹${d.lendenClub.totalPooled.toLocaleString("en-IN")} | ~10% net return
- Real Estate: ₹${d.realEstate.paid.toLocaleString("en-IN")} paid | Balance: ₹${d.realEstate.remaining.toLocaleString("en-IN")}
- Salary History: ${(d.salaryHistory||[]).map(m=>m.month+": ₹"+m.salary).join(", ")}
- LendenClub Loans: ${d.lendenClub.loanSamples.length} sample loans, ${d.lendenClub.tabSummary.reduce((s,t)=>s+t.loans,0)} total`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:1000,
          system:`You are a React financial dashboard widget generator for Naresh Sagar's personal finance dashboard.
The dashboard uses these color variables (already defined): P.gold="#F5C542", P.emerald="#10E8A0", P.ruby="#FF5C7A", P.sapphire="#4FC3F7", P.violet="#B39DFF", P.teal="#26C6AC", P.orange="#FF9A3C", P.rose="#F48FB1", P.bg="#050D1A", P.card="#0A1628", P.card2="#0F1E36", P.card3="#162340", P.border="#1C3050", P.text="#D8EAF8", P.muted="#4E6D8C".
Available: recharts (BarChart, Bar, AreaChart, Area, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend), and helper functions: fmt(v), fmtF(v), pct(a,b), n(v).

RULES:
1. Return ONLY a JSON object: {"title":"Widget Title","description":"1-line description","html":"...full JSX string..."}
2. The "html" value must be a complete JSX expression (starting with <div) that uses real numbers from the context provided
3. Use inline styles only, matching the dark theme
4. Include actual calculations and real data — not placeholders
5. Make it visually striking with the color palette
6. Keep it self-contained (no external imports needed)
7. Return ONLY the JSON, no markdown, no backticks, no preamble`,
          messages:[{role:"user",content:`${ctx}\n\nUSER REQUEST: "${req}"\n\nGenerate a financial widget for this request. Use the actual numbers from the context above.`}]
        })
      });
      const apiData = await res.json();
      const rawText = apiData.content?.map(c=>c.text||"").join("") || "";
      const clean   = rawText.replace(/```json|```/g,"").trim();
      let parsed;
      try { parsed = JSON.parse(clean); } catch {
        const match = clean.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : null;
      }
      if (!parsed) throw new Error("Could not parse AI response");
      setWidgets(prev=>[{id:Date.now(), ...parsed, prompt:req}, ...prev]);
    } catch(e) {
      setError(`⚠ ${e.message}`);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="fade">
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${P.violet}18,${P.gold}0A)`,border:`1px solid ${P.violet}33`,borderRadius:16,padding:"18px 22px",marginBottom:16,display:"flex",alignItems:"center",gap:16}}>
        <div style={{width:52,height:52,borderRadius:14,background:`linear-gradient(135deg,${P.violet},${P.gold})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0,boxShadow:`0 0 20px ${P.violet}44`}}>⚡</div>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,color:P.text}}>AI Feature Builder</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted,marginTop:2}}>Describe any analytics, chart, or calculation — AI will build it instantly using your real financial data</div>
        </div>
        <div style={{marginLeft:"auto",textAlign:"right"}}>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>Widgets Built</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:32,fontWeight:800,color:P.violet}}>{widgets.length}</div>
        </div>
      </div>

      {/* Input */}
      <Card accent={P.violet} style={{marginBottom:14}}>
        <SectionHead title="Describe Your Feature" icon="✏️" color={P.violet}/>
        <div style={{display:"flex",gap:10,marginBottom:12}}>
          <input
            value={prompt}
            onChange={e=>setPrompt(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&buildWidget()}
            placeholder='Example: "Add a chart showing monthly savings trend with target line at ₹30,000"'
            style={{flex:1,background:P.card3,border:`1px solid ${P.border}`,borderRadius:10,padding:"12px 16px",color:P.text,fontFamily:"'Outfit',sans-serif",fontSize:13,outline:"none"}}
          />
          <button
            onClick={()=>buildWidget()}
            disabled={building||!prompt.trim()}
            style={{background:building||!prompt.trim()?P.border:`linear-gradient(135deg,${P.violet},${P.gold})`,border:"none",borderRadius:10,padding:"12px 22px",color:P.bg,cursor:building||!prompt.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:12,fontWeight:700,transition:"all .15s",whiteSpace:"nowrap"}}>
            {building?"Building…":"⚡ Build"}
          </button>
        </div>
        {error && <div style={{padding:"10px 14px",background:`${P.ruby}14`,border:`1px solid ${P.ruby}33`,borderRadius:8,fontFamily:"'Fira Code',monospace",fontSize:11,color:P.ruby}}>{error}</div>}
        <div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted,marginBottom:8,letterSpacing:1.5,textTransform:"uppercase"}}>Quick Prompts — Click to Build</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {EXAMPLES.map((e,i)=>(
              <button key={i} onClick={()=>buildWidget(e)} disabled={building}
                style={{background:P.card3,border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 12px",color:P.muted,cursor:building?"not-allowed":"pointer",fontFamily:"'Outfit',sans-serif",fontSize:11,textAlign:"left",transition:"all .15s",lineHeight:1.4}}
                onMouseEnter={ev=>{ev.currentTarget.style.borderColor=P.violet+"66";ev.currentTarget.style.color=P.text;}}
                onMouseLeave={ev=>{ev.currentTarget.style.borderColor=P.border;ev.currentTarget.style.color=P.muted;}}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Loading */}
      {building && (
        <Card accent={P.violet} style={{marginBottom:14,textAlign:"center",padding:"32px 20px"}}>
          <div style={{fontSize:40,marginBottom:12}}>🤖</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:700,color:P.violet,marginBottom:8}}>Building your widget…</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted}}>AI is generating analytics, calculations, and chart code using your real financial data</div>
          <div style={{display:"flex",justifyContent:"center",gap:6,marginTop:16}}>
            {[0,1,2].map(i=><div key={i} style={{width:10,height:10,borderRadius:"50%",background:P.violet,animation:`pulse 1.2s ${i*0.2}s infinite`}}/>)}
          </div>
        </Card>
      )}

      {/* Generated Widgets */}
      {widgets.map((w,i)=>(
        <Card key={w.id} accent={[P.violet,P.gold,P.emerald,P.teal,P.rose][i%5]} style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
            <div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:700,color:P.text,marginBottom:4}}>{w.title}</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.muted}}>{w.description}</div>
              <div style={{fontFamily:"'Fira Code',monospace",fontSize:9,color:`${P.violet}88`,marginTop:4}}>Prompt: "{w.prompt}"</div>
            </div>
            <button onClick={()=>setWidgets(prev=>prev.filter(x=>x.id!==w.id))}
              style={{background:"none",border:`1px solid ${P.border}`,color:P.muted,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:10,fontFamily:"'Fira Code',monospace"}}>✕ Remove</button>
          </div>
          <div style={{padding:"16px 0"}} dangerouslySetInnerHTML={{__html:""}}/>
          {/* Render description as fallback since dangerouslySetInnerHTML can't execute JSX */}
          <div style={{background:`${P.violet}08`,border:`1px solid ${P.violet}22`,borderRadius:10,padding:"16px 18px"}}>
            <pre style={{fontFamily:"'Fira Code',monospace",fontSize:10,color:P.emerald,margin:0,lineHeight:1.8,whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:300,overflowY:"auto"}}>{w.html}</pre>
          </div>
          <div style={{marginTop:8,fontFamily:"'Fira Code',monospace",fontSize:9,color:P.muted}}>💡 Copy the JSX above and add it to your local dashboard file to render it interactively</div>
        </Card>
      ))}

      {widgets.length===0 && !building && (
        <div style={{textAlign:"center",padding:"60px 20px",color:P.muted}}>
          <div style={{fontSize:60,marginBottom:16,opacity:.4}}>⚡</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:700,color:`${P.muted}88`,marginBottom:8}}>No widgets yet</div>
          <div style={{fontFamily:"'Fira Code',monospace",fontSize:11}}>Type a prompt above or click one of the quick prompts to generate your first AI-powered widget</div>
        </div>
      )}
    </div>
  );
}


// ─── API SETTINGS COMPONENT ──────────────────────────────────────────────────
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
        // Check all 6 keys present
        const keys = Object.keys(data);
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
            { step:"1", color:P.emerald, text:"Open script.google.com → create a new project" },
            { step:"2", color:P.sapphire,text:"Paste the Central API script code (download below)" },
            { step:"3", color:P.gold,    text:"Click Deploy → New Deployment → Web App" },
            { step:"4", color:P.teal,    text:'Execute as: Me · Who has access: Anyone (no Google account required)' },
            { step:"5", color:P.orange,  text:"Copy the /exec URL and paste it in the field below" },
            { step:"6", color:P.ruby,    text:"Click Test → if all 6 sheets show, click Save & Sync" },
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
            placeholder="/api/central or https://script.google.com/macros/s/.../exec"
            style={{flex:1,background:P.card3,border:`1px solid ${result?.ok===true?P.emerald:result?.ok===false?P.ruby:P.border}`,borderRadius:10,padding:"11px 14px",color:P.text,fontFamily:"'Fira Code',monospace",fontSize:11,outline:"none",transition:"border-color .2s"}}
          />
          <button onClick={handleTest} disabled={testing||!local.trim()} style={{background:testing?P.border:`${P.sapphire}22`,border:`1px solid ${testing?P.border:P.sapphire}55`,borderRadius:10,padding:"11px 20px",color:testing?P.muted:P.sapphire,cursor:testing||!local.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,whiteSpace:"nowrap",transition:"all .15s"}}>
            {testing ? "⏳ Testing..." : "🔬 Test"}
          </button>
          <button onClick={handleSave} disabled={!local.trim()} style={{background:saved?`${P.emerald}22`:`linear-gradient(135deg,${P.sapphire},${P.teal})`,border:saved?`1px solid ${P.emerald}44`:"none",borderRadius:10,padding:"11px 22px",color:saved?P.emerald:"#050D1A",cursor:!local.trim()?"not-allowed":"pointer",fontFamily:"'Fira Code',monospace",fontSize:11,fontWeight:700,whiteSpace:"nowrap",transition:"all .2s"}}>
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

        {/* Active URL display */}
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

// ─── TABS ─────────────────────────────────────────────────────────────────────
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
  { id:"milestones",  label:"Milestones",       icon:"🎯" },
  { id:"ai",          label:"AI Adviser",       icon:"🤖" },
  { id:"aibuilder",   label:"AI Builder",       icon:"⚡" },
  { id:"codefixer",   label:"Code Fixer",       icon:"🔧" },
  { id:"urlsettings", label:"⚙ API Settings",   icon:"🔗" },
];

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data,     setData]     = useState(SEED);
  const [tab,      setTab]      = useState("overview");
  const [syncSt,   setSyncSt]   = useState("idle");
  const [lastSync, setLastSync] = useState(null);
  const [syncLog,  setSyncLog]  = useState([]);  // [{ts,key,status,duration,summary,error}]
  const [syncLogOpen, setSyncLogOpen] = useState(false);
  const [cd,       setCd]       = useState(AUTO_SYNC_SECONDS);
  const [corsWarn, setCorsWarn] = useState(false);
  const [syncHint, setSyncHint] = useState("");
  const [apiUrl,   setApiUrl]   = useState(loadApiUrl);  // ← single central API URL
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
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.25} }
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
          {[`NET WORTH ${fmt(netWorth)}`,`SALARY ₹${(d.income.salary/1000).toFixed(0)}K`,`IN-HAND ${fmt(d.income.inHand)}`,`EMI LOAD ${emiPct}%`,`STOCKS ${fmt(d.stocks.summary.total.current)}`,`P&L +${fmt(d.stocks.summary.total.pl)}`,`P.LENDING ₹${(d.personalLending.totalCapital/100000).toFixed(1)}L`,`LENDEN ₹${(d.lendenClub.totalPooled/1000).toFixed(0)}K`,`HDFC ${fmt(d.loans.hdfc.outstanding)}`,`IDFC ${fmt(d.loans.idfc.outstanding)}`,`LAND PAID ${fmt(d.realEstate.paid)}`].map((t,i)=>(
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

        {/* ═══ AI ADVISER ═══ */}
        {tab==="ai" && <AIAdviser data={data}/>}

        {/* ═══ CODE FIXER ═══ */}
        {tab==="codefixer" && <AICodeFixer syncLog={syncLog}/>}

        {/* ═══ API SETTINGS ═══ */}
        {tab==="urlsettings" && (
          <APISettings
            apiUrl={apiUrl}
            setApiUrl={setApiUrl}
            onSyncNow={()=>syncFnRef.current()}
          />
        )}

        {/* ═══ MILESTONES ═══ */}
        {tab==="milestones" && <Milestones data={data}/>}

        {/* ═══ SALARY TRACKER ═══ */}
        {tab==="salary" && <SalaryTracker data={data}/>}

        {/* ═══ AI BUILDER ═══ */}
        {tab==="aibuilder" && <AIBuilder data={data}/>}

        {/* ═══ OVERVIEW ═══ */}
        {tab==="overview" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:10,marginBottom:16}}>
              <KPI label="Monthly Salary"    value={fmt(d.income.salary)}               sub={`Age ${d.income.age} · ${d.income.year}`}  color={P.gold}     icon="💼"/>
              <KPI label="In-Hand Income"    value={fmt(d.income.inHand)}               sub={`Savings rate ${savingsRate}%`}            color={P.emerald}  icon="💵"/>
              <KPI label="Total Investments" value={fmt(totalInv)}                      sub="All assets"                               color={P.sapphire} icon="📊"/>
              <KPI label="Total Debt"        value={fmt(totalDebt)}                     sub="3 active loans"                           color={P.ruby}     icon="🏦"/>
              <KPI label="Stock Portfolio"   value={fmt(d.stocks.summary.total.current)}sub={`P&L +${fmt(d.stocks.summary.total.pl)}`} color={P.violet}   icon="📈"/>
              <KPI label="EMI Burden"        value={`${emiPct}%`}                       sub={`${fmt(emiTotal)}/month`}                  color={emiPct>50?P.ruby:P.orange} icon="💳"/>
              <KPI label="Lending Received" value={fmt(d.income.lendingInterest || d.personalLending.receivedThisMonth || 0)} sub={d.income.month ? `Actual in ${d.income.month}` : (d.personalLending.receivedMonthLabel ? `Interest in ${d.personalLending.receivedMonthLabel}` : "Latest received month")} color={P.teal} icon="🤝"/>
              <KPI label="LendenClub Pool"   value={fmt(d.lendenClub.totalPooled)}      sub="P2P portfolio"                            color={P.rose}     icon="🏛"/>
            </div>

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
                      <TD color={P.emerald}>+{f.returnsP}%</TD>
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
                      <TD color={P.emerald}>+{e.plP}%</TD>
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
                        <TD>{c.qty}</TD><TD>{(c.buyPrice/100000).toFixed(2)}L</TD>
                        <TD>{fmtF(c.invested)}</TD><TD color={P.gold}>{fmtF(c.current)}</TD>
                        <TD color={P.emerald}>+{fmtF(c.pl)}</TD>
                        <TD color={P.emerald}>+{c.plP.toFixed(2)}%</TD>
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
              <KPI label="Total Outstanding" value={fmt(totalDebt)}      sub="Across all 3 loans"      color={P.ruby}   icon="🏦"/>
              <KPI label="Monthly EMI Total" value={fmt(emiTotal)}       sub={`${emiPct}% of salary`}  color={P.orange} icon="💳"/>
              <KPI label="Interest Paid HDFC"value={fmtF(d.loans.hdfc.totalInterestPaid||76874)} sub="4 EMIs paid" color={P.muted} icon="📉"/>
            </div>

            <Card accent={P.ruby} style={{marginBottom:14}}>
              <SectionHead title="HDFC Home Loan — Amortisation" icon="🏦" color={P.ruby}/>
              <div style={{display:"flex",gap:24,marginBottom:14,flexWrap:"wrap"}}>
                <DonutRing pct={(d.loans.hdfc.paid/d.loans.hdfc.total)*100} color={P.ruby} size={100} stroke={9} label={`${d.loans.hdfc.paid}/${d.loans.hdfc.total}`} sub="EMIs"/>
                <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted,lineHeight:2.1}}>
                  <div>EMI: <span style={{color:P.ruby}}>{fmtF(d.loans.hdfc.emi)}/mo</span></div>
                  <div>Outstanding: <span style={{color:P.ruby}}>{fmtF(d.loans.hdfc.outstanding)}</span></div>
                  <div>Rate: <span style={{color:P.gold}}>{d.loans.hdfc.interestRate}% p.a.</span></div>
                  <div>Remaining: <span style={{color:P.text}}>{d.loans.hdfc.total-d.loans.hdfc.paid} EMIs</span></div>
                  <div>Principal paid: <span style={{color:P.emerald}}>{fmtF(d.loans.hdfc.totalPrincipalPaid||92396)}</span></div>
                  <div>Interest paid: <span style={{color:P.ruby}}>{fmtF(d.loans.hdfc.totalInterestPaid||76874)}</span></div>
                </div>
              </div>
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

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <Card accent={P.sapphire}>
                <SectionHead title="IDFC Personal Loan" icon="🏦" color={P.sapphire}/>
                <div style={{display:"flex",gap:14,marginBottom:12,alignItems:"center"}}>
                  <DonutRing pct={(d.loans.idfc.paid/d.loans.idfc.total)*100} color={P.sapphire} size={90} stroke={8} label={`${d.loans.idfc.paid}/${d.loans.idfc.total}`} sub="EMIs"/>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted,lineHeight:2.1}}>
                    <div>EMI: <span style={{color:P.sapphire}}>{fmtF(d.loans.idfc.emi)}/mo</span></div>
                    <div>Outstanding: <span style={{color:P.ruby}}>{fmtF(d.loans.idfc.outstanding)}</span></div>
                    <div>Rate: <span style={{color:P.gold}}>{d.loans.idfc.interestRate}% p.a.</span></div>
                  </div>
                </div>
                <table className="row-hover">
                  <thead><tr><TH>#</TH><TH>Date</TH><TH>EMI</TH><TH>Principal</TH><TH>Interest</TH><TH>Balance</TH><TH>Status</TH></tr></thead>
                  <tbody>
                    {d.loans.idfc.schedule.map((s,i)=>(
                      <tr key={i}><TD color={P.muted}>{s.no}</TD><TD color={P.muted}>{s.date}</TD><TD>{fmtF(s.emi)}</TD><TD color={P.emerald}>{fmtF(s.principal)}</TD><TD color={P.ruby}>{fmtF(s.interest)}</TD><TD color={P.sapphire}>{fmtF(s.balance)}</TD><TD><Pill color={s.status==="Paid"?P.emerald:P.muted}>{s.status||"Pending"}</Pill></TD></tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card accent={P.orange}>
                <SectionHead title="SBI Personal Loan" icon="🏦" color={P.orange}/>
                <div style={{display:"flex",gap:14,marginBottom:12,alignItems:"center"}}>
                  <DonutRing pct={0} color={P.orange} size={90} stroke={8} label="0/25" sub="EMIs"/>
                  <div style={{fontFamily:"'Fira Code',monospace",fontSize:11,color:P.muted,lineHeight:2.1}}>
                    <div>EMI: <span style={{color:P.orange}}>{fmtF(d.loans.sbi.emi)}/mo</span></div>
                    <div>Outstanding: <span style={{color:P.ruby}}>{fmtF(d.loans.sbi.outstanding)}</span></div>
                    <div>Rate: <span style={{color:P.gold}}>{d.loans.sbi.interestRate}% p.a.</span></div>
                    <div>Total Interest: <span style={{color:P.ruby}}>{fmtF(d.loans.sbi.totalInterestOnLoan||5495)}</span></div>
                  </div>
                </div>
                <table className="row-hover">
                  <thead><tr><TH>#</TH><TH>Date</TH><TH>EMI</TH><TH>Principal</TH><TH>Interest</TH><TH>Closing Bal</TH></tr></thead>
                  <tbody>
                    {d.loans.sbi.schedule.slice(0,4).map((s,i)=>(
                      <tr key={i}><TD color={P.muted}>{s.no}</TD><TD color={P.muted}>{s.date}</TD><TD>{fmtF(s.emi)}</TD><TD color={P.emerald}>{fmtF(s.principal)}</TD><TD color={P.ruby}>{fmtF(s.interest)}</TD><TD color={P.sapphire}>{fmtF(s.balance)}</TD></tr>
                    ))}
                    <tr style={{background:P.card2}}><TD colSpan={6} color={P.muted} left>25 EMIs total · Ends Apr 2028</TD></tr>
                  </tbody>
                </table>
              </Card>
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
                          <TD color={P.gold}>{fmtF(b.amount)}</TD><TD color={P.sapphire}>{n(b.rate).toFixed(2)}%</TD>
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
                      {d.realEstate.valuation.map((v,i)=>(
                        <tr key={i}><TD color={P.gold}>{v.year}</TD><TD color={P.muted}>{v.marketValue?fmtF(v.marketValue):"—"}</TD><TD color={P.text}>{fmtF(v.totalInvested)}</TD><TD color={P.muted}>{v.unrealisedGain!=null?fmtF(v.unrealisedGain):"—"}</TD><TD color={P.muted}>{v.gainP!=null?`${v.gainP}%`:"—"}</TD></tr>
                      ))}
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
