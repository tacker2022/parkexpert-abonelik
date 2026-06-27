import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendTelegramAlert } from "./telegram_helper.js";
import { logAudit } from "./audit_helper.js";

// Helper for safe base64 encoding (supports Unicode)
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binString = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  return btoa(binString);
}

// Helper to sign token using HMAC-SHA256
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

async function hashPassword(password, salt = "parkexpert-salt-key-98765") {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
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
  const rootPassword = context.env.SUPERADMIN_PASSWORD;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret || !rootPassword || !context.env.PASSWORD_SALT) {
    return new Response(JSON.stringify({ error: "Server security environment variables (JWT_SECRET / SUPERADMIN_PASSWORD / PASSWORD_SALT) are not configured." }), { status: 500, headers });
  }

  try {
    const { username, password, turnstileResponse } = await context.request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password are required" }), { status: 400, headers });
    }

    // Verify Cloudflare Turnstile token
    if (!turnstileResponse) {
      return new Response(JSON.stringify({ error: "Güvenlik doğrulama kodu bulunamadı." }), { status: 400, headers });
    }

    const turnstileSecret = context.env.TURNSTILE_SECRET || "1x00000000000000000000000000000000";
    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret: turnstileSecret,
        response: turnstileResponse,
        remoteip: context.request.headers.get("CF-Connecting-IP") || ""
      })
    });

    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return new Response(JSON.stringify({ error: "Güvenlik doğrulaması (Turnstile) başarısız oldu! Lütfen tekrar deneyin." }), { status: 400, headers });
    }

    // Check account lockout status first
    const lockoutState = await getLockoutState(username, supabaseUrl, supabaseAnonKey);
    if (lockoutState.locked) {
      const minutes = Math.ceil(lockoutState.remainingMs / 60000);
      return new Response(JSON.stringify({ 
        error: `Bu hesap başarısız giriş denemeleri nedeniyle geçici olarak kilitlenmiştir. Lütfen ${minutes} dakika sonra tekrar deneyin.` 
      }), { status: 403, headers });
    }

    let userObj = null;

    if (username.toLowerCase() === "superadmin") {
      if (password === rootPassword) {
        userObj = {
          id: "superadmin",
          name: "Süper Yönetici",
          username: "superadmin",
          role: "superadmin",
          otoparks: []
        };
      }
    } else {
      // Query admin user in Supabase by username only
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
          const salt = context.env.PASSWORD_SALT;
          const inputHash = await hashPassword(password, salt);
          
          let passwordMatches = false;
          let needsMigration = false;
          
          // Check if stored password is a 64-char hex SHA-256 hash
          const isHashed = /^[0-9a-fA-F]{64}$/.test(admin.password || "");
          
          if (isHashed) {
            passwordMatches = (admin.password === inputHash);
          } else {
            // Old plain-text password comparison
            passwordMatches = (admin.password === password);
            if (passwordMatches) {
              needsMigration = true;
            }
          }

           if (passwordMatches) {
            userObj = {
              id: admin.id,
              name: admin.name,
              username: admin.username,
              role: admin.role || "admin",
              otoparks: admin.otoparks || [],
              phone: admin.phone,
              email: admin.email
            };

            // Migrate plain-text password to hashed in Supabase
            if (needsMigration) {
              try {
                await fetch(`${supabaseUrl}/rest/v1/admin_users?id=eq.${admin.id}`, {
                  method: "PATCH",
                  headers: {
                    "apikey": supabaseAnonKey,
                    "Authorization": `Bearer ${supabaseAnonKey}`,
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({ password: inputHash })
                });
              } catch (e) {
                console.error("Failed to migrate plain-text password:", e);
              }
            }
          }
        }
      }
    }

    if (!userObj) {
      const record = await recordFailedAttempt(username, supabaseUrl, supabaseAnonKey);
      let errorMsg = "Hatalı kullanıcı adı veya şifre!";
      if (record.locked) {
        errorMsg = "Hesabınız çok fazla başarısız giriş denemesi nedeniyle geçici olarak 15 dakika kilitlenmiştir.";
      } else {
        errorMsg += ` (Kalan deneme hakkı: ${5 - record.attempts})`;
      }

      // Send telegram alert if failed attempts are 3 or more
      if (record.attempts >= 3) {
        const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
        const alertMsg = record.locked
          ? `<b>🚨 ŞÜPHELİ DURUM: HESAP KİLİTLENDİ (LOGIN)</b>\n\n` +
            `<b>Kullanıcı:</b> ${username}\n` +
            `<b>IP Adresi:</b> ${clientIp}\n` +
            `<b>Durum:</b> Üst üste 5 kez başarısız giriş denemesi yapıldığı için hesap 15 dakika kilitlendi (Brute-force uyarısı).`
          : `<b>⚠️ ŞÜPHELİ DURUM: BAŞARISIZ GİRİŞ DENEMESİ</b>\n\n` +
            `<b>Kullanıcı:</b> ${username}\n` +
            `<b>IP Adresi:</b> ${clientIp}\n` +
            `<b>Durum:</b> Üst üste ${record.attempts} kez başarısız giriş denemesi yapıldı.`;
        
        await sendTelegramAlert(alertMsg, context.env);
      }

      return new Response(JSON.stringify({ error: errorMsg }), { status: 401, headers });
    }

    // 1. Check if 2FA is enabled in settings
    let twoFactorEnabled = false;
    let twoFactorWhatsappEnabled = false;
    let twoFactorSmsEnabled = false;
    try {
      const settingsRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      if (settingsRes.ok) {
        const rows = await settingsRes.json();
        if (rows.length > 0 && rows[0].value) {
          const val = rows[0].value;
          twoFactorEnabled = val.two_factor_enabled === true;
          twoFactorWhatsappEnabled = val.two_factor_whatsapp_enabled === true;
          twoFactorSmsEnabled = val.two_factor_sms_enabled === true;
        }
      }
    } catch (e) {
      console.error("Failed to fetch notification toggles in login:", e);
    }

    const targetPhone = (username.toLowerCase() === "superadmin")
      ? context.env.SUPERADMIN_PHONE
      : userObj.phone;

    const targetEmail = (username.toLowerCase() === "superadmin")
      ? context.env.SUPERADMIN_EMAIL
      : userObj.email;

    // Force 2FA only if enabled AND we have an email address to send the code to
    if (twoFactorEnabled && targetEmail) {
      const otpCode = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // Store OTP in database
      const otpRes = await fetch(`${supabaseUrl}/rest/v1/admin_otps`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: userObj.username,
          otp_code: otpCode,
          expires_at: expiresAt
        })
      });

      if (!otpRes.ok) {
        const otpErr = await otpRes.text();
        console.error("Failed to save OTP in database:", otpErr);
      } else {
        // Send automatically via Email
        const mailHtml = `
          <p>Merhaba,</p>
          <p><strong>PARKEXPERT Yönetici Paneli</strong> giriş işleminizi tamamlamak için kullanabileceğiniz güvenlik kodu aşağıdadır:</p>
          <div style="text-align: center; margin: 2rem 0; padding: 1rem; background: #f1f5f9; border-radius: 8px; border: 1px solid #cbd5e1;">
            <span style="font-family: monospace; font-size: 2.25rem; font-weight: 800; letter-spacing: 0.1em; color: #0f3ba2;">${otpCode}</span>
          </div>
          <p>Bu kod güvenlik amacıyla <strong>5 dakika</strong> süreyle geçerlidir.</p>
          <p>Giriş talebini siz yapmadıysanız lütfen şifrenizi değiştirin ve sistem yöneticinizle iletişime geçin.</p>
        `;
        await sendEmail({
          to: targetEmail,
          subject: `PARKEXPERT Giriş Güvenlik Kodu: ${otpCode}`,
          html: mailHtml,
          env: context.env
        });

        // Send Telegram alert for superadmin login attempt
        const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
        if (userObj.role === "superadmin") {
          await sendTelegramAlert(
            `<b>🔑 Oturum Giriş Girişimi (2FA)</b>\n\n` +
            `<b>Kullanıcı:</b> superadmin\n` +
            `<b>IP Adresi:</b> ${clientIp}\n` +
            `<b>Durum:</b> İki aşamalı doğrulama kodu e-posta adresine gönderildi.`,
            context.env
          );
        }

        // Mask phone
        let phoneMasked = "";
        if (targetPhone) {
          const cleanPhone = targetPhone.replace(/\D/g, "");
          if (cleanPhone.length >= 10) {
            const last4 = cleanPhone.substring(cleanPhone.length - 4);
            const prefix = cleanPhone.substring(0, cleanPhone.length - 8);
            phoneMasked = `${prefix}***${last4}`;
          } else {
            phoneMasked = targetPhone;
          }
        }

        // Mask email
        let emailMasked = "";
        const parts = targetEmail.split("@");
        if (parts.length === 2) {
          const name = parts[0];
          const domain = parts[1];
          if (name.length > 2) {
            emailMasked = `${name.substring(0, 1)}***${name.substring(name.length - 1)}@${domain}`;
          } else {
            emailMasked = `***@${domain}`;
          }
        } else {
          emailMasked = targetEmail;
        }

        return new Response(JSON.stringify({
          twoFactorRequired: true,
          username: userObj.username,
          phone_masked: phoneMasked,
          email_masked: emailMasked,
          has_whatsapp: !!(twoFactorWhatsappEnabled && targetPhone),
          has_sms: !!(twoFactorSmsEnabled && targetPhone),
          has_email: true
        }), { status: 200, headers });
      }
    }

    // Sign session token directly (no 2FA or disabled/missing contact details)
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
      details: "Yönetici doğrudan (2FA olmadan) giriş yaptı.",
      ipAddress: clientIp
    });
    
    if (userObj.role === "superadmin") {
      await sendTelegramAlert(
        `<b>✅ Doğrudan Giriş Başarılı</b>\n\n` +
        `<b>Kullanıcı:</b> superadmin\n` +
        `<b>IP Adresi:</b> ${clientIp}\n` +
        `<b>Durum:</b> Oturum iki aşamalı doğrulama olmadan (devre dışı olduğu için) doğrudan başlatıldı.`,
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
