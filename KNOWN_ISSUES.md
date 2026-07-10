# CrownPay — Known Issues

Compiled July 10, 2026 from simulated QA: two rounds of 10 test users each ran through a
full pay period against the exact deployed code (verified byte-identical to the GitHub blob).

## Status after Round 2 (10 new employees: Priya, Marcus, Jen, Carlos, Aisha, Denny, Lena, Omar, Grace, Victor)

**FIXED and re-verified:**
- ✅ H1 — Crew switch no longer fabricates history (0 backfilled shifts, was 96), and stays clean after reloads (Round 2 found the reload leak; also fixed)
- ✅ M1 — Moving a shift's date no longer lets auto-fill resurrect the original night
- ✅ M2/L3 — 0-hour and sub-30-minute shifts are rejected with a warning (unworked holidays still save correctly)
- ✅ NEW (Round 2, Aisha) — Paystub was still adding the 5% differential for day-shift crews while the summary correctly didn't ($1,431 vs $1,493.10); paystub now matches to the penny and hides the SHIFT DIFF line on days

**Still open (low, by design or cosmetic):** L1 (projection totals unlabeled), L2 (old-crew
history on "off" days), L4 (clearing rate silently keeps old rate), L5 (no past-week paystub),
L6 (deductions are estimates).

---

Original Round 1 report follows.

## Test subjects

| # | Persona | Scenario |
|---|---------|----------|
| 1 | Nora | Brand-new user; fat-fingers a shift before setting her rate |
| 2 | Steve | Standard A-Crew nights; checks summary vs. paystub math |
| 3 | Bella | Switches from A-Crew Nights to B-Crew Days mid-year |
| 4 | Hank | Works one holiday, takes another off (flat 13.25h) |
| 5 | Dana | Deletes a scheduled night, later re-adds it |
| 6 | Ivan | Exports a backup, imports it on a second device |
| 7 | Eddie | Hostile input: script tags in notes, 15-minute shifts |
| 8 | Olivia | Held over: 18:00–08:00 shift (5.5h OT) |
| 9 | Tom | Flips between Week/Last/Month/Year tabs comparing totals |
| 10 | Rita | Moves a shift to a different date; clears her rate field |

## Issues found

### HIGH

**H1. Switching crews fabricates a year of history** (Bella)
Changing Crew/Shift in Settings rebuilds the schedule from Jan 1, so it backfills every
past date the *new* crew was scheduled — on top of the old crew's real history. In testing,
switching A-Nights → B-Days added 96 fake past shifts and inflated "This Year" from
$65,574 to $112,190.
*Fix: when the rebuild is triggered by a crew change, only auto-fill from today forward.*

### MEDIUM

**M1. Moving a shift's date double-counts the original night** (Rita)
Editing a shift's date (e.g. Jul 12 → Jul 13) leaves the original date unprotected, so
auto-populate refills Jul 12 on the next launch and the week gains a shift.
*Fix: when an edit changes the date, add the old date to the removed-dates list.*

**M2. Zero-hour shifts save silently** (Nora)
A shift with identical start/end times saves as 0 paid hours / $0 with no warning, and
because the date is now "taken," auto-populate won't fill that scheduled night — it quietly
stays at $0 until manually fixed.
*Fix: block save (or warn) when paid hours computes to 0.*

### LOW

**L1. Month/Year totals include future shifts with no label** (Tom)
"This Month" and "This Year" include upcoming auto-filled shifts (26 at test time). It's a
useful projection, but nothing on screen says "projected" — could be mistaken for money
already earned.

**L2. Old-crew history renders on "off" days after a switch** (Bella)
Past shifts from the previous crew are correctly kept, but the calendar paints those dates
as off-days for the new crew, which looks contradictory. Cosmetic.

**L3. Sub-30-minute shifts save as 0 paid hours** (Eddie)
A 15-minute entry nets 0h after the break deduction and saves without warning. Same fix as M2.

**L4. Clearing the rate field silently keeps the old rate** (Rita)
Blanking the rate and hitting Save gives no feedback and keeps the previous rate. There's no
way to unset the rate short of Reset Everything. Minor UX.

**L5. Paystub only shows the current week**
No way to view last week's (or any past week's) paystub estimate for checking against a real
stub that arrives later. Feature gap, not a bug.

**L6. Deductions are rough estimates**
Federal tax is a flat 13% of (gross − 401k) with no brackets/filing status; other rates are
fixed percentages. Net pay is directionally right, not exact. Documented limitation.

## Verified working (no issues found)

- Summary "Est. Gross Pay" matches paystub gross to the penny ($2,167.76 = $2,167.76)
- Worked holiday: 11.5h reg + 5.75h premium + 13.25h flat, +5% diff — correct at all rates tested
- Unworked holiday: flat 13.25h only, no differential
- Deleted shifts stay deleted across reloads; re-adding works once
- Holiday-marked shifts no longer duplicate on reload
- Backup import on a second device: 0 duplicates
- Script/HTML in notes is escaped (no XSS)
- 18:00→08:00 shift: 13.5 paid hrs, 5.5h OT, pay exact
- This Week never exceeds This Month; OT stat correct
- B-Crew day-shift pay correctly drops the 5% night differential
