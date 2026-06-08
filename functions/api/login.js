import { sendWhatsApp } from "./whatsapp_helper.js";

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
async function signToken(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payloadStr = JSON.stringify({ ...data, exp: Date.now() + 24 * 60 * 60 * 1000 }); // 24 Hours expiry
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
  const headers = {
    "Access-Control-Allow-Origin": "*",
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
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";
  const rootPassword = context.env.SUPERADMIN_PASSWORD || "admin123";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    const { username, password } = await context.request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password are required" }), { status: 400, headers });
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
      // Query admin user in Supabase
      const res = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&password=eq.${password}&select=*`, {
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
      return new Response(JSON.stringify({ error: "Hatalı kullanıcı adı veya şifre!" }), { status: 401, headers });
    }

    // 1. Check if 2FA is enabled in settings
    let twoFactorEnabled = false; // default false to prevent locking out existing users
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
          twoFactorEnabled = rows[0].value.two_factor_enabled === true;
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

    // Force 2FA only if enabled AND we have at least a phone or email to send the code to
    if (twoFactorEnabled && (targetPhone || targetEmail)) {
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
        // Fallback: if table doesn't exist, we bypass 2FA for now so we don't break login
        twoFactorEnabled = false;
      } else {
        // Send via WhatsApp if phone is present
        if (targetPhone) {
          const waMessage = `PARKEXPERT Yönetici Giriş Doğrulama Kodunuz: ${otpCode}\nBu kod 5 dakika boyunca geçerlidir.`;
          await sendWhatsApp(targetPhone, waMessage, context.env);
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
        if (targetEmail) {
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
        }

        return new Response(JSON.stringify({
          twoFactorRequired: true,
          username: userObj.username,
          phone_masked: phoneMasked,
          email_masked: emailMasked
        }), { status: 200, headers });
      }
    }

    // Sign session token directly (no 2FA or disabled/missing contact details)
    const token = await signToken(userObj, jwtSecret);
    return new Response(JSON.stringify({ success: true, user: userObj, token }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
