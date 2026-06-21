// Helper for safe base64 decoding (supports Unicode)
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Helper to verify JWT token using HMAC-SHA256
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
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;
  const bucket = context.env.BUCKET;

  if (!supabaseUrl || !supabaseAnonKey || !bucket) {
    return new Response(JSON.stringify({ error: "Missing configuration or bindings" }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }

  // Get file path from URL query params, e.g. /api/document?path=applications/PE-123456/ruhsat.pdf or /api/document?path=avatars/admin-12345.jpg
  const { searchParams } = new URL(context.request.url);
  const path = searchParams.get("path");

  if (!path) {
    return new Response(JSON.stringify({ error: "Missing path parameter" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }

  const pathParts = path.split("/");
  const isAvatar = pathParts[0] === "avatars";

  // Authenticate Request
  let user = null;
  if (!isAvatar) {
    const authHeader = context.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }

    const token = authHeader.substring(7);
    const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
    user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
    if (!user) {
      return new Response(JSON.stringify({ error: "Geçersiz oturum!" }), {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }

    if (pathParts.length < 3 || pathParts[0] !== "applications") {
      return new Response(JSON.stringify({ error: "Invalid document path" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }
  } else {
    if (pathParts.length !== 2) {
      return new Response(JSON.stringify({ error: "Invalid avatar path" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }
  }

  try {
    if (!isAvatar) {
      const appId = pathParts[1];

      // If regular admin, check if authorized for this otopark
      if (user.role !== "superadmin") {
        const getRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${appId}&select=parking_location`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (!getRes.ok) {
          return new Response(JSON.stringify({ error: "Başvuru bulunamadı!" }), {
            status: 404,
            headers: { ...headers, "Content-Type": "application/json" }
          });
        }

        const apps = await getRes.json();
        if (apps.length === 0) {
          return new Response(JSON.stringify({ error: "Başvuru bulunamadı!" }), {
            status: 404,
            headers: { ...headers, "Content-Type": "application/json" }
          });
        }

        const appLocation = apps[0].parking_location;
        if (!user.otoparks.includes(appLocation)) {
          return new Response(JSON.stringify({ error: "Bu evraka erişim yetkiniz bulunmamaktadır!" }), {
            status: 403,
            headers: { ...headers, "Content-Type": "application/json" }
          });
        }
      }
    }

    // Retrieve file from Cloudflare R2
    const object = await bucket.get(path);
    if (!object) {
      return new Response(JSON.stringify({ error: "Dosya depoda bulunamadı!" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }

    // Serve streaming response
    const fileHeaders = new Headers();
    object.writeHttpMetadata(fileHeaders);
    fileHeaders.set("etag", object.httpEtag);
    fileHeaders.set("Access-Control-Allow-Origin", allowOrigin);
    
    // Set appropriate disposition header to preview/download safely
    fileHeaders.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");

    return new Response(object.body, {
      status: 200,
      headers: fileHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}
