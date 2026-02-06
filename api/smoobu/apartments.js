export default async function handler(req, res) {
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

    res.status(200).json({
      ok: true,
      apartments: data.apartments || []
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
