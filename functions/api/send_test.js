import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendSMS } from "./sms_helper.js";

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

  // Generate a random mock application ID
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randomCode = "";
  for (let i = 0; i < 4; i++) {
    randomCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const mockAppId = `PE-TEST-${randomCode}`;
  
  let testEmail = "talha.emre.calargun@parkexpert.net";
  let testPhone = "5372939874"; // +90 537 293 98 74
  let scheduledDate = null;

  try {
    const body = await context.request.json();
    if (body.email) testEmail = body.email.trim();
    if (body.phone) testPhone = body.phone.trim();
    if (body.scheduledDate) scheduledDate = body.scheduledDate;
  } catch (e) {
    // ignore, use defaults
  }
  
  const parkingLocation = "Birlik Sanayi Sitesi - Beylikdüzü";
  const fullName = "TEST KULLANICI (AHMET YILMAZ)";
  const plateNumber = "34TEST34";
  const subscriptionType = "Bireysel Abonelik (1 Aylık)";

  try {
    // 1. Fetch otopark details from Supabase
    const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(parkingLocation)}&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    let park = {};
    if (otoparkRes.ok) {
      const parks = await otoparkRes.json();
      if (parks.length > 0) {
        park = parks[0];
      }
    }

    const bankName = park.bank_name || "ALBARAKA";
    const iban = park.iban || "TR00 0000 0000 0000 0000 0000 00";
    const companyTitle = park.company_title || "PARKEXPERT TEKNOLOJİ A.Ş.";
    const price = park.price_employee || "300";
    const supportPhone = park.support_phone || "02165044722";

    const templateVars = {
      fullName,
      appId: mockAppId,
      plateNumber,
      parkingLocation,
      subscriptionType,
      price,
      supportPhone,
      bankName,
      iban,
      companyTitle,
      carModel: 'Belirtilmedi'
    };

    const replaceVars = (str, vars) => {
      if (!str) return "";
      let res = str;
      for (const [k, v] of Object.entries(vars)) {
        const regex = new RegExp(`\\{${k}\\}`, "g");
        res = res.replace(regex, v);
      }
      return res;
    };

    const customTemplates = park.templates || {};
    const applyTemplates = customTemplates.apply || {};

    // 2. Construct WhatsApp Message (exact template requested by user)
    let waMessage = "";
    if (applyTemplates.whatsapp) {
      waMessage = replaceVars(applyTemplates.whatsapp, templateVars);
    } else {
      waMessage = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce kontrol edilmek üzere başarıyla teslim alınmıştır! Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${mockAppId}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${parkingLocation}\n💸 Ücret: ${price}\n📞 Destek Telefonu: ${supportPhone}\n\n💳 Ödeme ve Dekont Bilgilendirmesi:\nYüklemiş olduğunuz ödeme dekontunuz yetkililerimiz tarafından incelenerek başvurunuz en geç 1 saat içerisinde onaylanacaktır. Başvurunuz onaylandığında plaka tanıma sistemimiz anında aktifleşecektir.\n\nBanka: ${bankName}\nIBAN: ${iban}\nAlıcı: ${companyTitle}`;
    }

    // 3. Send WhatsApp
    let waSuccess = false;
    let waError = null;
    try {
      const waResult = await sendWhatsApp(testPhone, waMessage, context.env);
      waSuccess = waResult.success !== false;
      if (!waSuccess) waError = waResult.error;
    } catch (e) {
      waError = e.message;
    }

    // Send SMS Test
    let smsSuccess = false;
    let smsError = null;
    try {
      let smsMessage = "";
      if (applyTemplates.sms) {
        smsMessage = replaceVars(applyTemplates.sms, templateVars);
      } else {
        smsMessage = `Bu bir test mesajidir. Takip No: ${mockAppId}. PARKEXPERT`;
      }
      const smsResult = await sendSMS(testPhone, smsMessage, context.env, scheduledDate);
      smsSuccess = smsResult.success !== false;
      if (!smsSuccess) smsError = smsResult.error;
    } catch (e) {
      smsError = e.message;
    }

    // 4. Construct Email HTML
    let emailSubject = "";
    let emailHtml = "";
    
    if (applyTemplates.email_subject) {
      emailSubject = replaceVars(applyTemplates.email_subject, templateVars);
    } else {
      emailSubject = `🌟 PARKEXPERT Abonelik Başvurunuz Alındı! (Takip No: ${mockAppId})`;
    }

    if (applyTemplates.email_html) {
      emailHtml = replaceVars(applyTemplates.email_html, templateVars);
    } else {
      emailHtml = `
        <h2 style="font-size: 1.25rem; color: #0f3ba2; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
        
        <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
          Bu bir <strong>TEST MESAJIDIR</strong>. Abonelik başvuru kaydınız başarıyla veri tabanımıza kaydedilmiştir. Plaka tanıma sistemi entegrasyonu ve yüklemiş olduğunuz belgeler ekiplerimiz tarafından incelenmektedir.
        </p>

        <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #0f3ba2; border: 1px solid #e2e8f0; border-left-width: 4px;">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Başvuru Detayları (TEST)</h4>
          <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
            <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${mockAppId}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${parkingLocation}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Abonelik Tipi:</strong> <span>${subscriptionType}</span></div>
          </div>
        </div>

        <div style="background: rgba(15, 59, 162, 0.05); border: 1px dashed #0f3ba2; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #0f3ba2; margin-bottom: 1.5rem;">
          <strong>Ödeme ve Hesap Bilgileri:</strong><br>
          Banka: ${bankName}<br>
          IBAN: ${iban}<br>
          Alıcı Unvanı: ${companyTitle}<br>
          Ücret: ${price} TL
        </div>
      `;
    }

    // 5. Send Email
    let emailSuccess = false;
    let emailError = null;
    try {
      const emailResult = await sendEmail({ to: testEmail, subject: emailSubject, html: emailHtml, env: context.env });
      emailSuccess = emailResult.success !== false;
      if (!emailSuccess) emailError = emailResult.error;
    } catch (e) {
      emailError = e.message;
    }

    return new Response(JSON.stringify({ 
      success: true, 
      mockAppId,
      whatsapp: { success: waSuccess, error: waError },
      email: { success: emailSuccess, error: emailError },
      sms: { success: smsSuccess, error: smsError }
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
