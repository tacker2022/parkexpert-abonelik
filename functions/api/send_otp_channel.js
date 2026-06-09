import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendSMS } from "./sms_helper.js";
import { sendEmail } from "./email_helper.js";

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

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    const { username, channel } = await context.request.json();

    if (!username || !channel) {
      return new Response(JSON.stringify({ error: "Kullanıcı adı ve kanal bilgisi zorunludur." }), { status: 400, headers });
    }

    if (channel !== "whatsapp" && channel !== "sms" && channel !== "email") {
      return new Response(JSON.stringify({ error: "Geçersiz doğrulama kanalı." }), { status: 400, headers });
    }

    // 1. Fetch active OTP for user
    const nowIso = new Date().toISOString();
    const otpRes = await fetch(`${supabaseUrl}/rest/v1/admin_otps?username=eq.${username.toLowerCase()}&expires_at=gt.${encodeURIComponent(nowIso)}&order=created_at.desc&limit=1`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    if (!otpRes.ok) {
      const otpErr = await otpRes.text();
      return new Response(JSON.stringify({ error: `Database query error: ${otpErr}` }), { status: 500, headers });
    }

    const otps = await otpRes.json();
    if (otps.length === 0) {
      return new Response(JSON.stringify({ error: "Aktif ve geçerli bir giriş doğrulama talebi bulunamadı. Lütfen tekrar şifrenizle giriş yapın." }), { status: 400, headers });
    }

    const otpCode = otps[0].otp_code;

    // 2. Fetch system settings to check if channel is allowed
    let settings = {
      two_factor_whatsapp_enabled: false,
      two_factor_sms_enabled: false,
      two_factor_enabled: false
    };

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
          settings = rows[0].value;
        }
      }
    } catch (e) {
      console.error("Failed to fetch notification toggles in send_otp_channel:", e);
    }

    // Check permissions
    if (channel === "whatsapp" && settings.two_factor_whatsapp_enabled !== true) {
      return new Response(JSON.stringify({ error: "WhatsApp doğrulama kanalı aktif değil." }), { status: 400, headers });
    }
    if (channel === "sms" && settings.two_factor_sms_enabled !== true) {
      return new Response(JSON.stringify({ error: "SMS doğrulama kanalı aktif değil." }), { status: 400, headers });
    }

    // 3. Fetch user contact details
    let targetPhone = "";
    let targetEmail = "";

    if (username.toLowerCase() === "superadmin") {
      targetPhone = context.env.SUPERADMIN_PHONE || "";
      targetEmail = context.env.SUPERADMIN_EMAIL || "";
    } else {
      const userRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&select=phone,email`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      if (userRes.ok) {
        const admins = await userRes.json();
        if (admins.length > 0) {
          targetPhone = admins[0].phone || "";
          targetEmail = admins[0].email || "";
        }
      }
    }

    // Mask phone helper
    const maskPhone = (phone) => {
      if (!phone) return "";
      const clean = phone.replace(/\D/g, "");
      if (clean.length >= 10) {
        const last4 = clean.substring(clean.length - 4);
        const prefix = clean.substring(0, clean.length - 8);
        return `${prefix}***${last4}`;
      }
      return phone;
    };

    // Mask email helper
    const maskEmail = (email) => {
      if (!email) return "";
      const parts = email.split("@");
      if (parts.length === 2) {
        const name = parts[0];
        const domain = parts[1];
        if (name.length > 2) {
          return `${name.substring(0, 1)}***${name.substring(name.length - 1)}@${domain}`;
        }
        return `***@${domain}`;
      }
      return email;
    };

    // 4. Send via selected channel
    if (channel === "whatsapp") {
      if (!targetPhone) {
        return new Response(JSON.stringify({ error: "Yöneticinin kayıtlı bir telefon numarası bulunamadı." }), { status: 400, headers });
      }

      const waMessage = `PARKEXPERT Yönetici Giriş Doğrulama Kodunuz: ${otpCode}\nBu kod 5 dakika boyunca geçerlidir.`;
      await sendWhatsApp(targetPhone, waMessage, context.env);

      return new Response(JSON.stringify({
        success: true,
        phone_masked: maskPhone(targetPhone)
      }), { status: 200, headers });
    }

    if (channel === "sms") {
      if (!targetPhone) {
        return new Response(JSON.stringify({ error: "Yöneticinin kayıtlı bir telefon numarası bulunamadı." }), { status: 400, headers });
      }

      const smsMessage = `PARKEXPERT Yönetici Giriş Doğrulama Kodunuz: ${otpCode}. Bu kod 5 dakika boyunca geçerlidir.`;
      const smsSent = await sendSMS(targetPhone, smsMessage, context.env, null, false, "0", "2FA");

      if (!smsSent.success) {
        return new Response(JSON.stringify({ error: smsSent.error || "SMS gönderimi başarısız oldu." }), { status: 500, headers });
      }

      return new Response(JSON.stringify({
        success: true,
        phone_masked: maskPhone(targetPhone)
      }), { status: 200, headers });
    }

    if (channel === "email") {
      if (!targetEmail) {
        return new Response(JSON.stringify({ error: "Yöneticinin kayıtlı bir e-posta adresi bulunamadı." }), { status: 400, headers });
      }

      const mailHtml = `
        <p>Merhaba,</p>
        <p><strong>PARKEXPERT Yönetici Paneli</strong> giriş işleminizi tamamlamak için kullanabileceğiniz güvenlik kodu aşağıdadır:</p>
        <div style="text-align: center; margin: 2rem 0; padding: 1rem; background: #f1f5f9; border-radius: 8px; border: 1px solid #cbd5e1;">
          <span style="font-family: monospace; font-size: 2.25rem; font-weight: 800; letter-spacing: 0.1em; color: #0f3ba2;">${otpCode}</span>
        </div>
        <p>Bu kod güvenlik amacıyla <strong>5 dakika</strong> süreyle geçerlidir.</p>
        <p>Giriş talebini siz yapmadıysanız lütfen şifrenizi değiştirin ve sistem yöneticinizle iletişime geçin.</p>
      `;

      const emailSent = await sendEmail({
        to: targetEmail,
        subject: `PARKEXPERT Giriş Güvenlik Kodu: ${otpCode}`,
        html: mailHtml,
        env: context.env
      });

      if (!emailSent.success) {
        return new Response(JSON.stringify({ error: emailSent.error || "E-posta gönderimi başarısız oldu." }), { status: 500, headers });
      }

      return new Response(JSON.stringify({
        success: true,
        email_masked: maskEmail(targetEmail)
      }), { status: 200, headers });
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
