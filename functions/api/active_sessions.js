import { logAudit } from "./audit_helper.js";

function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function verifyToken(token, secret, clientIp, supabaseUrl, supabaseAnonKey) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payloadStr = base64Decode(parts[0]);
    const signatureHex = parts[1];

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadStr)
    );
    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    const reSignatureHex = signatureArray.map(b => b.toString(16).padStart(2, "0")).join("");

    if (signatureHex === reSignatureHex) {
      const payload = JSON.parse(payloadStr);
      if (payload.exp && payload.exp < Date.now()) {
        return null;
      }
      if (payload.role === "superadmin") {
        if (!payload.ip || payload.ip !== clientIp) {
          return null;
        }
      }
      return payload;
    }
  } catch (e) {
    return null;
  }
  return null;
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
  
  if (!user || user.role !== "superadmin") {
    return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
  }

  // GET: Fetch all active sessions
  if (context.request.method === "GET") {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/active_sessions?select=*&order=last_active_at.desc`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // DELETE: Force terminate session(s) (Logout specific session or bulk sessions)
  if (context.request.method === "DELETE") {
    try {
      const body = await context.request.json();
      const isBulk = Array.isArray(body.sessions);
      const sessionsToTerminate = isBulk ? body.sessions : [body];

      for (const s of sessionsToTerminate) {
        const { jti, expiresAt, username } = s;
        if (!jti) continue;

        // 1. Delete from active_sessions
        const delRes = await fetch(`${supabaseUrl}/rest/v1/active_sessions?id=eq.${jti}`, {
          method: "DELETE",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (!delRes.ok) {
          console.error(`Failed to delete active session ${jti}:`, await delRes.text());
        }

        // 2. Add to blacklisted_tokens to revoke the JWT immediately
        const expTime = expiresAt || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
        const blRes = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens`, {
          method: "POST",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            jti: jti,
            expires_at: expTime
          })
        });

        if (!blRes.ok) {
          console.error(`Failed to blacklist terminated token ${jti}:`, await blRes.text());
        }

        // 3. Log to audit logs
        await logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "TERMINATE_SESSION",
          targetId: jti,
          details: `Süper yönetici, '${username}' kullanıcısının aktif oturumunu zorla sonlandırdı.`,
          ipAddress: clientIp
        });
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
}
