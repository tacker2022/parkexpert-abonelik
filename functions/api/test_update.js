export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    // 1. Fetch current birlik-sanayi otopark
    const oldRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.birlik-sanayi&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const oldData = await oldRes.json();
    const park = oldData[0] || {};

    // 2. Try to update it with tariffs = [{"name": "Personel", "price": "300"}]
    const updateRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.birlik-sanayi`, {
      method: "PATCH",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        price_employee: "300",
        price_external: "300",
        tariffs: [{ name: "Personel", price: "300" }]
      })
    });
    const updateResult = updateRes.ok ? await updateRes.json() : { error: await updateRes.text(), status: updateRes.status };

    // 3. Fetch again to verify
    const verifyRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.birlik-sanayi&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const verifyData = await verifyRes.json();

    return new Response(JSON.stringify({
      success: true,
      oldData: park,
      updateResult,
      verifyData: verifyData[0] || {}
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers });
  }
}
