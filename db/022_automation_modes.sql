-- Automation mode per action type.
--
-- Replaces a boolean that was never stored: autoApprove was passed per call
-- site, hardcoded true for the content sync and false for anything the user
-- asked for while watching. Nobody ever had a preference, so nothing is being
-- migrated from — every account starts at 'ask' because that is the only
-- honest reading of "we never asked them".
--
--   draft  write it and leave it; never queues on its own
--   ask    queue on a person's approval
--   auto   queue without one, under autopilot's own caps
--
-- withdraw defaults to 'auto' because it already behaves that way:
-- reconciliation queues withdrawals with no approval step. The value is
-- descriptive rather than new, and it exists so there is somewhere to turn it
-- off if taking invitations back ever needs supervision.
ALTER TABLE accounts ADD COLUMN automation_modes TEXT NOT NULL
  DEFAULT '{"post":"ask","comment":"ask","connect":"ask","withdraw":"auto"}';
