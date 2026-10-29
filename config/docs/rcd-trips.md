# Residual current trips

## Symptoms
The charge point stops a session after a few minutes and reports GroundFailure, sometimes OverCurrentFailure. Trips cluster after rain or on cold mornings.

## First checks
Read the last 72 hours of status notifications. Four or more GroundFailure events on one connector within a day point to the residual current device rather than the vehicle. Check whether other connectors at the site trip too: a site-wide pattern points to the supply, not the charger.

## On site
Test the type B RCD module with the tester before replacing anything. Inspect the cable gland and the inlet seal for water ingress. Replace the RCD module only if the test fails; replacing the cable first is the most common wasted visit.

## Close the ticket
Record the measured trip current and the module serial number. Set the resolution cause to rcd_trip.
