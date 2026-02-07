import { applyCors, handleCorsPreflight } from "../_cors";

export default async function handler(req, res) {
  if (handleCorsPreflight(req, res)) {
    return;
  }

  applyCors(req, res);

  try {
    const response = await fetch(
      `${process.env.SMOOBU_API_BASE}/apartments`,
      {
        headers: {
          "Api-Key": process.env.SMOOBU_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Smoobu API error: ${response.status}`);
    }

    const data = await response.json();
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
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
