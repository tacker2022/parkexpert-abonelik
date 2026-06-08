// POST endpoint for sending active login OTP code via Email as backup
import { sendEmail } from "./email_helper.js";

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
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
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    const { username } = await context.request.json();

    if (!username) {
      return new Response(JSON.stringify({ error: "Kullanıcı adı zorunludur." }), { status: 400, headers });
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

    // 2. Fetch email address
    let targetEmail = "";
    if (username.toLowerCase() === "superadmin") {
      targetEmail = context.env.SUPERADMIN_EMAIL;
    } else {
      const res = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&select=email`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      if (res.ok) {
        const admins = await res.json();
        if (admins.length > 0) {
          targetEmail = admins[0].email;
        }
      }
    }

    if (!targetEmail) {
      return new Response(JSON.stringify({ error: "Kullanıcıya ait kayıtlı bir e-posta adresi bulunamadı." }), { status: 400, headers });
    }

    // 3. Send email using sendEmail helper
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
      throw new Error(emailSent.error || "E-posta gönderimi başarısız oldu.");
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

    return new Response(JSON.stringify({ success: true, email_masked: emailMasked }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
