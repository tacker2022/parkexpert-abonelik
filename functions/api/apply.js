import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendSMS } from "./sms_helper.js";

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
  const bucket = context.env.BUCKET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!bucket) {
    return new Response(JSON.stringify({ error: "Missing Cloudflare R2 Bucket binding" }), { status: 500, headers });
  }

  try {
    const formData = await context.request.formData();

    const appId = formData.get("id");
    const fullName = formData.get("full_name");
    const email = formData.get("email");
    const phone = formData.get("phone");
    const plateNumber = formData.get("plate_number");
    const parkingLocation = formData.get("parking_location");
    const companyName = formData.get("company_name") || null;
    const taxOffice = formData.get("tax_office") || null;
    const taxNumber = formData.get("tax_number") || null;
    const subscriptionType = formData.get("subscription_type");
    
    // Additional fields
    const tcNo = formData.get("tc_no") || null;
    const carModel = formData.get("car_model") || null;
    const driverName = formData.get("driver_name") || null;
    const homeAddress = formData.get("home_address") || null;
    const notes = formData.get("notes") || null;
    const dateApplied = formData.get("date_applied") || new Date().toISOString();

    if (!appId || !fullName || !email || !phone || !plateNumber || !parkingLocation || !subscriptionType) {
      return new Response(JSON.stringify({ error: "Missing required text fields" }), { status: 400, headers });
    }

    // Helper function to upload file to R2
    const uploadToR2 = async (file, fieldName) => {
      if (!file || typeof file === "string" || file.size === 0) return null;
      const ext = file.name ? file.name.split(".").pop() : "pdf";
      const path = `applications/${appId}/${fieldName}.${ext}`;
      await bucket.put(path, file, {
        httpMetadata: {
          contentType: file.type || "application/octet-stream"
        }
      });
      return path;
    };

    // Upload files
    const ruhsatFile = formData.get("ruhsat");
    const kimlikFile = formData.get("kimlik");
    const dekontFile = formData.get("dekont");
    const vergiFile = formData.get("vergi");
    const sirkulerFile = formData.get("sirkuler");
    const calismaFile = formData.get("calisma");

    const ruhsatUrl = await uploadToR2(ruhsatFile, "ruhsat");
    const kimlikUrl = await uploadToR2(kimlikFile, "kimlik");
    const dekontUrl = await uploadToR2(dekontFile, "dekont");
    const vergiUrl = await uploadToR2(vergiFile, "vergi");
    const sirkulerUrl = await uploadToR2(sirkulerFile, "sirkuler");
    const calismaUrl = await uploadToR2(calismaFile, "calisma");

    if (!ruhsatUrl || !kimlikUrl || !dekontUrl) {
      return new Response(JSON.stringify({ error: "Missing required files (ruhsat, kimlik or dekont)" }), { status: 400, headers });
    }

    // Insert record into Supabase
    const payload = {
      id: appId,
      full_name: fullName,
      email: email,
      phone: phone,
      plate_number: plateNumber,
      parking_location: parkingLocation,
      company_name: companyName,
      tax_office: taxOffice,
      tax_number: taxNumber,
      subscription_type: subscriptionType,
      status: "Beklemede",
      ruhsat_url: ruhsatUrl,
      kimlik_url: kimlikUrl,
      dekont_url: dekontUrl,
      vergi_url: vergiUrl,
      sirkuler_url: sirkulerUrl,
      calisma_url: calismaUrl,
      tc_no: tcNo,
      car_model: carModel,
      driver_name: driverName,
      home_address: homeAddress,
      notes: notes,
      date_applied: dateApplied
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/applications`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: res.status, headers });
    }

    const data = await res.json();

    // Trigger notifications asynchronously in the background
    context.waitUntil(
      (async () => {
        try {
          // 1. Fetch System Settings / Notification Toggles
          const settingsRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
            headers: {
              "apikey": supabaseAnonKey,
              "Authorization": `Bearer ${supabaseAnonKey}`
            }
          });
          
          let settings = { email_enabled: true, whatsapp_enabled: true, sms_enabled: true };
          if (settingsRes.ok) {
            const rows = await settingsRes.json();
            if (rows.length > 0) {
              settings = rows[0].value;
            }
          }

          // 2. Fetch Otopark details
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

          const bankName = park.bank_name || "Vakıfbank";
          const iban = park.iban || "TR23 0001 5001 5800 7302 9104 88";
          const companyTitle = park.company_title || "PARKEXPERT";
          const price = subscriptionType.includes("Kurumsal") 
            ? (park.price_external || "2400 TL") 
            : (park.price_employee || "1200 TL");
          const supportPhone = park.support_phone || "0216 504 47 22";

          // 3. Dispatch WhatsApp Notification if enabled
          if (settings.whatsapp_enabled) {
            const message = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce kontrol edilmek üzere başarıyla teslim alınmıştır! Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${appId}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${parkingLocation}\n💸 Ücret: ${price}\n📞 Destek Telefonu: ${supportPhone}\n\n💳 Ödeme ve Dekont Bilgilendirmesi:\nYüklemiş olduğunuz ödeme dekontunuz yetkililerimiz tarafından incelenerek başvurunuz en geç 1 saat içerisinde onaylanacaktır. Başvurunuz onaylandığında plaka tanıma sistemimiz anında aktifleşecektir.\n\nBanka: ${bankName}\nIBAN: ${iban}\nAlıcı: ${companyTitle}`;
            await sendWhatsApp(phone, message, context.env);
          }

          // 4. Dispatch Email Notification if enabled
          if (settings.email_enabled) {
            const emailSubject = `🌟 PARKEXPERT Abonelik Başvurunuz Alındı! (Takip No: ${appId})`;
            const emailHtml = `
              <h2 style="font-size: 1.25rem; color: #0f3ba2; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
              
              <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
                Abonelik başvuru kaydınız başarıyla veri tabanımıza kaydedilmiştir. Plaka tanıma sistemi entegrasyonu ve yüklemiş olduğunuz belgeler ekiplerimiz tarafından incelenmektedir.
              </p>

              <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #0f3ba2; border: 1px solid #e2e8f0; border-left-width: 4px;">
                <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Başvuru Detayları</h4>
                <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                  <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${appId}</span></div>
                  <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
                  <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${parkingLocation}</span></div>
                  <div style="margin-bottom: 0.25rem;"><strong>Abonelik Tipi:</strong> <span>${subscriptionType}</span></div>
                  <div style="margin-bottom: 0.25rem;"><strong>Ücret:</strong> <span>${price}</span></div>
                  <div style="margin-bottom: 0.25rem;"><strong>Araç Modeli:</strong> <span>${carModel || 'Belirtilmedi'}</span></div>
                </div>
              </div>

              <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #eab308; border: 1px solid #e2e8f0; border-left-width: 4px;">
                <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Ödeme ve Dekont Bilgilerhi</h4>
                <p style="font-size: 0.875rem; margin: 0 0 0.5rem 0; color: #334155;">Aboneliğinizin aktifleşmesi için aşağıdaki IBAN adresine havale/EFT yapıp dekontunuzu yüklediğinizden emin olunuz:</p>
                <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                  <div><strong>Banka:</strong> ${bankName}</div>
                  <div><strong>IBAN:</strong> <code style="background: #e2e8f0; padding: 0.1rem 0.3rem; border-radius: 4px; font-family: monospace;">${iban}</code></div>
                  <div><strong>Alıcı:</strong> ${companyTitle}</div>
                  <div style="margin-top: 0.5rem; font-weight: 600; color: #b45309;">AÇIKLAMA KISMINA PLAKA VE ABONE BİLGİSİ YAZMAYI UNUTMAYINIZ!</div>
                </div>
              </div>

              <div style="background: rgba(15, 59, 162, 0.05); border: 1px dashed #0f3ba2; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #1e3a8a;">
                Başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktif edilecek ve tarafınıza <strong>E-posta</strong> ve <strong>WhatsApp</strong> ile bilgilendirme yapılacaktır. Takip numaranız ile istediğiniz an durum sorgulaması yapabilirsiniz.
              </div>
            `;
            await sendEmail({ to: email, subject: emailSubject, html: emailHtml, env: context.env });
          }

          // 5. Dispatch SMS Notification if enabled
          if (settings.sms_enabled) {
            const smsMessage = `Sayın ${fullName}, ${parkingLocation} otopark abonelik başvurunuz alınmıştır. Takip No: ${appId}. Evraklarınız incelenmektedir. PARKEXPERT`;
            await sendSMS(phone, smsMessage, context.env);
          }
        } catch (waErr) {
          console.error("Failed to send notifications on apply:", waErr);
        }
      })()
    );

    return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
