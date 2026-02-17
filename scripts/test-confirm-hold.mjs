
// Node 18+ fetch

async function main() {
  // Step 1: Create hold
  const createBody = {
    propertyId: "test-property",
    unitId: "test-unit",
    from: "2026-02-18",
    to: "2026-02-20",
    guests: 2,
    customerEmail: "test@example.com",
    customerName: "Test User"
  };
  const createRes = await fetch("http://localhost:3000/api/holds/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody)
  });
  const createJson = await createRes.json();
  console.log("Create response:", createJson);

  // Step 2: Extract hold id
  const hold = createJson.hold || createJson.inserted || createJson.confirmed || createJson.data || createJson;
  const holdId = hold.id || createJson.id;
  if (!holdId) {
    console.error("No hold id found in create response.");
    process.exit(1);
  }

  // Step 3: Confirm hold
  const confirmBody = {
    holdId,
    stripeSessionId: `cs_test_${Date.now()}`,
    stripePaymentIntentId: `pi_test_${Date.now()}`
  };
  const confirmRes = await fetch("http://localhost:3000/api/holds/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirmBody)
  });
  const confirmJson = await confirmRes.json();
  console.log("Confirm response:", confirmJson);
}

main();
