# Firmware crashes and reboot loops

## Symptoms
InternalError and ResetFailure notifications, the charge point flips between Unavailable and Available, sessions restart. Firmware versions 4.2.1 (ABB) and 2.7.0 (Kempower) are known to be affected.

## First checks
Check the firmware version in the charge point record. If it is a known affected version, schedule the update before sending anyone.

## Remote fixes
Push the vendor's current firmware over OCPP. Do not update during the evening peak.

## Close the ticket
Record the old and new firmware versions. Set the resolution cause to firmware_crash.
