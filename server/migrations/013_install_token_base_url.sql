-- Remember the address the install link was minted for.
--
-- Redemption is a bare `curl`: no Referer, no session, nothing that says where
-- the dashboard lives. Working the base URL out again at that moment therefore
-- loses any sub-path — behind nginx at /monit the agent was configured with the
-- bare domain, and its first sample came back as somebody else's web page:
--
--   ✗ unexpected HTTP 200 from http://poc.moph.go.th/api/v1/ingest
--
-- The mint request is the one with the context to get this right (an admin's
-- setting, or the browser's own address), so it decides once and the answer
-- travels with the token.

ALTER TABLE install_tokens ADD COLUMN IF NOT EXISTS base_url text;
