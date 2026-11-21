-- 0031 down (TEST only; refused while any bcc-v2 render exists, because the restored CHECK would not hold).
SET LOCAL lock_timeout = '5s';
DROP FUNCTION booking.claim_guest_notification_v3(uuid, text, text, text, text, text, text);
ALTER TABLE booking.notification_renders DROP CONSTRAINT notification_renders_version_binding;
ALTER TABLE booking.notification_renders ADD CONSTRAINT notification_renders_version_binding CHECK (
     (template_version = 'gn-v1' AND message_ref = 'gn1-' || operation_id::text AND locale IS NULL AND copy_contract_version IS NULL)
  OR (template_version = 'gn-v2' AND template = 'booking_confirmed' AND message_ref = 'gn2-' || operation_id::text
      AND locale IS NOT NULL AND locale IN ('en', 'es') AND copy_contract_version IS NOT NULL AND copy_contract_version = 'bcc-v1'));
