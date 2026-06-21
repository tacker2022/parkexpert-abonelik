import { logAudit } from "./audit_helper.js";
import { sendTelegramAlert } from "./telegram_helper.js";

// Inline JWT validator for Cloudflare Workers
async function verifyTokenInline(token, secret, clientIp) {
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // 1. Authorize Admin
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const adminUser = await verifyTokenInline(token, jwtSecret, clientIp);
  
  if (!adminUser || adminUser.role !== "superadmin") {
    return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
  }

  const url = new URL(context.request.url);
  const action = url.searchParams.get("action") || "list";

  try {
    // ----------------------------------------------------
    // ACTION: list (List backups from R2)
    // ----------------------------------------------------
    if (action === "list") {
      const bucket = context.env.BACKUP_BUCKET;
      if (!bucket) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "BACKUP_BUCKET_MISSING",
          message: "Yedeklerin listelenebilmesi için Cloudflare Dashboard'da R2 yedekleme kovasının 'BACKUP_BUCKET' adıyla Pages projesine bağlanması gerekmektedir."
        }), { status: 200, headers });
      }

      const listResult = await bucket.list({ limit: 100 });
      const files = listResult.objects
        .map(obj => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded
        }))
        .filter(f => f.key.startsWith("backup-"))
        .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

      return new Response(JSON.stringify({ success: true, files }), { status: 200, headers });
    }

    // ----------------------------------------------------
    // ACTION: download (Download file from R2)
    // ----------------------------------------------------
    if (action === "download") {
      const bucket = context.env.BACKUP_BUCKET;
      const filename = url.searchParams.get("file");

      if (!bucket) {
        return new Response(JSON.stringify({ error: "BACKUP_BUCKET binding is missing" }), { status: 500, headers });
      }
      if (!filename) {
        return new Response(JSON.stringify({ error: "Dosya adı belirtilmedi." }), { status: 400, headers });
      }

      const fileObj = await bucket.get(filename);
      if (!fileObj) {
        return new Response(JSON.stringify({ error: "Dosya bulunamadı." }), { status: 404, headers });
      }

      // Log action to Audit Logs
      await logAudit({
        supabaseUrl,
        supabaseAnonKey,
        username: adminUser.username,
        role: adminUser.role,
        actionType: "Veritabanı Yedeği İndirildi",
        targetId: filename,
        details: `${filename} isimli yedek dosyası admin panelinden indirildi.`,
        ipAddress: clientIp
      });

      context.waitUntil(
        sendTelegramAlert(
          `<b>📥 Veritabanı Yedeği İndirildi</b>\n\n` +
          `<b>Yapan:</b> ${adminUser.username} (Rol: ${adminUser.role})\n` +
          `<b>IP Adresi:</b> ${clientIp}\n` +
          `<b>Dosya:</b> ${filename}`,
          context.env
        )
      );

      const responseHeaders = {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": filename.endsWith(".xlsx") 
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/octet-stream"
      };

      return new Response(fileObj.body, { headers: responseHeaders });
    }

    // ----------------------------------------------------
    // ACTION: trigger (Trigger GitHub Action manually)
    // ----------------------------------------------------
    if (action === "trigger" && context.request.method === "POST") {
      const githubPat = context.env.GITHUB_PAT;
      
      if (!githubPat) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "GITHUB_PAT_MISSING",
          message: "Manuel yedekleme tetiklemek için Cloudflare Dashboard'da GITHUB_PAT (GitHub Personal Access Token) tanımlanmış olmalıdır."
        }), { status: 200, headers });
      }

      const repo = context.env.GITHUB_REPO || "tacker2022/parkexpert-abonelik";
      const workflow = context.env.GITHUB_WORKFLOW || "db_backup.yml";

      const ghResponse = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${githubPat}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Cloudflare-Pages-Worker",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({ ref: "main" })
      });

      if (!ghResponse.ok) {
        const errText = await ghResponse.text();
        return new Response(JSON.stringify({ 
          success: false, 
          error: "GITHUB_API_ERROR", 
          message: `GitHub API hatası: ${errText}` 
        }), { status: 200, headers });
      }

      // Log action to Audit Logs
      await logAudit({
        supabaseUrl,
        supabaseAnonKey,
        username: adminUser.username,
        role: adminUser.role,
        actionType: "Veritabanı Yedekleme Tetiklendi",
        targetId: workflow,
        details: "Yönetici paneli üzerinden manuel veritabanı yedekleme işlemi (GitHub Actions) tetiklendi.",
        ipAddress: clientIp
      });

      context.waitUntil(
        sendTelegramAlert(
          `<b>💾 Veritabanı Yedekleme Tetiklendi</b>\n\n` +
          `<b>Yapan:</b> ${adminUser.username} (Rol: ${adminUser.role})\n` +
          `<b>IP Adresi:</b> ${clientIp}\n` +
          `<b>Durum:</b> GitHub Actions yedekleme iş akışı manuel başlatıldı.`,
          context.env
        )
      );

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Yedekleme işlemi başarıyla tetiklendi. Yedekler 2-3 dakika içinde R2 ve Google Drive'a yüklenecektir." 
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Geçersiz eylem veya istek yöntemi." }), { status: 400, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
