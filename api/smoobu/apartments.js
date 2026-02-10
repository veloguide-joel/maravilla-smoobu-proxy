import { applyCors, handleCorsPreflight } from "../_cors";

export default async function handler(req, res) {
  try {
    if (handleCorsPreflight(req, res)) {
      return;
    }

    applyCors(req, res);

    const response = await fetch(
      `${process.env.SMOOBU_API_BASE}/apartments`,
      {
        headers: {
          "Api-Key": process.env.SMOOBU_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const upstreamStatus = response.status;
    const upstreamStatusText = response.statusText;
    const upstreamText = await response.text();

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
      data = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (parseError) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_INVALID",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        }
      });
      return;
    }

    const apartments = Array.isArray(data.apartments) ? data.apartments : [];
    const payload = {
      ok: true,
      apartments
    };

    if (req.query && req.query.debug === "1") {
      payload._debug = {
        apartmentKeysSample: Object.keys(apartments[0] || {})
      };
    }

    res.status(200).json(payload);

  } catch (err) {
    console.error("[smoobu] endpoint failed", {
      endpoint: "apartments",
      message: err?.message,
      stack: err?.stack
    });
    try {
      applyCors(req, res);
    } catch (corsError) {
      // Ignore secondary failures when applying CORS headers.
    }
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "apartments",
      message: err?.message || "Unknown error"
    });
  }
}
