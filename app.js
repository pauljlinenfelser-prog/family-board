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

  const [due, shares, mine, toConfirm] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,owner_id,paid").eq("paid", false).lte("due_date", in14).order("due_date"),
    // this month's shares, plus unpaid ones from earlier months (past due)
    db.from("bill_share_amounts").select("id,bill_id,bill_name,share_amount,paid,paid_method,confirmed,due_date,member_id").eq("member_id", me.id)
      .or(`and(due_date.gte.${monthStart},due_date.lt.${nextMonth}),and(paid.eq.false,due_date.lt.${monthStart})`).order("due_date"),
    db.from("bills").select("id,name,amount,due_date,paid,show_on_board").eq("owner_id", me.id).gte("due_date", monthStart).lt("due_date", nextMonth).order("due_date"),
    canManage()
      ? db.from("bill_share_amounts").select("id,bill_name,share_amount,paid_method,paid_on,due_date,member_id").eq("paid", true).eq("confirmed", false).neq("member_id", me.id).order("due_date")
      : Promise.resolve({ data: [] }),
  ]);
  const waiting = toConfirm.data || [];
  const items = [
    ...(shares.data || []).map((s) => ({ shareId: s.id, name: s.bill_name, amount: Number(s.share_amount), paid: s.paid, method: s.paid_method, confirmed: s.confirmed, due: s.due_date, kind: "Household share" })),
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
  if (items.some((i) => i.shareId && !i.paid)) html += `<p class="sub center">Tap one of your shares to mark it paid.</p>`;

  if (waiting.length) {
    html += `<h2>Waiting for you to confirm</h2>`;
    html += waiting.map((w) => {
      const p = people[w.member_id];
      return `<div class="card row"><div class="grow"><div class="name">${esc(p?.display_name ?? "Someone")} · ${esc(w.bill_name)}</div>
        <div class="sub">${money(w.share_amount)} · ${esc(methodLabel(w.paid_method))}${w.paid_on ? " · " + fmtDate(w.paid_on) : ""}</div></div>
        <button class="btn" data-confirm="${w.id}" style="width:auto;min-height:44px;margin:0;padding:0 18px">Confirm ✓</button></div>`;
    }).join("");
  }

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
  $("tab-board").innerHTML = html;
  boardItems = items;
}

function itemRow(i) {
  const d = daysUntil(i.due);
  const cls = i.paid ? "paid" : d < 0 ? "late" : d <= 7 ? "soon" : "";
  let status = i.paid ? "Paid ✓" : dueLabel(i.due);
  if (i.paid && i.shareId) status = i.confirmed ? "Paid ✓ · confirmed" : `Paid · ${methodLabel(i.method)} · waiting for ${payee()?.display_name ?? "admin"} to confirm`;
  return `<div class="card row" ${i.shareId ? `data-share="${i.shareId}" style="cursor:pointer"` : ""}><div class="grow"><div class="name">${esc(i.name)}</div>
    <div class="sub ${cls}">${esc(status)} · ${esc(i.kind)}</div></div>
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
  h += `<button class="btn ghost" data-back="1">Back</button><div class="err" id="shareErr"></div></div>`;
  $("tab-board").innerHTML = h;
  window.scrollTo(0, 0);
  $("tab-board").querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => markShare(i, b.dataset.pay)));
  $("tab-board").querySelector("[data-back]").addEventListener("click", loadBoard);
}

async function markShare(i, how) {
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
  const row = e.target.closest("[data-share]");
  if (row) {
    const i = boardItems.find((x) => x.shareId === row.dataset.share);
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
  const [bills, shares, sample, mine] = await Promise.all([
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,split_method,website,logo_url,paid,next_bill_id").is("owner_id", null).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
    db.from("bill_shares").select("id,bill_id,member_id,percent,fixed_amount,paid,paid_method,paid_on,confirmed"),
    db.from("bills").select("id", { count: "exact", head: true }).eq("notes", "SAMPLE"),
    db.from("bills").select("id,name,amount,due_date,repeat_kind,repeat_days,website,logo_url,paid,next_bill_id,owner_id,show_on_board").eq("owner_id", me.id).or(`due_date.gte.${monthStart},paid.eq.false`).order("due_date"),
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
    const note = s.paid && !s.confirmed
      ? `<div class="sub soon" style="grid-column:1/-1">Marked paid by ${esc(p.display_name)} — <a href="#" data-okshare="${s.id}">confirm ✓</a></div>` : "";
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
