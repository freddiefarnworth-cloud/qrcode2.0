import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";

/** ========= helpers ========= */
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  return createClient(url, key);
}
const monthKey = (d = new Date()) => d.toISOString().slice(0,7); // YYYY-MM
const todayUtc = () => new Date().toISOString().slice(0,10);     // YYYY-MM-DD
const genCode = () => randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2,8);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.WIDGET_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function ensureMonthlyCodes(supa, userId, mk) {
  const defs = [
    { label: "20% Off Drinks", policy: "always_show" },
    { label: "Free Beer/Coffee", policy: "hide_on_redeem" }
  ];
  for (const def of defs) {
    const { data: exists } = await supa
      .from("codes").select("id")
      .eq("user_id", userId).eq("month_key", mk).eq("display_policy", def.policy)
      .maybeSingle();
    if (!exists) {
      await supa.from("codes").insert({
        user_id: userId, code: genCode(), month_key: mk,
        benefit_label: def.label, display_policy: def.policy
      });
    }
  }
}

/** ========= API handlers ========= */
async function apiMyCodes(req, res, supa, url) {
  const email = url.searchParams.get("email");
  if (!email) return res.status(400).json({ error: "missing_email" });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }
  const token = auth.slice(7);
  const { data: authData, error: authErr } = await supa.auth.getUser(token);
  if (authErr || !authData.user || authData.user.email !== email) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const { data: user } = await supa.from("users").select("*").eq("email", email).single();
  if (!user) return res.status(403).json({ error: "unknown_member" });
  if (user.active_until < todayUtc()) return res.json({ codes: [], reason: "inactive_membership" });

  const mk = monthKey();
  await ensureMonthlyCodes(supa, user.id, mk);

  const { data: rows } = await supa.from("codes").select("*").eq("user_id", user.id).eq("month_key", mk);
  const out = rows
    .filter(r => r.display_policy === "always_show" || !r.redeemed_at)
    .map(r => ({ code: r.code, benefit_label: r.benefit_label, display_policy: r.display_policy, month_key: r.month_key }));
  res.json({ codes: out });
}

async function apiValidate(req, res, supa, url) {
  const code = url.searchParams.get("code");
  if (!code) return res.status(400).json({ error: "missing_code" });
  const { data: row } = await supa.from("codes").select("*, users(*)").eq("code", code).single();
  if (!row) return res.status(404).json({ valid: false, reason: "not_found" });
  if (row.users.active_until < todayUtc()) return res.status(403).json({ valid:false, reason:"inactive" });

  const currentMonth = monthKey();
  if (row.month_key !== currentMonth) return res.status(409).json({ valid:false, reason:"wrong_month", month_key: row.month_key });
  if (row.display_policy === "hide_on_redeem" && row.redeemed_at) {
    return res.status(409).json({ valid:false, reason:"already_redeemed", redeemed_at: row.redeemed_at });
  }
  res.json({ valid:true, display_policy:row.display_policy, benefit_label:row.benefit_label, month_key:row.month_key, user_email:row.users.email });
}

async function apiRedeem(req, res, supa, body) {
  const token = process.env.STAFF_REDEEM_TOKEN || "";
  const auth = req.headers.authorization || "";
  if (!token || !auth.startsWith("Bearer ") || auth.slice(7) !== token) {
    return res.status(401).json({ ok:false, error:"unauthorized" });
  }
  const { code, discount_type, discount_value, gross_amount = 0, till_txn_id = null, staff_id = null, store_id = null } = body || {};
  if (!code || !discount_type || discount_value == null) return res.status(400).json({ ok:false, error:"missing_fields" });

  const { data: row } = await supa.from("codes").select("*, users(*)").eq("code", code).single();
  if (!row) return res.status(404).json({ ok:false, error:"not_found" });
  if (row.users.active_until < todayUtc()) return res.status(403).json({ ok:false, error:"inactive" });

  const currentMonth = monthKey();
  if (row.month_key !== currentMonth) return res.status(409).json({ ok:false, error:"wrong_month", month_key: row.month_key });
  if (row.display_policy === "hide_on_redeem" && row.redeemed_at) return res.status(409).json({ ok:false, error:"already_redeemed" });

  let saved = 0;
  const base = Number(gross_amount) || 0;
  if (discount_type === "percent") {
    saved = +(base * (Number(discount_value)/100)).toFixed(2);
  } else if (discount_type === "fixed") {
    saved = +Math.min(base, Number(discount_value)).toFixed(2);
  } else if (discount_type === "item") {
    const cap = Number(process.env.FREE_ITEM_CAP || 0);
    saved = cap > 0 ? +Math.min(base, cap).toFixed(2) : +base.toFixed(2);
  } else {
    return res.status(400).json({ ok:false, error:"bad_discount_type" });
  }

  const red = {
    code_id: row.id, user_id: row.user_id,
    staff_id, store_id, gross_amount: base,
    discount_type, discount_value, amount_saved: saved, till_txn_id
  };
  // insert redemption (idempotency by (code_id, till_txn_id))
  const ins = await supa.from("redemptions").insert(red).select("*");
  if (!ins.error && row.display_policy === "hide_on_redeem") {
    await supa.from("codes").update({ redeemed_at: new Date().toISOString() }).eq("id", row.id);
  } else if (!ins.error && row.display_policy === "always_show") {
    await supa.from("codes").update({ redemption_count: row.redemption_count + 1 }).eq("id", row.id);
  }

  // summaries (RPC if present, else fallback)
  let monthSum = null, allSum = null;
  try {
    monthSum = (await supa.rpc("sum_savings_period", { p_user_id: row.user_id, p_period: "this_month" })).data;
    allSum   = (await supa.rpc("sum_savings_period", { p_user_id: row.user_id, p_period: "all_time" })).data;
  } catch(_) {}
  res.json({ ok:true, amount_saved: saved, currency: process.env.DEFAULT_CURRENCY || "GBP",
             this_month: monthSum || { uses:0, saved:0 }, all_time: allSum || { uses:0, saved:0 } });
}

/** ========= static assets served by this same function ========= */
async function serveWidgetJS(res) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  const js = await readFile(new URL("../public/widget.js", import.meta.url));
  res.end(js);
}

function serveRedeemHTML(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const token = process.env.STAFF_REDEEM_TOKEN || "";
  res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Member QR Redemption</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f8fafc;padding:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;max-width:560px;margin:0 auto}
.ok{background:#dcfce7;border:1px solid #22c55e;padding:12px;border-radius:8px}
.err{background:#fee2e2;border:1px solid #ef4444;padding:12px;border-radius:8px}
label{display:block;margin-top:8px} input,select{padding:10px;border:1px solid #cbd5e1;border-radius:8px;width:100%}
button{margin-top:12px;padding:10px 14px;border-radius:8px;border:1px solid #1e293b;background:#1e293b;color:#fff}
</style></head><body>
<div class="card">
  <h2>Member QR Redemption</h2>
  <div id="status"></div>
  <div id="form" style="display:none">
    <label>Discount Type
      <select id="discount_type">
        <option value="percent">Percent (20%)</option>
        <option value="item">Free Beer/Coffee</option>
      </select>
    </label>
    <label>Bill / Drink Price
      <input id="gross" type="number" step="0.01" placeholder="e.g., 12.50"/>
    </label>
    <label>POS Transaction ID (optional) <input id="txn" placeholder="POS-12345"/></label>
    <label>Store (optional) <input id="store" placeholder="Taproom-1"/></label>
    <label>Staff ID / Initials (optional) <input id="staff" placeholder="AB"/></label>
    <button id="redeem">Redeem</button>
  </div>
</div>
<script>
const API = location.origin.replace(/\\/$/,'') + '/api';
const params = new URLSearchParams(location.search);
const code = params.get('code') || '';
const status = document.getElementById('status');
const form = document.getElementById('form');
const sel = document.getElementById('discount_type');
const gross = document.getElementById('gross');
const txn = document.getElementById('txn');
const store = document.getElementById('store');
const staff = document.getElementById('staff');
const btn = document.getElementById('redeem');
const STAFF_TOKEN = ${JSON.stringify(token)};

async function init(){
  if(!code){ status.innerHTML = '<div class="err">No code provided.</div>'; return; }
  const r = await fetch(API + '/validate?code=' + encodeURIComponent(code));
  const j = await r.json();
  if(!j.valid){ status.innerHTML = '<div class="err"><strong>INVALID</strong><br/>Reason: ' + (j.reason||'unknown') + '</div>'; return; }
  status.innerHTML = '<div class="ok"><strong>VALID</strong> — ' + j.benefit_label + '</div>';
  if(j.display_policy === 'always_show'){ sel.value='percent'; gross.placeholder='Drinks subtotal (e.g., 12.50)'; }
  else { sel.value='item'; gross.placeholder='Price of free drink (e.g., 5.80)'; }
  form.style.display='block';
}
btn.onclick = async function(){
  const body = {
    code,
    discount_type: sel.value,
    discount_value: sel.value==='percent'?20:0,
    gross_amount: parseFloat(gross.value || '0'),
    till_txn_id: txn.value || null,
    store_id: store.value || null,
    staff_id: staff.value || null
  };
  const r = await fetch(API + '/redeem', {
    method:'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + STAFF_TOKEN },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if(!j.ok){ status.innerHTML = '<div class="err">Redemption failed: ' + (j.error||'unknown') + '</div>'; }
  else { status.innerHTML = '<div class="ok">Redeemed. Saved ' + j.currency + ' ' + j.amount_saved.toFixed(2) + '</div>'; form.style.display='none'; }
};
init();
</script>
</body></html>`);
}

/** ========= main export ========= */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const supa = getSupabase();
  const url = new URL(req.url, "http://local");
  const path = url.pathname;

  try {
    // API routes
    if (path === "/api/my-codes") return apiMyCodes(req, res, supa, url);
    if (path === "/api/validate") return apiValidate(req, res, supa, url);
    if (path === "/api/redeem") {
      if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method_not_allowed" });
      const chunks=[]; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      return apiRedeem(req, res, supa, body);
    }

    // Static assets
    if (path === "/public/widget.js") return serveWidgetJS(res);
    if (path === "/public/redeem.html") return serveRedeemHTML(res);

    // Default 404
    res.status(404).json({ error: "NOT_FOUND" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
}

