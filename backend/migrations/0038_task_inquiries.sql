CREATE TABLE task_inquiries (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), upstream_task_id TEXT NOT NULL REFERENCES tasks(id),
 requester_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
 recipient_source TEXT NOT NULL CHECK(recipient_source IN('submission','completion','substitute')),
 task_title TEXT NOT NULL, upstream_title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX task_inquiries_task ON task_inquiries(project_id,task_id,created_at);
CREATE TABLE task_inquiry_messages (
 id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL REFERENCES task_inquiries(id), author_id TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL
);
CREATE INDEX task_inquiry_messages_thread ON task_inquiry_messages(inquiry_id,created_at);
