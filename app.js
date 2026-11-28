// Family Board phone app — P1: sign in, board, notes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://nczdujvoooyvckectjue.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_apPREG2GuNpBozWZcG8BCQ_P1OYtx-O"; // public by design; data is protected by sign-in rules
const db = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysUntil = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(localISO() + "T12:00:00")) / 86400000);
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

let me = null;        // auth user
let member = null;    // members row
let people = {};      // id -> member

// ---------- auth ----------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErr").textContent = "";
  const { error } = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) $("loginErr").textContent = error.message === "Invalid login credentials" ? "That email or password didn't work." : error.message;
});
$("signOut").addEventListener("click", () => db.auth.signOut());

db.auth.onAuthStateChange((_evt, session) => {
  if (session?.user) start(session.user); else showLogin();
});

function showLogin() {
  me = null;
  $("setpw").classList.add("hidden");
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

async function start(user) {
  if (me?.id === user.id) return;
  me = user;
  const { data: rows } = await db.from("members").select("id,display_name,color,role,cashtag,bill_manager,avatar_path,must_change_password,phone,linked_with").order("created_at");
  people = Object.fromEntries((rows || []).map((r) => [r.id, r]));
  member = people[user.id];
  if (member?.role === "display") {
    await db.auth.signOut();
    $("loginErr").textContent = "That's the TV's account. Sign in with your own.";
    return;
  }
  $("login").classList.add("hidden");
  if (member?.must_change_password) {
    $("setpw").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }
  $("setpw").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("hello").textContent = `Hi, ${member?.display_name ?? "there"}`;
  $("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  await paintAvatar($("me"), member);
  fillProfile();
  paintPush().catch(() => {});
  paintCal().catch(() => {});
  paintLinks();
  $("meEmail").textContent = user.email;
  $("meRole").textContent = member?.role === "admin" ? "Admin" : member?.bill_manager ? "Bill manager" : "Family member";
  fillNoteTo();
  loadBoard();
  loadNotes();
}

// ---------- first sign-in password (P4) ----------
$("setpwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("setpwErr").textContent = "";
  const a = $("newpw1").value, b = $("newpw2").value;
  if (a.length < 8) return ($("setpwErr").textContent = "Use at least 8 characters.");
  if (a !== b) return ($("setpwErr").textContent = "Those two don't match.");
  const { error } = await db.auth.updateUser({ password: a });
  if (error) return ($("setpwErr").textContent = error.message.includes("different") ? "Pick a password different from the temporary one." : "Couldn't save: " + error.message);
  await db.from("members").update({ must_change_password: false }).eq("id", me.id);
  member.must_change_password = false;
  $("newpw1").value = ""; $("newpw2").value = "";
  const u = me; me = null; start(u);
});

// ---------- tabs ----------
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    ["board", "bills", "notes", "me"].forEach((t) => $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    if (b.dataset.tab === "board") loadBoard();
    if (b.dataset.tab === "notes") loadNotes();
    if (b.dataset.tab === "bills") loadBills();
  })
);
$("me").addEventListener("click", () => document.querySelector('nav button[data-tab="me"]').click());

// ---------- board ----------
async function loadBoard() {
  const today = localISO();
  const monthStart = today.slice(0, 8) + "01";
  const n = new Date(); const next = new Date(n.getFullYear(), n.getMonth() + 1, 1);
  const nextMonth = localISO(next);
  const in7 = localISO(new Date(Date.now() + 7 * 86400000));
  // P20: your bills = everything unpaid due in the next 30 days (past due included) + what you paid in the last 30 days
  const in30 = localISO(new Date(Date.now() + 30 * 86400000));
  const ago30 = localISO(new Date(Date.now() - 30 * 86400000));
  const windowFilter = `paid.eq.false,due_date.gte.${ago30}`;

  const [shares, mine, toConfirm, events] = await Promise.all([
    db.from("bill_share_amounts").select("id,bill_id,bill_name,bill_amount,share_amount,paid,paid_method,confirmed,due_date,member_id").eq("member_id", me.id)
      .lte("due_date", in30).or(windowFilter).order("due_date"),
    db.from("bills").select("id,name,amount,due_date,paid,show_on_board,logo_url,website,repeat_kind,repeat_days,full_images,admin_id,pay_url,account_number,autopay,pay_note").eq("owner_id", me.id)
      .lte("due_date", in30).or(windowFilter).order("due_date"),
    canManage()
      ? db.from("bill_share_amounts").select("id,bill_name,share_amount,paid_method,paid_on,due_date,member_id").eq("paid", true).eq("confirmed", false).neq("member_id", me.id).order("due_date")
      : Promise.resolve({ data: [] }),
    db.from("events").select("id,title,kind,starts_at,ends_at,all_day,member_id,notes,source").lte("starts_at", in7 + "T23:59:59")
      .or(`starts_at.gte.${today},ends_at.gte.${today}`).order("starts_at").limit(30),
  ]);
  const { data: others } = await db.from("bills").select("id,name,amount,due_date,owner_id,admin_id,logo_url,website,full_images,pay_url,account_number,autopay,pay_note")
    .not("owner_id", "is", null).neq("owner_id", me.id).eq("paid", false).lte("due_date", in7).order("due_date");
  helpBills = (others || []).filter((b) => people[b.owner_id]);
  // logos + repeat info for the household bills behind my shares
  const billIds = [...new Set((shares.data || []).map((s) => s.bill_id))];
  const { data: shareBills } = billIds.length
    ? await db.from("bills").select("id,logo_url,website,repeat_kind,repeat_days,full_images,admin_id,pay_url,account_number,autopay,pay_note").in("id", billIds)
    : { data: [] };
  const billInfo = Object.fromEntries((shareBills || []).map((b) => [b.id, b]));

  const waiting = toConfirm.data || [];
  const items = [
    ...(shares.data || []).map((s) => ({ shareId: s.id, billId: s.bill_id, name: s.bill_name, amount: Number(s.share_amount), billAmount: Number(s.bill_amount),
      paid: s.paid, method: s.paid_method, confirmed: s.confirmed, due: s.due_date, kind: "household", info: billInfo[s.bill_id] || {} })),
    ...(mine.data || []).map((b) => ({ personalId: b.id, bill: b, name: b.name, amount: Number(b.amount), paid: b.paid, due: b.due_date,
      kind: b.show_on_board ? "personal" : "private", info: b })),
  ].sort((a, b) => a.due.localeCompare(b.due));
  const open = items.filter((i) => !i.paid);
  const left = open.reduce((t, i) => t + i.amount, 0);
  const late = open.filter((i) => daysUntil(i.due) < 0).reduce((t, i) => t + i.amount, 0);

  let html = `<div class="tiles">
      <div class="tile"><div class="sub">Left to pay · next 30 days</div><div class="tnum">${money(left)}</div></div>
      <div class="tile ${late ? "tile-late" : ""}"><div class="sub">${late ? "Past due" : "Past due"}</div><div class="tnum">${money(late)}</div></div>
    </div>`;

  // ---- wallet: my unpaid bills as stacked cards, oldest first ----
  // P34: late + current copies of the same bill share one card (oldest first, total owed)
  const groupsByKey = {};
  for (const i of open) (groupsByKey[groupKey(i)] ??= []).push(i);
  const heads = Object.values(groupsByKey).map((g) => { g.sort((a, b) => a.due.localeCompare(b.due)); g[0].group = g; return g[0]; })
    .sort((a, b) => a.due.localeCompare(b.due));
  const cards = heads.slice(0, 8).reverse(); // most urgent ends up in front
  if (cards.length) {
    const step = 58, h = 176;
    html += `<div class="wallet" style="height:${(cards.length - 1) * step + h}px">` + cards.map((i, k) => walletCard(i, k, step)).join("") + `</div>`;
    html += `<p class="sub center">Tap a card to bring it forward. Tap it again to pay or mark it paid.</p>`;
    if (heads.length > cards.length) html += `<p class="sub center">+ ${heads.length - cards.length} more on the Bills tab</p>`;
  } else {
    html += `<div class="card center" style="padding:26px 16px"><div class="big" style="font-size:22px">All paid up ✓</div><div class="sub">Nothing due in the next 30 days.</div></div>`;
  }
  const paidItems = items.filter((i) => i.paid);
  if (paidItems.length) html += `<details class="paidlist"><summary class="sub">Paid in the last 30 days (${paidItems.length})</summary>${paidItems.map(itemRow).join("")}</details>`;

  if (waiting.length) {
    html += `<h2>Waiting for you to confirm</h2>`;
    html += waiting.map((w) => {
      const p = people[w.member_id];
      return `<div class="card row"><div class="grow"><div class="name">${esc(p?.display_name ?? "Someone")} · ${esc(w.bill_name)}</div>
        <div class="sub">${money(w.share_amount)} · ${esc(methodLabel(w.paid_method))}${w.paid_on ? " · " + fmtDate(w.paid_on) : ""}</div></div>
        <button class="btn" data-confirm="${w.id}" style="width:auto;min-height:44px;margin:0;padding:0 18px">Confirm ✓</button></div>`;
    }).join("");
  }

  if (helpBills.length) {
    html += `<h2>Could use a hand</h2>`;
    html += helpBills.map((b) => {
      const d = daysUntil(b.due_date);
      const who = people[b.owner_id];
      const when = d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "due today" : `due in ${d} day${d === 1 ? "" : "s"}`;
      return `<div class="card row" data-help="${b.id}" style="cursor:pointer">${logoTile(b)}
        <div class="grow"><div class="name">${esc(who.display_name)} · ${esc(b.name)}</div>
        <div class="sub ${d < 0 ? "late" : "soon"}">${when}</div></div><div class="amt">${money(b.amount)}</div></div>`;
    }).join("");
  }
  html += weekStrip(events.data || [], open, today);

  html += `<h2 class="row" style="justify-content:space-between">Family photos <span><a href="#" data-allph="1" class="hlink" style="margin-right:14px">See all</a><a href="#" data-addph="1" class="hlink">+ Add</a></span></h2>
    <div id="homePhotos" class="phgrid"><div class="sub">Loading photos…</div></div>`;

  $("tab-board").innerHTML = html;
  boardItems = items;
  walletFront = null;
  fillHomePhotos();
}

// ---- wallet cards (P12) ----
let walletFront = null;
const CARD_COLORS = [["#0C447C", "#E6F1FB", "#B5D4F4"], ["#2C2C2A", "#F1EFE8", "#B4B2A9"], ["#085041", "#E1F5EE", "#9FE1CB"],
  ["#3C3489", "#EEEDFE", "#CECBF6"], ["#633806", "#FAEEDA", "#FAC775"], ["#72243E", "#FBEAF0", "#F4C0D1"]];
function cardColors(i) {
  if (daysUntil(i.due) < 0) return ["#A32D2D", "#FCEBEB", "#F7C1C1"];
  let h = 0; for (const c of i.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CARD_COLORS[h % CARD_COLORS.length];
}
// P34: same bill = same name (and same owner for personal bills)
function groupKey(i) {
  return (i.kind === "household" ? "h:" : "p:" + (i.bill?.owner_id ?? me.id) + ":") + String(i.name || "").trim().toLowerCase();
}
function walletCard(i, k, step) {
  const [bg, fg, soft] = cardColors(i);
  const key = i.shareId ? "s:" + i.shareId : "p:" + i.personalId;
  const logo = i.info.logo_url
    ? `<div class="wlogo" style="background-image:url('${esc(i.info.logo_url)}')"></div>`
    : `<div class="wlogo" style="background-color:${fg};color:${bg}">${esc(i.name.slice(0, 1).toUpperCase())}</div>`;
  const sub = [i.kind === "household" ? "Household" : i.kind === "private" ? "🔒 Private" : "Personal", repeatLabel(i.info), i.info?.autopay ? "Autopay" : ""].filter(Boolean).join(" · ");
  const many = i.group && i.group.length > 1;
  let pill = i.kind === "household" ? `Bill ${money(i.billAmount)}` : "Tap to mark paid";
  if (many) pill = `${i.group.length} unpaid · total ${money(i.group.reduce((t, x) => t + x.amount, 0))}`;
  return `<div class="wcard" data-card="${key}" style="top:${k * step}px;z-index:${k + 1};background:${bg};color:${fg}">
    <div class="row">${logo}<div class="grow"><div class="name">${esc(i.name)}</div><div style="font-size:12px;color:${soft}">${esc(sub)}</div></div></div>
    <div class="wamt">${money(many ? i.group.reduce((t, x) => t + x.amount, 0) : i.amount)}${i.kind === "household" ? `<span style="font-size:12px;font-weight:600;color:${soft}"> ${many ? "you owe" : "your share"}</span>` : ""}</div>
    <div class="row" style="justify-content:space-between;margin-top:6px"><span style="font-size:13px">${esc(dueLabel(i.due))}</span>
      <span class="wpill" style="background:${fg};color:${bg}">${esc(pill)}</span></div></div>`;
}
function bringForward(el) {
  const cardsEls = [...document.querySelectorAll("#tab-board .wcard")];
  const step = 58;
  const order = cardsEls.filter((c) => c !== el).concat(el);
  order.forEach((c, pos) => { c.style.top = pos * step + "px"; c.style.zIndex = pos + 1; });
  walletFront = el.dataset.card;
}

// ---- this week (P12): events + my due dates ----
function weekStrip(events, open, today) {
  const days = [...Array(7)].map((_, k) => localISO(new Date(new Date(today + "T12:00:00").getTime() + k * 86400000)));
  const evDay = (e) => localISO(new Date(e.starts_at));
  const evEnd = (e) => localISO(new Date(e.ends_at || e.starts_at));
  const list = [];
  for (const e of events) {
    if (evEnd(e) < today) continue;
    const p = people[e.member_id];
    const when = e.all_day ? fmtShort(evDay(e)) : fmtShort(evDay(e)) + " " + new Date(e.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").toLowerCase();
    list.push({ day: evDay(e) < today ? today : evDay(e), color: p?.color ?? "#8A919E", ev: e,
      text: `${p?.display_name ?? "Someone"}${e.kind === "away" ? " away" : ""} · ${e.title}`, when });
  }
  for (const i of open) if (i.due >= today && i.due <= days[6]) list.push({ day: i.due, color: "#F2C14E", text: `${i.name} due`, when: fmtShort(i.due), billId: i.billId || i.personalId });
  list.sort((a, b) => a.day.localeCompare(b.day));
  weekEvents = list.filter((x) => x.ev).map((x) => x.ev);
  let h = `<h2 class="row" style="justify-content:space-between">This week <span><a href="#" data-allev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600;margin-right:14px">See all</a><a href="#" data-addev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600">+ Add</a></span></h2><div class="card"><div class="week">` + days.map((d) => {
    const dots = [...new Set(list.filter((x) => x.day === d).map((x) => x.color))].slice(0, 3);
    return `<div class="wday ${d === today ? "on" : ""}" data-day="${d}" style="cursor:pointer"><div class="sub">${new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" })}</div>
      <div class="wnum">${Number(d.slice(8))}</div><div class="wdots">${dots.map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</div></div>`;
  }).join("") + `</div>`;
  h += list.length
    ? list.slice(0, 6).map((x) => `<div class="wev" ${x.ev ? `data-ev="${x.ev.id}" style="cursor:pointer"` : x.billId ? `data-billid="${x.billId}" style="cursor:pointer"` : ""}><i style="background:${esc(x.color)}"></i><span class="sub" style="width:74px;margin:0">${esc(x.when)}</span><span>${esc(x.text)}</span></div>`).join("")
    : `<div class="sub" style="margin-top:10px">Nothing on the calendar this week.</div>`;
  return h + `</div>`;
}
// ---------- calendar events and away times (P13) ----------
let weekEvents = [];
const canEditEvent = (e) => !e.id || (e.source !== "phone" && (e.member_id === me.id || member?.role === "admin"));
const timeOf = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function openEvent(e) {
  const isNew = !e.id;
  const mineOnly = member?.role !== "admin";
  const who = e.member_id ?? me.id;
  const start = e.starts_at ? localISO(new Date(e.starts_at)) : localISO();
  const end = e.ends_at ? localISO(new Date(e.ends_at)) : "";
  const allDay = isNew ? true : !!e.all_day;
  const fam = familyList().filter((p) => !mineOnly || p.id === me.id);
  let h = `<h2>${isNew ? "Add to the calendar" : "Edit calendar entry"}</h2><div class="card">
    <label style="margin-top:0">Who</label>
    <select id="evWho" ${fam.length < 2 ? "disabled" : ""}>${fam.map((p) => `<option value="${p.id}" ${p.id === who ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select>
    <label>What kind</label>
    <select id="evKind"><option value="event">Event or appointment</option><option value="away" ${e.kind === "away" ? "selected" : ""}>Away (trip, work, out of town)</option></select>
    <label for="evTitle">What</label>
    <input id="evTitle" maxlength="60" placeholder="Dentist, hunting trip, work trip…" value="${esc(e.title ?? "")}">
    <div class="check"><input type="checkbox" id="evAllDay" ${allDay ? "checked" : ""}><label for="evAllDay" style="margin:0;color:var(--text)">All day</label></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div><label for="evStart">Starts</label><input id="evStart" type="date" value="${start}"></div>
      <div class="evTime"><label for="evStartT">Time</label><input id="evStartT" type="time" value="${e.starts_at && !e.all_day ? timeOf(e.starts_at) : "09:00"}"></div>
      <div><label for="evEnd">Ends (optional)</label><input id="evEnd" type="date" value="${end}"></div>
      <div class="evTime"><label for="evEndT">Time</label><input id="evEndT" type="time" value="${e.ends_at && !e.all_day ? timeOf(e.ends_at) : ""}"></div>
    </div>
    <label for="evNotes">Notes (optional)</label>
    <input id="evNotes" maxlength="200" value="${esc(e.notes ?? "")}">
    <button class="btn" id="evSave">Save</button>
    <button class="btn ghost" id="evBack">Cancel</button>
    ${isNew ? "" : `<button class="btn ghost" id="evDel" style="color:var(--red)">Delete</button>`}
    <div class="err" id="evErr"></div></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  const showTimes = () => document.querySelectorAll(".evTime").forEach((el) => el.classList.toggle("hidden", $("evAllDay").checked));
  $("evAllDay").addEventListener("change", showTimes); showTimes();
  $("evBack").addEventListener("click", loadBoard);
  $("evDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete "${e.title}"?`)) return;
    const { error } = await db.from("events").delete().eq("id", e.id);
    if (error) return ($("evErr").textContent = "Couldn't delete: " + error.message);
    loadBoard();
  });
  $("evSave").addEventListener("click", async () => {
    $("evErr").textContent = "";
    const title = $("evTitle").value.trim();
    const sd = $("evStart").value, ed = $("evEnd").value, all = $("evAllDay").checked;
    if (!title) return ($("evErr").textContent = "Say what it is, like Dentist or Work trip.");
    if (!sd) return ($("evErr").textContent = "Pick the start date.");
    if (ed && ed < sd) return ($("evErr").textContent = "The end date is before the start date.");
    const startsAt = new Date(`${sd}T${all ? "00:00" : $("evStartT").value || "09:00"}`);
    let endsAt = null;
    if (ed || (!all && $("evEndT").value)) endsAt = new Date(`${ed || sd}T${all ? "23:59" : $("evEndT").value || "23:59"}`);
    if (endsAt && endsAt < startsAt) return ($("evErr").textContent = "It ends before it starts.");
    const fields = { member_id: $("evWho").value, kind: $("evKind").value, title, all_day: all,
      starts_at: startsAt.toISOString(), ends_at: endsAt ? endsAt.toISOString() : null, notes: $("evNotes").value.trim() || null };
    const { error } = isNew ? await db.from("events").insert(fields) : await db.from("events").update(fields).eq("id", e.id);
    if (error) return ($("evErr").textContent = "Couldn't save: " + error.message);
    loadBoard();
  });
}

// ---------- month calendar (P22) ----------
function addDaysISO(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return localISO(d); }
async function openMonth(monthIso, pickDay) {
  const first = new Date(monthIso + "T12:00:00");
  const gridStart = addDaysISO(monthIso, -first.getDay());
  const gridEnd = addDaysISO(gridStart, 41);
  const prev = localISO(new Date(first.getFullYear(), first.getMonth() - 1, 1, 12));
  const next = localISO(new Date(first.getFullYear(), first.getMonth() + 1, 1, 12));
  const today = localISO();
  const sel = pickDay || (today.slice(0, 7) === monthIso.slice(0, 7) ? today : monthIso);
  $("tab-board").innerHTML = `<div class="sub center" style="padding:30px">Loading the calendar…</div>`;
  const [ev, bl] = await Promise.all([
    db.from("events").select("id,title,kind,starts_at,ends_at,all_day,member_id,notes,source").lte("starts_at", gridEnd + "T23:59:59")
      .or(`starts_at.gte.${gridStart},ends_at.gte.${gridStart}`).order("starts_at").limit(500),
    db.from("bills").select("id,name,amount,due_date,paid,owner_id,logo_url").gte("due_date", gridStart).lte("due_date", gridEnd).order("due_date"),
  ]);
  const byDay = {};
  const put = (d, kind, x) => ((byDay[d] ??= { ev: [], bl: [] })[kind].push(x));
  for (const e of ev.data || []) {
    let d = localISO(new Date(e.starts_at));
    const end = e.ends_at ? localISO(new Date(e.ends_at)) : d;
    for (let n = 0; d <= end && n < 62; n++, d = addDaysISO(d, 1)) put(d, "ev", e);
  }
  for (const b of bl.data || []) put(b.due_date, "bl", b);
  weekEvents = ev.data || [];

  const title = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  let h = `<div class="row" style="justify-content:space-between;margin-top:10px">
      <button class="btn ghost" data-mnav="${prev}" style="width:auto;min-height:40px;margin:0;padding:0 14px">‹</button>
      <h2 style="margin:0">${esc(title)}</h2>
      <button class="btn ghost" data-mnav="${next}" style="width:auto;min-height:40px;margin:0;padding:0 14px">›</button></div>
    <div class="mcal">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="mhead">${x}</div>`).join("")}`;
  for (let i = 0; i < 42; i++) {
    const d = addDaysISO(gridStart, i);
    const it = byDay[d] || { ev: [], bl: [] };
    const dots = [...new Set(it.ev.map((e) => people[e.member_id]?.color ?? "#8A919E"))].slice(0, 3)
      .map((c) => `<i style="background:${esc(c)}"></i>`).join("") + (it.bl.some((b) => !b.paid) ? `<i style="background:#F2C14E"></i>` : "");
    h += `<div class="mday${d.slice(0, 7) !== monthIso.slice(0, 7) ? " out" : ""}${d === today ? " today" : ""}${d === sel ? " sel" : ""}" data-day="${d}">
      <div>${Number(d.slice(8))}</div><div class="wdots">${dots}</div></div>`;
  }
  h += `</div>`;

  // the picked day
  const it = byDay[sel] || { ev: [], bl: [] };
  h += `<h2 class="row" style="justify-content:space-between">${esc(fmtDate(sel))} <a href="#" data-addon="${sel}" class="hlink">+ Add</a></h2><div class="card">`;
  h += it.ev.length ? it.ev.map((e) => {
    const p = people[e.member_id];
    const time = e.all_day ? "All day" : new Date(e.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `<div class="wev" ${canEditEvent(e) || e.source === "phone" ? `data-ev="${e.id}" style="cursor:pointer"` : ""}><i style="background:${esc(p?.color ?? "#8A919E")}"></i>
      <span class="sub" style="width:74px;margin:0">${esc(time)}</span><span>${esc(p?.display_name ?? "Someone")}${e.kind === "away" ? " away" : ""} · ${esc(e.title)}${e.notes ? `<span class="sub"> · ${esc(e.notes)}</span>` : ""}</span></div>`;
  }).join("") : `<div class="sub">Nothing on the calendar.</div>`;
  if (it.bl.length) h += it.bl.map((b) => `<div class="wev" data-billid="${b.id}" style="cursor:pointer"><i style="background:${b.paid ? "#7D8594" : "#F2C14E"}"></i>
      <span class="sub" style="width:74px;margin:0">${b.paid ? "Paid" : "Due"}</span><span>${esc(b.name)} · ${money(b.amount)}${b.owner_id ? ` <span class="sub">(${esc(people[b.owner_id]?.display_name ?? "personal")})</span>` : ""}</span></div>`).join("");
  h += `</div><button class="btn ghost" id="calBack">Back to Home</button>`;
  $("tab-board").innerHTML = h;
  $("calBack").addEventListener("click", loadBoard);
}

async function openAllEvents() {
  const today = localISO();
  const { data } = await db.from("events").select("id,title,kind,starts_at,ends_at,all_day,member_id,notes,source")
    .or(`starts_at.gte.${today},ends_at.gte.${today}`).order("starts_at").limit(100);
  const rows = data || [];
  weekEvents = rows;
  let h = `<h2 class="row" style="justify-content:space-between">Coming up <a href="#" data-addev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600">+ Add</a></h2>`;
  h += rows.length ? rows.map((e) => {
    const p = people[e.member_id];
    const sd = localISO(new Date(e.starts_at)), ed = e.ends_at ? localISO(new Date(e.ends_at)) : sd;
    let when = fmtDate(sd) + (ed !== sd ? " – " + fmtDate(ed) : "");
    if (!e.all_day) when += " · " + new Date(e.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `<div class="card row" ${canEditEvent(e) || e.source === "phone" ? `data-ev="${e.id}" style="cursor:pointer"` : ""}>
      <i style="width:10px;height:10px;border-radius:5px;flex:none;background:${esc(p?.color ?? "#8A919E")}"></i>
      <div class="grow"><div class="name">${esc(p?.display_name ?? "Someone")}${e.kind === "away" ? " away" : ""} · ${esc(e.title)}</div>
      <div class="sub">${esc(when)}${e.notes ? " · " + esc(e.notes) : ""}</div></div></div>`;
  }).join("") : `<div class="card sub">Nothing on the calendar yet.</div>`;
  h += `<button class="btn ghost" id="evAllBack">Back</button>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("evAllBack").addEventListener("click", loadBoard);
}

// ---------- family photos (P14) ----------
let photoRows = [];
async function signPhotos(rows) {
  if (!rows.length) return {};
  const { data } = await db.storage.from("family-photos").createSignedUrls(rows.map((r) => r.path), 3600);
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}
async function fillHomePhotos() {
  const { data } = await db.from("photos").select("id,path,caption,taken_on,show_on_board,uploaded_by,created_at,purpose").eq("purpose", "family").order("created_at", { ascending: false }).limit(6);
  const rows = data || [];
  const el = $("homePhotos");
  if (!el) return;
  if (!rows.length) { el.innerHTML = `<div class="card sub center" style="grid-column:1/-1;padding:22px 16px">No photos yet. Tap + Add to share some — they'll rotate on the TV too.</div>`; return; }
  const urls = await signPhotos(rows);
  photoRows = rows.map((r) => ({ ...r, url: urls[r.path] }));
  el.innerHTML = photoRows.map((r) => `<button class="ph" data-ph="${r.id}" style="background-image:url('${esc(r.url ?? "")}')" aria-label="${esc(r.caption ?? "Photo")}"></button>`).join("");
}
async function openAllPhotos() {
  $("tab-board").innerHTML = `<h2 class="row" style="justify-content:space-between">Family photos <a href="#" data-addph="family" class="hlink">+ Add</a></h2><div id="allPhotos" class="phgrid"><div class="sub">Loading…</div></div>
    <h2 class="row" style="justify-content:space-between">TV backgrounds <a href="#" data-addph="background" class="hlink">+ Add</a></h2>
    <div class="sub" style="margin-top:-4px">Pictures to use behind the TV board. They don't rotate with the family photos. On the TV: ✱ > Background.</div>
    <div id="bgPhotos" class="phgrid" style="margin-top:8px"></div><button class="btn ghost" data-back="1">Back</button>`;
  window.scrollTo(0, 0);
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
  const { data } = await db.from("photos").select("id,path,caption,taken_on,show_on_board,uploaded_by,created_at,purpose").order("created_at", { ascending: false }).limit(300);
  const rows = data || [];
  const urls = await signPhotos(rows);
  photoRows = rows.map((r) => ({ ...r, url: urls[r.path] }));
  const tile = (r) => `<button class="ph" data-ph="${r.id}" style="background-image:url('${esc(r.url ?? "")}')">${r.show_on_board ? "" : `<span class="phtag">Not on TV</span>`}</button>`;
  const fam = photoRows.filter((r) => r.purpose !== "background"), bgs = photoRows.filter((r) => r.purpose === "background");
  $("allPhotos").innerHTML = fam.length ? fam.map(tile).join("") : `<div class="card sub center" style="grid-column:1/-1">No photos yet.</div>`;
  $("bgPhotos").innerHTML = bgs.length ? bgs.map(tile).join("") : `<div class="card sub center" style="grid-column:1/-1">No backgrounds yet. Any family photo can be a background too.</div>`;
}
function openPhoto(r) {
  const mineOrAdmin = r.uploaded_by === me.id || member?.role === "admin";
  const by = people[r.uploaded_by]?.display_name ?? "Someone";
  let h = `<div class="card" style="padding:10px"><img src="${esc(r.url ?? "")}" alt="" style="width:100%;border-radius:12px;display:block">
    <div class="sub" style="margin:10px 4px 0">${r.caption ? esc(r.caption) + " · " : ""}Added by ${esc(by)} · ${fmtDate(localISO(new Date(r.created_at)))}</div></div>`;
  if (mineOrAdmin) {
    h += `<label for="phCap">Caption</label><input id="phCap" maxlength="80" value="${esc(r.caption ?? "")}" placeholder="Lake trip, Brock's first deer…">
      <div class="check"><input type="checkbox" id="phTv" ${r.show_on_board ? "checked" : ""}><label for="phTv" style="margin:0;color:var(--text)">Show on the TV</label></div>
      <label for="phUse">Use it as</label>
      <select id="phUse"><option value="family" ${r.purpose !== "background" ? "selected" : ""}>Family photo (rotates on the TV)</option><option value="background" ${r.purpose === "background" ? "selected" : ""}>TV background only</option></select>
      <button class="btn" id="phSave">Save</button>
      <button class="btn ghost" id="phDel" style="color:var(--red)">Delete photo</button>`;
  }
  h += `<button class="btn ghost" data-allph="1">Back to photos</button><div class="err" id="phErr"></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("phSave")?.addEventListener("click", async () => {
    const { error } = await db.from("photos").update({ caption: $("phCap").value.trim() || null, show_on_board: $("phTv").checked, purpose: $("phUse").value }).eq("id", r.id);
    if (error) return ($("phErr").textContent = "Couldn't save: " + error.message);
    openAllPhotos();
  });
  $("phDel")?.addEventListener("click", async () => {
    if (!confirm("Delete this photo for everyone? This can't be undone.")) return;
    const { error } = await db.from("photos").delete().eq("id", r.id);
    if (error) return ($("phErr").textContent = "Couldn't delete: " + error.message);
    await db.storage.from("family-photos").remove([r.path]);
    openAllPhotos();
  });
}
// shrink big phone photos before uploading (long side 1920px, JPEG)
function scaledJpeg(file, max = 1920) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image"))), "image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = URL.createObjectURL(file);
  });
}
let pickPurpose = "family";
const photoPicker = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true });
photoPicker.style.display = "none";
document.body.appendChild(photoPicker);
photoPicker.addEventListener("change", async () => {
  const files = [...(photoPicker.files || [])];
  photoPicker.value = "";
  if (!files.length) return;
  const status = (t) => { const el = $("homePhotos") || $("allPhotos"); if (el) el.innerHTML = `<div class="sub" style="grid-column:1/-1">${esc(t)}</div>`; };
  let done = 0, failed = 0;
  for (const f of files) {
    status(`Uploading ${done + failed + 1} of ${files.length}…`);
    try {
      const blob = await scaledJpeg(f);
      const path = `${me.id}/photos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const up = await db.storage.from("family-photos").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const { error } = await db.from("photos").insert({ path, uploaded_by: me.id, purpose: pickPurpose, taken_on: f.lastModified ? localISO(new Date(f.lastModified)) : null });
      if (error) { await db.storage.from("family-photos").remove([path]); throw error; }
      done++;
    } catch { failed++; }
  }
  if (failed) alert(`${done} uploaded, ${failed} couldn't be read. (Some iPhone photos need "Most Compatible" camera format.)`);
  if ($("allPhotos")) openAllPhotos(); else loadBoard();
});

// ---------- bill pages: photos or PDF pages (P15) ----------
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
let pdfjsLib = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(PDFJS + "pdf.min.mjs");
  const boot = new Blob([`import "${PDFJS}pdf.worker.min.mjs";`], { type: "text/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(boot), { type: "module" });
  return pdfjsLib;
}
async function pdfToJpegs(file, maxPages = 15) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1600 / base.width });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("page"))), "image/jpeg", 0.85)));
  }
  return { pages: out, total: doc.numPages };
}
const billFolder = (bill) => (bill.owner_id ? `${me.id}/bills/${bill.id}` : `household/${bill.id}`);
async function signBillPages(paths) {
  if (!paths?.length) return [];
  const { data } = await db.storage.from("bill-media").createSignedUrls(paths, 3600);
  const m = Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  return paths.map((pth) => m[pth]).filter(Boolean);
}
async function drawPages() {
  const bill = editing || {};
  const pages = bill.full_images || [];
  $("addPages").classList.toggle("hidden", !bill.id);
  $("pagesHint").textContent = bill.id ? (pages.length ? "Tap a page to see it full size. Pages save right away." : "Add a photo or screenshot of the bill, or a PDF.")
    : "Save the bill first, then open it again to add its pages.";
  if (!pages.length) { $("bPages").innerHTML = ""; return; }
  const urls = await signBillPages(pages);
  $("bPages").innerHTML = urls.map((u, k) => `<div class="ph" style="background-image:url('${esc(u)}')" data-page="${k}"><span class="pgn">${k + 1}</span><button type="button" class="pgx" data-delpage="${k}" aria-label="Remove page">×</button></div>`).join("");
}
async function savePages(bill, pages) {
  const { error } = await db.from("bills").update({ full_images: pages }).eq("id", bill.id);
  if (error) throw error;
  bill.full_images = pages;
}
const pagePicker = Object.assign(document.createElement("input"), { type: "file", accept: "image/*,application/pdf", multiple: true });
pagePicker.style.display = "none";
document.body.appendChild(pagePicker);
$("addPages").addEventListener("click", () => pagePicker.click());
pagePicker.addEventListener("change", async () => {
  const files = [...(pagePicker.files || [])];
  pagePicker.value = "";
  const bill = editing;
  if (!files.length || !bill?.id) return;
  const pages = [...(bill.full_images || [])];
  const say = (t) => ($("pagesHint").textContent = t);
  try {
    for (const f of files) {
      let blobs = [];
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        say("Reading the PDF…");
        const r = await pdfToJpegs(f);
        blobs = r.pages;
        if (r.total > r.pages.length) alert(`That PDF has ${r.total} pages; the first ${r.pages.length} were added.`);
      } else {
        blobs = [await scaledJpeg(f, 2000)];
      }
      for (const b of blobs) {
        say(`Uploading page ${pages.length + 1}…`);
        const path = `${billFolder(bill)}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        const up = await db.storage.from("bill-media").upload(path, b, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        pages.push(path);
        await savePages(bill, pages);
      }
    }
    say("");
  } catch (err) {
    say("Couldn't add that: " + (err?.message || err));
  }
  drawPages();
});
$("bPages").addEventListener("click", async (e) => {
  const bill = editing;
  const del = e.target.closest("[data-delpage]");
  if (del) {
    e.stopPropagation();
    if (!confirm("Remove this page from the bill?")) return;
    const k = Number(del.dataset.delpage);
    const pages = [...(bill.full_images || [])];
    const [gone] = pages.splice(k, 1);
    try { await savePages(bill, pages); await db.storage.from("bill-media").remove([gone]); } catch (err) { $("pagesHint").textContent = "Couldn't remove: " + err.message; }
    return drawPages();
  }
  const pg = e.target.closest("[data-page]");
  if (pg) openViewer(bill.full_images, bill.name || "Bill", Number(pg.dataset.page));
});

// full-screen page viewer (phone)
async function openViewer(paths, title, startAt = 0) {
  const v = $("viewer");
  v.innerHTML = `<div class="vbar"><span>${esc(title)}</span><button class="btn ghost" id="vClose" style="width:auto;min-height:38px;margin:0;padding:0 16px">Close</button></div><div class="sub center" style="color:#ccc">Loading…</div>`;
  v.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("vClose").addEventListener("click", closeViewer);
  const urls = await signBillPages(paths);
  v.innerHTML = `<div class="vbar"><span>${esc(title)} · ${urls.length} page${urls.length === 1 ? "" : "s"}</span><button class="btn ghost" id="vClose" style="width:auto;min-height:38px;margin:0;padding:0 16px">Close</button></div>` +
    urls.map((u, k) => `<img src="${esc(u)}" alt="Page ${k + 1}" id="vpage${k}">`).join("");
  $("vClose").addEventListener("click", closeViewer);
  if (startAt) setTimeout(() => $("vpage" + startAt)?.scrollIntoView(), 50);
}
function closeViewer() { $("viewer").classList.add("hidden"); $("viewer").innerHTML = ""; document.body.style.overflow = ""; }
let viewerBills = {};
function viewBillButton(info, name) {
  const pages = info?.full_images || [];
  if (!pages.length) return "";
  const key = "v" + Math.random().toString(36).slice(2, 8);
  viewerBills[key] = { pages, name };
  return `<button class="btn ghost" data-viewbill="${key}">View the bill (${pages.length} page${pages.length === 1 ? "" : "s"})</button>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-viewbill]");
  if (!b) return;
  const vb = viewerBills[b.dataset.viewbill];
  if (vb) openViewer(vb.pages, vb.name);
});

function fmtShort(iso) { return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }); }

function itemRow(i) {
  const d = daysUntil(i.due);
  const cls = i.paid ? "paid" : d < 0 ? "late" : d <= 7 ? "soon" : "";
  let status = i.paid ? "Paid ✓" : dueLabel(i.due);
  if (i.paid && i.shareId) status = i.confirmed ? "Paid ✓ · confirmed" : `Paid · ${methodLabel(i.method, i.info)} · waiting for ${payeeFor(i.info)?.display_name ?? "admin"} to confirm`;
  const key = i.shareId ? "s:" + i.shareId : "p:" + i.personalId;
  return `<div class="card row" data-card="${key}" style="cursor:pointer"><div class="grow"><div class="name">${esc(i.name)}</div>
    <div class="sub ${cls}">${esc(status)}</div></div>
    <div class="amt ${i.paid ? "paid" : ""}">${money(i.amount)}</div></div>`;
}

// ---------- pay online + account number (P23) ----------
function normUrl(v) {
  v = String(v || "").trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
}
function payBox(info) {
  if (!info) return "";
  let h = "";
  if (info.autopay) {
    const adm = payeeFor(info);
    const note = info.pay_note || `Paid automatically from ${adm?.display_name ?? "the bill administrator"}'s account. Don't pay the company — send ${adm?.display_name ?? "them"} your share.`;
    h += `<div class="card" style="margin-top:12px;border:1px solid #2E6B3C"><div class="sub" style="margin:0;color:#7FD18B;font-weight:700">AUTOPAY</div>
      <div style="font-size:17px;font-weight:600;margin-top:4px">${esc(note)}</div></div>`;
    return h;
  }
  const url = info.pay_url || (info.website && info.website.includes(".") ? "https://" + info.website : "");
  if (info.pay_note) h += `<div class="card" style="margin-top:12px"><div style="font-weight:600">${esc(info.pay_note)}</div></div>`;
  if (url) h += `<a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none">🌐 Pay online${info.pay_url ? "" : ` (${esc(info.website)})`}</a>`;
  if (info.account_number) h += `<div class="row" style="margin-top:12px"><div class="grow"><div class="sub" style="margin:0">Account number</div>
      <div style="font-weight:700;letter-spacing:1px">${esc(info.account_number)}</div></div>
      <button type="button" class="chip" data-copy="${esc(info.account_number)}" style="border:0;min-height:36px;padding:0 14px">Copy</button></div>`;
  if (url) h += `<div class="sub" style="margin-top:8px">After paying on the website, come back and mark it paid.</div>`;
  if (!url && !info.account_number && info.id) {
    const canEdit = info.owner_id ? info.owner_id === me.id : canManage();
    h += `<div class="sub" style="margin-top:12px">No payment link saved for this bill yet.</div>`;
    if (canEdit) h += `<button type="button" class="btn ghost" data-addlink="${info.id}">+ Add a payment link</button>`;
  }
  return h;
}

// ---------- open any bill from anywhere (P25) ----------
const BILL_FIELDS = "id,name,amount,due_date,paid,owner_id,admin_id,show_on_board,logo_url,website,repeat_kind,repeat_days,full_images,pay_url,account_number,autopay,pay_note";
async function openBillById(id) {
  const { data: b } = await db.from("bills").select(BILL_FIELDS).eq("id", id).maybeSingle();
  if (!b) return;
  const { data: sh } = await db.from("bill_share_amounts").select("id,share_amount,paid,paid_method,confirmed").eq("bill_id", id).eq("member_id", me.id).maybeSingle();
  if (!document.querySelector('nav button[data-tab="board"]').classList.contains("on")) document.querySelector('nav button[data-tab="board"]').click();
  if (sh) return openShare({ shareId: sh.id, billId: id, name: b.name, amount: Number(sh.share_amount), billAmount: Number(b.amount),
    paid: sh.paid, method: sh.paid_method, confirmed: sh.confirmed, due: b.due_date, kind: "household", info: b });
  if (b.owner_id === me.id) return openShare({ personalId: b.id, bill: b, name: b.name, amount: Number(b.amount), paid: b.paid, due: b.due_date,
    kind: b.show_on_board ? "personal" : "private", info: b });
  openHelp(b);
}
// jump to the Bills tab and open that bill's editor
async function editBillById(id) {
  document.querySelector('nav button[data-tab="bills"]').click();
  for (let n = 0; n < 40; n++) {
    const el = document.querySelector(`[data-edit="${id}"], [data-mine="${id}"]`);
    if (el) { el.click(); setTimeout(() => $("bPayUrl")?.scrollIntoView({ block: "center" }), 150); $("bPayUrl")?.focus(); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-copy]");
  if (!c) return;
  try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = "Copied ✓"; }
  catch { c.textContent = "Couldn't copy"; }
  setTimeout(() => (c.textContent = "Copy"), 2000);
});

// ---------- "could use a hand" (P21): help pay someone else's bill ----------
function openHelp(b) {
  const owner = people[b.owner_id];
  const admin = people[b.admin_id] || owner || payee();
  const d = daysUntil(b.due_date);
  let h = `<h2>${owner ? esc(owner.display_name) + "'s " : ""}${esc(b.name)}</h2><div class="card">
    <div class="sub">${d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : dueLabel(b.due_date)}</div><div class="big">${money(b.amount)}</div>`;
  if (admin && admin.id !== me.id) {
    h += `<label for="helpAmt">How much do you want to send ${esc(admin.display_name)}?</label>
      <input id="helpAmt" inputmode="decimal" value="${Number(b.amount).toFixed(2)}">`;
    if (admin.cashtag) {
      h += `<a class="btn" id="helpCash" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none;background:#00D64F;color:#04210F">Send with Cash App</a>
        <div class="sub center" style="margin-top:6px">Opens Cash App to ${esc(admin.display_name)} (${esc(admin.cashtag)}) with the amount filled in. You press Pay in Cash App.</div>`;
    } else {
      h += `<div class="sub" style="margin-top:10px">${esc(admin.display_name)} hasn't added a Cash App tag yet (Me tab).</div>`;
    }
    if (admin.phone) h += `<a class="btn ghost" id="helpText" style="display:flex;align-items:center;justify-content:center;text-decoration:none">💬 Text ${esc(admin.display_name)}</a>`;
    // P30: record it so ${admin} sees "received from me" on their Bills tab
    h += `<button class="btn ghost" data-sent="cashapp">I sent it with Cash App</button>
      <button class="btn ghost" data-sent="other">I paid ${esc(admin.display_name)} another way</button>
      <div class="err" id="helpErr"></div><div id="helpMine"></div>`;
  }
  h += payBox(b);
  h += viewBillButton(b, b.name);
  h += `<button class="btn ghost" data-back="1">Back</button></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  const refresh = () => {
    const amt = parseFloat(String($("helpAmt")?.value || "").replace(/[$,]/g, "")) || 0;
    if ($("helpCash")) { $("helpCash").href = cashAppLink(amt, admin) || "#"; $("helpCash").textContent = `Send ${money(amt)} with Cash App`; }
    if ($("helpText")) $("helpText").href = smsLink(admin.phone, `Hey ${admin.display_name}, I saw ${b.name} on the Family Board (${money(b.amount)}). I can help with ${money(amt)} — sending it now.`);
  };
  $("helpAmt")?.addEventListener("input", refresh);
  refresh();
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
  if (!(admin && admin.id !== me.id)) return;
  // P30: what I've already sent toward this bill
  const paintMine = async () => {
    const { data } = await db.from("bill_payments").select("id,amount,method,sent_on,confirmed").eq("bill_id", b.id).eq("from_member", me.id).order("created_at");
    $("helpMine").innerHTML = (data || []).length ? `<div class="sub" style="margin-top:12px">What you've sent toward this bill:</div>` + data.map((p) =>
      `<div class="row" style="margin-top:4px"><div class="grow">${money(p.amount)} · ${p.method === "cashapp" ? "Cash App" : "other way"} · ${esc(fmtDate(p.sent_on))}
        <span class="${p.confirmed ? "" : "soon"}" style="${p.confirmed ? "color:var(--paid)" : ""}">${p.confirmed ? " · received ✓" : ` · waiting for ${esc(admin.display_name)} to confirm`}</span></div>
        ${p.confirmed ? "" : `<button type="button" class="chip" data-unsent="${p.id}" style="border:0;min-height:30px;color:var(--red)">Undo</button>`}</div>`).join("") : "";
    $("helpMine").querySelectorAll("[data-unsent]").forEach((x) => x.addEventListener("click", async () => {
      if (!confirm("Take this back? Only if you didn't actually send it.")) return;
      const { error } = await db.from("bill_payments").delete().eq("id", x.dataset.unsent);
      if (error) return ($("helpErr").textContent = "Couldn't undo: " + error.message);
      paintMine();
    }));
  };
  $("tab-board").querySelectorAll("[data-sent]").forEach((btn) => btn.addEventListener("click", async () => {
    const amt = parseFloat(String($("helpAmt")?.value || "").replace(/[$,]/g, "")) || 0;
    if (amt <= 0) return ($("helpErr").textContent = "Type how much you sent first.");
    btn.disabled = true;
    const { error } = await db.from("bill_payments").insert({ bill_id: b.id, amount: Math.round(amt * 100) / 100, method: btn.dataset.sent });
    btn.disabled = false;
    if (error) return ($("helpErr").textContent = "Couldn't save: " + error.message);
    $("helpErr").style.color = "var(--paid)";
    $("helpErr").textContent = `Saved ✓ — ${admin.display_name} will see ${money(amt)} from you on their Bills tab.`;
    paintMine();
  }));
  paintMine();
}

// ---------- marking shares paid (P8) ----------
let boardItems = [];
// household shares are paid back to the admin
const payee = () => Object.values(people).find((p) => p.role === "admin");
const payeeFor = (info) => (info && people[info.admin_id]) || payee();
let helpBills = [];
function methodLabel(m, info) {
  const who = payeeFor(info)?.display_name ?? "admin";
  return { to_admin: `paid ${who}`, direct: "paid the company", cashapp: "Cash App", other: "other" }[m] ?? "paid";
}
function cashAppLink(amount, person = payee()) {
  const tag = String(person?.cashtag ?? "").trim().replace(/^\$/, "");
  if (!tag) return null;
  return `https://cash.app/$${encodeURIComponent(tag)}/${Number(amount).toFixed(2)}`;
}

function openShare(i) {
  const pay = payeeFor(i.info);
  const iAmPayee = pay?.id === me.id || (!!pay && member?.linked_with === pay.id);
  const link = iAmPayee ? null : cashAppLink(i.amount, pay);
  if (i.personalId) {
    let h = `<h2>${esc(i.name)}</h2><div class="card"><div class="sub">Your bill</div><div class="big">${money(i.amount)}</div>
      <div class="sub">${i.paid ? "Paid ✓" : dueLabel(i.due)}</div>`;
    h += i.paid ? `<button class="btn ghost" data-pay="undo" style="color:var(--red)">Undo — not paid yet</button>`
      : `<button class="btn" data-pay="direct">Mark paid</button>`;
    h += payBox(i.info);
    h += viewBillButton(i.info, i.name);
    h += `<button class="btn ghost" data-back="1">Back</button><div class="err" id="shareErr"></div></div>`;
    $("tab-board").innerHTML = h;
    window.scrollTo(0, 0);
    $("tab-board").querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => markShare(i, b.dataset.pay)));
    $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
    return;
  }
  let h = `<h2>${esc(i.name)}</h2><div class="card">
    <div class="sub">Your share</div><div class="big">${money(i.amount)}</div>
    <div class="sub">${i.paid ? (i.confirmed ? "Paid ✓ · confirmed" : "Paid · " + esc(methodLabel(i.method, i.info))) : dueLabel(i.due)}</div>`;
  if (!i.paid) {
    if (link) h += `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none;background:#00D64F;color:#04210F">Pay ${money(i.amount)} with Cash App</a>
      <div class="sub center" style="margin-top:6px">Opens Cash App to ${esc(pay.display_name)}. Come back and tap "I paid with Cash App".</div>`;
    else if (!iAmPayee && pay) h += `<div class="sub" style="margin-top:10px">${esc(pay.display_name)} hasn't added a Cash App tag yet (Me tab), so the Cash App button is hidden.</div>`;
    if (!iAmPayee) {
      h += `<button class="btn ghost" data-pay="cashapp">I paid with Cash App</button>`;
      h += `<button class="btn ghost" data-pay="to_admin">I paid ${esc(pay?.display_name ?? "admin")}</button>`;
    }
    const partner = people[member?.linked_with];
    if (partner) h += `<div class="sub" style="margin-top:10px">🔗 You and ${esc(partner.display_name)} share money — marking yours also marks ${esc(partner.display_name)}'s.</div>`;
    // autopay (P28): nobody pays the company; the person being paid just marks their own share
    if (i.info?.autopay) { if (iAmPayee) h += `<button class="btn" data-pay="direct">Mark my share paid</button>`; }
    else h += `<button class="btn ghost" data-pay="direct">I paid the company directly</button>`;
  } else if (!i.confirmed) {
    h += `<button class="btn ghost" data-pay="undo" style="color:var(--red)">Undo — I haven't paid this yet</button>`;
  }
  const sibs = boardItems.filter((x) => !x.paid && x !== i && groupKey(x) === groupKey(i)).sort((a, b) => a.due.localeCompare(b.due));
  if (sibs.length) h += `<div class="card" style="margin-top:12px"><div class="sub" style="margin:0 0 6px">Also unpaid for ${esc(i.name)}</div>` +
    sibs.map((x) => `<button type="button" class="btn ghost" data-sib="${x.shareId ? "s:" + x.shareId : "p:" + x.personalId}" style="margin-top:6px">${esc(dueLabel(x.due))} · ${money(x.amount)} — open</button>`).join("") + `</div>`;
  const seeAll = iAmPayee || canManage();
  if (seeAll) h += `<div id="sharePeople" style="margin-top:14px"></div>`;
  h += payBox(i.info);
  h += viewBillButton(i.info, i.name);
  h += `<button class="btn ghost" data-back="1">Back</button><div class="err" id="shareErr"></div></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("tab-board").querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => markShare(i, b.dataset.pay)));
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
  $("tab-board").querySelectorAll("[data-sib]").forEach((b) => b.addEventListener("click", () => {
    const x = boardItems.find((y) => (y.shareId ? "s:" + y.shareId : "p:" + y.personalId) === b.dataset.sib);
    if (x) openShare(x);
  }));
  if (seeAll) paintSharePeople(i);
}

// P33: on the bill screen, whoever gets paid sees everyone's share (same lines as the Bills tab)
async function paintSharePeople(i) {
  const { data } = await db.from("bill_share_amounts").select("id,member_id,share_amount,paid,paid_method,confirmed").eq("bill_id", i.billId);
  const el = $("sharePeople");
  if (!el || !data) return;
  const pay = payeeFor(i.info);
  el.innerHTML = `<div class="sub" style="margin:0 0 4px">Everyone's share</div>` + data.filter((s) => people[s.member_id]).map((s) => {
    const p = people[s.member_id];
    const self = pay && p.id === pay.id;
    let st;
    if (s.paid && (s.confirmed || self)) st = `<span style="color:var(--paid)">${self ? "paid ✓" : `received ✓ · ${esc(methodLabel(s.paid_method, i.info))}`}</span>`;
    else if (s.paid) st = `<span class="soon">says paid · ${esc(methodLabel(s.paid_method, i.info))}</span>` +
      (canManage() ? ` <button type="button" class="chip" data-okpay="${s.id}" style="border:0;min-height:30px;margin-left:6px;color:var(--accent)">Confirm ✓</button>` : "");
    else st = `<span class="sub" style="margin:0">not yet</span>`;
    return `<div style="font-size:15px;margin-top:4px"><b style="color:${esc(p.color)}">${esc(p.display_name)}</b> ${money(s.share_amount)} — ${st}</div>`;
  }).join("");
  el.querySelectorAll("[data-okpay]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Saving…";
    const { error } = await db.from("bill_shares").update({ confirmed: true }).eq("id", b.dataset.okpay);
    if (error) { b.disabled = false; b.textContent = "Couldn't save — try again"; return; }
    paintSharePeople(i);
  }));
}

async function markShare(i, how) {
  if (i.personalId) {
    const { error } = await db.from("bills").update({ paid: how !== "undo" }).eq("id", i.personalId);
    if (error) return ($("shareErr").textContent = "Couldn't save: " + error.message);
    return loadBoard();
  }
  const fields = how === "undo"
    ? { paid: false, paid_on: null, paid_method: null }
    : { paid: true, paid_on: localISO(), paid_method: how };
  // the admin or a bill manager paying their own share needs no confirming
  if (how !== "undo" && canManage()) fields.confirmed = true;
  const { error } = await db.from("bill_shares").update(fields).eq("id", i.shareId);
  if (error) return ($("shareErr").textContent = "Couldn't save: " + error.message);
  loadBoard();
}

$("tab-board").addEventListener("click", async (e) => {
  const billLink = e.target.closest("[data-billid]");
  if (billLink) { e.preventDefault(); return openBillById(billLink.dataset.billid); }
  const addLink = e.target.closest("[data-addlink]");
  if (addLink) { e.preventDefault(); return editBillById(addLink.dataset.addlink); }
  const helpRow = e.target.closest("[data-help]");
  if (helpRow) { const b = helpBills.find((x) => x.id === helpRow.dataset.help); if (b) openHelp(b); return; }
  if (e.target.closest("[data-addev]")) { e.preventDefault(); return openEvent({}); }
  if (e.target.closest("[data-addph]")) { e.preventDefault(); pickPurpose = e.target.closest("[data-addph]").dataset.addph === "background" ? "background" : "family"; return photoPicker.click(); }
  if (e.target.closest("[data-allph]")) { e.preventDefault(); return openAllPhotos(); }
  const phBtn = e.target.closest("[data-ph]");
  if (phBtn) { const r = photoRows.find((x) => x.id === phBtn.dataset.ph); if (r) openPhoto(r); return; }
  if (e.target.closest("[data-allev]")) { e.preventDefault(); return openMonth(localISO().slice(0, 8) + "01"); }
  const dayCell = e.target.closest("[data-day]");
  if (dayCell) { e.preventDefault(); return openMonth(dayCell.dataset.day.slice(0, 8) + "01", dayCell.dataset.day); }
  const mNav = e.target.closest("[data-mnav]");
  if (mNav) { e.preventDefault(); return openMonth(mNav.dataset.mnav); }
  if (e.target.closest("[data-addon]")) { e.preventDefault(); const d = e.target.closest("[data-addon]").dataset.addon; return openEvent({ starts_at: new Date(d + "T12:00:00").toISOString() }); }
  const evRow = e.target.closest("[data-ev]");
  if (evRow) {
    const ev = weekEvents.find((x) => x.id === evRow.dataset.ev);
    if (ev && ev.source === "phone") alert(`This comes from ${people[ev.member_id]?.display_name ?? "their"}'s phone calendar. Change it there; the board picks it up within an hour.`);
    else if (ev && canEditEvent(ev)) openEvent(ev);
    return;
  }
  const row = e.target.closest("[data-card]");
  if (row) {
    if (row.classList.contains("wcard") && Number(row.style.zIndex) !== document.querySelectorAll("#tab-board .wcard").length) {
      bringForward(row);
      return;
    }
    const key = row.dataset.card;
    const i = boardItems.find((x) => (x.shareId ? "s:" + x.shareId : "p:" + x.personalId) === key);
    if (i) openShare(i);
    return;
  }
  const c = e.target.closest("[data-confirm]");
  if (c) {
    c.disabled = true;
    const { error } = await db.from("bill_shares").update({ confirmed: true }).eq("id", c.dataset.confirm);
    if (error) { c.disabled = false; alert("Couldn't confirm: " + error.message); return; }
    loadBoard();
  }
});

function dueLabel(iso) {
  const d = daysUntil(iso);
  if (d < 0) return `Overdue ${-d}d`;
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  return "Due " + fmtDate(iso);
}

// ---------- notes ----------
function fillNoteTo() {
  const opts = [`<option value="">Everyone</option>`];
  for (const p of Object.values(people)) {
    if (p.id !== me.id && p.role !== "display") opts.push(`<option value="${p.id}">${esc(p.display_name)}</option>`);
  }
  $("noteTo").innerHTML = opts.join("");
}

$("noteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("noteErr").textContent = "";
  const to = $("noteTo").value || null;
  const priv = $("notePrivate").checked;
  if (priv && !to) { $("noteErr").textContent = "Pick a person for a private note."; return; }
  const { data: posted, error } = await db.from("notes").insert({
    author_id: me.id, to_member: to, body: $("noteBody").value.trim(), pinned: $("notePin").checked, private: priv,
  }).select("id").single();
  const notifyNote = () => posted?.id && db.functions.invoke("notify", { body: { type: "note", note_id: posted.id } }).catch(() => {});
  if (error) { $("noteErr").textContent = "Couldn't post: " + error.message; return; }
  notifyNote();
  $("noteBody").value = ""; $("notePin").checked = false; $("notePrivate").checked = false;
  loadNotes();
});

async function loadNotes() {
  const { data, error } = await db.from("notes").select("id,body,pinned,private,created_at,author_id,to_member,seen_at").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(40);
  if (error) { $("noteList").innerHTML = `<div class="card sub">Couldn't load notes.</div>`; return; }
  $("noteList").innerHTML = (data || []).map((n) => {
    const a = people[n.author_id];
    const to = n.to_member ? people[n.to_member]?.display_name ?? "?" : "Everyone";
    const when = n.pinned ? "Pinned" : new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const mine = n.author_id === me.id || member?.role === "admin";
    return `<div class="card"><div class="note-head"><span style="color:${esc(a?.color ?? "#A7ADB8")};font-weight:700">${esc(a?.display_name ?? "Someone")} → ${esc(to)}${n.private ? " 🔒" : ""}</span>
      <span class="sub" style="margin:0">${when}</span></div><div class="note-body">${esc(n.body)}</div>
      ${n.seen_at ? `<div class="sub paid" style="margin-top:6px">Seen on TV ✓ · ${new Date(n.seen_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — no longer shown on the TV</div>` : ""}
      ${mine ? `<button class="chip" data-del="${n.id}" style="margin-top:10px;border:0;min-height:32px">Delete</button>` : ""}</div>`;
  }).join("") || `<div class="card sub">No notes yet.</div>`;
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this note?")) return;
    await db.from("notes").delete().eq("id", b.dataset.del);
    loadNotes();
  }));
}

// ---------- phone notifications (P18) ----------
const PUSH_PUBLIC_KEY = "BE8uAPmnmhXH3lk6OjtteGk3hDbXGkbUrIZaaj-KVHh_W6Y7enIVK3UoordOqoqjqUKkaniuHC_R8OvP-699Xlg";
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isInstalled = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function pushSub() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function paintPush() {
  const show = (id, on) => $(id).classList.toggle("hidden", !on);
  $("pushErr").textContent = "";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    $("pushState").textContent = isIOS && !isInstalled()
      ? "On iPhone, first add the app to your Home Screen (Share button > Add to Home Screen), open it from there, then come back here."
      : "This phone's browser can't do notifications. Try Chrome, or add the app to your home screen.";
    show("pushOn", false); show("pushTest", false); show("pushOff", false);
    return;
  }
  const sub = await pushSub();
  if (sub && Notification.permission === "granted") {
    $("pushState").textContent = "Notifications are on for this phone: bills due tomorrow/today/overdue, reminders, and notes for you.";
    show("pushOn", false); show("pushTest", true); show("pushOff", true);
  } else if (Notification.permission === "denied") {
    $("pushState").textContent = "Notifications are blocked for this app. Turn them on in your phone's settings for this app/site, then come back.";
    show("pushOn", false); show("pushTest", false); show("pushOff", false);
  } else {
    $("pushState").textContent = "Get a heads-up when a bill is due, when it's overdue, when someone sends you a reminder, or leaves you a note.";
    show("pushOn", true); show("pushTest", false); show("pushOff", false);
  }
}
$("pushOn").addEventListener("click", async () => {
  $("pushErr").textContent = "";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return paintPush();
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUSH_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await db.from("push_subscriptions").upsert({ member_id: me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) throw error;
    await paintPush();
  } catch (e) {
    $("pushErr").textContent = "Couldn't turn on notifications: " + (e?.message || e);
  }
});
$("pushTest").addEventListener("click", async () => {
  $("pushErr").textContent = "Sending…";
  const { data, error } = await db.functions.invoke("notify", { body: { type: "test" } });
  $("pushErr").textContent = error ? "Couldn't send the test: " + error.message : data?.sent ? "Sent — it should pop up in a few seconds." : "Nothing was sent. Try turning notifications off and on again.";
});
$("pushOff").addEventListener("click", async () => {
  const sub = await pushSub();
  if (sub) { await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
  paintPush();
});

// ---------- my phone calendar (P27): Google / iPhone calendar link, copied in by the notify function ----------
let calLink = null;
async function paintCal() {
  const { data: l } = await db.from("calendar_links").select("ics_url,busy_only,last_sync,last_count,last_error").eq("member_id", me.id).maybeSingle();
  calLink = l || null;
  const show = (id, on) => $(id).classList.toggle("hidden", !on);
  show("calForm", !calLink); show("calSave", !calLink); show("calSync", !!calLink); show("calUnlink", !!calLink);
  $("calBusy").checked = !!calLink?.busy_only;
  if (!calLink) $("calState").textContent = "Link the calendar on your phone so your appointments show on the family board and the TVs. It checks for changes every hour.";
  else if (calLink.last_error) $("calState").innerHTML = `Linked, but the last check didn't work: <span style="color:var(--red)">${esc(calLink.last_error)}</span>`;
  else $("calState").textContent = calLink.last_sync
    ? `Linked ✓ · ${calLink.last_count ?? 0} entries in the next 90 days · checked ${agoText(calLink.last_sync)}. Checks again every hour.`
    : "Linked ✓ · first check coming up.";
}
async function runCalSync() {
  $("calErr").textContent = "Reading your calendar…";
  const { data, error } = await db.functions.invoke("notify", { body: { type: "calsync" } });
  $("calErr").textContent = error ? "Couldn't check the calendar: " + error.message
    : data?.error ? "Couldn't read it: " + data.error
    : `Done — ${data?.count ?? 0} entries are on the family board.`;
  await paintCal();
}
$("calSave").addEventListener("click", async () => {
  const url = $("calUrl").value.trim();
  if (!/^(https?|webcal):\/\/\S+$/i.test(url)) return ($("calErr").textContent = "Paste the whole link. It starts with https:// or webcal://");
  $("calErr").textContent = "Saving…";
  const { error } = await db.from("calendar_links").upsert({ member_id: me.id, ics_url: url, busy_only: $("calBusy").checked }, { onConflict: "member_id" });
  if (error) return ($("calErr").textContent = "Couldn't save: " + error.message);
  $("calUrl").value = "";
  await runCalSync();
});
$("calSync").addEventListener("click", runCalSync);
$("calBusy").addEventListener("change", async () => {
  if (!calLink) return;
  const { error } = await db.from("calendar_links").update({ busy_only: $("calBusy").checked }).eq("member_id", me.id);
  if (error) return ($("calErr").textContent = "Couldn't save: " + error.message);
  await runCalSync();
});
$("calUnlink").addEventListener("click", async () => {
  if (!confirm("Unlink your phone calendar? Its entries come off the family board.")) return;
  $("calErr").textContent = "Unlinking…";
  const { error } = await db.functions.invoke("notify", { body: { type: "calunlink" } });
  $("calErr").textContent = error ? "Couldn't unlink: " + error.message : "Unlinked.";
  await paintCal();
});

// ---------- shared money (P31): the admin links two people who share a bank account ----------
function paintLinks() {
  $("linkBox").classList.toggle("hidden", member?.role !== "admin");
  if (member?.role !== "admin") return;
  const fam = familyList();
  $("linkRows").innerHTML = fam.map((p) => `<div class="split-row" style="grid-template-columns:1fr 170px">
      <span style="color:${esc(p.color)};font-weight:600">${esc(p.display_name)} shares money with</span>
      <select data-link="${p.id}"><option value="">nobody</option>${fam.filter((q) => q.id !== p.id).map((q) =>
        `<option value="${q.id}" ${p.linked_with === q.id ? "selected" : ""}>${esc(q.display_name)}</option>`).join("")}</select></div>`).join("");
  $("linkRows").querySelectorAll("[data-link]").forEach((sel) => sel.addEventListener("change", async () => {
    const a = sel.dataset.link, b = sel.value || null;
    $("linkErr").textContent = "Saving…";
    const { error } = await db.rpc("set_money_link", { a, b });
    if (error) return ($("linkErr").textContent = "Couldn't save: " + error.message);
    const { data: rows } = await db.from("members").select("id,linked_with");
    (rows || []).forEach((r) => { if (people[r.id]) people[r.id].linked_with = r.linked_with; });
    $("linkErr").style.color = "var(--paid)";
    $("linkErr").textContent = b ? `Linked ✓ ${people[a].display_name} and ${people[b].display_name}.` : `${people[a].display_name} isn't linked to anyone now.`;
    setTimeout(() => { $("linkErr").textContent = ""; $("linkErr").style.color = ""; }, 4000);
    paintLinks();
  }));
}

// ---------- profile (P2) ----------
const COLORS = ["#7FA8F9", "#E57FA8", "#A98BF5", "#5DC26A", "#F0A04B", "#4FC1B0", "#F2C14E", "#FF8A80"];
let pickedColor = null;

async function avatarUrl(path) {
  if (!path) return null;
  const { data } = await db.storage.from("family-photos").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

async function paintAvatar(el, m) {
  el.textContent = (m?.display_name ?? "?").slice(0, 1);
  el.style.backgroundColor = m?.color ?? "#8A919E";
  const url = await avatarUrl(m?.avatar_path);
  if (url) { el.style.backgroundImage = `url("${url}")`; el.classList.add("photo"); }
  else { el.style.backgroundImage = ""; el.classList.remove("photo"); }
}

function fillProfile() {
  $("profName").value = member?.display_name ?? "";
  $("profCash").value = member?.cashtag ?? "";
  $("profPhone").value = member?.phone ?? "";
  pickedColor = member?.color ?? COLORS[0];
  $("swatches").innerHTML = COLORS.map((c) => `<button class="sw${c.toLowerCase() === pickedColor.toLowerCase() ? " on" : ""}" style="background:${c}" data-c="${c}" aria-label="Color ${c}"></button>`).join("");
  document.querySelectorAll(".sw").forEach((b) => b.addEventListener("click", () => {
    pickedColor = b.dataset.c;
    document.querySelectorAll(".sw").forEach((x) => x.classList.toggle("on", x === b));
    $("bigAvatar").style.backgroundColor = pickedColor;
  }));
  $("removePhoto").classList.toggle("hidden", !member?.avatar_path);
  paintAvatar($("bigAvatar"), member);
}

$("saveProfile").addEventListener("click", async () => {
  $("profErr").textContent = "";
  let cash = $("profCash").value.trim();
  if (cash && !cash.startsWith("$")) cash = "$" + cash;
  if (cash && !/^\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(cash)) { $("profErr").textContent = "A $Cashtag starts with $ and a letter."; return; }
  const name = $("profName").value.trim();
  if (!name) { $("profErr").textContent = "Your name can't be empty."; return; }
  const digits = $("profPhone").value.replace(/\D/g, "");
  if (digits && !(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) { $("profErr").textContent = "Enter a 10-digit cell number, like 989-555-0123."; return; }
  const phone = digits ? "+1" + digits.slice(-10) : null;
  const { error } = await db.from("members").update({ display_name: name, color: pickedColor, cashtag: cash || null, phone }).eq("id", me.id);
  if (error) { $("profErr").textContent = "Couldn't save: " + error.message; return; }
  Object.assign(member, { display_name: name, color: pickedColor, cashtag: cash || null, phone });
  $("hello").textContent = `Hi, ${name}`;
  paintAvatar($("me"), member);
  $("profErr").style.color = "var(--paid)"; $("profErr").textContent = "Saved ✓";
  setTimeout(() => { $("profErr").textContent = ""; $("profErr").style.color = ""; }, 2500);
});

// shrink any photo to a 320x320 square JPEG before upload
function squareJpeg(file, size = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas"); c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image"))), "image/jpeg", 0.86);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = URL.createObjectURL(file);
  });
}

$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("profErr").textContent = "Uploading…";
  try {
    const blob = await squareJpeg(file);
    const path = `${me.id}/avatar-${Date.now()}.jpg`;
    const up = await db.storage.from("family-photos").upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    const old = member.avatar_path;
    const { error } = await db.from("members").update({ avatar_path: path }).eq("id", me.id);
    if (error) throw error;
    if (old) await db.storage.from("family-photos").remove([old]);
    member.avatar_path = path;
    fillProfile(); paintAvatar($("me"), member);
    $("profErr").textContent = "";
  } catch (err) {
    $("profErr").textContent = "Upload failed: " + (err.message || err);
  }
  e.target.value = "";
});

$("removePhoto").addEventListener("click", async () => {
  const old = member.avatar_path;
  await db.from("members").update({ avatar_path: null }).eq("id", me.id);
  if (old) await db.storage.from("family-photos").remove([old]);
  member.avatar_path = null;
  fillProfile(); paintAvatar($("me"), member);
});

// ---------- household bills (P3) ----------
const canManage = () => member?.role === "admin" || member?.bill_manager === true;
let editing = null; // bill being edited, or {} for new

async function loadBills() {
  $("billEditor").classList.add("hidden");
  $("billsList").classList.remove("hidden");
  const monthStart = localISO().slice(0, 8) + "01";
  const ago60 = localISO(new Date(Date.now() - 60 * 86400000));
  const [bills, shares, sample, mine, helps] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,split_method,website,logo_url,paid,next_bill_id,full_images,admin_id,pay_url,account_number,autopay,pay_note").is("owner_id", null).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
    db.from("bill_shares").select("id,bill_id,member_id,percent,fixed_amount,paid,paid_method,paid_on,confirmed"),
    db.from("bills").select("id", { count: "exact", head: true }).eq("notes", "SAMPLE"),
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,website,logo_url,paid,next_bill_id,owner_id,show_on_board,full_images,admin_id,pay_url,account_number,autopay,pay_note").eq("owner_id", me.id).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
    // P30: money people sent toward personal bills (I only see ones to me / on my bills / from me)
    db.from("bill_payments").select("id,bill_id,from_member,to_member,amount,method,sent_on,confirmed,bills(name,owner_id)").gte("sent_on", ago60).order("created_at"),
  ]);
  const helpsByBill = {};
  (helps.data || []).filter((p) => p.from_member !== me.id).forEach((p) => (helpsByBill[p.bill_id] ??= []).push(p));
  const helpLine = (p) => {
    const who = people[p.from_member]?.display_name ?? "Someone";
    const how = p.method === "cashapp" ? "Cash App" : "other way";
    const st = p.confirmed ? `<span style="color:var(--paid)">received ✓</span>`
      : `<span class="soon">says sent</span> <button type="button" class="chip" data-helpok="${p.id}" style="border:0;min-height:30px;margin-left:6px;color:var(--accent)">Confirm ✓</button>`;
    return `<div style="font-size:14px;margin-top:3px"><b style="color:${esc(people[p.from_member]?.color ?? "inherit")}">${esc(who)}</b> ${money(p.amount)} · ${how} · ${esc(fmtDate(p.sent_on))} — ${st}</div>`;
  };
  const byBill = {};
  (shares.data || []).forEach((s) => (byBill[s.bill_id] ??= []).push(s));
  let html = `<h2>Household bills</h2>`;
  if (canManage()) html += `<button class="btn" id="newBill" style="margin:0 0 12px">+ Add a household bill</button>`;
  const rows = bills.data || [];
  // unpaid bills whose due date has passed (any month) go in their own group at the top
  const pastDue = rows.filter((b) => !b.paid && daysUntil(b.due_date) < 0);
  const current = rows.filter((b) => !pastDue.includes(b));
  const billRow = (b) => {
    const who = (byBill[b.id] || []).map((s) => people[s.member_id]?.display_name).filter(Boolean);
    const d = daysUntil(b.due_date);
    const cls = b.paid ? "paid" : d < 0 ? "late" : d <= 7 ? "soon" : "";
    return `<div class="card row" ${canManage() ? `data-edit="${b.id}" style="cursor:pointer"` : ""}>
      ${logoTile(b)}
      <div class="grow"><div class="name">${esc(b.name)}</div>
      <div class="sub ${cls}">${b.paid ? "Paid ✓" : dueLabel(b.due_date)}${repeatLabel(b) ? " · " + repeatLabel(b) : ""}</div>
      <div class="sub">${!who.length ? "Not split yet" : canManage() ? `${(byBill[b.id] || []).filter((s) => s.paid).length} of ${who.length} paid` : "Split: " + esc(who.join(", ")) + ` · ${(byBill[b.id] || []).filter((s) => s.paid).length} of ${who.length} paid`}</div>
      ${canManage() ? receivedLines(b) : ""}</div>
      <div class="amt">${money(b.amount)}</div></div>`;
  };
  // P29: the bill administrator sees, per person, whether their share came in (and can confirm it right here)
  const receivedLines = (b) => {
    const list = (byBill[b.id] || []).filter((s) => people[s.member_id]);
    if (!list.length) return "";
    const pay = payeeFor(b);
    return `<div style="margin-top:6px">` + list.map((s) => {
      const p = people[s.member_id];
      const amt = money(shareAmount(b, s, list));
      const self = pay && p.id === pay.id;
      let st;
      if (s.paid && (s.confirmed || self)) st = `<span style="color:var(--paid)">${self ? "your share ✓" : `received ✓ · ${esc(methodLabel(s.paid_method, b))}`}</span>`;
      else if (s.paid) st = `<span class="soon">says paid · ${esc(methodLabel(s.paid_method, b))}</span>
        <button type="button" class="chip" data-recv="${s.id}" style="border:0;min-height:30px;margin-left:6px;color:var(--accent)">Confirm ✓</button>`;
      else st = `<span class="sub" style="margin:0">${self ? "your share · not marked" : "not yet"}</span>`;
      const lk = people[p.linked_with] && list.some((x) => x.member_id === p.linked_with) ? ` <span class="sub" style="margin:0">🔗 ${esc(people[p.linked_with].display_name)}</span>` : "";
      return `<div style="font-size:14px;margin-top:3px"><b style="color:${esc(p.color)}">${esc(p.display_name)}</b>${lk} ${amt} — ${st}</div>`;
    }).join("") + `</div>`;
  };
  // P34: late + current copies of the same bill in one card (total owed, each copy tappable)
  const nameKey = (b) => String(b.name || "").trim().toLowerCase();
  const unpaidBy = {};
  rows.filter((b) => !b.paid).forEach((b) => (unpaidBy[nameKey(b)] ??= []).push(b));
  const multi = Object.values(unpaidBy).filter((g) => g.length > 1);
  const inGroup = new Set(multi.flat().map((b) => b.id));
  const groupRow = (g) => {
    g.sort((a, b) => a.due_date.localeCompare(b.due_date));
    const total = g.reduce((t, b) => t + Number(b.amount || 0), 0);
    const late = daysUntil(g[0].due_date) < 0;
    return `<div class="card"><div class="row">${logoTile(g[0])}<div class="grow"><div class="name">${esc(g[0].name)}</div>
      <div class="sub ${late ? "late" : "soon"}">${g.length} unpaid · oldest ${esc(dueLabel(g[0].due_date))}</div></div>
      <div class="amt">${money(total)}</div></div>` +
      g.map((b) => {
        const who = (byBill[b.id] || []).filter((x) => people[x.member_id]);
        return `<div ${canManage() ? `data-edit="${b.id}" style="cursor:pointer;` : `style="`}border-top:1px solid rgba(255,255,255,.08);margin-top:10px;padding-top:8px">
          <div class="row"><div class="grow sub ${daysUntil(b.due_date) < 0 ? "late" : ""}" style="margin:0">${esc(dueLabel(b.due_date))}${who.length ? ` · ${who.filter((x) => x.paid).length} of ${who.length} paid` : ""}</div><b>${money(b.amount)}</b></div>
          ${canManage() ? receivedLines(b) : ""}</div>`;
      }).join("") + `</div>`;
  };
  const entries = [];
  rows.filter((b) => !inGroup.has(b.id)).forEach((b) => entries.push({ due: b.due_date, late: !b.paid && daysUntil(b.due_date) < 0, html: () => billRow(b) }));
  multi.forEach((g) => { const first = g.reduce((a, b) => (a.due_date < b.due_date ? a : b)); entries.push({ due: first.due_date, late: daysUntil(first.due_date) < 0, html: () => groupRow(g) }); });
  entries.sort((a, b) => a.due.localeCompare(b.due));
  const lateE = entries.filter((e) => e.late), nowE = entries.filter((e) => !e.late);
  if (lateE.length) html += `<h2 class="late">Past due</h2>` + lateE.map((e) => e.html()).join("") + `<h2>This month &amp; coming up</h2>`;
  html += nowE.length ? nowE.map((e) => e.html()).join("") : `<div class="card sub">No household bills this month yet.</div>`;
  if (canManage()) html += `<p class="sub center">Tap a bill to edit it.</p>`;

  // ---- my own bills (P11) ----
  const myRows = mine.data || [];
  html += `<h2>My bills</h2><button class="btn ghost" id="newMine" style="margin:0 0 12px">+ Add a personal bill</button>`;
  html += myRows.length ? myRows.map((b) => {
    const d = daysUntil(b.due_date);
    const cls = b.paid ? "paid" : d < 0 ? "late" : d <= 7 ? "soon" : "";
    return `<div class="card row" data-mine="${b.id}" style="cursor:pointer">
      ${logoTile(b)}
      <div class="grow"><div class="name">${esc(b.name)}</div>
      <div class="sub ${cls}">${b.paid ? "Paid ✓" : dueLabel(b.due_date)}${repeatLabel(b) ? " · " + repeatLabel(b) : ""}</div>
      <div class="sub">${b.show_on_board ? "On the family board" : "🔒 Private — only you see this"}</div>
      ${(helpsByBill[b.id] || []).length ? `<div style="margin-top:6px"><div class="sub" style="margin:0">Payments received</div>${helpsByBill[b.id].map(helpLine).join("")}</div>` : ""}</div>
      <div class="amt">${money(b.amount)}</div></div>`;
  }).join("") : `<div class="card sub">No personal bills yet. Add things only you pay (phone, car, card…).</div>`;
  // P30: help sent to me for someone else's bill (I'm that bill's administrator)
  const toMe = (helps.data || []).filter((p) => p.to_member === me.id && p.bills?.owner_id !== me.id && p.from_member !== me.id);
  if (toMe.length) html += `<h2>Payments sent to you</h2>` + toMe.map((p) =>
    `<div class="card"><div class="name">${esc(people[p.bills?.owner_id]?.display_name ?? "")}${p.bills?.owner_id ? "'s " : ""}${esc(p.bills?.name ?? "bill")}</div>${helpLine(p)}</div>`).join("");

  if (member?.role === "admin" && sample.count) html += `<button class="btn ghost" id="clearSample" style="margin-top:20px">Remove the sample data (${sample.count} sample bills)</button>`;
  $("billsList").innerHTML = html;
  $("newBill")?.addEventListener("click", () => openEditor({}, []));
  $("newMine").addEventListener("click", () => openEditor({ owner_id: me.id, show_on_board: true }, []));
  document.querySelectorAll("[data-mine]").forEach((el) => el.addEventListener("click", () => {
    openEditor(myRows.find((r) => r.id === el.dataset.mine), []);
  }));
  document.querySelectorAll("[data-helpok]").forEach((el) => el.addEventListener("click", async (e) => {
    e.stopPropagation();
    el.disabled = true; el.textContent = "Saving…";
    const { error } = await db.from("bill_payments").update({ confirmed: true }).eq("id", el.dataset.helpok);
    if (error) { el.disabled = false; el.textContent = "Couldn't save — try again"; return; }
    loadBills();
  }));
  document.querySelectorAll("[data-recv]").forEach((el) => el.addEventListener("click", async (e) => {
    e.stopPropagation();
    el.disabled = true; el.textContent = "Saving…";
    const { error } = await db.from("bill_shares").update({ confirmed: true }).eq("id", el.dataset.recv);
    if (error) { el.disabled = false; el.textContent = "Couldn't save — try again"; return; }
    loadBills();
  }));
  document.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => {
    const b = rows.find((r) => r.id === el.dataset.edit);
    openEditor(b, byBill[b.id] || []);
  }));
  $("clearSample")?.addEventListener("click", clearSample);
}

function repeatLabel(b) {
  switch (b.repeat_kind) {
    case "weekly": return "weekly";
    case "biweekly": return "every 2 weeks";
    case "monthly": return "monthly";
    case "days": return `every ${b.repeat_days} days`;
    default: return "";
  }
}

function showRepeatBits() {
  $("bDaysBox").classList.toggle("hidden", $("bRepeat").value !== "days");
  const willMakeNext = $("bRepeat").value !== "none" && $("bPaid").checked && !editing?.paid && !editing?.next_bill_id;
  $("bPaidHint").textContent = willMakeNext ? "Saving will also add the next one to the list." : "";
}
$("bRepeat").addEventListener("change", showRepeatBits);
$("bPaid").addEventListener("change", showRepeatBits);

function familyList() {
  return Object.values(people).filter((p) => p.role !== "display");
}

function openEditor(bill, shares) {
  editing = bill;
  $("billsList").classList.add("hidden");
  $("billEditor").classList.remove("hidden");
  const personal = !!bill.owner_id;
  $("editorTitle").textContent = (bill.id ? "Edit " : "New ") + (personal ? "personal bill" : "household bill");
  $("splitBox").classList.toggle("hidden", personal);
  $("personalBox").classList.toggle("hidden", !personal);
  $("bShow").checked = bill.show_on_board ?? true;
  const defAdmin = bill.admin_id ?? (personal ? me.id : payee()?.id ?? me.id);
  $("bAdmin").innerHTML = familyList().map((p) => `<option value="${p.id}" ${p.id === defAdmin ? "selected" : ""}>${esc(p.display_name)}${p.id === me.id ? " (you)" : ""}</option>`).join("");
  $("bName").value = bill.name ?? "";
  $("bAmount").value = bill.amount ?? "";
  $("bDue").value = bill.due_date ?? localISO(new Date(Date.now() + 14 * 86400000));
  $("bSite").value = bill.website ?? "";
  $("bPayUrl").value = bill.pay_url ?? "";
  $("bAcct").value = bill.account_number ?? "";
  $("bAutopay").value = bill.autopay ? "auto" : "company";
  $("bPayNote").value = bill.pay_note ?? "";
  logoUrl = bill.logo_url ?? null;
  paintLogo();
  $("logoHint").textContent = "";
  $("logoPicker").classList.add("hidden");
  $("logoResults").innerHTML = "";
  $("logoQuery").value = "";
  drawPages();
  $("bRepeat").value = bill.repeat_kind ?? "monthly";
  $("bDays").value = bill.repeat_days ?? "";
  $("bPaid").checked = !!bill.paid;
  showRepeatBits();
  $("bMethod").value = bill.split_method ?? "equal";
  $("deleteBill").classList.toggle("hidden", !bill.id);
  $("billErr").textContent = "";
  const sh = Object.fromEntries(shares.map((s) => [s.member_id, s]));
  const isNew = !bill.id;
  $("splitPeople").innerHTML = familyList().map((p) => {
    const s = sh[p.id];
    const on = isNew || !!s;
    const val = s ? (s.percent ?? s.fixed_amount ?? "") : "";
    return `<div class="split-row"><input type="checkbox" data-p="${p.id}" ${on ? "checked" : ""} aria-label="${esc(p.display_name)}">
      <span style="color:${esc(p.color)};font-weight:600">${esc(p.display_name)}</span>
      <input type="text" inputmode="decimal" data-v="${p.id}" value="${esc(val)}"></div>`;
  }).join("");
  document.querySelectorAll("#splitPeople input, #bMethod, #bAmount").forEach((el) => el.addEventListener("input", updateSplit));
  updateSplit();
  drawWhoPaid(personal ? [] : shares);
  window.scrollTo(0, 0);
}

// ---------- bill logos (P10): pick an app icon from Apple's App Store search ----------
let logoUrl = null;
function logoTile(b) {
  if (b.logo_url) return `<div class="logo" style="background-image:url('${esc(b.logo_url)}')"></div>`;
  return `<div class="logo">${esc((b.name || "?").slice(0, 1).toUpperCase())}</div>`;
}
function paintLogo() {
  const el = $("bLogo");
  el.style.backgroundImage = logoUrl ? `url('${logoUrl}')` : "";
  el.textContent = logoUrl ? "" : ($("bName").value || "?").slice(0, 1).toUpperCase();
  $("clearLogo").classList.toggle("hidden", !logoUrl);
}
async function searchLogos() {
  const q = $("logoQuery").value.trim();
  if (!q) return;
  $("logoResults").innerHTML = `<div class="sub">Searching…</div>`;
  try {
    const r = await fetch(`https://itunes.apple.com/search?entity=software&country=us&limit=9&term=${encodeURIComponent(q)}`);
    const results = (await r.json()).results || [];
    if (!results.length) return ($("logoResults").innerHTML = `<div class="sub" style="grid-column:1/-1">No apps found. Try a shorter name.</div>`);
    $("logoResults").innerHTML = results.map((a) => {
      const url = String(a.artworkUrl512 || a.artworkUrl100 || "").replace(/\/\d+x\d+bb\.(jpg|png)$/, "/256x256bb.$1");
      return `<button type="button" class="logo-pick" data-logo="${esc(url)}"><img src="${esc(a.artworkUrl100)}" alt="">${esc(a.trackName)}</button>`;
    }).join("");
  } catch {
    $("logoResults").innerHTML = `<div class="sub" style="grid-column:1/-1">Couldn't search right now. Check the internet and try again.</div>`;
  }
}
$("pickLogo").addEventListener("click", () => {
  $("logoPicker").classList.toggle("hidden");
  if (!$("logoQuery").value) $("logoQuery").value = $("bName").value.trim();
  if (!$("logoPicker").classList.contains("hidden") && $("logoQuery").value) searchLogos();
});
$("logoSearch").addEventListener("click", searchLogos);
$("logoQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchLogos(); } });
$("logoResults").addEventListener("click", (e) => {
  const b = e.target.closest("[data-logo]");
  if (!b) return;
  logoUrl = b.dataset.logo;
  paintLogo();
  $("logoPicker").classList.add("hidden");
});
$("clearLogo").addEventListener("click", () => { logoUrl = null; paintLogo(); });

// P26: upload your own logo (photo or screenshot) when there's no app logo.
// Squared onto a white 256x256 tile and stored in bill-media with a long-lasting link, so the TVs show it too.
function logoPng(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 256, pad = 16, c = document.createElement("canvas");
      c.width = S; c.height = S;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, S, S);
      const k = Math.min((S - 2 * pad) / img.naturalWidth, (S - 2 * pad) / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image"))), "image/png");
    };
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = URL.createObjectURL(file);
  });
}
const logoFile = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
logoFile.style.display = "none";
document.body.appendChild(logoFile);
$("uploadLogo").addEventListener("click", () => logoFile.click());
logoFile.addEventListener("change", async () => {
  const f = logoFile.files?.[0];
  logoFile.value = "";
  if (!f) return;
  const say = (t) => ($("logoHint").textContent = t);
  try {
    say("Uploading logo…");
    const blob = await logoPng(f);
    const folder = editing?.owner_id ? `${editing.owner_id}/logos` : "household/logos";
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`;
    const up = await db.storage.from("bill-media").upload(path, blob, { contentType: "image/png" });
    if (up.error) throw up.error;
    const { data, error } = await db.storage.from("bill-media").createSignedUrl(path, 315360000); // ~10 years
    if (error || !data?.signedUrl) throw error || new Error("no link");
    logoUrl = data.signedUrl;
    paintLogo();
    $("logoPicker").classList.add("hidden");
    say("Logo ready. Tap Save to keep it.");
  } catch (err) {
    say("Couldn't upload that logo: " + (err?.message || err));
  }
});

// ---------- reminder texts (P17): opens the phone's own Messages app, ready to send ----------
const APP_URL = "https://pauljlinenfelser-prog.github.io/family-board/";
function shareAmount(bill, share, shares) {
  const amt = Number(bill.amount || 0);
  if (bill.split_method === "percent") return (amt * Number(share.percent || 0)) / 100;
  if (bill.split_method === "fixed") return Number(share.fixed_amount || 0);
  return shares.length ? amt / shares.length : amt;
}
function reminderText(personName, billName, amount, due) {
  const pay = payeeFor(editing);
  let t = `Hi ${personName}, reminder from the Family Board: your share of ${billName} is ${money(amount)}, ${daysUntil(due) < 0 ? "was due" : "due"} ${fmtDate(due)}.`;
  const link = pay && pay.id === me.id ? cashAppLink(amount, pay) : null;
  if (link) t += ` Pay ${pay.display_name} with Cash App: ${link}`;
  return t + ` ${APP_URL}`;
}
function smsLink(phone, text) { return `sms:${phone}?body=${encodeURIComponent(text)}`; }

// ---------- last reminded + remind everyone (P24) ----------
function agoText(ts) {
  const secs = (Date.now() - new Date(ts).getTime()) / 1000;
  if (secs < 120) return "just now";
  if (secs < 3600) return Math.round(secs / 60) + "m ago";
  if (secs < 86400) return Math.round(secs / 3600) + "h ago";
  return Math.round(secs / 86400) + "d ago";
}
async function fillLastReminded(saved) {
  if (!editing?.id) return;
  const { data } = await db.from("reminder_log").select("member_id,created_at,via").eq("bill_id", editing.id).order("created_at", { ascending: false }).limit(50);
  const last = {};
  for (const r of data || []) last[r.member_id] ??= r;
  for (const s of saved) {
    const el = document.getElementById("rem-" + s.member_id);
    if (el) el.textContent = last[s.member_id] ? `Last reminded ${agoText(last[s.member_id].created_at)}${last[s.member_id].via === "auto" ? " (automatic)" : last[s.member_id].via === "tv" ? " (from the TV)" : ""}` : "";
  }
  const unpaid = saved.filter((s) => !s.paid);
  $("remindAll").classList.toggle("hidden", !unpaid.length || !!editing.paid);
  $("remindAll").textContent = `🔔 Remind everyone who hasn't paid (${unpaid.length})`;
}
$("remindAll").addEventListener("click", async () => {
  if (!editing?.id) return;
  if (!confirm("Send a reminder notification to everyone who hasn't paid this bill?")) return;
  $("remindAll").disabled = true;
  const { data, error } = await db.functions.invoke("notify", { body: { type: "remind_bill", bill_id: editing.id } });
  $("remindAll").disabled = false;
  if (error) return ($("billErr").textContent = "Couldn't send: " + error.message);
  $("billErr").style.color = "var(--paid)";
  $("billErr").textContent = `Reminder sent to ${data?.people ?? 0} ${data?.people === 1 ? "person" : "people"}.`;
  setTimeout(() => { $("billErr").textContent = ""; $("billErr").style.color = ""; }, 4000);
  drawWhoPaid(editingShares || []);
});

// ---------- who has paid their share (P9): the admin can mark each person ----------
let editingShares = null;
function drawWhoPaid(shares) {
  editingShares = shares;
  const saved = shares.filter((s) => s.id && people[s.member_id]);
  $("whoPaidBox").classList.toggle("hidden", !saved.length);
  if (!saved.length) return ($("whoPaid").innerHTML = "");
  const who = payeeFor(editing)?.display_name ?? "admin";
  const opts = [["", "Not paid"], ["to_admin", `Paid ${who}`], ["direct", "Paid the company"], ["cashapp", "Cash App"], ["other", "Other"]];
  $("whoPaid").innerHTML = saved.map((s) => {
    const p = people[s.member_id];
    const cur = s.paid ? s.paid_method ?? "other" : "";
    let note = s.paid && !s.confirmed
      ? `<div class="sub soon" style="grid-column:1/-1">Marked paid by ${esc(p.display_name)} — <a href="#" data-okshare="${s.id}">confirm ✓</a></div>` : "";
    if (!s.paid && p.id !== me.id && editing?.id) {
      note += p.phone
        ? `<div style="grid-column:1/-1"><a class="chip" style="display:inline-block;margin-top:2px;color:var(--accent)" href="${esc(smsLink(p.phone, reminderText(p.display_name, editing.name, shareAmount(editing, s, saved), editing.due_date)))}">💬 Text ${esc(p.display_name)} a reminder</a></div>`
        : `<div class="sub" style="grid-column:1/-1">${esc(p.display_name)} hasn't added a cell number yet (Me tab), so texting is off.</div>`;
      note += `<div style="grid-column:1/-1"><button type="button" class="chip" style="border:0;min-height:30px;color:var(--accent)" data-pushremind="${s.id}">🔔 Send ${esc(p.display_name)} a reminder notification</button></div>`;
    }
    note += `<div class="sub" id="rem-${s.member_id}" style="grid-column:1/-1;margin:0"></div>`;
    return `<div class="split-row" style="grid-template-columns:1fr 170px">
      <span style="color:${esc(p.color)};font-weight:600">${esc(p.display_name)}${s.paid && s.confirmed ? " ✓" : ""}</span>
      <select data-paidshare="${s.id}">${opts.map(([v, t]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      ${note}</div>`;
  }).join("");
  const err = (m) => ($("billErr").textContent = m);
  $("whoPaid").querySelectorAll("[data-paidshare]").forEach((sel) => sel.addEventListener("change", async () => {
    const s = saved.find((x) => x.id === sel.dataset.paidshare);
    const fields = sel.value
      ? { paid: true, paid_method: sel.value, paid_on: s.paid_on ?? localISO(), confirmed: true }
      : { paid: false, paid_method: null, paid_on: null, confirmed: false };
    sel.disabled = true;
    const { error } = await db.from("bill_shares").update(fields).eq("id", s.id);
    sel.disabled = false;
    if (error) return err("Couldn't save who paid: " + error.message);
    Object.assign(s, fields);
    drawWhoPaid(shares);
  }));
  $("whoPaid").querySelectorAll("[data-pushremind]").forEach((b) => b.addEventListener("click", async () => {
    const s = saved.find((x) => x.id === b.dataset.pushremind);
    const p = people[s.member_id];
    const amt = shareAmount(editing, s, saved);
    const body = `Your share of ${editing.name} is ${money(amt)}, ${daysUntil(editing.due_date) < 0 ? "was due" : "due"} ${fmtDate(editing.due_date)}.`;
    b.disabled = true;
    const { data, error } = await db.functions.invoke("notify", { body: { type: "remind", to: s.member_id, body, bill_id: editing.id } });
    b.disabled = false;
    if (error) return err("Couldn't send: " + error.message);
    b.textContent = data?.sent ? `✓ Sent to ${p.display_name}` : `${p.display_name} hasn't turned on notifications yet — try a text`;
  }));
  fillLastReminded(saved);
  $("whoPaid").querySelectorAll("[data-okshare]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    const s = saved.find((x) => x.id === a.dataset.okshare);
    const { error } = await db.from("bill_shares").update({ confirmed: true }).eq("id", s.id);
    if (error) return err("Couldn't confirm: " + error.message);
    s.confirmed = true;
    drawWhoPaid(shares);
  }));
}

function splitRows() {
  return familyList().map((p) => ({
    id: p.id, name: p.display_name,
    on: document.querySelector(`[data-p="${p.id}"]`).checked,
    val: parseFloat(document.querySelector(`[data-v="${p.id}"]`).value) || 0,
  })).filter((r) => r.on);
}

function updateSplit() {
  const method = $("bMethod").value;
  const amount = parseFloat($("bAmount").value) || 0;
  document.querySelectorAll("[data-v]").forEach((el) => {
    el.classList.toggle("hidden", method === "equal");
    el.placeholder = method === "percent" ? "%" : "$";
  });
  const rows = splitRows();
  let txt = "";
  if (!rows.length) txt = "Pick at least one person.";
  else if (method === "equal") txt = rows.map((r) => `${r.name} ${money(amount / rows.length)}`).join(" · ");
  else if (method === "percent") {
    const sum = rows.reduce((t, r) => t + r.val, 0);
    txt = rows.map((r) => `${r.name} ${money((amount * r.val) / 100)}`).join(" · ") + ` — total ${sum}%` + (Math.abs(sum - 100) > 0.01 ? " (should be 100%)" : " ✓");
  } else {
    const sum = rows.reduce((t, r) => t + r.val, 0);
    txt = `Shares add up to ${money(sum)} of ${money(amount)}` + (Math.abs(sum - amount) > 0.009 ? " (should match the bill)" : " ✓");
  }
  $("splitSummary").textContent = txt;
}

$("cancelBill").addEventListener("click", loadBills);

$("saveBill").addEventListener("click", async () => {
  $("billErr").textContent = "";
  const name = $("bName").value.trim();
  const amount = parseFloat(String($("bAmount").value).replace(/[$,]/g, ""));
  const due = $("bDue").value;
  const method = $("bMethod").value;
  const personal = !!editing.owner_id;
  const rows = personal ? [] : splitRows();
  if (!name) return ($("billErr").textContent = "Give the bill a name.");
  if (!(amount >= 0)) return ($("billErr").textContent = "Enter the amount, like 186.00");
  if (!due) return ($("billErr").textContent = "Pick a due date.");
  if (!personal && !rows.length) return ($("billErr").textContent = "Pick at least one person to split with.");
  if (method === "percent" && Math.abs(rows.reduce((t, r) => t + r.val, 0) - 100) > 0.01) return ($("billErr").textContent = "Percents need to add up to 100.");
  if (method === "fixed" && Math.abs(rows.reduce((t, r) => t + r.val, 0) - amount) > 0.009) return ($("billErr").textContent = "Fixed amounts need to add up to the bill amount.");

  let site = $("bSite").value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const repeat_kind = $("bRepeat").value;
  const repeat_days = repeat_kind === "days" ? parseInt($("bDays").value, 10) : null;
  if (repeat_kind === "days" && !(repeat_days >= 1 && repeat_days <= 365)) return ($("billErr").textContent = "Enter how many days between bills (1 to 365).");
  const fields = { name, amount, due_date: due, repeat_kind, repeat_days, split_method: method, website: site || null, logo_url: logoUrl, owner_id: null, admin_id: $("bAdmin").value || null,
    pay_url: normUrl($("bPayUrl").value), account_number: $("bAcct").value.trim() || null,
    autopay: $("bAutopay").value === "auto", pay_note: $("bPayNote").value.trim() || null };
  if (personal) Object.assign(fields, { owner_id: me.id, show_on_board: $("bShow").checked, split_method: "equal" });
  let billId = editing.id;
  if (billId) {
    const { error } = await db.from("bills").update(fields).eq("id", billId);
    if (error) return ($("billErr").textContent = "Couldn't save: " + error.message);
  } else {
    const { data, error } = await db.from("bills").insert(fields).select("id").single();
    if (error) return ($("billErr").textContent = "Couldn't save: " + error.message);
    billId = data.id;
  }
  // shares: keep paid status for people who stay on the bill (household bills only)
  if (!personal) {
  const keepIds = rows.map((r) => r.id);
  const { data: existing } = await db.from("bill_shares").select("member_id").eq("bill_id", billId);
  const drop = (existing || []).map((e) => e.member_id).filter((id) => !keepIds.includes(id));
  if (drop.length) await db.from("bill_shares").delete().eq("bill_id", billId).in("member_id", drop);
  const up = rows.map((r) => ({ bill_id: billId, member_id: r.id, percent: method === "percent" ? r.val : null, fixed_amount: method === "fixed" ? r.val : null }));
  const { error: shErr } = await db.from("bill_shares").upsert(up, { onConflict: "bill_id,member_id" });
  if (shErr) return ($("billErr").textContent = "Bill saved, but the split didn't: " + shErr.message);
  }
  // paid is saved last, so a repeating bill's next copy gets the split saved above
  const paid = $("bPaid").checked;
  if (paid !== !!editing.paid) {
    const { error: pErr } = await db.from("bills").update({ paid }).eq("id", billId);
    if (pErr) return ($("billErr").textContent = "Bill saved, but marking it paid didn't: " + pErr.message);
  }
  loadBills();
});

$("deleteBill").addEventListener("click", async () => {
  if (!editing?.id || !confirm(`Delete "${editing.name}"? Everyone's share of it goes too.`)) return;
  const { error } = await db.from("bills").delete().eq("id", editing.id);
  if (error) return ($("billErr").textContent = "Couldn't delete: " + error.message);
  loadBills();
});

async function clearSample() {
  if (!confirm("Remove all the sample bills, notes and events? Your real entries stay.")) return;
  await db.from("bills").delete().eq("notes", "SAMPLE");
  await db.from("notes").delete().like("body", "%(sample)");
  await db.from("events").delete().eq("notes", "SAMPLE");
  loadBills();
}

// ---------- installable app ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
