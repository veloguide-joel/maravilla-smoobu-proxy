export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      res.status(500).json({ ok: false, error: "SMOOBU_KEY_MISSING" });
      return;
    }

    let response = null;
    try {
      response = await fetch("https://login.smoobu.com/api/me", {
        headers: {
          "Api-Key": apiKey,
          "Accept": "application/json"
        }
      });
    } catch (fetchError) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: { status: null, statusText: null }
      });
      return;
    }

    const upstreamStatus = response.status;
    const upstreamStatusText = response.statusText;

    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        }
      });
      return;
    }

    let data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        }
      });
      return;
    }

    const id = Number(data?.id);

    res.status(200).json({
      ok: true,
      id: Number.isFinite(id) ? id : null,
      email: typeof data?.email === "string" ? data.email : null,
      name: typeof data?.name === "string" ? data.name : null
    });
  } catch (err) {
    console.error("[smoobu] endpoint failed", {
      endpoint: "me",
      message: err?.message,
      stack: err?.stack
    });
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "me",
      message: err?.message || "Unknown error"
    });
  }
}
