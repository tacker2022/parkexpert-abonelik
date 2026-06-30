import { logAudit } from "./audit_helper.js";

// Helper for safe base64 decoding (supports Unicode)
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Helper to verify JWT token using HMAC-SHA256
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
      if (payload.jti && supabaseUrl && supabaseAnonKey) {
        try {
          const blRes = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens?jti=eq.${payload.jti}&select=jti`, {
            headers: {
              "apikey": supabaseAnonKey,
              "Authorization": `Bearer ${supabaseAnonKey}`
            }
          });
          if (blRes.ok) {
            const rows = await blRes.json();
            if (rows.length > 0) {
              return null; 
            }
          }
        } catch (e) {
          console.error("Blacklist check error:", e);
        }
      } else {
        return null; 
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
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
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

  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  try {
    const authHeader = context.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
    }

    const token = authHeader.substring(7);
    const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
    const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);

    if (!user) {
      return new Response(JSON.stringify({ error: "Yetkisiz veya süresi geçmiş oturum!" }), { status: 401, headers });
    }

    const allowedRoles = ["superadmin", "admin", "operator", "yonetim", "yonetim_avm", "yonetim_site"];
    if (!allowedRoles.includes(user.role)) {
      return new Response(JSON.stringify({ error: "Bu işlem için yetkiniz bulunmamaktadır." }), { status: 403, headers });
    }

    const payload = await context.request.json();
    const { otopark_name, source_company, target_company } = payload;

    if (!otopark_name || !source_company || !target_company) {
      return new Response(JSON.stringify({ error: "Eksik parametreler." }), { status: 400, headers });
    }

    if (source_company === target_company) {
      return new Response(JSON.stringify({ error: "Kaynak ve hedef firma aynı olamaz." }), { status: 400, headers });
    }

    // Verify otopark authorization
    if (user.role !== "superadmin" && (!user.otoparks || !user.otoparks.includes(otopark_name))) {
      return new Response(JSON.stringify({ error: "Bu otoparkta işlem yetkiniz bulunmamaktadır." }), { status: 403, headers });
    }

    // 1. Update applications in bulk using PATCH
    const patchRes = await fetch(`${supabaseUrl}/rest/v1/applications?parking_location=eq.${encodeURIComponent(otopark_name)}&company_name=eq.${encodeURIComponent(source_company)}`, {
      method: "PATCH",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        company_name: target_company
      })
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return new Response(JSON.stringify({ error: `Taşıma hatası: ${errText}` }), { status: patchRes.status, headers });
    }

    const updatedRows = await patchRes.json();
    const movedPlatesCount = updatedRows.length;

    // 2. Clean up (delete) the source company from companies database table
    try {
      await fetch(`${supabaseUrl}/rest/v1/companies?otopark_name=eq.${encodeURIComponent(otopark_name)}&name=eq.${encodeURIComponent(source_company)}`, {
        method: "DELETE",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
    } catch (err) {
      console.error("Error deleting source company during merge:", err);
    }

    // 3. Log to audit helper
    try {
      await logAudit({
        supabaseUrl,
        supabaseAnonKey,
        username: user.username,
        role: user.role,
        actionType: "Firma Birleştirme",
        details: `Otopark: ${otopark_name}, Kaynak: "${source_company}" -> Hedef: "${target_company}". Taşınan Araç: ${movedPlatesCount}`,
        ipAddress: clientIp
      });
    } catch (e) {
      console.error("Audit log error:", e);
    }

    return new Response(JSON.stringify({ success: true, count: movedPlatesCount }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: `Server error: ${err.message}` }), { status: 500, headers });
  }
}
