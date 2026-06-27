// GET & POST endpoint for otopark categories configuration
import { logAudit } from "./audit_helper.js";

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
      // Enforce IP binding for superadmin
      if (payload.role === "superadmin") {
        if (!payload.ip || payload.ip !== clientIp) {
          return null; // IP mismatch or missing IP claim!
        }
      }
      // Check blacklist
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
              return null; // Blacklisted!
            }
          }
        } catch (e) {
          console.error("Blacklist check error:", e);
        }
      }
      return payload;
    }
  } catch (err) {
    console.error("verifyToken error:", err);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  const method = context.request.method;

  const defaultCategories = [
    "OSB / Sanayi Sitesi Otoparkları",
    "AVM Otoparkları",
    "Açık Otoparklar / Bağımsız Otoparklar"
  ];

  try {
    // ----------------------------------------------------
    // GET: Fetch otopark categories (Publicly readable)
    // ----------------------------------------------------
    if (method === "GET") {
      const res = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.otopark_categories&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        console.warn("[GET /api/otopark_categories] query failed, returning defaults");
        return new Response(JSON.stringify(defaultCategories), { status: 200, headers });
      }

      const rows = await res.json();
      if (rows.length === 0) {
        return new Response(JSON.stringify(defaultCategories), { status: 200, headers });
      }

      const value = rows[0].value;
      if (Array.isArray(value)) {
        return new Response(JSON.stringify(value), { status: 200, headers });
      } else if (value && Array.isArray(value.categories)) {
        return new Response(JSON.stringify(value.categories), { status: 200, headers });
      }

      return new Response(JSON.stringify(defaultCategories), { status: 200, headers });
    }

    // ----------------------------------------------------
    // POST: Save otopark categories (Super Admin Only)
    // ----------------------------------------------------
    if (method === "POST") {
      const authHeader = context.request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
      }

      const token = authHeader.substring(7);
      const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
      const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
      if (!user || user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
      }

      const payload = await context.request.json();
      if (!Array.isArray(payload)) {
        return new Response(JSON.stringify({ error: "Kategori listesi geçersiz formatta (dizi olmalıdır)." }), { status: 400, headers });
      }

      // Check if categories setting already exists to get its ID
      const existingRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.otopark_categories&select=id`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      
      let targetId = null;
      if (existingRes.ok) {
        const rows = await existingRes.json();
        if (rows.length > 0) {
          targetId = rows[0].id;
        }
      }
      
      // If it doesn't exist, dynamically find next ID or generate a UUID
      if (!targetId) {
        const allRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?select=id`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });
        
        if (allRes.ok) {
          const allRows = await allRes.json();
          const isNumeric = allRows.every(r => !isNaN(parseInt(r.id)));
          if (isNumeric && allRows.length > 0) {
            const numericIds = allRows.map(r => parseInt(r.id));
            targetId = String(Math.max(...numericIds) + 1);
          } else {
            targetId = crypto.randomUUID();
          }
        } else {
          targetId = crypto.randomUUID();
        }
      }

      const dbPayload = {
        id: targetId,
        key: "otopark_categories",
        value: payload,
        updated_at: new Date().toISOString()
      };

      const res = await fetch(`${supabaseUrl}/rest/v1/system_settings`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(dbPayload)
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase save error: ${errText}` }), { status: res.status, headers });
      }

      // Log audit
      await logAudit(
        supabaseUrl,
        supabaseAnonKey,
        user.email,
        "UPDATE_OTOPARK_CATEGORIES",
        `Otopark kategorileri güncellendi: ${payload.join(", ")}`,
        clientIp
      );

      return new Response(JSON.stringify({ success: true, categories: payload }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Yöntem desteklenmiyor." }), { status: 405, headers });

  } catch (err) {
    console.error("otopark_categories API error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
