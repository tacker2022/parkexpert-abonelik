// GET & POST endpoint for system settings configuration
import { logAudit } from "./audit_helper.js";
import { sendTelegramAlert } from "./telegram_helper.js";

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
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
          expiration_reminder_days: 3,
          flash_sms: false,
          two_factor_enabled: false,
          two_factor_whatsapp_enabled: false,
          two_factor_sms_enabled: false,
          auto_reminders_enabled: false,
          auto_reminders_channel: "sms",
          auto_reminders_days: "7,3,1,0",
          auto_reminders_template_7d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz 7 gün sonra dolacaktır. Yenilemek için plakanız: {plateNumber}. PARKEXPERT",
          auto_reminders_template_3d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz 3 gün sonra dolacaktır. Yenilemek için lütfen ödemenizi yapıp dekontunuzu sisteme yükleyiniz. PARKEXPERT",
          auto_reminders_template_1d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz yarın dolacaktır. Plakanız: {plateNumber}. PARKEXPERT",
          auto_reminders_template_0d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz bugün dolmuştur. Plaka tanıma sisteminiz deaktif edilmiştir. Plakanız: {plateNumber}. PARKEXPERT"
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
          expiration_reminder_days: 3,
          flash_sms: false,
          two_factor_enabled: false,
          two_factor_whatsapp_enabled: false,
          two_factor_sms_enabled: false,
          auto_reminders_enabled: false,
          auto_reminders_channel: "sms",
          auto_reminders_days: "7,3,1,0",
          auto_reminders_template_7d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz 7 gün sonra dolacaktır. Yenilemek için plakanız: {plateNumber}. PARKEXPERT",
          auto_reminders_template_3d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz 3 gün sonra dolacaktır. Yenilemek için lütfen ödemenizi yapıp dekontunuzu sisteme yükleyiniz. PARKEXPERT",
          auto_reminders_template_1d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz yarın dolacaktır. Plakanız: {plateNumber}. PARKEXPERT",
          auto_reminders_template_0d: "Sayın {fullName}, {appLocation} otopark aboneliğiniz bugün dolmuştur. Plaka tanıma sisteminiz deaktif edilmiştir. Plakanız: {plateNumber}. PARKEXPERT"
        }), { status: 200, headers });
      }

      // Merge defaults for newly added settings keys in existing database rows
      const dbSettings = rows[0].value || {};
      const mergedSettings = {
        email_enabled: dbSettings.email_enabled !== false,
        whatsapp_enabled: dbSettings.whatsapp_enabled !== false,
        sms_enabled: dbSettings.sms_enabled !== false,
        delay_night_sms: dbSettings.delay_night_sms === true,
        send_expiration_reminder: dbSettings.send_expiration_reminder !== false,
        expiration_reminder_days: parseInt(dbSettings.expiration_reminder_days) || 3,
        flash_sms: dbSettings.flash_sms === true,
        two_factor_enabled: dbSettings.two_factor_enabled === true,
        two_factor_whatsapp_enabled: dbSettings.two_factor_whatsapp_enabled === true,
        two_factor_sms_enabled: dbSettings.two_factor_sms_enabled === true,
        auto_reminders_enabled: dbSettings.auto_reminders_enabled === true,
        auto_reminders_channel: dbSettings.auto_reminders_channel || "sms",
        auto_reminders_days: dbSettings.auto_reminders_days || "7,3,1,0",
        auto_reminders_template_7d: dbSettings.auto_reminders_template_7d || "Sayın {fullName}, {appLocation} otopark aboneliğiniz 7 gün sonra dolacaktır. Yenilemek için plakanız: {plateNumber}. PARKEXPERT",
        auto_reminders_template_3d: dbSettings.auto_reminders_template_3d || "Sayın {fullName}, {appLocation} otopark aboneliğiniz 3 gün sonra dolacaktır. Yenilemek için lütfen ödemenizi yapıp dekontunuzu sisteme yükleyiniz. PARKEXPERT",
        auto_reminders_template_1d: dbSettings.auto_reminders_template_1d || "Sayın {fullName}, {appLocation} otopark aboneliğiniz yarın dolacaktır. Plakanız: {plateNumber}. PARKEXPERT",
        auto_reminders_template_0d: dbSettings.auto_reminders_template_0d || "Sayın {fullName}, {appLocation} otopark aboneliğiniz bugün dolmuştur. Plaka tanıma sisteminiz deaktif edilmiştir. Plakanız: {plateNumber}. PARKEXPERT"
      };

      return new Response(JSON.stringify(mergedSettings), { status: 200, headers });
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
      const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
      
      // Inline decode & verify JWT token using HMAC-SHA256
      const verifyTokenInline = async (token, secret, clientIp, supabaseUrl, supabaseAnonKey) => {
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
            // Enforce IP binding for superadmin
            if (payload.role === "superadmin") {
              if (!payload.ip || payload.ip !== clientIp) {
                return null; // IP mismatch or missing IP claim!
              }
            }
            // Check blacklist
            if (payload.jti && supabaseUrl && supabaseAnonKey) {
              try {
                const blRes = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens?jti=eq.${payload.jti}&select=jti`, {
                  headers: {
                    "apikey": supabaseAnonKey,
                    "Authorization": `Bearer ${supabaseAnonKey}`
                  }
                });
                if (blRes.ok) {
                  const rows = await blRes.json();
                  if (rows.length > 0) {
                    return null; // Blacklisted!
                  }
                }
              } catch (e) {
                console.error("Blacklist check error:", e);
              }
            } else {
              return null; // Force log out for old tokens without JTI
            }
            return payload;
          }
        } catch (e) {
          return null;
        }
        return null;
      };

      const user = await verifyTokenInline(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
      if (!user || user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
      }

      const payload = await context.request.json();
      const { email_enabled, whatsapp_enabled, sms_enabled, delay_night_sms, send_expiration_reminder, expiration_reminder_days, flash_sms, two_factor_enabled, two_factor_whatsapp_enabled, two_factor_sms_enabled,
              auto_reminders_enabled, auto_reminders_channel, auto_reminders_days,
              auto_reminders_template_7d, auto_reminders_template_3d, auto_reminders_template_1d, auto_reminders_template_0d } = payload;

      // 1. Fetch old settings first to compare changes
      let oldSettings = {};
      try {
        const oldRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });
        if (oldRes.ok) {
          const oldRows = await oldRes.json();
          if (oldRows.length > 0 && oldRows[0].value) {
            oldSettings = oldRows[0].value;
          }
        }
      } catch (e) {
        console.warn("Failed to fetch old settings for auditing:", e);
      }

      const dbPayload = {
        id: "1",
        key: "notification_toggles",
        value: {
          email_enabled: email_enabled !== false,
          whatsapp_enabled: whatsapp_enabled !== false,
          sms_enabled: sms_enabled !== false,
          delay_night_sms: delay_night_sms === true,
          send_expiration_reminder: send_expiration_reminder !== false,
          expiration_reminder_days: parseInt(expiration_reminder_days) || 3,
          flash_sms: flash_sms === true,
          two_factor_enabled: two_factor_enabled === true,
          two_factor_whatsapp_enabled: two_factor_whatsapp_enabled === true,
          two_factor_sms_enabled: two_factor_sms_enabled === true,
          auto_reminders_enabled: auto_reminders_enabled === true,
          auto_reminders_channel: auto_reminders_channel || "sms",
          auto_reminders_days: auto_reminders_days || "7,3,1,0",
          auto_reminders_template_7d: auto_reminders_template_7d || "",
          auto_reminders_template_3d: auto_reminders_template_3d || "",
          auto_reminders_template_1d: auto_reminders_template_1d || "",
          auto_reminders_template_0d: auto_reminders_template_0d || ""
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

      // Compare changes
      const changes = [];
      const keysToCompare = [
        { key: "email_enabled", name: "E-posta Bildirimi" },
        { key: "whatsapp_enabled", name: "WhatsApp Bildirimi" },
        { key: "sms_enabled", name: "SMS Bildirimi" },
        { key: "delay_night_sms", name: "Gece SMS Erteleme" },
        { key: "send_expiration_reminder", name: "Bitiş Hatırlatması" },
        { key: "expiration_reminder_days", name: "Hatırlatma Gün Sayısı" },
        { key: "flash_sms", name: "Flash SMS" },
        { key: "two_factor_enabled", name: "E-posta 2FA" },
        { key: "two_factor_whatsapp_enabled", name: "WhatsApp 2FA Yedek" },
        { key: "two_factor_sms_enabled", name: "SMS 2FA Yedek" },
        { key: "auto_reminders_enabled", name: "Otomatik Hatırlatıcı" },
        { key: "auto_reminders_channel", name: "Hatırlatıcı Kanalı" }
      ];

      for (const item of keysToCompare) {
        const oldVal = oldSettings[item.key];
        const newVal = dbPayload.value[item.key];
        if (oldVal !== newVal) {
          const formatVal = (v) => {
            if (v === true) return "Aktif";
            if (v === false) return "Pasif";
            if (v === undefined || v === null) return "Tanımsız";
            return String(v);
          };
          changes.push(`${item.name}: ${formatVal(oldVal)} ➔ ${formatVal(newVal)}`);
        }
      }

      let details = "Sistem bildirim ve otomatik hatırlatma ayarları güncellendi.";
      if (changes.length > 0) {
        details += " (Değişenler: " + changes.join(", ") + ")";
      }

      // Log audit action
      const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
      context.waitUntil(
        logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "update_settings",
          targetId: "notification_toggles",
          details,
          ipAddress
        })
      );

      context.waitUntil(
        sendTelegramAlert(
          `<b>⚙️ Sistem Ayarları Güncellendi</b>\n\n` +
          `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
          `<b>IP Adresi:</b> ${ipAddress}\n` +
          `<b>Detay:</b> ${details}`,
          context.env
        )
      );

      return new Response(JSON.stringify({ success: true, data: data[0]?.value }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
