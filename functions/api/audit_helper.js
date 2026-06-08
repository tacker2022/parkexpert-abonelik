// Helper for logging admin actions to audit_logs table in Supabase
export async function logAudit({
  supabaseUrl,
  supabaseAnonKey,
  username,
  role,
  actionType,
  targetId,
  details,
  ipAddress
}) {
  try {
    const cleanUrl = supabaseUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
    
    // We run it as a fire-and-forget fetch or await it.
    // In workers context, if using context.waitUntil, we can pass it, but standard await is safer.
    const response = await fetch(`${cleanUrl}/rest/v1/audit_logs`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        admin_username: username || "unknown",
        admin_role: role || "unknown",
        action_type: actionType,
        target_id: String(targetId || ""),
        details: details || "",
        ip_address: ipAddress || ""
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[logAudit Response Error]:", errText);
    }
  } catch (err) {
    console.error("[logAudit Exception Error]:", err);
  }
}
