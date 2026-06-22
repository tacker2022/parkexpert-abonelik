// POST endpoint to blacklist the current session token (Logout)
import { logAudit } from "./audit_helper.js";

function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing configuration" }), { status: 500, headers });
  }

  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "No token provided" }), { status: 400, headers });
  }

  const token = authHeader.substring(7);

  try {
    const { reason } = await context.request.json().catch(() => ({}));

    const parts = token.split(".");
    if (parts.length !== 2) {
      return new Response(JSON.stringify({ error: "Invalid token format" }), { status: 400, headers });
    }

    const payloadStr = base64Decode(parts[0]);
    const payload = JSON.parse(payloadStr);

    if (payload.jti) {
      const expiresAt = new Date(payload.exp || (Date.now() + 3 * 60 * 60 * 1000)).toISOString();
      const clientIp = context.request.headers.get("CF-Connecting-IP") || "";

      // 1. Delete from active_sessions
      const delRes = await fetch(`${supabaseUrl}/rest/v1/active_sessions?id=eq.${payload.jti}`, {
        method: "DELETE",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      if (!delRes.ok) {
        console.error("[Logout API Error] Failed to delete session:", await delRes.text());
      }
      
      // 2. Save JTI in Supabase blacklisted_tokens table
      const res = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({
          jti: payload.jti,
          expires_at: expiresAt
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("[Logout API Error] Failed to blacklist token:", errText);
      }

      // 3. Log audit
      const details = (reason === "inactivity")
        ? "Yöneticinin oturumu 15 dakika hareketsizlik nedeniyle otomatik kapatıldı."
        : "Yönetici kendi isteğiyle güvenli çıkış yaptı.";

      await logAudit({
        supabaseUrl,
        supabaseAnonKey,
        username: payload.username || "unknown",
        role: payload.role || "unknown",
        actionType: "LOGOUT",
        targetId: payload.jti,
        details: details,
        ipAddress: clientIp
      });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
