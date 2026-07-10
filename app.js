/* ═══════════════ CrownPay — app logic ═══════════════ */

// ── State & constants ──
let state = {
  hourlyRate: 0,
  shifts: [],
  removedDates: [],   // dates the user deleted — auto-populate will never resurrect these
  scheduleStart: null, // earliest date auto-populate may fill (set to today on crew switches)
  fedPct: 13,          // estimated federal withholding % (Settings)
  k401Pct: 2,          // 401k pre-tax contribution % (Settings)
  psWeek: 0,           // paystub week offset: 0 = current, -1 = last week, ...
  period: 'week',
  prevPeriod: 'week',
  editingId: null,
  unscheduled: false,
  isHoliday: false,
  holidayWorked: true,
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear(),
  crew: 'A',            // 'A' or 'B' — B works exactly the days A is off
  shiftType: 'night',   // 'night' (6PM–6AM, gets 5% diff) or 'day' (6AM–6PM, no diff)
};
let pendingCrew = 'A', pendingShiftType = 'night'; // settings selections before Save
const CREW_ANCHOR = new Date(2026, 4, 14);
const SHIFT_DIFF = 0.05;          // flat 5% of base wage, on worked hours
const HOLIDAY_FLAT_HRS = 13.25;   // flat holiday pay — received worked or not

// ── Date helpers (calendar-safe: no raw ms-per-day math, so DST can't skew days) ──
function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function dateToStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function strToDate(s){ return startOfDay(new Date(s + 'T12:00:00')); }
function todayStr(){ return dateToStr(new Date()); }

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function isScheduledDay(date){
  const diff = Math.round((startOfDay(date) - startOfDay(CREW_ANCHOR)) / 86400000);
  const aOn = (((diff % 8) + 8) % 8) < 4;
  return state.crew === 'B' ? !aOn : aOn; // B Crew works exactly the days A is off
}

function defaultTimes(st){
  return (st || state.shiftType) === 'day'
    ? { start: '06:00', end: '18:00', startDisplay: '6:00 AM', endDisplay: '6:00 PM' }
    : { start: '18:00', end: '06:00', startDisplay: '6:00 PM', endDisplay: '6:00 AM' };
}

function getThisWeekMonday(){
  const today = startOfDay(new Date());
  const day = today.getDay();
  return addDays(today, day === 0 ? -6 : 1 - day);
}

// ── Pay math (single source of truth — summary, cards, calendar, preview and paystub all use this) ──
function calcPaidHours(startStr, endStr){
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  let gross = (eh * 60 + em) - (sh * 60 + sm);
  if(gross === 0) return 0;          // start == end → no shift (was: treated as 24h)
  if(gross < 0) gross += 1440;       // overnight shift
  return Math.max(0, gross / 60 - 0.5); // 30 min unpaid break
}

/*
 Returns full pay breakdown for one shift:
   base      — all worked hours × rate (REGULAR line)
   premium   — OT +0.5×/hr, unscheduled +0.75×/hr, worked holiday +0.5×/hr (PREMIUM line)
   holFlat   — flat 13.25h × rate per holiday, worked or not (HOLIDAY line)
   shiftDiff — flat 5% of base wage on worked hours (SHIFT DIFF line)
   total     — gross for this shift (matches paystub)
*/
function calcShiftPay(s, rate, shiftTypeOverride){
  const r = { base: 0, premium: 0, premHrs: 0, holFlat: 0, shiftDiff: 0, total: 0 };
  if(!rate || rate <= 0) return r;
  const hrs = s.paidHours || 0;
  const diffPct = ((shiftTypeOverride || state.shiftType) === 'night') ? SHIFT_DIFF : 0; // 5% differential is nights only
  if(s.isHoliday){
    r.holFlat = HOLIDAY_FLAT_HRS * rate;
    if(s.holidayWorked !== false){
      r.base = hrs * rate;
      r.premHrs = hrs * 0.5;
      r.premium = r.premHrs * rate;
      r.shiftDiff = hrs * rate * diffPct;
    }
  } else if(s.isUnscheduled){
    r.base = hrs * rate;
    r.premHrs = hrs * 0.75;
    r.premium = r.premHrs * rate;
    r.shiftDiff = hrs * rate * diffPct;
  } else {
    r.base = hrs * rate;
    const ot = Math.max(0, hrs - 8);
    r.premHrs = ot * 0.5;
    r.premium = r.premHrs * rate;
    r.shiftDiff = hrs * rate * diffPct;
  }
  r.total = r.base + r.premium + r.holFlat + r.shiftDiff;
  return r;
}

function otHours(s){
  return (s.isUnscheduled || s.isHoliday) ? 0 : Math.max(0, (s.paidHours || 0) - 8);
}

// ── Period filtering (consistent: every period includes ALL logged shifts in its range,
//    past or future — so "This Week" can never exceed "This Month") ──
function filterShifts(shifts, period){
  const mon = getThisWeekMonday();
  const nextMon = addDays(mon, 7);
  const lastMon = addDays(mon, -7);
  const now = new Date();
  return shifts.filter(s => {
    const d = strToDate(s.date);
    switch(period){
      case 'week':  return d >= mon && d < nextMon;
      case 'last':  return d >= lastMon && d < mon;
      case 'month': return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      case 'year':  return d.getFullYear() === now.getFullYear();
      default: return true;
    }
  });
}

// Shifts falling in the week at `off` weeks from the current one (0 = this week)
function shiftsForWeekOffset(off){
  const mon = addDays(getThisWeekMonday(), 7 * (off || 0));
  const next = addDays(mon, 7);
  return state.shifts.filter(s => { const d = strToDate(s.date); return d >= mon && d < next; });
}

// ── Persistence ──
function save(){
  localStorage.setItem('crownpay_shifts', JSON.stringify(state.shifts));
  localStorage.setItem('crownpay_rate', String(state.hourlyRate));
  localStorage.setItem('crownpay_removed', JSON.stringify(state.removedDates));
  localStorage.setItem('crownpay_crew', state.crew);
  localStorage.setItem('crownpay_shift', state.shiftType);
  localStorage.setItem('crownpay_schedstart', state.scheduleStart || '');
  localStorage.setItem('crownpay_fedpct', String(state.fedPct));
  localStorage.setItem('crownpay_401kpct', String(state.k401Pct));
}

function load(){
  const r = localStorage.getItem('crownpay_rate');
  if(r) state.hourlyRate = parseFloat(r) || 0;
  try {
    const s = localStorage.getItem('crownpay_shifts');
    if(s) state.shifts = JSON.parse(s) || [];
  } catch(e){ state.shifts = []; }
  try {
    const rm = localStorage.getItem('crownpay_removed');
    if(rm) state.removedDates = JSON.parse(rm) || [];
  } catch(e){ state.removedDates = []; }
  const c = localStorage.getItem('crownpay_crew');
  if(c === 'A' || c === 'B') state.crew = c;
  const sh = localStorage.getItem('crownpay_shift');
  if(sh === 'night' || sh === 'day') state.shiftType = sh;
  const ss = localStorage.getItem('crownpay_schedstart');
  if(ss) state.scheduleStart = ss;
  const fp = parseFloat(localStorage.getItem('crownpay_fedpct'));
  if(!isNaN(fp) && fp >= 0 && fp <= 60) state.fedPct = fp;
  const kp = parseFloat(localStorage.getItem('crownpay_401kpct'));
  if(!isNaN(kp) && kp >= 0 && kp <= 60) state.k401Pct = kp;
  // Migrate holiday shifts saved before the "worked / not worked" split
  state.shifts.forEach(s => { if(s.isHoliday && s.holidayWorked === undefined) s.holidayWorked = true; });
}

function getShiftByDate(dateStr){
  return state.shifts.find(s => s.date === dateStr && !s.isUnscheduled);
}

// Auto-populate the A-crew rotation. Skips any date that already has a shift
// of ANY kind (was: re-added a duplicate if the day's shift was marked holiday)
// and any date the user deleted (was: deleted shifts came back on every reload).
function autoPopulateCrewShifts(fromToday){
  const today = startOfDay(new Date());
  // Crew/shift switches must never backfill fake history for the new pattern —
  // persist the cutoff so boot-time repopulation respects it too.
  if(fromToday) state.scheduleStart = todayStr();
  const start = state.scheduleStart ? strToDate(state.scheduleStart) : new Date(today.getFullYear(), 0, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  const removed = new Set(state.removedDates);
  const haveDate = new Set(state.shifts.map(s => s.date));
  const dt = defaultTimes();
  let cur = new Date(start);
  while(cur <= end){
    const dateStr = dateToStr(cur);
    if(isScheduledDay(cur) && !haveDate.has(dateStr) && !removed.has(dateStr)){
      state.shifts.push({
        id: crypto.randomUUID(), date: dateStr,
        startTime: dt.start, endTime: dt.end,
        startDisplay: dt.startDisplay, endDisplay: dt.endDisplay,
        paidHours: 11.5, isUnscheduled: false, isHoliday: false, note: '',
      });
    }
    cur = addDays(cur, 1);
  }
  state.shifts.sort((a, b) => a.date < b.date ? -1 : 1);
}

// ── Formatting ──
function fmt(n){ return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n); }
function fmtShort(n){
  if(n >= 1000) return '$' + Math.round(n / 100) / 10 + 'k';
  return '$' + Math.round(n);
}
function fmtDate(dateStr){
  const d = new Date(dateStr + 'T12:00:00');
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day: d.getDate(),
    mon: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  };
}
function f12(t){ const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`; }

// ── Summary ──
function renderSummary(){
  const visible = filterShifts(state.shifts, state.period);
  let te = 0, tp = 0, tr = 0, tot = 0, uc = 0;
  visible.forEach(s => {
    te += calcShiftPay(s, state.hourlyRate).total; // gross incl. 5% shift diff — matches paystub
    tp += s.paidHours;
    tot += otHours(s);
    if(!s.isUnscheduled && !s.isHoliday) tr += Math.min(s.paidHours, 8);
    if(s.isUnscheduled) uc++;
  });
  document.getElementById('totalEarnings').textContent = fmt(te);
  // L1: make it obvious when the total includes shifts not yet worked
  const lbl = document.getElementById('summaryLabel');
  if(lbl) lbl.textContent = visible.some(s => s.date > todayStr()) ? 'Est. Gross Pay · incl. upcoming' : 'Est. Gross Pay';
  document.getElementById('statPaidHrs').textContent = tp.toFixed(1) + 'h';
  document.getElementById('statRegHrs').textContent = tr.toFixed(1) + 'h';
  document.getElementById('statOtHrs').textContent = tot.toFixed(1) + 'h';
  document.getElementById('statUnsc').textContent = uc;
  document.getElementById('rateWarning').style.display = state.hourlyRate > 0 ? 'none' : 'flex';
}

// ── Schedule strip / calendar ──
function renderSchedule(forceRefresh){
  if(state.period === 'month'){
    renderCalendar();
  } else {
    const existing = document.getElementById('scheduleStrip');
    if(!existing || forceRefresh || state.prevPeriod === 'month'){
      renderStrip();
    } else {
      scrollStripToPeriod();
    }
  }
}

function scrollStripToPeriod(){
  const targetDate = state.period === 'last' ? addDays(getThisWeekMonday(), -7) : startOfDay(new Date());
  const targetMs = targetDate.getTime();
  document.querySelectorAll('.strip-week').forEach(w => {
    w.querySelectorAll('.strip-day').forEach(d => {
      const onclick = d.getAttribute('onclick') || '';
      const match = onclick.match(/'(\d{4}-\d{2}-\d{2})'/);
      if(match && strToDate(match[1]).getTime() === targetMs){
        w.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
      }
    });
  });
}

function renderStrip(){
  const container = document.getElementById('scheduleContainer');
  container.innerHTML = `<div class="strip-head">
    <div class="strip-label">🗓 Schedule — Tap Any ${state.shiftType === 'day' ? 'Day' : 'Night'}</div>
    <div class="strip-nav">
      <button class="strip-nav-btn" onclick="stripNav(-1)" title="Previous week">‹</button>
      <button class="strip-nav-btn" onclick="stripNav(1)" title="Next week">›</button>
    </div>
  </div><div class="strip-scroll" id="scheduleStrip"></div>`;
  const strip = document.getElementById('scheduleStrip');
  const today = startOfDay(new Date());
  const todayMs = today.getTime();
  const snapToDate = state.period === 'last' ? addDays(getThisWeekMonday(), -7) : today;
  const snapMs = snapToDate.getTime();
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 3, 0);
  const sd = start.getDay();
  let cur = addDays(start, -(sd === 0 ? 6 : sd - 1)); // back up to Monday
  const weeks = [];
  while(cur <= end){
    const week = [];
    for(let i = 0; i < 7; i++){ week.push(cur); cur = addDays(cur, 1); }
    weeks.push(week);
  }
  let html = '';
  let todayWi = 0, snapWi = 0;
  weeks.forEach((week, wi) => {
    html += `<div class="strip-week" id="week-${wi}">`;
    week.forEach(d => {
      const ms = d.getTime();
      const isToday = ms === todayMs;
      const isPast = ms < todayMs;
      if(isToday) todayWi = wi;
      if(ms === snapMs) snapWi = wi;
      const dateStr = dateToStr(d);
      const isA = isScheduledDay(d);
      const hol = state.shifts.find(s => s.date === dateStr && s.isHoliday);
      const logged = getShiftByDate(dateStr);
      const unsc = state.shifts.find(s => s.date === dateStr && s.isUnscheduled);
      const dow = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      const day = d.getDate();
      const mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      let cls = 'strip-day', icon = '—';
      if(hol){ cls += ' strip-hol'; icon = '🎉'; }               // was: holiday shifts were invisible in strip view
      else if(unsc){ cls += ' strip-ot'; icon = '⭐'; }
      else if(logged){ cls += ' strip-logged'; icon = '✓'; } // L2: show logged shifts even on days the current crew is "off" (old-crew history)
      else if(isA){ icon = state.shiftType === 'day' ? '☀️' : '🌙'; if(isPast) cls += ' strip-past'; }
      else { cls += ' strip-b'; icon = '·'; }
      if(isToday) cls += ' today';
      html += `<div class="${cls}" onclick="stripDayTapped('${dateStr}')">
        <div class="strip-dow">${dow}</div>
        <div class="strip-num">${day}</div>
        <div class="strip-mon">${mon}</div>
        <div class="strip-moon">${icon}</div>
      </div>`;
    });
    html += `</div>`;
  });
  strip.innerHTML = html;
  // Desktop: let a normal mouse wheel scroll the strip horizontally
  strip.addEventListener('wheel', e => {
    if(Math.abs(e.deltaY) > Math.abs(e.deltaX)){
      e.preventDefault();
      strip.scrollBy({ left: e.deltaY > 0 ? strip.clientWidth : -strip.clientWidth, behavior: 'smooth' });
    }
  }, { passive: false });
  requestAnimationFrame(() => {
    const targetWi = state.period === 'last' ? snapWi : todayWi;
    const el = document.getElementById('week-' + targetWi);
    if(el) el.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
  });
}

function stripNav(dir){
  const strip = document.getElementById('scheduleStrip');
  if(!strip) return;
  const week = strip.querySelector('.strip-week');
  strip.scrollBy({ left: dir * (week ? week.offsetWidth : strip.clientWidth), behavior: 'smooth' });
}

function calNav(dir){
  state.calMonth += dir;
  if(state.calMonth > 11){ state.calMonth = 0; state.calYear++; }
  if(state.calMonth < 0){ state.calMonth = 11; state.calYear--; }
  renderCalendar();
}

function renderCalendar(){
  const container = document.getElementById('scheduleContainer');
  const today = startOfDay(new Date());
  const yr = state.calYear, mo = state.calMonth;
  const monthName = new Date(yr, mo, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const firstDay = new Date(yr, mo, 1);
  const lastDay = new Date(yr, mo + 1, 0);
  let startDow = (firstDay.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const totalDays = lastDay.getDate();

  const cells = [];
  for(let i = 0; i < startDow; i++) cells.push(null);
  for(let d = 1; d <= totalDays; d++) cells.push(new Date(yr, mo, d));
  while(cells.length % 7 !== 0) cells.push(null);

  const dows = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

  let html = `<div class="cal-wrap">
    <div class="cal-header">
      <div class="cal-title">${monthName}</div>
      <div class="cal-nav">
        <button class="cal-nav-btn" onclick="calNav(-1)">‹</button>
        <button class="cal-nav-btn" onclick="calNav(1)">›</button>
      </div>
    </div>
    <div class="cal-dow-row">${dows.map(d => `<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">`;

  cells.forEach(d => {
    if(!d){ html += `<div class="cal-day cal-empty"></div>`; return; }
    const isToday = d.getTime() === today.getTime();
    const dateStr = dateToStr(d);
    const isA = isScheduledDay(d);
    const logged = getShiftByDate(dateStr);
    const unsc = state.shifts.find(s => s.date === dateStr && s.isUnscheduled);
    const isPast = d <= today;

    let cls = 'cal-day', icon = '', payStr = '';
    const holShift = state.shifts.find(s => s.date === dateStr && s.isHoliday);
    if(holShift){
      cls += ' hol-day';
      icon = '🎉';
      if(state.hourlyRate > 0) payStr = fmtShort(calcShiftPay(holShift, state.hourlyRate).total);
    } else if(unsc){
      cls += ' ot-day';
      icon = '⭐';
      if(state.hourlyRate > 0) payStr = fmtShort(calcShiftPay(unsc, state.hourlyRate).total);
    } else if(logged){ // L2: old-crew history still shows as logged
      cls += ' a-logged';
      icon = '<span style="color:#007700;font-size:9px;font-weight:900">✓</span>';
      if(state.hourlyRate > 0) payStr = fmtShort(calcShiftPay(logged, state.hourlyRate).total);
    } else if(isA){
      cls += ' a-crew';
      icon = isPast ? '·' : (state.shiftType === 'day' ? '☀️' : '🌙');
    } else {
      cls += ' b-crew';
    }
    if(isToday) cls += ' today';

    html += `<div class="${cls}" onclick="stripDayTapped('${dateStr}')">
      <div class="cal-day-num">${d.getDate()}</div>
      ${icon ? `<div class="cal-day-icon">${icon}</div>` : ''}
      ${payStr ? `<div class="cal-day-pay">${payStr}</div>` : ''}
    </div>`;
  });

  html += `</div>
    <div class="cal-legend">
      <div class="cal-legend-item"><div class="cal-legend-dot" style="background:rgba(255,80,80,0.5)"></div>${state.crew} Crew (my days)</div>
      <div class="cal-legend-item"><div class="cal-legend-dot" style="background:rgba(80,140,255,0.5)"></div>Off days</div>
      <div class="cal-legend-item"><div class="cal-legend-dot" style="background:#4fbb80"></div>Logged</div>
      <div class="cal-legend-item"><div class="cal-legend-dot" style="background:#cc9900"></div>⭐ Unscheduled</div>
      <div class="cal-legend-item"><div class="cal-legend-dot" style="background:#FFD700"></div>🎉 Holiday</div>
    </div>
  </div>`;

  container.innerHTML = html;
}

// ── Shift list ──
function renderShifts(){
  const list = document.getElementById('shiftList');
  const header = document.querySelector('.section-header');
  if(state.period === 'month'){
    if(header) header.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  if(header) header.style.display = '';
  const visible = filterShifts(state.shifts, state.period)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  if(visible.length === 0){
    list.innerHTML = `<div class="empty"><div class="emoji">🌙</div><p>No shifts logged yet.<br>Tap <strong>Add Shift</strong> below.</p></div>`;
    return;
  }
  list.innerHTML = visible.map(s => {
    const pay = calcShiftPay(s, state.hourlyRate);
    const ot = otHours(s);
    const { dow, day, mon } = fmtDate(s.date);
    const holNotWorked = s.isHoliday && s.holidayWorked === false;
    const badge = s.isHoliday
      ? `<span class="badge" style="background:rgba(255,215,0,0.2);color:#FFD700;border:1px solid rgba(255,215,0,0.5)">🎉</span>`
      : s.isUnscheduled ? `<span class="badge badge-unsc">1.75×</span>`
      : ot > 0 ? `<span class="badge badge-ot">OT</span>` : '';
    const otNote = (!s.isUnscheduled && !s.isHoliday && ot > 0) ? ` (${ot.toFixed(1)}h OT)` : '';
    const cls = s.isHoliday ? 'has-holiday' : s.isUnscheduled ? 'unscheduled' : ot > 0 ? 'has-ot' : '';
    const timeLine = holNotWorked ? '🎁 Paid holiday (not worked)' : `${s.startDisplay}–${s.endDisplay}`;
    const hrsLine = holNotWorked ? `${HOLIDAY_FLAT_HRS} flat hrs` : `${s.paidHours.toFixed(1)} paid hrs${otNote}`;
    return `<div class="shift-card ${cls}" onclick="openEditShift('${s.id}')">
      <div class="date-badge"><div class="dow">${dow}</div><div class="day">${day}</div><div class="mon">${mon}</div></div>
      <div class="shift-divider"></div>
      <div class="shift-info">
        <div class="shift-time">${timeLine} ${badge}</div>
        <div class="shift-hrs">${hrsLine}</div>
        ${s.note ? `<div class="shift-note">${escapeHtml(s.note)}</div>` : ''}
      </div>
      <div class="shift-pay">
        <div class="shift-pay-amount">${fmt(pay.total)}</div>
        <div class="shift-pay-type">${s.isHoliday ? 'Holiday' : s.isUnscheduled ? 'Unscheduled' : 'Scheduled'}</div>
      </div>
    </div>`;
  }).join('');
}

function renderAll(forceRefresh){ renderSummary(); renderSchedule(forceRefresh); renderShifts(); }

// ── Shift modal ──
function setModalToggles(){
  document.getElementById('unscheduledSwitch').classList.toggle('on', state.unscheduled);
  document.getElementById('holidaySwitch').classList.toggle('on', state.isHoliday);
  document.getElementById('holWorkedSwitch').classList.toggle('on', state.holidayWorked);
  document.getElementById('holWorkedRow').style.display = state.isHoliday ? 'flex' : 'none';
  document.getElementById('timeRow').style.opacity = (state.isHoliday && !state.holidayWorked) ? '0.4' : '1';
}

function stripDayTapped(dateStr){
  const existing = state.shifts.find(s => s.date === dateStr);
  if(existing){ openEditShift(existing.id); return; }
  const isA = isScheduledDay(strToDate(dateStr));
  // Reset ALL modal state (was: stale isHoliday from a previous open silently saved shifts as holiday)
  state.editingId = null; state.unscheduled = !isA; state.isHoliday = false; state.holidayWorked = true;
  document.getElementById('shiftModalTitle').textContent = 'Add Shift';
  document.getElementById('shiftDate').value = dateStr;
  document.getElementById('shiftStart').value = defaultTimes().start;
  document.getElementById('shiftEnd').value = defaultTimes().end;
  document.getElementById('shiftNote').value = '';
  document.getElementById('shiftDeleteBtn').style.display = 'none';
  setModalToggles();
  updateCrewIndicator(); updateShiftPreview();
  document.getElementById('shiftModal').classList.add('open');
}

function openAddShift(){
  state.editingId = null; state.unscheduled = false; state.isHoliday = false; state.holidayWorked = true;
  document.getElementById('shiftModalTitle').textContent = 'Add Shift';
  document.getElementById('shiftDate').value = todayStr();
  document.getElementById('shiftStart').value = defaultTimes().start;
  document.getElementById('shiftEnd').value = defaultTimes().end;
  document.getElementById('shiftNote').value = '';
  document.getElementById('shiftDeleteBtn').style.display = 'none';
  setModalToggles();
  updateCrewIndicator(); updateShiftPreview();
  document.getElementById('shiftModal').classList.add('open');
}

function openEditShift(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  state.editingId = id;
  state.unscheduled = !!s.isUnscheduled;
  state.isHoliday = !!s.isHoliday;
  state.holidayWorked = s.holidayWorked !== false;
  document.getElementById('shiftModalTitle').textContent = 'Edit Shift';
  document.getElementById('shiftDate').value = s.date;
  document.getElementById('shiftStart').value = s.startTime;
  document.getElementById('shiftEnd').value = s.endTime;
  document.getElementById('shiftNote').value = s.note || '';
  document.getElementById('shiftDeleteBtn').style.display = 'block';
  setModalToggles();
  updateCrewIndicator(); updateShiftPreview();
  document.getElementById('shiftModal').classList.add('open');
}

function closeShiftModal(){ document.getElementById('shiftModal').classList.remove('open'); }

function toggleUnscheduled(){
  state.unscheduled = !state.unscheduled;
  if(state.unscheduled) state.isHoliday = false; // mutually exclusive
  setModalToggles();
  updateShiftPreview();
}

function toggleHoliday(){
  state.isHoliday = !state.isHoliday;
  if(state.isHoliday){ state.unscheduled = false; state.holidayWorked = true; }
  setModalToggles();
  updateShiftPreview();
}

function toggleHolidayWorked(){
  state.holidayWorked = !state.holidayWorked;
  setModalToggles();
  updateShiftPreview();
}

function updateCrewIndicator(){
  const v = document.getElementById('shiftDate').value;
  const ind = document.getElementById('crewIndicator');
  if(!v) return;
  const sched = isScheduledDay(strToDate(v));
  const word = state.shiftType === 'day' ? 'day' : 'night';
  ind.className = 'crew-indicator ' + (sched ? 'scheduled' : 'off');
  ind.innerHTML = sched
    ? `<span>✓</span> ${state.crew} Crew scheduled ${word}`
    : `<span>–</span> Not a scheduled ${state.crew} Crew ${word}`;
}

function updateShiftPreview(){
  const st = document.getElementById('shiftStart').value || defaultTimes().start;
  const en = document.getElementById('shiftEnd').value || defaultTimes().end;
  const worked = !state.isHoliday || state.holidayWorked;
  const paid = worked ? calcPaidHours(st, en) : 0;
  const temp = { paidHours: paid, isUnscheduled: state.unscheduled, isHoliday: state.isHoliday, holidayWorked: state.holidayWorked };
  const pay = calcShiftPay(temp, state.hourlyRate);
  const ot = otHours(temp);
  document.getElementById('previewAmount').textContent = fmt(pay.total);
  document.getElementById('previewHrs').textContent = paid.toFixed(1) + 'h';
  let note;
  if(!(state.hourlyRate > 0)) note = 'Set your rate in Settings';
  else if(state.isHoliday && !state.holidayWorked) note = `🎁 Paid holiday — flat ${HOLIDAY_FLAT_HRS}h`;
  else if(state.isHoliday) note = `🎉 Holiday — 1× + 0.5× prem + ${HOLIDAY_FLAT_HRS}h flat`;
  else if(state.unscheduled) note = '⭐ Unscheduled — 1.75× rate';
  else if(ot > 0) note = `⚡ ${ot.toFixed(1)}h overtime at 1.5×`;
  else note = '☕ 30 min break deducted';
  document.getElementById('previewNote').textContent = note;
}

function saveShift(){
  const date = document.getElementById('shiftDate').value;
  const startStr = document.getElementById('shiftStart').value;
  const endStr = document.getElementById('shiftEnd').value;
  const note = document.getElementById('shiftNote').value.trim();
  if(!date || !startStr || !endStr) return;
  const worked = !state.isHoliday || state.holidayWorked;
  const paid = worked ? calcPaidHours(startStr, endStr) : 0;
  if(worked && paid <= 0){
    alert('⚠️ Those times come out to 0 paid hours (after the 30-minute break). Please check the start and end times.');
    return;
  }
  // One shift per date — replacing prevents silent double-counted pay
  const dup = state.shifts.find(s => s.date === date && s.id !== state.editingId);
  if(dup){
    if(!confirm('A shift already exists on ' + date + '. Replace it?')) return;
    state.shifts = state.shifts.filter(s => !(s.date === date && s.id !== state.editingId));
  }
  const shift = {
    id: state.editingId || crypto.randomUUID(),
    date, startTime: startStr, endTime: endStr,
    startDisplay: f12(startStr), endDisplay: f12(endStr),
    paidHours: paid,
    isUnscheduled: state.unscheduled,
    isHoliday: state.isHoliday,
    holidayWorked: state.isHoliday ? state.holidayWorked : undefined,
    note,
  };
  if(state.editingId){
    const idx = state.shifts.findIndex(s => s.id === state.editingId);
    if(idx >= 0){
      // Moving a shift to a new date: protect the old date from auto-refill
      const oldDate = state.shifts[idx].date;
      if(oldDate !== date && !state.removedDates.includes(oldDate)) state.removedDates.push(oldDate);
      state.shifts[idx] = shift;
    } else {
      state.shifts.push(shift);
    }
  } else {
    state.shifts.push(shift);
  }
  // Manually adding a shift on a previously-deleted date un-deletes it
  state.removedDates = state.removedDates.filter(d => d !== date);
  state.shifts.sort((a, b) => a.date < b.date ? -1 : 1);
  save();
  renderAll(true);
  closeShiftModal();
}

function deleteShift(){
  if(!state.editingId) return;
  if(!confirm('Delete this shift?')) return;
  const s = state.shifts.find(x => x.id === state.editingId);
  if(s && !state.removedDates.includes(s.date)) state.removedDates.push(s.date); // stop auto-populate resurrecting it
  state.shifts = state.shifts.filter(x => x.id !== state.editingId);
  save();
  renderAll(true);
  closeShiftModal();
}

// ── Settings ──
function openSettings(){
  document.getElementById('rateInput').value = state.hourlyRate > 0 ? state.hourlyRate.toFixed(2) : '';
  document.getElementById('fedPctInput').value = state.fedPct;
  document.getElementById('k401PctInput').value = state.k401Pct;
  pendingCrew = state.crew; pendingShiftType = state.shiftType;
  renderSegs();
  renderPreviewTable();
  document.getElementById('settingsModal').classList.add('open');
}

function renderSegs(){
  document.querySelectorAll('#crewSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === pendingCrew));
  document.querySelectorAll('#shiftSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === pendingShiftType));
}

function setCrew(c){ pendingCrew = c; renderSegs(); renderPreviewTable(); }
function setShiftType(t){ pendingShiftType = t; renderSegs(); renderPreviewTable(); }

function updateRulesText(){
  const day = state.shiftType === 'day';
  const e1 = document.getElementById('ruleHours');
  if(e1) e1.textContent = day ? '6 AM → 6 PM (12 hrs gross)' : '6 PM → 6 AM (12 hrs gross)';
  const e2 = document.getElementById('ruleRotation');
  if(e2) e2.textContent = `${state.crew} Crew ${day ? 'Days' : 'Nights'} — 4 ON / 4 OFF`;
  const e3 = document.getElementById('ruleDiff');
  if(e3) e3.textContent = day ? 'Nights only — no differential on day shift' : 'Flat 5% of base wage on worked hours';
}

function closeSettings(){ document.getElementById('settingsModal').classList.remove('open'); }

function saveSettings(){
  const rawRate = document.getElementById('rateInput').value.trim();
  const r = parseFloat(rawRate);
  const rateOk = !isNaN(r) && r > 0;
  // L4: don't silently ignore what the user typed
  if(rawRate !== '' && !rateOk){ alert('⚠️ Please enter a valid hourly rate.'); return; }
  if(rawRate === '' && state.hourlyRate > 0){
    if(!confirm('Rate field is empty — keep your current rate of $' + state.hourlyRate.toFixed(2) + '?')) return;
  }
  const fp = parseFloat(document.getElementById('fedPctInput').value);
  if(!isNaN(fp) && fp >= 0 && fp <= 60) state.fedPct = fp;
  const kp = parseFloat(document.getElementById('k401PctInput').value);
  if(!isNaN(kp) && kp >= 0 && kp <= 60) state.k401Pct = kp;
  const firstRate = rateOk && state.hourlyRate === 0;
  const crewChanged = pendingCrew !== state.crew || pendingShiftType !== state.shiftType;
  if(crewChanged && state.shifts.length > 0){
    const name = pendingCrew + ' Crew ' + (pendingShiftType === 'day' ? 'Days' : 'Nights');
    if(!confirm('Switch to ' + name + '? Upcoming auto-filled shifts will be rebuilt for the new schedule. Past shifts, unscheduled days, holidays and shifts with notes are kept.')) return;
    // Drop future auto-filled scheduled shifts; keep history and anything special
    const t = todayStr();
    state.shifts = state.shifts.filter(s => s.date < t || s.isUnscheduled || s.isHoliday || (s.note && s.note.trim()));
  }
  state.crew = pendingCrew;
  state.shiftType = pendingShiftType;
  if(rateOk) state.hourlyRate = r;
  if(state.hourlyRate > 0 && (firstRate || crewChanged)) autoPopulateCrewShifts(crewChanged && !firstRate);
  updateRulesText();
  save(); renderAll(true); closeSettings();
}

function renderPreviewTable(){
  const rate = parseFloat(document.getElementById('rateInput').value) || state.hourlyRate;
  const word = pendingShiftType === 'day' ? 'day' : 'night';
  const rows = [
    { label: `Standard ${word} (11.5h)`, shift: { paidHours: 11.5 } },
    { label: 'Unscheduled (11.5h)', shift: { paidHours: 11.5, isUnscheduled: true }, cls: 'text-purple' },
    { label: 'Holiday worked (11.5h)', shift: { paidHours: 11.5, isHoliday: true, holidayWorked: true }, style: 'color:#FFD700' },
    { label: 'Holiday not worked', shift: { paidHours: 0, isHoliday: true, holidayWorked: false }, style: 'color:#FFD700' },
  ];
  document.getElementById('previewTable').innerHTML = rows.map(r => {
    const pay = calcShiftPay(r.shift, rate, pendingShiftType).total;
    return `<div class="preview-row"><span class="preview-row-label">${r.label}</span><span class="preview-row-val ${r.cls || ''}" ${r.style ? `style="${r.style}"` : ''}>${fmt(pay)}</span></div>`;
  }).join('');
}

// ── Backup / restore ──
function exportData(){
  const backup = { version: 3, exportedAt: new Date().toISOString(), hourlyRate: state.hourlyRate, shifts: state.shifts, removedDates: state.removedDates, crew: state.crew, shiftType: state.shiftType, scheduleStart: state.scheduleStart, fedPct: state.fedPct, k401Pct: state.k401Pct };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `crownpay-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
}

function importData(event){
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const backup = JSON.parse(e.target.result);
      if(!backup.shifts || !Array.isArray(backup.shifts)){ alert('Invalid backup file.'); return; }
      const ds = backup.exportedAt ? new Date(backup.exportedAt).toLocaleDateString() : 'backup';
      if(!confirm(`Import ${backup.shifts.length} shifts from ${ds}? New shifts will be merged.`)) return;
      // Merge by DATE, not id — auto-populated shifts have different random ids
      // per device, so id-merging doubled every shift. One shift per date wins.
      const dates = new Set(state.shifts.map(s => s.date));
      let added = 0;
      backup.shifts.forEach(s => {
        if(s && s.date && !dates.has(s.date)){
          dates.add(s.date);
          if(s.isHoliday && s.holidayWorked === undefined) s.holidayWorked = true;
          state.shifts.push(s);
          added++;
        }
      });
      if(Array.isArray(backup.removedDates)){
        backup.removedDates.forEach(d => { if(!state.removedDates.includes(d)) state.removedDates.push(d); });
      }
      if(state.hourlyRate === 0 && backup.hourlyRate > 0) state.hourlyRate = backup.hourlyRate;
      if(backup.crew === 'A' || backup.crew === 'B') state.crew = backup.crew;
      if(backup.shiftType === 'night' || backup.shiftType === 'day') state.shiftType = backup.shiftType;
      if(backup.scheduleStart) state.scheduleStart = backup.scheduleStart;
      if(typeof backup.fedPct === 'number' && backup.fedPct >= 0 && backup.fedPct <= 60) state.fedPct = backup.fedPct;
      if(typeof backup.k401Pct === 'number' && backup.k401Pct >= 0 && backup.k401Pct <= 60) state.k401Pct = backup.k401Pct;
      updateRulesText();
      state.shifts.sort((a, b) => a.date < b.date ? -1 : 1);
      save(); renderAll(true); closeSettings();
      alert('✅ ' + added + ' new shifts imported.');
    } catch(err){ alert('Could not read file.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ── Paystub ──
function openPaystub(){ state.psWeek = 0; renderPaystub(); document.getElementById('paystubModal').classList.add('open'); }
function psNav(d){ state.psWeek += d; renderPaystub(); } // L5: browse past/future weeks
function closePaystub(){ document.getElementById('paystubModal').classList.remove('open'); }
function openPremiumBreakdown(){ renderPremiumBreakdown(); document.getElementById('premiumModal').classList.add('open'); }
function closePremiumBreakdown(){ document.getElementById('premiumModal').classList.remove('open'); }

function renderPremiumBreakdown(){
  const rate = state.hourlyRate;
  const thisWeekShifts = shiftsForWeekOffset(state.psWeek);

  let rows = '';
  let totalPremHrs = 0, totalPremAmt = 0;

  thisWeekShifts.forEach(s => {
    const pay = calcShiftPay(s, rate);
    if(pay.premHrs <= 0) return;
    const d = new Date(s.date + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    totalPremHrs += pay.premHrs;
    totalPremAmt += pay.premium;
    let type, color, bg;
    if(s.isHoliday){ type = '🎉 Holiday'; color = '#ff9900'; bg = '#fff8ee'; }
    else if(s.isUnscheduled){ type = '1.75× Day'; color = '#7b00cc'; bg = '#f9f0ff'; }
    else { type = '1.5× OT'; color = '#cc6600'; bg = '#fff8ee'; }
    rows += `
      <div class="ps-grid-row" style="grid-template-columns:1fr 1fr 1fr 1fr;background:${bg};">
        <div style="font-size:11px;font-weight:600;color:#111">${dateLabel}</div>
        <div style="font-size:10px;color:${color};text-align:center;font-weight:700">${type}</div>
        <div style="font-size:11px;font-family:'DM Mono',monospace;text-align:right;color:${color}">${pay.premHrs.toFixed(2)} hrs</div>
        <div style="font-size:11px;font-family:'DM Mono',monospace;text-align:right;color:${color}">$${pay.premium.toFixed(2)}</div>
      </div>`;
  });

  if(!rows){
    rows = '<div style="padding:24px;text-align:center;color:#888;font-size:14px;">No premium pay this week.</div>';
  }

  const html = `
    <div class="ps-wrap">
      <div class="ps-section-title">Premium Pay — How It Works</div>
      <div style="padding:10px 12px;background:#f7f5f0;border-bottom:1px solid #ccc;font-size:11px;color:#444;line-height:1.6">
        Crown pays all worked hours at your base rate first (REGULAR line).<br>
        PREMIUM is the <strong>extra portion</strong> added on top:<br>
        • OT hours (&gt;8/shift): <strong>+ 0.5× rate per hour</strong><br>
        • Unscheduled days: <strong>+ 0.75× rate per hour</strong><br>
        • Worked holidays: <strong>+ 0.5× rate per hour</strong> (plus flat ${HOLIDAY_FLAT_HRS}h HOLIDAY line)
      </div>

      <div class="ps-section-title">This Week's Premium Shifts</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;padding:6px 12px;background:#ebe9e4;border-bottom:1px solid #ccc;">
        <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase">Date</div>
        <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase;text-align:center">Type</div>
        <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase;text-align:right">Prem Hrs</div>
        <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase;text-align:right">Amount</div>
      </div>
      ${rows}
      <div class="ps-grid-row ps-ded-row total" style="grid-template-columns:1fr 1fr 1fr 1fr">
        <div style="grid-column:1/3;font-weight:800">Total Premium</div>
        <div style="font-family:'DM Mono',monospace;text-align:right;font-weight:800">${totalPremHrs.toFixed(2)} hrs</div>
        <div style="font-family:'DM Mono',monospace;text-align:right;font-weight:800">$${totalPremAmt.toFixed(2)}</div>
      </div>

      <div style="padding:10px 12px;background:#ebe9e4;border-top:1px solid #ccc;">
        <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase;margin-bottom:6px">Rate Used</div>
        <div style="font-size:13px;font-weight:800;color:#111;font-family:'DM Mono',monospace">$${rate.toFixed(4)} / hr</div>
      </div>
    </div>
  `;

  document.getElementById('premiumBody').innerHTML = html;
}

function renderPaystub(){
  const rate = state.hourlyRate;
  const thisWeekShifts = shiftsForWeekOffset(state.psWeek);

  let regHrs = 0, otH = 0, unscHrs = 0, holHrs = 0, holCount = 0;
  thisWeekShifts.forEach(s => {
    if(s.isHoliday){
      holCount++;                                       // flat 13.25h applies worked or not
      if(s.holidayWorked !== false) holHrs += s.paidHours;
    } else if(s.isUnscheduled){
      unscHrs += s.paidHours;
    } else {
      regHrs += Math.min(s.paidHours, 8);
      otH += Math.max(0, s.paidHours - 8);
    }
  });

  // REGULAR = all worked hours × base rate
  const totalWorkedHrs = regHrs + otH + unscHrs + holHrs;
  const regAmt = totalWorkedHrs * rate;

  // HOLIDAY = flat 13.25 hrs × rate per holiday (worked or not)
  const holFixedHrs = holCount * HOLIDAY_FLAT_HRS;
  const holAmt = holFixedHrs * rate;

  // PREMIUM = OT +0.5×, unscheduled +0.75×, worked holiday +0.5×
  const premiumHrsEquiv = (otH * 0.5) + (unscHrs * 0.75) + (holHrs * 0.5);
  const premiumAmt = premiumHrsEquiv * rate;

  // SHIFT DIFF = flat 5% of base wage on worked hours — NIGHTS ONLY (matches calcShiftPay)
  const shiftAmt = state.shiftType === 'night' ? totalWorkedHrs * rate * SHIFT_DIFF : 0;

  const gross = regAmt + holAmt + premiumAmt + shiftAmt;

  // Deductions (estimates based on Crown WA paystub)
  const k401Before  = gross * (state.k401Pct / 100);             // 401k pre-tax (set in Settings)
  const fedTax      = (gross - k401Before) * (state.fedPct / 100); // fed withholding (Settings), after pre-tax 401k
  const socSec      = gross * 0.062;                   // 6.2% (401k is still FICA-taxable)
  const medicare    = gross * 0.0145;                  // 1.45%
  const workersComp = gross * 0.00172;                 // ~0.17%
  const waFamLeave  = gross * 0.00807;                 // ~0.81% WA Paid Family Leave
  const waLTC       = gross * 0.00580;                 // ~0.58% WA Cares (LTC)
  const totalDed    = fedTax + socSec + medicare + workersComp + k401Before + waFamLeave + waLTC;
  const netPay      = gross - totalDed;

  const periodStart = addDays(getThisWeekMonday(), 7 * state.psWeek);
  const periodEnd = addDays(periodStart, 6);
  const fmtMD = d => d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
  const periodEndStr = periodEnd.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const weekTag = state.psWeek === 0 ? ' · current' : state.psWeek === -1 ? ' · last week' : state.psWeek > 0 ? ' · upcoming' : '';

  const fmtN = n => '$' + n.toFixed(2);

  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <button class="strip-nav-btn" onclick="psNav(-1)" title="Previous week">‹</button>
      <div style="font-size:12px;font-weight:700;color:var(--muted)">Week ${fmtMD(periodStart)} – ${periodEndStr}${weekTag}</div>
      <button class="strip-nav-btn" onclick="psNav(1)" title="Next week">›</button>
    </div>
    <div class="ps-wrap">

      <div class="ps-banner">
        <div class="ps-banner-title">👑 CROWN Cork &amp; Seal</div>
        <div class="ps-banner-sub">Estimated Paystub · ${periodEndStr}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;background:#f7f5f0;border-bottom:2px solid #333;">
        <div style="padding:10px 12px;border-right:1px solid #ccc">
          <div class="ps-label">Rate of Pay</div>
          <div class="ps-value" style="font-size:15px">$${rate.toFixed(4)}</div>
        </div>
        <div style="padding:10px 12px;border-right:1px solid #ccc;text-align:center">
          <div class="ps-label">Total Hrs</div>
          <div class="ps-value" style="font-size:15px">${(totalWorkedHrs + holFixedHrs).toFixed(2)}</div>
        </div>
        <div style="padding:10px 12px;text-align:right">
          <div class="ps-label">Gross Pay</div>
          <div class="ps-value" style="font-size:15px;color:#1a4a1a">${fmtN(gross)}</div>
        </div>
      </div>

      <div class="ps-section-title">Shift Hours This Week</div>
      <div style="display:grid;grid-template-columns:repeat(${holCount > 0 ? 4 : (unscHrs > 0 ? 3 : 2)},1fr);background:#f7f5f0;border-bottom:2px solid #333;">
        <div style="padding:8px 12px;border-right:1px solid #ccc">
          <div class="ps-label">Scheduled</div>
          <div style="font-size:16px;font-weight:800;color:#111;font-family:'DM Mono',monospace">${(regHrs + otH).toFixed(1)}h</div>
          <div style="font-size:9px;color:#888">${regHrs.toFixed(1)} reg + ${otH.toFixed(1)} OT</div>
        </div>
        ${unscHrs > 0 ? `<div style="padding:8px 12px;border-right:1px solid #ccc">
          <div class="ps-label" style="color:#7b00cc">Unscheduled</div>
          <div style="font-size:16px;font-weight:800;color:#7b00cc;font-family:'DM Mono',monospace">${unscHrs.toFixed(1)}h</div>
          <div style="font-size:9px;color:#888">1.75× rate</div>
        </div>` : ''}
        ${holCount > 0 ? `<div style="padding:8px 12px;border-right:1px solid #ccc">
          <div class="ps-label" style="color:#ff9900">Holiday</div>
          <div style="font-size:16px;font-weight:800;color:#ff9900;font-family:'DM Mono',monospace">${holHrs.toFixed(1)}h</div>
          <div style="font-size:9px;color:#888">worked + ${HOLIDAY_FLAT_HRS} fixed</div>
        </div>` : ''}
        <div style="padding:8px 12px;text-align:right">
          <div class="ps-label">Paid Hours</div>
          <div style="font-size:16px;font-weight:800;color:#1a4a1a;font-family:'DM Mono',monospace">${totalWorkedHrs.toFixed(1)}h</div>
          <div style="font-size:9px;color:#888">excl. break</div>
        </div>
      </div>

      <div class="ps-section-title">Earnings</div>
      <div class="ps-grid-header ps-earn-header">
        <div>Description</div>
        <div class="ps-numeric">Hours</div>
        <div class="ps-numeric">Amount</div>
      </div>
      <div class="ps-grid-row ps-earn-row">
        <div>REGULAR</div>
        <div class="ps-numeric">${totalWorkedHrs.toFixed(2)}</div>
        <div class="ps-numeric">${fmtN(regAmt)}</div>
      </div>
      ${holFixedHrs > 0 ? `<div class="ps-grid-row ps-earn-row" style="background:#fffaf0">
        <div style="color:#b8860b;font-weight:800">HOLIDAY</div>
        <div class="ps-numeric" style="color:#b8860b">${holFixedHrs.toFixed(2)}</div>
        <div class="ps-numeric" style="color:#b8860b">${fmtN(holAmt)}</div>
      </div>` : ''}
      ${premiumHrsEquiv > 0 ? `
      <div class="ps-grid-row ps-earn-row" onclick="openPremiumBreakdown()" style="cursor:pointer;background:#fffdf5">
        <div style="display:flex;align-items:center;gap:4px">
          PREMIUM
          <span style="font-size:9px;background:#e6a800;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700">Details ›</span>
        </div>
        <div class="ps-numeric">${premiumHrsEquiv.toFixed(2)}</div>
        <div class="ps-numeric">${fmtN(premiumAmt)}</div>
      </div>` : ''}
      ${shiftAmt > 0 ? `<div class="ps-grid-row ps-earn-row">
        <div>SHIFT DIFF (5%)</div>
        <div class="ps-numeric">—</div>
        <div class="ps-numeric">${fmtN(shiftAmt)}</div>
      </div>` : ''}
      <div class="ps-grid-row ps-earn-row total">
        <div>Gross Total</div>
        <div class="ps-numeric">${(totalWorkedHrs + holFixedHrs).toFixed(2)}</div>
        <div class="ps-numeric">${fmtN(gross)}</div>
      </div>

      <div class="ps-section-title">Deductions (Estimates)</div>
      <div class="ps-grid-header ps-ded-header">
        <div>Description</div>
        <div class="ps-numeric">Amount</div>
      </div>
      <div class="ps-grid-row ps-ded-row"><div>FED INCOME TAX (${state.fedPct}%)</div><div class="ps-numeric">${fmtN(fedTax)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>SOC SEC</div><div class="ps-numeric">${fmtN(socSec)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>MEDICARE</div><div class="ps-numeric">${fmtN(medicare)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>WORKERS COMP</div><div class="ps-numeric">${fmtN(workersComp)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>401K BEFORE TAX (${state.k401Pct}%)</div><div class="ps-numeric">${fmtN(k401Before)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>WA FAMILY LEAVE</div><div class="ps-numeric">${fmtN(waFamLeave)}</div></div>
      <div class="ps-grid-row ps-ded-row"><div>WA LTC</div><div class="ps-numeric">${fmtN(waLTC)}</div></div>
      <div class="ps-grid-row ps-ded-row total"><div>Total Deductions</div><div class="ps-numeric">${fmtN(totalDed)}</div></div>

      <div class="ps-net-pay">
        <div class="ps-net-pay-label">ESTIMATED NET PAY</div>
        <div class="ps-net-pay-amount">${fmtN(netPay)}</div>
      </div>

      <div class="ps-note">
        Estimate only · WA Crown rates · Excludes union dues, 401k loans, LTD
      </div>
    </div>
  `;

  document.getElementById('paystubBody').innerHTML = html;
}

// ── Reset ──
function resetAllData(){
  if(!confirm('Reset everything? This deletes all shifts and your hourly rate. Cannot be undone.')) return;
  state.shifts = []; state.hourlyRate = 0; state.removedDates = []; state.scheduleStart = null;
  state.fedPct = 13; state.k401Pct = 2;
  localStorage.removeItem('crownpay_shifts');
  localStorage.removeItem('crownpay_rate');
  localStorage.removeItem('crownpay_removed');
  localStorage.removeItem('crownpay_schedstart');
  localStorage.removeItem('crownpay_fedpct');
  localStorage.removeItem('crownpay_401kpct');
  renderAll(); closeSettings();
}

// ── Event wiring ──
document.getElementById('periodTabs').addEventListener('click', e => {
  const tab = e.target.closest('.period-tab');
  if(!tab) return;
  document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  state.prevPeriod = state.period;
  state.period = tab.dataset.period;
  if(state.period === 'month'){ state.calMonth = new Date().getMonth(); state.calYear = new Date().getFullYear(); }
  renderSummary(); renderSchedule(); renderShifts();
});

['shiftDate','shiftStart','shiftEnd'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    if(id === 'shiftDate') updateCrewIndicator();
    updateShiftPreview();
  });
});

document.getElementById('rateInput').addEventListener('input', renderPreviewTable);

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.classList.remove('open'); });
});

// ── Boot ──
load();
updateRulesText();
if(state.hourlyRate > 0){ autoPopulateCrewShifts(); save(); }
renderAll();
