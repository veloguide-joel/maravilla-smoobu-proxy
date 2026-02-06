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

    const data = await response.json();

    res.status(200).json({
      ok: true,
      count: Array.isArray(data) ? data.length : null,
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
