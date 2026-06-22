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
      // Check blacklist
      if (payload.jti) {
        const blRes = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens?jti=eq.${payload.jti}&select=jti`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });
        if (blRes.ok) {
          const rows = await blRes.json();
          if (rows.length > 0) {
            return null; // Blacklisted!
          }
        }
      } else {
        return null; // Force log out for old tokens without JTI
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
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const payload = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);

  if (!payload || !payload.jti) {
    return new Response(JSON.stringify({ error: "Oturum geçersiz veya sonlandırılmış!" }), { status: 401, headers });
  }

  try {
    // 1. Update last_active_at in active_sessions
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/active_sessions?id=eq.${payload.jti}`, {
      method: "PATCH",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        last_active_at: new Date().toISOString()
      })
    });

    if (!patchRes.ok) {
      throw new Error("Failed to update heartbeat");
    }

    const rows = await patchRes.json();
    if (rows.length === 0) {
      // Session does not exist in active_sessions (e.g. terminated by superadmin)
      return new Response(JSON.stringify({ error: "Oturum sonlandırılmış!" }), { status: 401, headers });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
