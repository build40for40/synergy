-- Richer feedback per lead, so the dashboard can show Sent, Not for me and
-- what happened next, and keep a history. A lead is never deleted.
--
-- sent_at          when the user marked it sent (NULL = not sent)
-- dismissed_at     when the user marked it "not for me" (NULL = not dismissed)
-- dismiss_reason   optional reason, e.g. "Portfolio too young"
-- outcome          after sending: call, rejected or no_reply (NULL = still waiting)
-- outcome_at       when the outcome was set
-- notes_at         when the notes were last edited
--
-- reached_out and feedback_at stay for the extension's existing yes/no buttons.
ALTER TABLE leads ADD COLUMN sent_at TEXT;
ALTER TABLE leads ADD COLUMN dismissed_at TEXT;
ALTER TABLE leads ADD COLUMN dismiss_reason TEXT;
ALTER TABLE leads ADD COLUMN outcome TEXT CHECK (outcome IN ('call', 'rejected', 'no_reply'));
ALTER TABLE leads ADD COLUMN outcome_at TEXT;
ALTER TABLE leads ADD COLUMN notes_at TEXT;

-- Carry over any yes answers already given.
UPDATE leads SET sent_at = feedback_at WHERE reached_out = 1 AND sent_at IS NULL;

CREATE INDEX leads_by_outcome ON leads(outcome);
