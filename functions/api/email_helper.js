// Email helper module for Brevo API - Active Config

export async function sendEmail({ to, subject, html, env }) {
  const apiKey = env.BREVO_API_KEY;
  const fromEmail = env.BREVO_FROM_EMAIL || "PARKEXPERT <bilgi@parkexpertabonelik.net>";

  // Premium HTML wrapper template
  const wrappedHtml = `
<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; padding: 2rem; color: #334155; margin: 0; min-height: 100%;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; overflow: hidden;">
    <!-- Logo / Header -->
    <div style="text-align: center; padding: 2rem; background: #0f3ba2; border-bottom: 3px solid #eab308;">
      <h2 style="color: #ffffff; margin: 0; font-size: 1.5rem; font-weight: 800; letter-spacing: 0.05em;">PARKEXPERT</h2>
      <p style="color: #93c5fd; margin: 0.25rem 0 0 0; font-size: 0.8rem; font-weight: 500;">DİJİTAL ABONELİK SİSTEMİ</p>
    </div>
    <!-- Body Content -->
    <div style="padding: 2rem; line-height: 1.6; font-size: 0.95rem; color: #334155;">
      ${html}
    </div>
    <!-- Footer -->
    <div style="text-align: center; padding: 1.5rem; background: #f1f5f9; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b;">
      <p style="margin: 0;">Bu e-posta <strong>PARKEXPERT Dijital Abonelik Sistemi</strong> tarafından otomatik olarak gönderilmiştir.</p>
      <p style="margin: 0.25rem 0 0 0;">Lütfen bu adrese doğrudan yanıt vermeyiniz. Sorularınız için destek ekibimizle iletişime geçiniz.</p>
      <p style="margin: 1rem 0 0 0; font-weight: 600;">© 2026 PARKEXPERT. Tüm Hakları Saklıdır.</p>
    </div>
  </div>
</div>
  `;

  if (!apiKey) {
    console.log(`[E-posta Simüle Gönderim] (Env Değişkeni BREVO_API_KEY Eksik)
Gönderen: ${fromEmail}
Alıcı: ${to}
Konu: ${subject}
İçerik: (HTML şablonu loglandı)`);
    return { success: true, simulated: true, reason: "Missing BREVO_API_KEY" };
  }

  // Parse fromEmail into name and email address
  let senderName = "PARKEXPERT";
  let senderEmail = "bilgi@parkexpertabonelik.net";

  const match = fromEmail.match(/^(.*?)\s*<(.*?)>$/);
  if (match) {
    senderName = match[1].trim();
    senderEmail = match[2].trim();
  } else {
    senderEmail = fromEmail.trim();
  }

  const url = "https://api.brevo.com/v3/smtp/email";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: {
          name: senderName,
          email: senderEmail
        },
        to: [
          {
            email: to
          }
        ],
        subject: subject,
        htmlContent: wrappedHtml
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Brevo API Hatası] Durum: ${res.status}, Yanıt: ${errText}`);
      return { success: false, status: res.status, error: errText };
    }

    const data = await res.json();
    console.log(`[Brevo API Başarılı] Alıcı: ${to}, MesajID: ${data.messageId || "N/A"}`);
    return { success: true, data };
  } catch (err) {
    console.error(`[Brevo API Çökme Hatası]:`, err);
    return { success: false, error: err.message };
  }
}
