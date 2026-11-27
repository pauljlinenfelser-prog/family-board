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
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

async function start(user) {
  if (me?.id === user.id) return;
  me = user;
  const { data: rows } = await db.from("members").select("id,display_name,color,role,cashtag,bill_manager").order("created_at");
  people = Object.fromEntries((rows || []).map((r) => [r.id, r]));
  member = people[user.id];
  if (member?.role === "display") {
    await db.auth.signOut();
    $("loginErr").textContent = "That's the TV's account. Sign in with your own.";
    return;
  }
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("hello").textContent = `Hi, ${member?.display_name ?? "there"}`;
  $("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("me").textContent = (member?.display_name ?? "?").slice(0, 1);
  $("me").style.background = member?.color ?? "#8A919E";
  $("meName").textContent = member?.display_name ?? "";
  $("meEmail").textContent = user.email;
  $("meRole").textContent = member?.role === "admin" ? "Admin" : member?.bill_manager ? "Bill manager" : "Family member";
  fillNoteTo();
  loadBoard();
  loadNotes();
}

// ---------- tabs ----------
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    ["board", "notes", "me"].forEach((t) => $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    if (b.dataset.tab === "board") loadBoard();
    if (b.dataset.tab === "notes") loadNotes();
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
  html += `<p class="sub center" style="margin-top:20px">Adding bills and marking them paid come in the next versions.</p>`;
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

// ---------- installable app ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
