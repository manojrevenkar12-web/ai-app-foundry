# OCPP 1.6 error codes in practice

## How to read them
Status notifications carry a status (Available, Charging, Faulted, Unavailable) and an error code. NoError with Charging or Available is normal traffic. Vendor error codes add detail but differ between manufacturers.

## Common codes and what they usually mean
GroundFailure: residual current or insulation fault. ConnectorLockFailure: the connector did not lock, often mechanical. EVCommunicationError: the vehicle and the charger could not agree, sometimes the vehicle's fault. HighTemperature: cooling. ReaderFailure: the RFID or payment terminal. InternalError and ResetFailure: firmware. WeakSignal: the modem.
