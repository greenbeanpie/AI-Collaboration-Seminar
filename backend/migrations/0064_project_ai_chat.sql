CREATE TABLE project_ai_chat_sessions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
 generation INTEGER NOT NULL DEFAULT 1, job_id TEXT, updated_at TEXT NOT NULL,
 UNIQUE(project_id,user_id)
);
CREATE TABLE project_ai_chat_questions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES project_ai_chat_sessions(id), generation INTEGER NOT NULL,
 project_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL, job_id TEXT NOT NULL,
 context_stamp TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX project_ai_chat_questions_session ON project_ai_chat_questions(session_id,generation,created_at,id);
CREATE TABLE project_ai_chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL REFERENCES project_ai_chat_questions(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,references_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
 UNIQUE(question_id,role)
);
CREATE TABLE project_ai_chat_operations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,question_id TEXT NOT NULL REFERENCES project_ai_chat_questions(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL, operation_key TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,
 href TEXT,detail TEXT,attempt INTEGER NOT NULL,created_at TEXT NOT NULL, UNIQUE(job_id,operation_key)
);
CREATE TABLE project_ai_chat_context_cleanup (
 object_key TEXT PRIMARY KEY,created_at TEXT NOT NULL
);
