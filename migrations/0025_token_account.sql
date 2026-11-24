-- The account a token belongs to: one nullable column on api_token, so GET /api/v1/me
-- can name the account behind a token as well as its workspace. A token made from now on names
-- the account it was made for: the owner a new workspace is made with, or the account that
-- confirmed connecting the app. Nothing is dropped, renamed or rebuilt, and the statements of
-- the versions before it, which name no user_id, still run.
--
-- Of the tokens already made, only a connection (kind sign_in) can be told apart: its
-- collection wrote an audit row naming the confirming account, the workspace and the token in
-- the batch that made it (src/connect.ts). The column is filled from those rows alone, and only
-- when every connection_collected row naming the token names an account and the token's own
-- workspace, all of them the same account, and that account still exists and is a member of
-- the token's workspace. Any other shape (no row, a row without an account or a workspace, rows
-- naming two accounts, another workspace, an account deleted or no longer a member) leaves the
-- token without one. Every other token, the first token of every workspace among them, keeps no
-- account (null): nothing recorded whose it was, and none is guessed.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- The account the token was made for; null for a token nothing records an account of.
ALTER TABLE api_token ADD COLUMN user_id TEXT REFERENCES user (id);

UPDATE api_token SET user_id = (
  SELECT CASE
           WHEN count(*) = count(a.user_id)
            AND count(DISTINCT a.user_id) = 1
            AND sum(a.workspace_id IS api_token.workspace_id) = count(*)
            AND max(a.user_id) IN (SELECT m.user_id FROM membership m WHERE m.workspace_id = api_token.workspace_id)
            AND max(a.user_id) IN (SELECT u.id FROM user u)
           THEN max(a.user_id)
         END
    FROM audit a
   WHERE a.event = 'connection_collected' AND a.subject = api_token.id
) WHERE kind = 'sign_in' AND user_id IS NULL;
