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
  const { data: rows } = await db.from("members").select("id,display_name,color,role,cashtag,bill_manager,avatar_path,must_change_password").order("created_at");
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
  const in14 = localISO(new Date(Date.now() + 14 * 86400000));

  const [due, shares, mine] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,owner_id,paid").eq("paid", false).lte("due_date", in14).order("due_date"),
    db.from("bill_share_amounts").select("bill_id,bill_name,share_amount,paid,due_date,member_id").eq("member_id", me.id).gte("due_date", monthStart).lt("due_date", nextMonth).order("due_date"),
    db.from("bills").select("id,name,amount,due_date,paid,show_on_board").eq("owner_id", me.id).gte("due_date", monthStart).lt("due_date", nextMonth).order("due_date"),
  ]);
  const items = [
    ...(shares.data || []).map((s) => ({ name: s.bill_name, amount: Number(s.share_amount), paid: s.paid, due: s.due_date, kind: "Household share" })),
    ...(mine.data || []).map((b) => ({ name: b.name, amount: Number(b.amount), paid: b.paid, due: b.due_date, kind: b.show_on_board ? "Personal" : "Personal · private" })),
  ].sort((a, b) => a.due.localeCompare(b.due));
  const total = items.reduce((t, i) => t + i.amount, 0);
  const paid = items.filter((i) => i.paid).reduce((t, i) => t + i.amount, 0);
  const pct = total ? Math.round((paid / total) * 100) : 0;
  const color = member?.color ?? "#7FA8F9";

  let html = `<h2>Your ${new Date().toLocaleDateString("en-US", { month: "long" })}</h2>
    <div class="card">
      <div class="sub">Left to pay this month</div>
      <div class="big">${money(total - paid)}</div>
      <div class="sub">${money(total)} total · ${money(paid)} paid</div>
      <div class="bar"><div style="width:${pct}%;background:${esc(color)}"></div></div>
    </div>`;
  html += items.length ? items.map(itemRow).join("") : `<div class="card sub">Nothing on your list this month.</div>`;

  html += `<h2>Due in the next 2 weeks</h2>`;
  const dueRows = due.data || [];
  html += dueRows.length
    ? dueRows.map((b) => {
        const d = daysUntil(b.due_date);
        const cls = d < 0 ? "late" : d <= 7 ? "soon" : "";
        const whose = b.owner_id ? people[b.owner_id]?.display_name ?? "Personal" : "Household";
        return `<div class="card row"><div class="grow"><div class="name">${esc(b.name)}</div>
          <div class="sub ${cls}">${dueLabel(b.due_date)} · ${esc(whose)}</div></div><div class="amt">${money(b.amount)}</div></div>`;
      }).join("")
    : `<div class="card sub">Nothing due in the next two weeks.</div>`;
  html += `<p class="sub center" style="margin-top:20px">Marking bills paid comes in the next version.</p>`;
  $("tab-board").innerHTML = html;
}

function itemRow(i) {
  const d = daysUntil(i.due);
  const cls = i.paid ? "paid" : d < 0 ? "late" : d <= 7 ? "soon" : "";
  return `<div class="card row"><div class="grow"><div class="name">${esc(i.name)}</div>
    <div class="sub ${cls}">${i.paid ? "Paid ✓" : dueLabel(i.due)} · ${esc(i.kind)}</div></div>
    <div class="amt ${i.paid ? "paid" : ""}">${money(i.amount)}</div></div>`;
}

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
  const { error } = await db.from("notes").insert({
    author_id: me.id, to_member: to, body: $("noteBody").value.trim(), pinned: $("notePin").checked, private: priv,
  });
  if (error) { $("noteErr").textContent = "Couldn't post: " + error.message; return; }
  $("noteBody").value = ""; $("notePin").checked = false; $("notePrivate").checked = false;
  loadNotes();
});

async function loadNotes() {
  const { data, error } = await db.from("notes").select("id,body,pinned,private,created_at,author_id,to_member").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(40);
  if (error) { $("noteList").innerHTML = `<div class="card sub">Couldn't load notes.</div>`; return; }
  $("noteList").innerHTML = (data || []).map((n) => {
    const a = people[n.author_id];
    const to = n.to_member ? people[n.to_member]?.display_name ?? "?" : "Everyone";
    const when = n.pinned ? "Pinned" : new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const mine = n.author_id === me.id || member?.role === "admin";
    return `<div class="card"><div class="note-head"><span style="color:${esc(a?.color ?? "#A7ADB8")};font-weight:700">${esc(a?.display_name ?? "Someone")} → ${esc(to)}${n.private ? " 🔒" : ""}</span>
      <span class="sub" style="margin:0">${when}</span></div><div class="note-body">${esc(n.body)}</div>
      ${mine ? `<button class="chip" data-del="${n.id}" style="margin-top:10px;border:0;min-height:32px">Delete</button>` : ""}</div>`;
  }).join("") || `<div class="card sub">No notes yet.</div>`;
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this note?")) return;
    await db.from("notes").delete().eq("id", b.dataset.del);
    loadNotes();
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
  const { error } = await db.from("members").update({ display_name: name, color: pickedColor, cashtag: cash || null }).eq("id", me.id);
  if (error) { $("profErr").textContent = "Couldn't save: " + error.message; return; }
  Object.assign(member, { display_name: name, color: pickedColor, cashtag: cash || null });
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
  const [bills, shares, sample] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,split_method,website,paid,next_bill_id").is("owner_id", null).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
    db.from("bill_shares").select("bill_id,member_id,percent,fixed_amount,paid"),
    db.from("bills").select("id", { count: "exact", head: true }).eq("notes", "SAMPLE"),
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
      <div class="grow"><div class="name">${esc(b.name)}</div>
      <div class="sub ${cls}">${b.paid ? "Paid ✓" : dueLabel(b.due_date)}${repeatLabel(b) ? " · " + repeatLabel(b) : ""}</div>
      <div class="sub">${who.length ? "Split: " + esc(who.join(", ")) : "Not split yet"}</div></div>
      <div class="amt">${money(b.amount)}</div></div>`;
  };
  if (pastDue.length) html += `<h2 class="late">Past due</h2>` + pastDue.map(billRow).join("") + `<h2>This month &amp; coming up</h2>`;
  html += current.length ? current.map(billRow).join("") : `<div class="card sub">No household bills this month yet.</div>`;
  if (canManage()) html += `<p class="sub center">Tap a bill to edit it.</p>`;
  if (member?.role === "admin" && sample.count) html += `<button class="btn ghost" id="clearSample" style="margin-top:20px">Remove the sample data (${sample.count} sample bills)</button>`;
  $("billsList").innerHTML = html;
  $("newBill")?.addEventListener("click", () => openEditor({}, []));
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
  $("editorTitle").textContent = bill.id ? "Edit household bill" : "New household bill";
  $("bName").value = bill.name ?? "";
  $("bAmount").value = bill.amount ?? "";
  $("bDue").value = bill.due_date ?? localISO(new Date(Date.now() + 14 * 86400000));
  $("bSite").value = bill.website ?? "";
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
  window.scrollTo(0, 0);
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
  const rows = splitRows();
  if (!name) return ($("billErr").textContent = "Give the bill a name.");
  if (!(amount >= 0)) return ($("billErr").textContent = "Enter the amount, like 186.00");
  if (!due) return ($("billErr").textContent = "Pick a due date.");
  if (!rows.length) return ($("billErr").textContent = "Pick at least one person to split with.");
  if (method === "percent" && Math.abs(rows.reduce((t, r) => t + r.val, 0) - 100) > 0.01) return ($("billErr").textContent = "Percents need to add up to 100.");
  if (method === "fixed" && Math.abs(rows.reduce((t, r) => t + r.val, 0) - amount) > 0.009) return ($("billErr").textContent = "Fixed amounts need to add up to the bill amount.");

  let site = $("bSite").value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const repeat_kind = $("bRepeat").value;
  const repeat_days = repeat_kind === "days" ? parseInt($("bDays").value, 10) : null;
  if (repeat_kind === "days" && !(repeat_days >= 1 && repeat_days <= 365)) return ($("billErr").textContent = "Enter how many days between bills (1 to 365).");
  const fields = { name, amount, due_date: due, repeat_kind, repeat_days, split_method: method, website: site || null, owner_id: null };
  let billId = editing.id;
  if (billId) {
    const { error } = await db.from("bills").update(fields).eq("id", billId);
    if (error) return ($("billErr").textContent = "Couldn't save: " + error.message);
  } else {
    const { data, error } = await db.from("bills").insert(fields).select("id").single();
    if (error) return ($("billErr").textContent = "Couldn't save: " + error.message);
    billId = data.id;
  }
  // shares: keep paid status for people who stay on the bill
  const keepIds = rows.map((r) => r.id);
  const { data: existing } = await db.from("bill_shares").select("member_id").eq("bill_id", billId);
  const drop = (existing || []).map((e) => e.member_id).filter((id) => !keepIds.includes(id));
  if (drop.length) await db.from("bill_shares").delete().eq("bill_id", billId).in("member_id", drop);
  const up = rows.map((r) => ({ bill_id: billId, member_id: r.id, percent: method === "percent" ? r.val : null, fixed_amount: method === "fixed" ? r.val : null }));
  const { error: shErr } = await db.from("bill_shares").upsert(up, { onConflict: "bill_id,member_id" });
  if (shErr) return ($("billErr").textContent = "Bill saved, but the split didn't: " + shErr.message);
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
