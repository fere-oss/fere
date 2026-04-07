import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const DAILY_LIMIT = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. Validate the Supabase access token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Use Supabase user UUID (provider-agnostic)
    const userId = user.id;
    const today = new Date().toISOString().slice(0, 10);

    // 3. Parse request body
    const { request, count_usage: countUsage = true } = await req.json();
    if (!request || typeof request !== "object" || !Array.isArray(request.messages)) {
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Check usage only on the first model call for a user turn.
    const { data: usageRow } = await supabase
      .from("usage")
      .select("count")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    const currentCount = usageRow?.count ?? 0;

    if (countUsage && currentCount >= DAILY_LIMIT) {
      return new Response(
        JSON.stringify({ error: "limit_reached", used: DAILY_LIMIT, limit: DAILY_LIMIT }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const nextCount = countUsage ? currentCount + 1 : currentCount;
    if (countUsage) {
      const { error: upsertError } = await supabase.from("usage").upsert(
        { user_id: userId, date: today, count: nextCount },
        { onConflict: "user_id,date" },
      );
      if (upsertError) {
        console.error("[chat] Usage upsert failed:", upsertError);
      } else {
        console.log("[chat] Usage incremented to", nextCount, "for", userId);
      }
    }

    // 5. Call OpenAI with streaming using the exact request shape from Electron.
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: typeof request.model === "string" ? request.model : "gpt-4o",
        messages: request.messages,
        tools: Array.isArray(request.tools) ? request.tools : undefined,
        tool_choice: request.tool_choice ?? undefined,
        max_tokens:
          typeof request.max_tokens === "number" ? request.max_tokens : 4096,
        temperature:
          typeof request.temperature === "number" ? request.temperature : 0.3,
        stream: true,
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      return new Response(
        JSON.stringify({ error: "openai_error", detail: errBody }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 6. Stream OpenAI SSE response back to Electron.
    const remaining = DAILY_LIMIT - nextCount;
    return new Response(openaiRes.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Remaining": String(remaining),
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "internal", detail: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
