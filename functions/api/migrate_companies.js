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
      if (payload.exp && payload.exp < Date.now()) return null;
      if (payload.role === "superadmin") {
        if (!payload.ip || payload.ip !== clientIp) return null;
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey || !jwtSecret) {
    return new Response(JSON.stringify({ error: "Missing configuration" }), { status: 500, headers });
  }

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

  try {
    // 1. Fetch all applications
    const appsRes = await fetch(`${supabaseUrl}/rest/v1/applications?select=parking_location,company_name`, {
      headers: { "apikey": supabaseAnonKey, "Authorization": `Bearer ${supabaseAnonKey}` }
    });
    if (!appsRes.ok) throw new Error("Abonelikler yüklenemedi.");
    const applications = await appsRes.json();

    // 2. Fetch all registered companies
    const compsRes = await fetch(`${supabaseUrl}/rest/v1/companies?select=otopark_name,name`, {
      headers: { "apikey": supabaseAnonKey, "Authorization": `Bearer ${supabaseAnonKey}` }
    });
    if (!compsRes.ok) throw new Error("Firmalar yüklenemedi.");
    const registered = await compsRes.json();

    // 3. Find unique missing companies
    const registeredSet = new Set(registered.map(c => `${c.otopark_name.trim().toLowerCase()}||${c.name.trim().toLowerCase()}`));
    const missingMap = new Map();

    applications.forEach(app => {
      if (!app.company_name || !app.parking_location) return;
      const compName = app.company_name.trim();
      const otoparkName = app.parking_location.trim();
      if (compName === "SERBEST ÇALIŞAN" || compName === "") return;

      const key = `${otoparkName.toLowerCase()}||${compName.toLowerCase()}`;
      if (!registeredSet.has(key)) {
        missingMap.set(key, { name: compName, otopark_name: otoparkName });
      }
    });

    const toInsert = Array.from(missingMap.values());

    if (toInsert.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "Eski verilerdeki tüm firmalar zaten kayıtlı.", inserted: 0 }), { status: 200, headers });
    }

    // 4. Insert missing companies
    const dbPayload = toInsert.map(item => ({
      name: item.name,
      otopark_name: item.otopark_name,
      created_by: user.username
    }));

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/companies`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(dbPayload)
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      throw new Error(`Supabase insertion failed: ${errText}`);
    }

    const insertedData = await insertRes.json();

    // Log action in audit logs
    await logAudit({
      supabaseUrl,
      supabaseAnonKey,
      username: user.username,
      role: user.role,
      actionType: "Firma Göçü (Migration)",
      details: `Eski aboneliklerden ${insertedData.length} eksik firma sisteme otomatik aktarıldı.`,
      ipAddress: clientIp
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Eski aboneliklerden ${insertedData.length} adet eksik firma başarıyla companies tablosuna aktarıldı.`,
      migrated: insertedData
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
