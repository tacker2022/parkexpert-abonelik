import { sendWhatsApp } from "./whatsapp_helper.js";

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
    const dateApplied = formData.get("date_applied") || null;

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

    // Trigger WhatsApp notification asynchronously in the background
    context.waitUntil(
      (async () => {
        try {
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
          const price = subscriptionType.includes("Kurumsal") 
            ? (park.price_external || "2400 TL") 
            : (park.price_employee || "1200 TL");
          const supportPhone = park.support_phone || "0212 875 34 56";

          const message = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce kontrol edilmek üzere başarıyla teslim alınmıştır! Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${appId}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${parkingLocation}\n💸 Ücret: ${price}\n📞 Destek Telefonu: ${supportPhone}\n\n💳 Ödeme ve Dekont Bilgilendirmesi:\nYüklemiş olduğunuz ödeme dekontunuz yetkililerimiz tarafından incelenerek başvurunuz en geç 1 saat içerisinde onaylanacaktır. Başvurunuz onaylandığında plaka tanıma sistemimiz anında aktifleşecektir.\n\nBanka: ${bankName}\nIBAN: ${iban}`;

          await sendWhatsApp(phone, message, context.env);
        } catch (waErr) {
          console.error("Failed to send WhatsApp message on apply:", waErr);
        }
      })()
    );

    return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
