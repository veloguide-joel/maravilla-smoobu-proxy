# Production launch: working plan and state

Owner decisions (Joel, 2026-11-20): domain micasadirect.com; English, USD; 16% IVA + 5% state lodging tax added to every
total; full payment at booking for launch (50% deposit with the balance 60 days before arrival is the first post-launch
upgrade); all catalog listings sell direct; cancellation and refunds are manual (Hostaway, then the Stripe dashboard).
Cancellation policy: 90+ days before arrival, refund less a $250 fee; 89 to 0 days, no refund but a credit (less $250)
toward a stay in the same unit within one year. Claude merges and deploys test work; ChatGPT reviews sprint reports.

## Proven on TEST (2026-11-20)
One booking ran end to end with no human step after payment: kickoff run 44786323065, pipeline 44786599480
(reservation 72064398, capture, record: once each), confirmation 44789242238 (one email, delivered), status OK.

## Design rule for going live
TEST and LIVE are never mixed. Every safety check compares against the CONFIGURED mode ("test" by default) instead of the
literal "test": the database marker (`booking.instance`), the intent's environment, and Stripe's `livemode`. Production
gets its own database (marker `live`), its own GitHub environment and arm variable, and its own keys.

## Slices
| # | Slice | State |
|---|---|---|
| P1 | Taxes (`lib/checkout/tax-policy.js`, migration 0029). Off until `MV_CHECKOUT_TAX_POLICY=mx-iva16-ish5-v1` and 0029 are applied | merged (#237) |
| P2a | Checkout API + webhook take the mode from the gate; LIVE needs the full contract AND `MV_CHECKOUT_LIVE_ACTIVATION=live-payments-approved` | merged (#238) |
| P2b-1 | Reservation, capture, recording and compensation workers: `mode` option ("test" default); database marker, intent environment and payment livemode fences compare against it | this PR |
| P2b-2 | Proof modules (`capture-proof`, `compensation-proof`, `recovery-plan`: `livemode !== false`) and the state machine's `expectedLivemode` in worker `applyEvent` calls take the mode. Cleanup and mirror workers stay TEST-only | todo |
| P2c | Kickoff / pipeline / confirmation runners: listing allowlist instead of 606998; migration for the 0024 kickoff trigger (TEST / 606998 / USD only today) | todo |
| P2d | Confirmation email to real guests (today: sink address only), with policy text and the tax breakdown | todo |
| P3 | Production database (schema 1..N at marker `live`, backups), production Vercel env, production GitHub environment + arm, release pins | todo |
| P4 | Guest site "Book now" to the production checkout; micasadirect.com DNS to Vercel (today: Squarespace defaults + Resend mail records) | todo |
| P5 | TEST re-proof with taxes on ($169.40), then one owner-approved live booking | todo |

## Known constraints
- The armed TEST runners on `main` pin tooling commits and a release digest (`scripts/e7-test-arm/manifest.json`). Changes on
  `e7-test` do not reach them until the pins are updated; that re-pin is part of P2c / P3.
- The CI job `c119-s4-tooling` has been red since the C136 worker fences (a frozen-`lib` assertion in a one-off 0027 packet test).
- Fenced, never touched: the C120 `outcome_unknown` notification op, the historic notification rows, and reservations
  70636076 / 71045356 / 71072615 / 71081885.
