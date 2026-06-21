export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
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

  // 1. Authenticate JWT (Super Admin Only)
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";

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

  const urlObj = new URL(context.request.url);
  const refresh = urlObj.searchParams.get("refresh") === "true";

  try {
    // 2. Fetch latest 100 SMS logs from Supabase
    const logsRes = await fetch(`${supabaseUrl}/rest/v1/sms_logs?select=*&order=created_at.desc&limit=100`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    if (!logsRes.ok) {
      // If table doesn't exist yet, return a clear message so the admin knows they need to run the SQL script
      const errText = await logsRes.text();
      if (logsRes.status === 404 || errText.includes("relation") && errText.includes("does not exist")) {
        return new Response(JSON.stringify({
          error: "sms_logs_table_missing",
          message: "SMS günlüğü tablosu (sms_logs) veritabanında bulunamadı. Lütfen Supabase SQL Editor üzerinden tabloyu oluşturun."
        }), { status: 404, headers });
      }
      return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: logsRes.status, headers });
    }

    let smsLogs = await logsRes.json();

    // 3. If refresh=true, query Netgsm and update non-final statuses
    if (refresh) {
      const usercode = context.env.NETGSM_USERCODE;
      const password = context.env.NETGSM_PASSWORD;

      if (usercode && password) {
        // Find logs that are in non-final status (not 'İletildi' and not starting with 'Hata' or 'Simüle')
        const pendingLogs = smsLogs.filter(log => 
          log.job_id && 
          !log.job_id.startsWith("SIM-") && 
          log.status !== "İletildi" && 
          !log.status.startsWith("Hata") &&
          !log.status.startsWith("İletilemedi")
        );

        // Limit checking to avoid rate limits (max 8 logs per refresh)
        const logsToCheck = pendingLogs.slice(0, 8);

        for (const log of logsToCheck) {
          try {
            const reportUrl = `https://api.netgsm.com.tr/sms/report?usercode=${usercode}&password=${password}&bulkid=${log.job_id}&type=0&status=100&version=2`;
            const netgsmRes = await fetch(reportUrl, {
              headers: { "Content-Type": "application/json" }
            });

            if (netgsmRes.ok) {
              const resText = await netgsmRes.text();
              
              // Netgsm returns line like: "905xxxxxxxxx status_code length count date time operator_code"
              // e.g., "905372939874 1 10 1 08.06.2026 18:00:00 102"
              // Or error codes like "30", "60", "70", etc.
              const firstLine = resText.split("\n")[0]?.trim();
              if (firstLine && firstLine.length > 5) {
                const tokens = firstLine.split(/\s+/);
                const statusCode = tokens[1]; // Status code is second token
                
                let newStatus = log.status;
                if (statusCode === "1") {
                  newStatus = "İletildi";
                } else if (statusCode === "0") {
                  newStatus = log.scheduled_at ? "Zamanlandı" : "Beklemede";
                } else if (["2", "3", "4"].includes(statusCode)) {
                  newStatus = `İletilemedi (Kod ${statusCode})`;
                } else if (statusCode === "16") {
                  newStatus = "İletilemedi (İYS Engeli)";
                } else if (statusCode) {
                  newStatus = `Durum: ${statusCode}`;
                }

                if (newStatus !== log.status) {
                  // Update status in Supabase
                  await fetch(`${supabaseUrl}/rest/v1/sms_logs?id=eq.${log.id}`, {
                    method: "PATCH",
                    headers: {
                      "apikey": supabaseAnonKey,
                      "Authorization": `Bearer ${supabaseAnonKey}`,
                      "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ status: newStatus })
                  });
                  log.status = newStatus; // update in-memory value to return it immediately
                }
              } else if (resText === "60") {
                console.log(`[sms_reports] JobID ${log.job_id} returned 60 (No record found yet)`);
              } else if (["30", "40", "70", "80"].includes(resText.trim())) {
                console.warn(`[sms_reports] Netgsm returned error code: ${resText.trim()}`);
              }
            }
          } catch (err) {
            console.error(`[sms_reports] Failed to check status for JobID ${log.job_id}:`, err);
          }
        }
      }
    }

    return new Response(JSON.stringify(smsLogs), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
