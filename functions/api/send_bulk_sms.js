import { sendSMS } from "./sms_helper.js";

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
async function verifyToken(token, secret) {
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
        return null; // Expired
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
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // Authenticate Request
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const user = await verifyToken(token, jwtSecret);
  if (!user || user.role !== "superadmin") {
    return new Response(JSON.stringify({ error: "Yetkisiz işlem! Yalnızca Süper Yönetici bu işlemi yapabilir." }), { status: 403, headers });
  }

  let message = "";
  let targetType = "approved"; // all, approved, pending, otopark, manual
  let otoparkId = null;
  let manualNumbers = "";
  let isCommercial = false; // true -> filter = "11", false -> filter = "0"
  let flashSms = false;

  try {
    const body = await context.request.json();
    message = body.message ? body.message.trim() : "";
    targetType = body.targetType || "approved";
    otoparkId = body.otoparkId || null;
    manualNumbers = body.manualNumbers ? body.manualNumbers.trim() : "";
    isCommercial = body.isCommercial === true;
    flashSms = body.flashSms === true;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request payload" }), { status: 400, headers });
  }

  if (!message) {
    return new Response(JSON.stringify({ error: "Mesaj içeriği boş olamaz!" }), { status: 400, headers });
  }

  const filter = isCommercial ? "11" : "0";
  let targetUsers = [];

  try {
    if (targetType === "manual") {
      // Parse manual numbers
      const rawNumbers = manualNumbers.split(/[\s,;]+/).map(n => n.trim()).filter(Boolean);
      targetUsers = rawNumbers.map(num => ({
        phone: num,
        fullName: "Manuel Alıcı",
        plateNumber: "Manuel",
        appLocation: "Bilinmiyor"
      }));
    } else {
      // Query applications from Supabase
      let filterUrl = `${supabaseUrl}/rest/v1/applications?select=phone,full_name,plate_number,location,otopark_id`;
      if (targetType === "approved") {
        filterUrl += `&status=eq.approved`;
      } else if (targetType === "pending") {
        filterUrl += `&status=eq.pending`;
      } else if (targetType === "otopark" && otoparkId) {
        filterUrl += `&otopark_id=eq.${otoparkId}`;
      }

      const res = await fetch(filterUrl, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to fetch applications: ${res.status} ${errText}`);
      }

      const apps = await res.json();
      targetUsers = apps.map(app => ({
        phone: app.phone,
        fullName: app.full_name,
        plateNumber: app.plate_number,
        appLocation: app.location
      }));
    }

    // Deduplicate target list by phone number
    const uniquePhones = new Set();
    const deduplicatedUsers = [];
    for (const u of targetUsers) {
      if (u.phone) {
        // Simple normalization
        let clean = u.phone.replace(/\D/g, "");
        if (clean.startsWith("90") && clean.length > 10) clean = clean.substring(2);
        if (clean.startsWith("0") && clean.length > 10) clean = clean.substring(1);
        
        if (clean.length === 10 && !uniquePhones.has(clean)) {
          uniquePhones.add(clean);
          deduplicatedUsers.push(u);
        }
      }
    }

    if (deduplicatedUsers.length === 0) {
      return new Response(JSON.stringify({ error: "Gönderilecek uygun alıcı bulunamadı!" }), { status: 400, headers });
    }

    // Check if the message template contains placeholders
    const hasPlaceholders = /\{fullName\}|\{plateNumber\}|\{appLocation\}/.test(message);

    if (hasPlaceholders) {
      // We must send custom messages individually (using chunked parallelism)
      const results = { successCount: 0, failCount: 0, errors: [] };
      const chunkSize = 10;
      
      const replaceVars = (str, vars) => {
        return str
          .replace(/\{fullName\}/g, vars.fullName || "")
          .replace(/\{plateNumber\}/g, vars.plateNumber || "")
          .replace(/\{appLocation\}/g, vars.appLocation || "");
      };

      for (let i = 0; i < deduplicatedUsers.length; i += chunkSize) {
        const chunk = deduplicatedUsers.slice(i, i + chunkSize);
        const promises = chunk.map(async (u) => {
          const personalizedMsg = replaceVars(message, u);
          try {
            const res = await sendSMS(u.phone, personalizedMsg, context.env, null, flashSms, filter, u.appLocation);
            if (res.success) {
              results.successCount++;
            } else {
              results.failCount++;
              results.errors.push(`${u.phone}: ${res.error || "Bilinmeyen Hata"}`);
            }
          } catch (e) {
            results.failCount++;
            results.errors.push(`${u.phone}: ${e.message}`);
          }
        });
        await Promise.all(promises);
      }

      return new Response(JSON.stringify({
        success: true,
        mode: "personalized",
        totalChecked: deduplicatedUsers.length,
        successCount: results.successCount,
        failCount: results.failCount,
        errors: results.errors.slice(0, 100)
      }), { status: 200, headers });

    } else {
      // No placeholders, send to everyone in one bulk 1:n XML request
      const phoneList = deduplicatedUsers.map(u => u.phone);
      const bulkLocation = targetType === "otopark" ? (deduplicatedUsers[0]?.appLocation || "Otopark") : (targetType === "manual" ? "Manuel Alıcı" : "Genel Duyuru");
      const res = await sendSMS(phoneList, message, context.env, null, flashSms, filter, bulkLocation);
      
      if (res.success) {
        return new Response(JSON.stringify({
          success: true,
          mode: "bulk_1n",
          totalSent: phoneList.length,
          jobId: res.jobId
        }), { status: 200, headers });
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: res.error || "Toplu SMS gönderimi sırasında hata oluştu."
        }), { status: 500, headers });
      }
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
