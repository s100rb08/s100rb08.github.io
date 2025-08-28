/* app.js
   Plain JS attendance dashboard
   - replace CSV_URLS with your sheet export links (already set)
   - auto-refresh default 60s
*/

const CSV_URLS = [
  { subject: "DBMS", url: "https://docs.google.com/spreadsheets/d/1mpNm7B3lH0cwtYSuWq8hc_APwUvMtDsXUFa4Wxs79Gw/export?format=csv" },
  { subject: "Soft Computing", url: "https://docs.google.com/spreadsheets/d/1FpO3Unwv1r3qHUf0O6ej9VbFmOnQzxWBY2jkxFvqxMg/export?format=csv" },
  { subject: "DAA", url: "https://docs.google.com/spreadsheets/d/1ZCZPdJNCS_OjCB9Th8UkoKHK5lHnqY7zdwbZsWWli_Y/export?format=csv" },
  { subject: "OOSD With C++", url: "https://docs.google.com/spreadsheets/d/1_Ewg-7Bu1tX2YcSloaJfdsOxXoYf9_ltxhGR9o2jx3U/export?format=csv" }
];

const REFRESH_MS = 30000; // 30s

// UTIL: simple CSV parser handling quoted cells
function parseCSV(text) {
  text = text.replace(/\r/g, "");
  const lines = text.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") { rows.push([]); continue; }
    const row = [];
    let cur = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        if (inQuotes && line[j+1] === '"') { // escaped quote
          cur += '"'; j++; continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === "," && !inQuotes) {
        row.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function formatPercentFraction(frac) {
  if (!isFinite(frac) || isNaN(frac)) return "0.00%";
  return (frac * 100).toFixed(2) + "%";
}

function createElem(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const k in props) {
    if (k === "class") el.className = props[k];
    else if (k === "text") el.textContent = props[k];
    else if (k.startsWith("on") && typeof props[k] === "function") el.addEventListener(k.substring(2).toLowerCase(), props[k]);
    else el.setAttribute(k, props[k]);
  }
  children.forEach(ch => el.appendChild(ch));
  return el;
}

async function fetchCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchAllSheets() {
  // returns array of {subject, rows (2D array)}
  const promises = CSV_URLS.map(async s => {
    const txt = await fetchCSV(s.url);
    const rows = parseCSV(txt);
    return { subject: s.subject, rows };
  });
  return await Promise.all(promises);
}

// Build merged students map by Roll No
function buildStudentsMap(sheets) {
  // map: roll -> { name, roll, subjects: { subj: { classesHeld, presentByDate:[], presentTotal } }, totals }
  const map = {};
  // We'll also compute today's date per subject as the last header column (if header has date-like values)
  const subjectLastColIndex = {}; // subject -> last column index
  for (const sheet of sheets) {
    const rows = sheet.rows;
    if (!rows || rows.length < 1) continue;
    const header = rows[0];
    // Expect: Col A? B->Student Name (index 1), C->Roll (index 2), D onward -> dates
    const nameIdx = 1;
    const rollIdx = 2;
    const dateStart = 3; // index 3 = column D
    const classesHeld = Math.max(0, header.length - dateStart);
    subjectLastColIndex[sheet.subject] = header.length - 1; // last index

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = (row[nameIdx] || "").trim();
      const roll = (row[rollIdx] || "").trim();
      if (!roll) continue;
      if (!map[roll]) {
        map[roll] = { name: name || "Unknown", roll, subjects: {}, totals: { classesHeld: 0, present: 0, absent: 0 } };
      } else if (!map[roll].name && name) {
        map[roll].name = name;
      }
      // ensure we consider header classesHeld even if row has fewer cells
      const subjClassesHeld = classesHeld;
      let presentTotal = 0;
      // store presentByDate array for today's detection: index aligned with header last columns
      const presentByDate = [];
      for (let c = dateStart; c < header.length; c++) {
        const val = (row[c] || "").trim();
        const isPresent = (val.toLowerCase() === "p");
        presentByDate.push(isPresent ? 1 : 0);
        if (isPresent) presentTotal++;
      }
      const subjAbsent = subjClassesHeld - presentTotal;
      map[roll].subjects[sheet.subject] = {
        classesHeld: subjClassesHeld,
        present: presentTotal,
        absent: subjAbsent,
        presentByDate
      };
      map[roll].totals.classesHeld += subjClassesHeld;
      map[roll].totals.present += presentTotal;
      map[roll].totals.absent += subjAbsent;
    }
  }

  // compute overall percent and status
  for (const roll in map) {
    const t = map[roll].totals;
    t.percent = t.classesHeld > 0 ? t.present / t.classesHeld : 0;
    t.status = t.percent >= 0.75 ? "Good" : "Needs Improvement";
  }

  return { map, subjectLastColIndex };
}

// Compute today's present/absent using last date column per subject
function computeTodayCounts(map, subjectLastColIndex) {
  // For each subject, last column index is known; for each student we look into subject.presentByDate's last element
  let present = 0, absent = 0, unknown = 0;
  for (const roll in map) {
    const student = map[roll];
    // We'll consider a student present today if they are marked present in ANY subject's last column.
    // Absent if marked absent in ALL subjects where the subject has at least one date column.
    let hasAnySubject = false;
    let anyPresent = false;
    let anySubjectWithDate = false;
    for (const subj in student.subjects) {
      const s = student.subjects[subj];
      const lastIndex = s.presentByDate.length - 1;
      if (lastIndex >= 0) {
        anySubjectWithDate = true;
        hasAnySubject = true;
        const val = s.presentByDate[lastIndex];
        if (val === 1) { anyPresent = true; break; }
      }
    }
    if (!anySubjectWithDate) {
      unknown++;
    } else if (anyPresent) present++; else absent++;
  }
  return { present, absent, unknown };
}

// Render UI
function renderSummary(totalStudents, totalClassesHeld, avgAttendance, todayCounts) {
  const wrap = document.getElementById("summaryCards");
  wrap.innerHTML = "";

  const cards = [
    { title: "Total Students", value: totalStudents },
    { title: "Total Classes Held", value: totalClassesHeld },
    { title: "Average Attendance %", value: formatPercentFraction(avgAttendance) },
    { title: "Today's Present / Absent", value: `Present: ${todayCounts.present} · Absent: ${todayCounts.absent}` }
  ];

  for (const c of cards) {
    const card = createElem("div", { class: "card" }, []);
    card.innerHTML = `<div class="title">${c.title}</div><div class="value">${c.value}</div>`;
    wrap.appendChild(card);
  }
}

function renderStudentsTable(mapObj) {
  const tbody = document.getElementById("studentsTbody");
  tbody.innerHTML = "";
  const rows = Object.values(mapObj).sort((a,b) => a.roll.localeCompare(b.roll));

  if (rows.length === 0) {
    const tr = createElem("tr", {}, [createElem("td", { class: "center", colspan: "6", text: "No students found" })]);
    tbody.appendChild(tr);
    return;
  }

  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openProfile(s));
    tr.innerHTML = `
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.roll)}</td>
      <td>${s.totals.present}</td>
      <td>${s.totals.absent}</td>
      <td>${formatPercentFraction(s.totals.percent)}</td>
      <td>${s.totals.status === 'Good' ? `<span class="pill-good">✅ Good</span>` : `<span class="pill-warn">⚠️ Needs Improvement</span>`}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Simple text escape
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Profile panel
function openProfile(student) {
  document.getElementById("profileName").textContent = student.name;
  document.getElementById("profileRoll").textContent = `Roll No: ${student.roll}`;

  const statsWrap = document.getElementById("profileStats");
  statsWrap.innerHTML = "";
  const statPresent = createElem("div", { class: "stat-card" });
  statPresent.innerHTML = `<div class="muted">Total Present Days</div><div style="font-weight:700;font-size:20px">${student.totals.present}</div>`;
  const statAbsent = createElem("div", { class: "stat-card" });
  statAbsent.innerHTML = `<div class="muted">Total Absent Days</div><div style="font-weight:700;font-size:20px">${student.totals.absent}</div>`;
  statsWrap.appendChild(statPresent);
  statsWrap.appendChild(statAbsent);

  const tbody = document.getElementById("profileSubjectsTbody");
  tbody.innerHTML = "";
  const subjects = student.subjects;
  for (const subj in subjects) {
    const d = subjects[subj];
    const tr = createElem("tr");
    tr.innerHTML = `<td>${escapeHtml(subj)}</td><td>${d.classesHeld}</td><td>${d.present}</td><td>${d.absent}</td><td>${formatPercentFraction(d.classesHeld > 0 ? d.present / d.classesHeld : 0)}</td>`;
    tbody.appendChild(tr);
  }

  document.getElementById("overallAttendance").innerHTML = `<div style="font-weight:700;font-size:18px">Overall: ${formatPercentFraction(student.totals.percent)} · ${student.totals.status === 'Good' ? '✅ Good' : '⚠️ Needs Improvement'}</div>`;

  const overlay = document.getElementById("profileOverlay");
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
}

function closeProfile() {
  const overlay = document.getElementById("profileOverlay");
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

// Search
function setupSearch(map) {
  const input = document.getElementById("search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const allRows = Array.from(document.querySelectorAll("#studentsTbody tr"));
    if (q === "") {
      allRows.forEach(r => r.style.display = "");
      return;
    }
    allRows.forEach(r => {
      const name = (r.cells[0] && r.cells[0].textContent || "").toLowerCase();
      const roll = (r.cells[1] && r.cells[1].textContent || "").toLowerCase();
      if (name.includes(q) || roll.includes(q)) r.style.display = ""; else r.style.display = "none";
    });
  });
}

// Escape helper inside createElem not necessary here for innerHTML uses above.

document.getElementById("overlayBg").addEventListener("click", closeProfile);
document.getElementById("closeProfile").addEventListener("click", closeProfile);

async function loadAndRender() {
  const lastUpdatedEl = document.getElementById("lastUpdated");
  try {
    const sheets = await fetchAllSheets();
    const { map, subjectLastColIndex } = buildStudentsMap(sheets);
    const studentsMap = map;

    const studentsList = Object.values(studentsMap);
    const totalStudents = studentsList.length;
    const totalClassesHeld = studentsList.reduce((acc, s) => acc + (s.totals.classesHeld || 0), 0);
    const totalPresent = studentsList.reduce((acc, s) => acc + (s.totals.present || 0), 0);
    const avgAttendance = totalClassesHeld > 0 ? totalPresent / totalClassesHeld : 0;

    const todayCounts = computeTodayCounts(studentsMap, subjectLastColIndex);

    renderSummary(totalStudents, totalClassesHeld, avgAttendance, todayCounts);
    renderStudentsTable(studentsMap);

    lastUpdatedEl.textContent = `Last updated: ${new Date().toLocaleString()}`;
    setupSearch(studentsMap);
  } catch (err) {
    console.error(err);
    const tbody = document.getElementById("studentsTbody");
    tbody.innerHTML = `<tr><td colspan="6" class="center muted">Error loading data: ${escapeHtml(err.message || err)}</td></tr>`;
    document.getElementById("lastUpdated").textContent = "Error";
  }
}

// initial load + interval
loadAndRender();
setInterval(loadAndRender, REFRESH_MS);
