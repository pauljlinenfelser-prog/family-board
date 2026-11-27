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
  const { data: rows } = await db.from("members").select("id,display_name,color,role,cashtag,bill_manager,avatar_path,must_change_password,phone").order("created_at");
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
    db.from("bills").select("id,name,amount,due_date,paid,show_on_board,logo_url,website,repeat_kind,repeat_days,full_images").eq("owner_id", me.id)
      .lte("due_date", in30).or(windowFilter).order("due_date"),
    canManage()
      ? db.from("bill_share_amounts").select("id,bill_name,share_amount,paid_method,paid_on,due_date,member_id").eq("paid", true).eq("confirmed", false).neq("member_id", me.id).order("due_date")
      : Promise.resolve({ data: [] }),
    db.from("events").select("id,title,kind,starts_at,ends_at,all_day,member_id,notes").lte("starts_at", in7 + "T23:59:59")
      .or(`starts_at.gte.${today},ends_at.gte.${today}`).order("starts_at").limit(30),
  ]);
  // logos + repeat info for the household bills behind my shares
  const billIds = [...new Set((shares.data || []).map((s) => s.bill_id))];
  const { data: shareBills } = billIds.length
    ? await db.from("bills").select("id,logo_url,website,repeat_kind,repeat_days,full_images").in("id", billIds)
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
  const cards = open.slice(0, 8).reverse(); // most urgent ends up in front
  if (cards.length) {
    const step = 58, h = 176;
    html += `<div class="wallet" style="height:${(cards.length - 1) * step + h}px">` + cards.map((i, k) => walletCard(i, k, step)).join("") + `</div>`;
    html += `<p class="sub center">Tap a card to bring it forward. Tap it again to pay or mark it paid.</p>`;
    if (open.length > cards.length) html += `<p class="sub center">+ ${open.length - cards.length} more on the Bills tab</p>`;
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
function walletCard(i, k, step) {
  const [bg, fg, soft] = cardColors(i);
  const key = i.shareId ? "s:" + i.shareId : "p:" + i.personalId;
  const logo = i.info.logo_url
    ? `<div class="wlogo" style="background-image:url('${esc(i.info.logo_url)}')"></div>`
    : `<div class="wlogo" style="background-color:${fg};color:${bg}">${esc(i.name.slice(0, 1).toUpperCase())}</div>`;
  const sub = [i.kind === "household" ? "Household" : i.kind === "private" ? "🔒 Private" : "Personal", repeatLabel(i.info)].filter(Boolean).join(" · ");
  const pill = i.kind === "household" ? `Bill ${money(i.billAmount)}` : "Tap to mark paid";
  return `<div class="wcard" data-card="${key}" style="top:${k * step}px;z-index:${k + 1};background:${bg};color:${fg}">
    <div class="row">${logo}<div class="grow"><div class="name">${esc(i.name)}</div><div style="font-size:12px;color:${soft}">${esc(sub)}</div></div></div>
    <div class="wamt">${money(i.amount)}${i.kind === "household" ? `<span style="font-size:12px;font-weight:600;color:${soft}"> your share</span>` : ""}</div>
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
  for (const i of open) if (i.due >= today && i.due <= days[6]) list.push({ day: i.due, color: "#F2C14E", text: `${i.name} due`, when: fmtShort(i.due) });
  list.sort((a, b) => a.day.localeCompare(b.day));
  weekEvents = list.filter((x) => x.ev).map((x) => x.ev);
  let h = `<h2 class="row" style="justify-content:space-between">This week <span><a href="#" data-allev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600;margin-right:14px">See all</a><a href="#" data-addev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600">+ Add</a></span></h2><div class="card"><div class="week">` + days.map((d) => {
    const dots = [...new Set(list.filter((x) => x.day === d).map((x) => x.color))].slice(0, 3);
    return `<div class="wday ${d === today ? "on" : ""}"><div class="sub">${new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" })}</div>
      <div class="wnum">${Number(d.slice(8))}</div><div class="wdots">${dots.map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</div></div>`;
  }).join("") + `</div>`;
  h += list.length
    ? list.slice(0, 6).map((x) => `<div class="wev" ${x.ev ? `data-ev="${x.ev.id}" style="cursor:pointer"` : ""}><i style="background:${esc(x.color)}"></i><span class="sub" style="width:74px;margin:0">${esc(x.when)}</span><span>${esc(x.text)}</span></div>`).join("")
    : `<div class="sub" style="margin-top:10px">Nothing on the calendar this week.</div>`;
  return h + `</div>`;
}
// ---------- calendar events and away times (P13) ----------
let weekEvents = [];
const canEditEvent = (e) => !e.id || e.member_id === me.id || member?.role === "admin";
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

async function openAllEvents() {
  const today = localISO();
  const { data } = await db.from("events").select("id,title,kind,starts_at,ends_at,all_day,member_id,notes")
    .or(`starts_at.gte.${today},ends_at.gte.${today}`).order("starts_at").limit(100);
  const rows = data || [];
  weekEvents = rows;
  let h = `<h2 class="row" style="justify-content:space-between">Coming up <a href="#" data-addev="1" style="color:var(--accent);text-transform:none;letter-spacing:0;font-weight:600">+ Add</a></h2>`;
  h += rows.length ? rows.map((e) => {
    const p = people[e.member_id];
    const sd = localISO(new Date(e.starts_at)), ed = e.ends_at ? localISO(new Date(e.ends_at)) : sd;
    let when = fmtDate(sd) + (ed !== sd ? " – " + fmtDate(ed) : "");
    if (!e.all_day) when += " · " + new Date(e.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `<div class="card row" ${canEditEvent(e) ? `data-ev="${e.id}" style="cursor:pointer"` : ""}>
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
  const { data } = await db.from("photos").select("id,path,caption,taken_on,show_on_board,uploaded_by,created_at").order("created_at", { ascending: false }).limit(6);
  const rows = data || [];
  const el = $("homePhotos");
  if (!el) return;
  if (!rows.length) { el.innerHTML = `<div class="card sub center" style="grid-column:1/-1;padding:22px 16px">No photos yet. Tap + Add to share some — they'll rotate on the TV too.</div>`; return; }
  const urls = await signPhotos(rows);
  photoRows = rows.map((r) => ({ ...r, url: urls[r.path] }));
  el.innerHTML = photoRows.map((r) => `<button class="ph" data-ph="${r.id}" style="background-image:url('${esc(r.url ?? "")}')" aria-label="${esc(r.caption ?? "Photo")}"></button>`).join("");
}
async function openAllPhotos() {
  $("tab-board").innerHTML = `<h2 class="row" style="justify-content:space-between">Family photos <a href="#" data-addph="1" class="hlink">+ Add</a></h2><div id="allPhotos" class="phgrid"><div class="sub">Loading…</div></div><button class="btn ghost" data-back="1">Back</button>`;
  window.scrollTo(0, 0);
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
  const { data } = await db.from("photos").select("id,path,caption,taken_on,show_on_board,uploaded_by,created_at").order("created_at", { ascending: false }).limit(300);
  const rows = data || [];
  const urls = await signPhotos(rows);
  photoRows = rows.map((r) => ({ ...r, url: urls[r.path] }));
  $("allPhotos").innerHTML = photoRows.length
    ? photoRows.map((r) => `<button class="ph" data-ph="${r.id}" style="background-image:url('${esc(r.url ?? "")}')">${r.show_on_board ? "" : `<span class="phtag">Not on TV</span>`}</button>`).join("")
    : `<div class="card sub center" style="grid-column:1/-1">No photos yet.</div>`;
}
function openPhoto(r) {
  const mineOrAdmin = r.uploaded_by === me.id || member?.role === "admin";
  const by = people[r.uploaded_by]?.display_name ?? "Someone";
  let h = `<div class="card" style="padding:10px"><img src="${esc(r.url ?? "")}" alt="" style="width:100%;border-radius:12px;display:block">
    <div class="sub" style="margin:10px 4px 0">${r.caption ? esc(r.caption) + " · " : ""}Added by ${esc(by)} · ${fmtDate(localISO(new Date(r.created_at)))}</div></div>`;
  if (mineOrAdmin) {
    h += `<label for="phCap">Caption</label><input id="phCap" maxlength="80" value="${esc(r.caption ?? "")}" placeholder="Lake trip, Brock's first deer…">
      <div class="check"><input type="checkbox" id="phTv" ${r.show_on_board ? "checked" : ""}><label for="phTv" style="margin:0;color:var(--text)">Show on the TV</label></div>
      <button class="btn" id="phSave">Save</button>
      <button class="btn ghost" id="phDel" style="color:var(--red)">Delete photo</button>`;
  }
  h += `<button class="btn ghost" data-allph="1">Back to photos</button><div class="err" id="phErr"></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("phSave")?.addEventListener("click", async () => {
    const { error } = await db.from("photos").update({ caption: $("phCap").value.trim() || null, show_on_board: $("phTv").checked }).eq("id", r.id);
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
      const { error } = await db.from("photos").insert({ path, uploaded_by: me.id, taken_on: f.lastModified ? localISO(new Date(f.lastModified)) : null });
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
  if (i.paid && i.shareId) status = i.confirmed ? "Paid ✓ · confirmed" : `Paid · ${methodLabel(i.method)} · waiting for ${payee()?.display_name ?? "admin"} to confirm`;
  const key = i.shareId ? "s:" + i.shareId : "p:" + i.personalId;
  return `<div class="card row" data-card="${key}" style="cursor:pointer"><div class="grow"><div class="name">${esc(i.name)}</div>
    <div class="sub ${cls}">${esc(status)}</div></div>
    <div class="amt ${i.paid ? "paid" : ""}">${money(i.amount)}</div></div>`;
}

// ---------- marking shares paid (P8) ----------
let boardItems = [];
// household shares are paid back to the admin
const payee = () => Object.values(people).find((p) => p.role === "admin");
function methodLabel(m) {
  const who = payee()?.display_name ?? "admin";
  return { to_admin: `paid ${who}`, direct: "paid the company", cashapp: "Cash App", other: "other" }[m] ?? "paid";
}
function cashAppLink(amount) {
  const tag = String(payee()?.cashtag ?? "").trim().replace(/^\$/, "");
  if (!tag) return null;
  return `https://cash.app/$${encodeURIComponent(tag)}/${Number(amount).toFixed(2)}`;
}

function openShare(i) {
  const pay = payee();
  const iAmPayee = pay?.id === me.id;
  const link = iAmPayee ? null : cashAppLink(i.amount);
  if (i.personalId) {
    let h = `<h2>${esc(i.name)}</h2><div class="card"><div class="sub">Your bill</div><div class="big">${money(i.amount)}</div>
      <div class="sub">${i.paid ? "Paid ✓" : dueLabel(i.due)}</div>`;
    h += i.paid ? `<button class="btn ghost" data-pay="undo" style="color:var(--red)">Undo — not paid yet</button>`
      : `<button class="btn" data-pay="direct">Mark paid</button>`;
    if (i.info.website) h += `<a class="btn ghost" href="https://${esc(i.info.website)}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Open ${esc(i.info.website)}</a>`;
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
    <div class="sub">${i.paid ? (i.confirmed ? "Paid ✓ · confirmed" : "Paid · " + esc(methodLabel(i.method))) : dueLabel(i.due)}</div>`;
  if (!i.paid) {
    if (link) h += `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none;background:#00D64F;color:#04210F">Pay ${money(i.amount)} with Cash App</a>
      <div class="sub center" style="margin-top:6px">Opens Cash App to ${esc(pay.display_name)}. Come back and tap "I paid with Cash App".</div>`;
    else if (!iAmPayee && pay) h += `<div class="sub" style="margin-top:10px">${esc(pay.display_name)} hasn't added a Cash App tag yet (Me tab), so the Cash App button is hidden.</div>`;
    if (!iAmPayee) {
      h += `<button class="btn ghost" data-pay="cashapp">I paid with Cash App</button>`;
      h += `<button class="btn ghost" data-pay="to_admin">I paid ${esc(pay?.display_name ?? "admin")}</button>`;
    }
    h += `<button class="btn ghost" data-pay="direct">I paid the company directly</button>`;
  } else if (!i.confirmed) {
    h += `<button class="btn ghost" data-pay="undo" style="color:var(--red)">Undo — I haven't paid this yet</button>`;
  }
  h += viewBillButton(i.info, i.name);
  h += `<button class="btn ghost" data-back="1">Back</button><div class="err" id="shareErr"></div></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("tab-board").querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => markShare(i, b.dataset.pay)));
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
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
  if (e.target.closest("[data-addev]")) { e.preventDefault(); return openEvent({}); }
  if (e.target.closest("[data-addph]")) { e.preventDefault(); return photoPicker.click(); }
  if (e.target.closest("[data-allph]")) { e.preventDefault(); return openAllPhotos(); }
  const phBtn = e.target.closest("[data-ph]");
  if (phBtn) { const r = photoRows.find((x) => x.id === phBtn.dataset.ph); if (r) openPhoto(r); return; }
  if (e.target.closest("[data-allev]")) { e.preventDefault(); return openAllEvents(); }
  const evRow = e.target.closest("[data-ev]");
  if (evRow) {
    const ev = weekEvents.find((x) => x.id === evRow.dataset.ev);
    if (ev && canEditEvent(ev)) openEvent(ev);
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
  const [bills, shares, sample, mine] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,split_method,website,logo_url,paid,next_bill_id,full_images").is("owner_id", null).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
    db.from("bill_shares").select("id,bill_id,member_id,percent,fixed_amount,paid,paid_method,paid_on,confirmed"),
    db.from("bills").select("id", { count: "exact", head: true }).eq("notes", "SAMPLE"),
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,website,logo_url,paid,next_bill_id,owner_id,show_on_board,full_images").eq("owner_id", me.id).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
  ]);
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
      <div class="sub">${who.length ? "Split: " + esc(who.join(", ")) + ` · ${(byBill[b.id] || []).filter((s) => s.paid).length} of ${who.length} paid` : "Not split yet"}</div></div>
      <div class="amt">${money(b.amount)}</div></div>`;
  };
  if (pastDue.length) html += `<h2 class="late">Past due</h2>` + pastDue.map(billRow).join("") + `<h2>This month &amp; coming up</h2>`;
  html += current.length ? current.map(billRow).join("") : `<div class="card sub">No household bills this month yet.</div>`;
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
      <div class="sub">${b.show_on_board ? "On the family board" : "🔒 Private — only you see this"}</div></div>
      <div class="amt">${money(b.amount)}</div></div>`;
  }).join("") : `<div class="card sub">No personal bills yet. Add things only you pay (phone, car, card…).</div>`;

  if (member?.role === "admin" && sample.count) html += `<button class="btn ghost" id="clearSample" style="margin-top:20px">Remove the sample data (${sample.count} sample bills)</button>`;
  $("billsList").innerHTML = html;
  $("newBill")?.addEventListener("click", () => openEditor({}, []));
  $("newMine").addEventListener("click", () => openEditor({ owner_id: me.id, show_on_board: true }, []));
  document.querySelectorAll("[data-mine]").forEach((el) => el.addEventListener("click", () => {
    openEditor(myRows.find((r) => r.id === el.dataset.mine), []);
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
  $("bName").value = bill.name ?? "";
  $("bAmount").value = bill.amount ?? "";
  $("bDue").value = bill.due_date ?? localISO(new Date(Date.now() + 14 * 86400000));
  $("bSite").value = bill.website ?? "";
  logoUrl = bill.logo_url ?? null;
  paintLogo();
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

// ---------- reminder texts (P17): opens the phone's own Messages app, ready to send ----------
const APP_URL = "https://pauljlinenfelser-prog.github.io/family-board/";
function shareAmount(bill, share, shares) {
  const amt = Number(bill.amount || 0);
  if (bill.split_method === "percent") return (amt * Number(share.percent || 0)) / 100;
  if (bill.split_method === "fixed") return Number(share.fixed_amount || 0);
  return shares.length ? amt / shares.length : amt;
}
function reminderText(personName, billName, amount, due) {
  const pay = payee();
  let t = `Hi ${personName}, reminder from the Family Board: your share of ${billName} is ${money(amount)}, ${daysUntil(due) < 0 ? "was due" : "due"} ${fmtDate(due)}.`;
  const link = pay && pay.id === me.id ? cashAppLink(amount) : null;
  if (link) t += ` Pay ${pay.display_name} with Cash App: ${link}`;
  return t + ` ${APP_URL}`;
}
function smsLink(phone, text) { return `sms:${phone}?body=${encodeURIComponent(text)}`; }

// ---------- who has paid their share (P9): the admin can mark each person ----------
function drawWhoPaid(shares) {
  const saved = shares.filter((s) => s.id && people[s.member_id]);
  $("whoPaidBox").classList.toggle("hidden", !saved.length);
  if (!saved.length) return ($("whoPaid").innerHTML = "");
  const who = payee()?.display_name ?? "admin";
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
    const { data, error } = await db.functions.invoke("notify", { body: { type: "remind", to: s.member_id, body } });
    b.disabled = false;
    if (error) return err("Couldn't send: " + error.message);
    b.textContent = data?.sent ? `✓ Sent to ${p.display_name}` : `${p.display_name} hasn't turned on notifications yet — try a text`;
  }));
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
  const fields = { name, amount, due_date: due, repeat_kind, repeat_days, split_method: method, website: site || null, logo_url: logoUrl, owner_id: null };
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
