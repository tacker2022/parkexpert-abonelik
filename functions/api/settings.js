// GET & POST endpoint for system settings configuration

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: Fetch system settings (Publicly readable)
    // ----------------------------------------------------
    if (method === "GET") {
      const res = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        // Fallback to default if table doesn't exist or query fails
        console.warn("[GET /api/settings] system_settings table query failed or not created yet, returning defaults");
        return new Response(JSON.stringify({
          email_enabled: true,
          whatsapp_enabled: true,
          sms_enabled: true,
          delay_night_sms: false,
          send_expiration_reminder: true,
          expiration_reminder_days: 3
        }), { status: 200, headers });
      }

      const rows = await res.json();
      if (rows.length === 0) {
        return new Response(JSON.stringify({
          email_enabled: true,
          whatsapp_enabled: true,
          sms_enabled: true,
          delay_night_sms: false,
          send_expiration_reminder: true,
          expiration_reminder_days: 3
        }), { status: 200, headers });
      }

      return new Response(JSON.stringify(rows[0].value), { status: 200, headers });
    }

    // ----------------------------------------------------
    // POST: Update system settings (Super Admin Only)
    // ----------------------------------------------------
    if (method === "POST") {
      const authHeader = context.request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
      }

      const token = authHeader.substring(7);
      
      // Inline decode & verify JWT token using HMAC-SHA256
      const verifyTokenInline = async (token, secret) => {
        try {
          const parts = token.split(".");
          if (parts.length !== 2) return null;
          
          const binString = atob(parts[0]);
          const bytes = new Uint8Array(binString.length);
          for (let i = 0; i < binString.length; i++) {
            bytes[i] = binString.charCodeAt(i);
          }
          const payloadStr = new TextDecoder().decode(bytes);
          const signatureHex = parts[1];
          
          const encoder = new TextEncoder();
          const keyData = encoder.encode(secret);
          const key = await crypto.subtle.importKey(
            "raw",
            keyData,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          );
          
          const signatureBuffer = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(payloadStr)
          );
          const signatureArray = Array.from(new Uint8Array(signatureBuffer));
          const reSignatureHex = signatureArray.map(b => b.toString(16).padStart(2, "0")).join("");
          
          if (signatureHex === reSignatureHex) {
            const payload = JSON.parse(payloadStr);
            if (payload.exp && payload.exp < Date.now()) {
              return null; // Expired
            }
            return payload;
          }
        } catch (e) {
          return null;
        }
        return null;
      };

      const user = await verifyTokenInline(token, jwtSecret);
      if (!user || user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
      }

      const payload = await context.request.json();
      const { email_enabled, whatsapp_enabled, sms_enabled, delay_night_sms, send_expiration_reminder, expiration_reminder_days } = payload;

      const dbPayload = {
        id: "1",
        key: "notification_toggles",
        value: {
          email_enabled: email_enabled !== false,
          whatsapp_enabled: whatsapp_enabled !== false,
          sms_enabled: sms_enabled !== false,
          delay_night_sms: delay_night_sms === true,
          send_expiration_reminder: send_expiration_reminder !== false,
          expiration_reminder_days: parseInt(expiration_reminder_days) || 3
        },
        updated_at: new Date().toISOString()
      };

      // Upsert using POST with Resolution headers
      const res = await fetch(`${supabaseUrl}/rest/v1/system_settings`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(dbPayload)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[POST /api/settings] Supabase save error: ${errText}`);
        return new Response(JSON.stringify({ error: `Supabase save error: ${errText}` }), { status: res.status, headers });
      }

      const data = await res.json();
      return new Response(JSON.stringify({ success: true, data: data[0]?.value }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
