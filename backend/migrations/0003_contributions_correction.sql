-- 0003_contributions_correction.sql —— 贡献更正链（PLAN：补录与更正，保留原记录）
ALTER TABLE contributions ADD COLUMN correction_of TEXT REFERENCES contributions(id);
