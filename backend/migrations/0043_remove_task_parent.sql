-- Retire historical task nesting. Keep every task and its independent dependency edges.
-- ALTER TABLE preserves task IDs, other task columns, submissions and material history.
ALTER TABLE tasks DROP COLUMN parent_task_id;
