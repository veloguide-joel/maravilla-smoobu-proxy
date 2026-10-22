# Hostaway fixtures: SYNTHETIC, NOT provider evidence

Every file here was written by hand for offline tests of `lib/hostaway-reservations.js`.

- They follow the **documented** shapes of the official reference (https://api.hostaway.com/documentation, read 2026-10-22):
  - the "Reservation object" field names;
  - the "Standard Response" envelope;
  - the 429 rate-limit body.
- **None** of them was received from Hostaway.
- They contain no real guest, listing, reservation or account data:
  - listing `990001` and reservation ids are invented;
  - guest data uses the reserved `.invalid` domain.
- Behaviour the docs do not state (create-response envelope, refusal codes, `totalPrice` echo, `customFieldValues` in responses, id ordering) is **live-unverified**. These files do not prove it.
