// db/lib/codec.js — re-export shim (2026-11-02 packaging): the module lives in lib/booking-db/codec.js so the gated
// API route can bundle it while /db stays excluded from upload. Same module instance: identical exports and function identities.
export * from "../../lib/booking-db/codec.js";
