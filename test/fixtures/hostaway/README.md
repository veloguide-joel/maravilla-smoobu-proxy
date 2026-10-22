# Hostaway fixtures: SYNTHETIC, NOT provider evidence

Every file here was written by hand for offline tests of `lib/hostaway-reservations.js` and `scripts/hostaway-readonly-check.mjs`.

- They follow the **documented** shapes of the official reference (https://api.hostaway.com/documentation, read 2026-10-22):
  - the "Reservation object" field names;
  - the "Standard Response" envelope;
  - the 429 rate-limit body.
- **None** of them was received from Hostaway.
- They contain no real guest, reservation or account data (the `synthetic-ro-*` files reuse only the test listing's id and public test values):
  - listing `990001` and reservation ids are invented;
  - guest data uses the reserved `.invalid` domain.
- `synthetic-ro-*.json` (read-only CLI tests) follow the documented "Custom field object", "Listing object", calendar day object and "Calculate reservation price" (version 2) examples. Their values (field 105433, listing 606998, USD 100/night, USD 50 cleaning fee) mirror what the dashboard showed, but they are hand-written, **not** API responses.
- Behaviour the docs do not state (create-response envelope, refusal codes, `totalPrice` echo, `customFieldValues` in responses, id ordering) is **live-unverified**. These files do not prove it.
