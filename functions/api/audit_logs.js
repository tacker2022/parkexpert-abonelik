// GET endpoint for fetching admin audit logs (Super Admin Only)
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function verifyToken(token, secret, clientIp, supabaseUrl, supabaseAnonKey) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payloadStr = base64Decode(parts[0]);
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
        return null;
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
}

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

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
  if (!user || user.role !== "superadmin") {
    return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
  }

  const url = new URL(context.request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const search = url.searchParams.get("search") || "";
  const actionType = url.searchParams.get("action_type") || "";
  const startDate = url.searchParams.get("start_date") || "";
  const endDate = url.searchParams.get("end_date") || "";
  const isExport = url.searchParams.get("export") === "true";

  try {
    const queryParams = [];
    queryParams.push("select=*");
    queryParams.push("order=created_at.desc");

    if (actionType) {
      queryParams.push(`action_type=eq.${encodeURIComponent(actionType)}`);
    }
    if (startDate) {
      const startIso = new Date(startDate + "T00:00:00.000Z").toISOString();
      queryParams.push(`created_at=gte.${encodeURIComponent(startIso)}`);
    }
    if (endDate) {
      const endIso = new Date(endDate + "T23:59:59.999Z").toISOString();
      queryParams.push(`created_at=lte.${encodeURIComponent(endIso)}`);
    }
    if (search) {
      queryParams.push(`or=(admin_username.ilike.*${encodeURIComponent(search)}*,details.ilike.*${encodeURIComponent(search)}*,ip_address.ilike.*${encodeURIComponent(search)}*)`);
    }

    if (!isExport) {
      const offset = (page - 1) * limit;
      queryParams.push(`limit=${limit}`);
      queryParams.push(`offset=${offset}`);
    }

    const supabaseQueryUrl = `${supabaseUrl}/rest/v1/audit_logs?${queryParams.join("&")}`;

    const headersToSupabase = {
      "apikey": supabaseAnonKey,
      "Authorization": `Bearer ${supabaseAnonKey}`
    };
    if (!isExport) {
      headersToSupabase["Prefer"] = "count=exact";
    }

    const res = await fetch(supabaseQueryUrl, {
      headers: headersToSupabase
    });

    if (!res.ok) {
      console.warn("[audit_logs API] Failed to query audit_logs table. Returning empty response fallback.");
      return new Response(JSON.stringify(isExport ? [] : { data: [], page, limit, totalCount: 0 }), { status: 200, headers });
    }

    const data = await res.json();

    if (isExport) {
      return new Response(JSON.stringify(data), { status: 200, headers });
    } else {
      const contentRange = res.headers.get("content-range") || "";
      let totalCount = 0;
      if (contentRange) {
        const parts = contentRange.split("/");
        if (parts.length === 2) {
          totalCount = parseInt(parts[1]) || 0;
        }
      }
      return new Response(JSON.stringify({
        data,
        page,
        limit,
        totalCount
      }), { status: 200, headers });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
