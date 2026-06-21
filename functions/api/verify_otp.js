import { sendTelegramAlert } from "./telegram_helper.js";

// POST endpoint for verifying two-factor login OTP code
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binString = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  return btoa(binString);
}

async function signToken(data, secret, clientIp) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const jti = "jti-" + Date.now() + "-" + Math.random().toString(36).substring(2, 11);
  const payloadStr = JSON.stringify({ ...data, jti, ip: clientIp, exp: Date.now() + 3 * 60 * 60 * 1000 }); // 3 Hours expiry
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadStr)
  );

  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return base64Encode(payloadStr) + "." + signatureHex;
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
  const rootPassword = context.env.SUPERADMIN_PASSWORD || "admin123";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    const { username, otp_code } = await context.request.json();

    if (!username || !otp_code) {
      return new Response(JSON.stringify({ error: "Kullanıcı adı ve doğrulama kodu zorunludur." }), { status: 400, headers });
    }

    // 1. Verify OTP in database
    // We look for a row matching username and otp_code where expires_at is in the future
    const nowIso = new Date().toISOString();
    const otpRes = await fetch(`${supabaseUrl}/rest/v1/admin_otps?username=eq.${username.toLowerCase()}&otp_code=eq.${otp_code}&expires_at=gt.${encodeURIComponent(nowIso)}&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    if (!otpRes.ok) {
      const otpErr = await otpRes.text();
      return new Response(JSON.stringify({ error: `OTP verification database error: ${otpErr}` }), { status: 500, headers });
    }

    const otps = await otpRes.json();
    if (otps.length === 0) {
      return new Response(JSON.stringify({ error: "Geçersiz veya süresi dolmuş doğrulama kodu!" }), { status: 400, headers });
    }

    // 2. Code is correct! Load user object.
    let userObj = null;
    if (username.toLowerCase() === "superadmin") {
      userObj = {
        id: "superadmin",
        name: "Süper Yönetici",
        username: "superadmin",
        role: "superadmin",
        otoparks: []
      };
    } else {
      // Query admin user in Supabase
      const res = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (res.ok) {
        const admins = await res.json();
        if (admins.length > 0) {
          const admin = admins[0];
          userObj = {
            id: admin.id,
            name: admin.name,
            username: admin.username,
            role: "admin",
            otoparks: admin.otoparks || [],
            phone: admin.phone,
            email: admin.email
          };
        }
      }
    }

    if (!userObj) {
      return new Response(JSON.stringify({ error: "Yönetici kullanıcısı bulunamadı!" }), { status: 404, headers });
    }

    // 3. Delete OTP record (cleanup)
    await fetch(`${supabaseUrl}/rest/v1/admin_otps?username=eq.${username.toLowerCase()}`, {
      method: "DELETE",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    // 4. Sign final session token
    const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
    const token = await signToken(userObj, jwtSecret, clientIp);

    if (userObj.role === "superadmin") {
      await sendTelegramAlert(
        `<b>✅ İki Aşamalı Giriş Başarılı</b>\n\n` +
        `<b>Kullanıcı:</b> superadmin\n` +
        `<b>IP Adresi:</b> ${clientIp}\n` +
        `<b>Durum:</b> İki aşamalı doğrulama kodu başarıyla doğrulandı ve oturum açıldı.`,
        context.env
      );
    }

    return new Response(JSON.stringify({ success: true, user: userObj, token }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
