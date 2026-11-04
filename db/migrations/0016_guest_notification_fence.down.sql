-- 0016_guest_notification_fence (down) — DISPOSABLE LOCAL test databases only. GATED and race-safe (contract §8.3): refused while any
-- notification audit (render / latch) exists or any guest.notify row was ever attempted or left pending; the audit and the at-most-one
-- claim history are never discarded. Otherwise drops every 0016 object; 0001–0015 objects are untouched (0016 replaced none).
LOCK TABLE booking.external_operations, booking.provider_evidence, booking.notification_renders, booking.notification_latches,
  booking.notification_write_authority IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.notification_renders) OR EXISTS (SELECT 1 FROM booking.notification_latches)
     OR EXISTS (SELECT 1 FROM booking.external_operations WHERE op_type = 'guest.notify' AND (attempts > 0 OR state <> 'pending')) THEN
    RAISE EXCEPTION 'MIGRATION_0016_DOWN_REFUSED: notification audit or attempted guest.notify rows exist' USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP TRIGGER notification_evidence_lock ON booking.provider_evidence;
DROP TRIGGER notify_claim_binding ON booking.external_operations;
DROP TRIGGER notify_op_fence ON booking.external_operations;

DROP FUNCTION booking.guest_notification_summary(integer[]);
DROP FUNCTION booking.list_guest_notifications(integer[], uuid, integer);
DROP FUNCTION booking.recover_expired_notifications(integer[], uuid, integer);
DROP FUNCTION booking.complete_guest_notification(uuid, text, text, text, text);
DROP FUNCTION booking.guest_notification_presend(uuid, text);
DROP FUNCTION booking.latch_guest_notification(uuid, text, text);
DROP FUNCTION booking.claim_guest_notification(uuid, text, text, text, text, text);
DROP FUNCTION booking.guest_notification_snapshot(uuid);
DROP FUNCTION booking.release_notification_work(uuid, text);
DROP FUNCTION booking.claim_notification_work(text, integer[], uuid);
DROP FUNCTION booking.gn_facts_advisory(uuid);
DROP FUNCTION booking.gn_lock_bundle(uuid, boolean);
DROP FUNCTION booking.notification_evidence_lock();
DROP FUNCTION booking.notify_claim_binding();
DROP FUNCTION booking.notify_op_fence();
DROP FUNCTION booking.gn_check_scope(integer[]);
DROP FUNCTION booking.gn_check_worker(text);
DROP FUNCTION booking.gn_non_latching(text);
DROP FUNCTION booking.guest_notification_refusal(uuid);
DROP FUNCTION booking.gn_hash_facts(jsonb);
DROP FUNCTION booking.guest_notification_facts(uuid);
DROP FUNCTION booking.gn_latest_evidence(uuid, text, text);
DROP FUNCTION booking.guest_notification_recipient_hash(uuid);
DROP FUNCTION booking.gn_require_observation_context();
DROP FUNCTION booking.gn_recipient_hash_of(text, text);
DROP FUNCTION booking.guest_notification_class(uuid);
DROP FUNCTION booking.guest_notification_protected(uuid);
DROP FUNCTION booking.gn_obs_bool(jsonb, text[]);
DROP FUNCTION booking.gn_obs_text(jsonb, text[], text);
DROP FUNCTION booking.gn_obs_int(jsonb, text[]);
DROP FUNCTION booking.gn_obs(jsonb, text[]);
DROP FUNCTION booking.gn_recipient_in_scope(text);
DROP FUNCTION booking.gn_target_state(text);
DROP FUNCTION booking.gn_templates();

DROP TABLE booking.notification_write_authority;
DROP TABLE booking.notification_latches;
DROP TABLE booking.notification_renders;
DROP INDEX booking.external_operations_one_guest_notify;
