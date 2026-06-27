import { sendTelegramAlert } from "./telegram_helper.js";
import { logAudit } from "./audit_helper.js";

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
  const token = base64Encode(payloadStr) + "." + signatureHex;
  return { token, jti };
}

async function getLockoutState(username, supabaseUrl, supabaseAnonKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/login_attempts?username=eq.${encodeURIComponent(username.toLowerCase())}&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) {
        const row = rows[0];
        if (row.locked_until) {
          const lockedUntilTime = new Date(row.locked_until).getTime();
          if (lockedUntilTime > Date.now()) {
            return { locked: true, remainingMs: lockedUntilTime - Date.now(), attempts: row.attempts };
          }
        }
        return { locked: false, attempts: row.attempts };
      }
    }
  } catch (e) {
    console.error("Lockout check error:", e);
  }
  return { locked: false, attempts: 0 };
}

async function recordFailedAttempt(username, supabaseUrl, supabaseAnonKey) {
  try {
    const stateRes = await fetch(`${supabaseUrl}/rest/v1/login_attempts?username=eq.${encodeURIComponent(username.toLowerCase())}&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    
    let currentAttempts = 0;
    let exists = false;
    
    if (stateRes.ok) {
      const rows = await stateRes.json();
      if (rows.length > 0) {
        currentAttempts = rows[0].attempts;
        exists = true;
      }
    }
    
    const newAttempts = currentAttempts + 1;
    const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    
    const payload = {
      username: username.toLowerCase(),
      attempts: newAttempts,
      last_attempt_at: new Date().toISOString(),
      locked_until: lockedUntil
    };
    
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/login_attempts`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(payload)
    });
    
    if (!upsertRes.ok) {
      console.error("Failed to upsert login attempt:", await upsertRes.text());
    }
    
    return { attempts: newAttempts, locked: newAttempts >= 5 };
  } catch (e) {
    console.error("Record failed attempt error:", e);
  }
  return { attempts: 1, locked: false };
}

async function resetFailedAttempts(username, supabaseUrl, supabaseAnonKey) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/login_attempts?username=eq.${encodeURIComponent(username.toLowerCase())}`, {
      method: "DELETE",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
  } catch (e) {
    console.error("Reset failed attempts error:", e);
  }
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
  const jwtSecret = context.env.JWT_SECRET;
  const rootPassword = context.env.SUPERADMIN_PASSWORD;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret || !rootPassword) {
    return new Response(JSON.stringify({ error: "Server security environment variables (JWT_SECRET / SUPERADMIN_PASSWORD) are not configured." }), { status: 500, headers });
  }

  try {
    const { username, otp_code } = await context.request.json();

    if (!username || !otp_code) {
      return new Response(JSON.stringify({ error: "Kullanıcı adı ve doğrulama kodu zorunludur." }), { status: 400, headers });
    }

    // Check account lockout status first
    const lockoutState = await getLockoutState(username, supabaseUrl, supabaseAnonKey);
    if (lockoutState.locked) {
      const minutes = Math.ceil(lockoutState.remainingMs / 60000);
      return new Response(JSON.stringify({ 
        error: `Bu hesap başarısız giriş denemeleri nedeniyle geçici olarak kilitlenmiştir. Lütfen ${minutes} dakika sonra tekrar deneyin.` 
      }), { status: 403, headers });
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
      const record = await recordFailedAttempt(username, supabaseUrl, supabaseAnonKey);
      let errorMsg = "Geçersiz veya süresi dolmuş doğrulama kodu!";
      if (record.locked) {
        errorMsg = "Hesabınız çok fazla başarısız giriş denemesi nedeniyle geçici olarak 15 dakika kilitlenmiştir.";
      } else {
        errorMsg += ` (Kalan deneme hakkı: ${5 - record.attempts})`;
      }

      // Send telegram alert if failed attempts are 3 or more
      if (record.attempts >= 3) {
        const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
        const alertMsg = record.locked
          ? `<b>🚨 ŞÜPHELİ DURUM: HESAP KİLİTLENDİ (OTP)</b>\n\n` +
            `<b>Kullanıcı:</b> ${username}\n` +
            `<b>IP Adresi:</b> ${clientIp}\n` +
            `<b>Durum:</b> Üst üste 5 kez başarısız 2FA/OTP girişi yapıldığı için hesap 15 dakika kilitlendi (Brute-force uyarısı).`
          : `<b>⚠️ ŞÜPHELİ DURUM: BAŞARISIZ 2FA/OTP GİRİŞİ</b>\n\n` +
            `<b>Kullanıcı:</b> ${username}\n` +
            `<b>IP Adresi:</b> ${clientIp}\n` +
            `<b>Durum:</b> Üst üste ${record.attempts} kez başarısız 2FA/OTP doğrulama denemesi yapıldı.`;
        
        await sendTelegramAlert(alertMsg, context.env);
      }

      return new Response(JSON.stringify({ error: errorMsg }), { status: 400, headers });
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
            role: admin.role || "admin",
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
    const { token, jti } = await signToken(userObj, jwtSecret, clientIp);

    // Create session in active_sessions
    const userAgent = context.request.headers.get("User-Agent") || "";
    await fetch(`${supabaseUrl}/rest/v1/active_sessions`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: jti,
        username: userObj.username,
        name: userObj.name,
        role: userObj.role,
        ip_address: clientIp,
        user_agent: userAgent
      })
    });

    // Log audit
    await logAudit({
      supabaseUrl,
      supabaseAnonKey,
      username: userObj.username,
      role: userObj.role,
      actionType: "LOGIN",
      targetId: jti,
      details: "Yönetici 2FA kodunu başarıyla doğrulayarak giriş yaptı.",
      ipAddress: clientIp
    });

    if (userObj.role === "superadmin") {
      await sendTelegramAlert(
        `<b>✅ İki Aşamalı Giriş Başarılı</b>\n\n` +
        `<b>Kullanıcı:</b> superadmin\n` +
        `<b>IP Adresi:</b> ${clientIp}\n` +
        `<b>Durum:</b> İki aşamalı doğrulama kodu başarıyla doğrulandı ve oturum açıldı.`,
        context.env
      );
    }

    // Reset failed login attempts
    await resetFailedAttempts(username, supabaseUrl, supabaseAnonKey);

    return new Response(JSON.stringify({ success: true, user: userObj, token }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
