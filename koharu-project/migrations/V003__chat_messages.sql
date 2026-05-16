-- AI chat history, per-project. One row per turn (user or assistant
-- message). Tool calls + results are folded into the assistant content
-- as a JSON blob so we don't need a join table — agents in our
-- workflow rarely chain more than a handful of tool calls per turn.

CREATE TABLE chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content     TEXT NOT NULL,             -- markdown for user/assistant; JSON for tool results
    tool_calls  TEXT,                      -- JSON array of {id, name, args} when assistant invoked tools
    tool_call_id TEXT,                     -- present on `tool` rows; ties result back to the assistant turn
    model       TEXT,                      -- provider:model that produced this message
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
